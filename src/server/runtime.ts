import vm from 'node:vm';
import type {JsonObject, PathStep} from '../common/types';

/** Thrown by user code through ctx.fail(); also used for cancellation. */
export class MigrationError extends Error {
  constructor(
    message: string,
    readonly code: 'fail' | 'cancelled' | 'timeout' | 'compile' | 'crash',
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}

export type InvokeOptions = {
  /** preview runs resolve sleeps instantly and never perform real work */
  preview?: boolean;
  signal?: AbortSignal;
  /** per-sleep cap (real runs only) */
  maxSleepMs?: number;
};

// A single fresh V8 context per runtime. Standard built-ins (Object, Array,
// JSON, Promise, Math, ...) are provided by V8; nothing from the host realm is
// reachable from compiled code. This is a local-workbench sandbox, not a
// security boundary against malicious authors.
function createSandbox(): vm.Context {
  return vm.createContext({});
}

type Compiled = {kind: 'fn'; value: (doc: JsonObject, ctx: unknown) => unknown} | {kind: 'cond'; value: (doc: JsonObject) => unknown};

export class MigrationRuntime {
  private readonly sandbox = createSandbox();
  private readonly cache = new Map<string, Compiled>();

  /** Compile function source; throws MigrationError('compile') on bad syntax. */
  compileFunc(source: string): (doc: JsonObject, ctx: unknown) => unknown {
    let compiled = this.cache.get(source);
    if (!compiled) {
      try {
        const value = vm.runInContext(`(${source})`, this.sandbox, {filename: 'migration.js', timeout: 1000}) as unknown;
        if (typeof value !== 'function') throw new Error('source must evaluate to a function');
        compiled = {kind: 'fn', value: value as (doc: JsonObject, ctx: unknown) => unknown};
      } catch (error) {
        throw new MigrationError(`compile error: ${(error as Error).message}`, 'compile');
      }
      this.cache.set(source, compiled);
    }
    return compiled.value;
  }

  private compileCondition(expression: string): (doc: JsonObject) => unknown {
    const key = `cond:${expression}`;
    let compiled = this.cache.get(key);
    if (!compiled) {
      try {
        const value = vm.runInContext(`(doc) => (${expression})`, this.sandbox, {filename: 'condition.js', timeout: 1000}) as unknown;
        if (typeof value !== 'function') throw new Error('condition must evaluate to a function');
        compiled = {kind: 'cond', value: value as (doc: JsonObject) => unknown};
      } catch (error) {
        throw new MigrationError(`condition compile error: ${(error as Error).message}`, 'compile');
      }
      this.cache.set(key, compiled);
    }
    return compiled.value as (doc: JsonObject) => unknown;
  }

  /** Evaluate a condition predicate; absent condition means applicable. */
  evaluate(condition: string | undefined, doc: JsonObject): boolean {
    if (condition === undefined || condition.trim() === '') return true;
    return Boolean(this.compileCondition(condition)(doc));
  }

  /** Apply a bound step's function to a document. */
  async invoke(step: PathStep, doc: JsonObject, source: string, options: InvokeOptions = {}): Promise<JsonObject> {
    const fn = this.compileFunc(source);
    const abort = options.signal;
    const ctx = {
      input: doc,
      preview: Boolean(options.preview),
      fail(message: string): never {
        throw new MigrationError(String(message ?? 'migration failed'), 'fail');
      },
      async sleep(ms: number): Promise<void> {
        const total = Math.max(0, Number(ms) || 0);
        if (options.preview) return;
        const cap = options.maxSleepMs ?? 10_000;
        const remaining = Math.min(total, cap);
        const stepMs = 25;
        for (let waited = 0; waited < remaining; waited += stepMs) {
          if (abort?.aborted) throw new MigrationError('run cancelled', 'cancelled');
          await new Promise((resolve) => setTimeout(resolve, Math.min(stepMs, remaining - waited)));
        }
        if (abort?.aborted) throw new MigrationError('run cancelled', 'cancelled');
      },
      throwIfAborted(): void {
        if (abort?.aborted) throw new MigrationError('run cancelled', 'cancelled');
      },
    };
    try {
      const output = await fn(doc, ctx);
      if (output === null || typeof output !== 'object' || Array.isArray(output)) {
        throw new MigrationError('function must return an object', 'crash');
      }
      return output as JsonObject;
    } catch (error) {
      if (error instanceof MigrationError) throw error;
      throw new MigrationError(`function threw: ${(error as Error).message}`, 'crash');
    }
  }
}
