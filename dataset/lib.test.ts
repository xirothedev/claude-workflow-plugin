import { describe, expect, test } from "bun:test";
import { loadEntries, loadSchema, scoreEntry, search, stats, validateEntry } from "./lib.ts";

describe("dataset — schema + entries", () => {
  test("schema.json loads", () => {
    expect(loadSchema()).toBeDefined();
  });

  test("the seed entries load and parse", () => {
    expect(loadEntries().length).toBeGreaterThanOrEqual(3);
  });

  test("every entry validates against schema.json", () => {
    for (const entry of loadEntries()) {
      const r = validateEntry(entry);
      if (!r.ok) throw new Error(`${entry.id}: ${(r.errors ?? []).join("; ")}`);
      expect(r.ok).toBe(true);
    }
  });

  test("entry ids are unique", () => {
    const ids = loadEntries().map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("validateEntry rejects an entry missing required fields", () => {
    expect(validateEntry({ id: "x", domain: "y" }).ok).toBe(false);
  });

  test("validateEntry rejects unknown top-level keys", () => {
    const entry = loadEntries()[0]!;
    expect(validateEntry({ ...entry, bogusKey: 1 }).ok).toBe(false);
  });

  test("validateEntry rejects an invalid archetype", () => {
    const entry = structuredClone(loadEntries()[0]!);
    entry.workflows[0]!.archetype = "made-up" as never;
    expect(validateEntry(entry).ok).toBe(false);
  });
});

describe("dataset — search ranking", () => {
  test("exact domain match ranks the matching entry first", () => {
    expect(search({ domain: "rest-api" })[0]?.entry.id).toBe("rest-api-bun-hono");
  });

  test("stack overlap contributes to the score", () => {
    const hits = search({ stack: ["bun", "hono"] });
    expect(hits.some((h) => h.entry.id === "rest-api-bun-hono")).toBe(true);
  });

  test("archetype filter only returns entries that use it", () => {
    const hits = search({ archetype: "survey-round" });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.entry.workflows.some((w) => w.archetype === "survey-round")).toBe(true);
    }
  });

  test("a no-match query returns no hits", () => {
    expect(search({ domain: "nonexistent-domain-xyz" }).length).toBe(0);
  });

  test("limit caps the result count", () => {
    expect(search({ keywords: ["convergence"], limit: 1 }).length).toBeLessThanOrEqual(1);
  });

  test("scoreEntry is zero with an empty why for an unrelated query", () => {
    const hit = scoreEntry(loadEntries()[0]!, { domain: "totally-different" });
    expect(hit.score).toBe(0);
    expect(hit.why.length).toBe(0);
  });

  test("each hit carries a non-empty why explaining the match", () => {
    expect(search({ domain: "rest-api" })[0]?.why.length).toBeGreaterThan(0);
  });

  test("hits are sorted by descending score", () => {
    const hits = search({ keywords: ["convergence", "api", "port"] });
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
    }
  });
});

describe("dataset — stats", () => {
  test("stats counts entries, convergence and archetypes", () => {
    const s = stats();
    expect(s.entries).toBe(loadEntries().length);
    expect(s.converged).toBeGreaterThan(0);
    expect(Object.keys(s.archetypes).length).toBeGreaterThan(0);
    expect(Object.keys(s.domains).length).toBeGreaterThan(0);
  });
});
