import type { JsonSchema, ValidationResult } from "./types.ts";

export function validate(value: unknown, schema: JsonSchema): ValidationResult {
  const errors: string[] = [];
  walk(value, schema, "$", errors);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

/** True if `value` validates against `schema` with zero errors. */
function matches(value: unknown, schema: JsonSchema): boolean {
  const e: string[] = [];
  walk(value, schema, "$", e);
  return e.length === 0;
}

function walk(value: unknown, schema: JsonSchema, path: string, errors: string[]): void {
  // oneOf — exactly one branch must match (JSON Schema semantics).
  if ("oneOf" in schema) {
    const hits = schema.oneOf.filter((s) => matches(value, s)).length;
    if (hits !== 1) errors.push(`${path}: expected exactly 1 oneOf match, got ${hits}`);
    return;
  }
  // anyOf — at least one branch must match.
  if ("anyOf" in schema) {
    if (!schema.anyOf.some((s) => matches(value, s))) errors.push(`${path}: no anyOf match`);
    return;
  }
  // Bare enum schema ({ enum: [...] } with no `type`).
  if ("enum" in schema && !("type" in schema)) {
    if (!schema.enum.includes(value as string | number | boolean))
      errors.push(`${path}: ${JSON.stringify(value)} not in [${schema.enum.join(", ")}]`);
    return;
  }
  if (!("type" in schema)) return;

  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        errors.push(`${path}: expected object, got ${typeof value}`);
        return;
      }
      const obj = value as Record<string, unknown>;
      for (const key of schema.required || []) {
        if (!(key in obj)) errors.push(`${path}.${key}: required`);
      }
      if (schema.properties) {
        for (const [key, prop] of Object.entries(schema.properties)) {
          if (key in obj) walk(obj[key], prop, `${path}.${key}`, errors);
        }
      }
      // Reject unknown keys when additionalProperties is explicitly false.
      if (schema.additionalProperties === false) {
        const known = schema.properties ? Object.keys(schema.properties) : [];
        for (const key of Object.keys(obj)) {
          if (!known.includes(key)) errors.push(`${path}.${key}: unexpected property`);
        }
      }
      break;
    }
    case "string": {
      if (typeof value !== "string") errors.push(`${path}: expected string, got ${typeof value}`);
      else if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: "${value}" not in [${schema.enum.join(", ")}]`);
      break;
    }
    case "integer": {
      if (typeof value !== "number" || !Number.isInteger(value)) errors.push(`${path}: expected integer`);
      break;
    }
    case "boolean": {
      if (typeof value !== "boolean") errors.push(`${path}: expected boolean`);
      break;
    }
    case "array": {
      if (!Array.isArray(value)) { errors.push(`${path}: expected array`); return; }
      for (let i = 0; i < value.length; i++) walk(value[i], schema.items, `${path}[${i}]`, errors);
      break;
    }
  }
}
