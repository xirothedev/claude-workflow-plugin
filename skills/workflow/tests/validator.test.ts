import { describe, expect, test } from "bun:test";
import type { JsonSchema } from "../src/types.ts";
import { validate } from "../src/validator.ts";

describe("validate — primitives", () => {
  test("object: required key present", () => {
    const s: JsonSchema = { type: "object", required: ["a"], properties: { a: { type: "string" } } };
    expect(validate({ a: "x" }, s).ok).toBe(true);
  });

  test("object: missing required key fails with path", () => {
    const s: JsonSchema = { type: "object", required: ["a"], properties: { a: { type: "string" } } };
    const r = validate({}, s);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("$.a: required");
  });

  test("string enum: value outside enum fails", () => {
    const s: JsonSchema = { type: "string", enum: ["ok", "error"] };
    expect(validate("ok", s).ok).toBe(true);
    expect(validate("nope", s).ok).toBe(false);
  });

  test("integer rejects fractional", () => {
    const s: JsonSchema = { type: "integer" };
    expect(validate(3, s).ok).toBe(true);
    expect(validate(3.5, s).ok).toBe(false);
  });
});

describe("validate — oneOf (exactly one match)", () => {
  // Two overlapping object schemas so a value can match 0, 1, or 2 branches.
  const s: JsonSchema = {
    oneOf: [
      { type: "object", required: ["a"], properties: { a: { type: "integer" } } },
      { type: "object", required: ["b"], properties: { b: { type: "integer" } } },
    ],
  };

  test("exactly one branch matches → ok", () => {
    expect(validate({ a: 1 }, s).ok).toBe(true);
  });

  test("zero branches match → fail", () => {
    expect(validate({ c: 1 }, s).ok).toBe(false);
  });

  test("two branches match → fail (oneOf is exactly-one, not any)", () => {
    expect(validate({ a: 1, b: 2 }, s).ok).toBe(false);
  });
});

describe("validate — anyOf (at least one match)", () => {
  const s: JsonSchema = { anyOf: [{ type: "string" }, { type: "integer" }] };

  test("one branch matches → ok", () => {
    expect(validate("x", s).ok).toBe(true);
    expect(validate(7, s).ok).toBe(true);
  });

  test("no branch matches → fail", () => {
    expect(validate(true, s).ok).toBe(false);
  });
});

describe("validate — bare enum (no type keyword)", () => {
  const s: JsonSchema = { enum: ["high", "medium", "low"] };

  test("value in enum → ok", () => {
    expect(validate("medium", s).ok).toBe(true);
  });

  test("value outside enum → fail", () => {
    expect(validate("x", s).ok).toBe(false);
  });
});

describe("validate — additionalProperties: false", () => {
  const s: JsonSchema = {
    type: "object",
    properties: { a: { type: "string" } },
    additionalProperties: false,
  };

  test("only known keys → ok", () => {
    expect(validate({ a: "x" }, s).ok).toBe(true);
  });

  test("unknown key → fail", () => {
    const r = validate({ a: "x", b: 1 }, s);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("$.b: unexpected property");
  });
});

describe("validate — nested path errors", () => {
  const s: JsonSchema = {
    type: "object",
    required: ["items"],
    properties: {
      items: {
        type: "array",
        items: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
      },
    },
  };

  test("error path points at the offending array index", () => {
    const r = validate({ items: [{ name: "a" }, {}] }, s);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("$.items[1].name: required");
  });
});
