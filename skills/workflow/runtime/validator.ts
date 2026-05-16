import type { JsonSchema, ValidationResult } from "./types.ts";

export function validate(value: unknown, schema: JsonSchema): ValidationResult {
  const errors: string[] = [];
  walk(value, schema, "$", errors);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

function walk(value: unknown, schema: JsonSchema, path: string, errors: string[]): void {
  if ("oneOf" in schema) {
    if (!schema.oneOf.some((s) => { const e: string[] = []; walk(value, s, path, e); return e.length === 0; }))
      errors.push(`${path}: no oneOf match`);
    return;
  }
  if ("anyOf" in schema) return;
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
