import type {FieldSpec, JsonObject, Schema} from './types';

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Returns a human-readable mismatch detail, or null when the doc conforms. */
export function checkSchema(schema: Schema, doc: unknown): string | null {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return `expected object, got ${describeType(doc)}`;
  }
  const record = doc as Record<string, unknown>;
  for (const field of schema.fields) {
    if (!(field.name in record)) {
      if (!field.optional) return `missing required field "${field.name}"`;
      continue;
    }
    const value = record[field.name];
    if (value === null || value === undefined) {
      if (!field.optional) return `field "${field.name}" is null`;
      continue;
    }
    if (describeType(value) !== field.type) {
      return `field "${field.name}" expected ${field.type}, got ${describeType(value)}`;
    }
  }
  if (schema.additional === false) {
    const known = new Set(schema.fields.map((f: FieldSpec) => f.name));
    for (const key of Object.keys(record)) {
      if (!known.has(key)) return `unexpected field "${key}"`;
    }
  }
  return null;
}

export function emptySchema(): Schema {
  return {fields: [], additional: true};
}

/** Stable signature used to detect schema drift across revisions. */
export function schemaSignature(schema: Schema): string {
  return JSON.stringify({
    a: schema.additional ?? true,
    f: schema.fields.map((f) => [f.name, f.type, f.optional ? 1 : 0]),
  });
}

/** Validate the seed document against the first edge's input schema. */
export function validateSeed(schema: Schema, sample: JsonObject): string | null {
  return checkSchema(schema, sample);
}
