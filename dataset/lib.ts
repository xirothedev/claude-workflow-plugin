/**
 * dataset/lib.ts — load, validate and search the contributed dataset.
 *
 * Shared by `dataset/search.ts` (CLI), `dataset/validate.ts` (CI) and
 * `mcp/dataset-server.ts` (MCP). Each of those is a thin wrapper over this file.
 *
 * Entries are full orchestrate-run records (see `dataset/schema.json`). Search
 * scores an entry against a partial query so a new project can pull "best
 * practices" — the `lessons` — from structurally similar past projects.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { JsonSchema } from "../skills/workflow/src/types.ts";
import { validate } from "../skills/workflow/src/validator.ts";

const ENTRIES_DIR = resolve(import.meta.dir, "entries");
const SCHEMA_PATH = resolve(import.meta.dir, "schema.json");

export type Archetype = "single-agent" | "multi-stage" | "parallel-swarm" | "verified-swarm" | "survey-round";

export interface WorkflowUsage {
  phase: string;
  archetype: Archetype;
  agents?: number;
  notes?: string;
}

export interface DatasetEntry {
  id: string;
  domain: string;
  summary: string;
  stack: string[];
  architecture: { backend: string; frontend: string; designSystem?: string; notes?: string[] };
  workflows: WorkflowUsage[];
  outcome: { converged: boolean; rounds?: number; totalAgents?: number; note?: string };
  lessons: string[];
  pitfalls?: string[];
  tags?: string[];
  contributor: { name: string; url?: string };
  contributedAt: string;
  license?: string;
}

export interface SearchQuery {
  domain?: string;
  stack?: string[];
  archetype?: Archetype;
  keywords?: string[];
  limit?: number;
}

export interface SearchHit {
  entry: DatasetEntry;
  score: number;
  why: string[];
}

/** The JSON Schema every entry must satisfy. */
export function loadSchema(): JsonSchema {
  return JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as JsonSchema;
}

/** Validate one parsed entry against the schema. */
export function validateEntry(raw: unknown): { ok: boolean; errors?: string[] } {
  const r = validate(raw, loadSchema());
  return r.ok ? { ok: true } : { ok: false, errors: r.errors };
}

/** Load every `*.json` entry from `dataset/entries/`. Throws on a malformed file. */
export function loadEntries(): DatasetEntry[] {
  let files: string[];
  try {
    files = readdirSync(ENTRIES_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files.sort().map((f) => {
    const path = resolve(ENTRIES_DIR, f);
    try {
      return JSON.parse(readFileSync(path, "utf8")) as DatasetEntry;
    } catch (e) {
      throw new Error(`dataset entry ${f} is not valid JSON: ${(e as Error).message}`);
    }
  });
}

const lower = (s: string): string => s.toLowerCase();

/** Jaccard similarity of two string sets, case-insensitive. */
function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a.map(lower));
  const setB = new Set(b.map(lower));
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;
  return inter / (setA.size + setB.size - inter);
}

/**
 * Score one entry against a query. Weighting reflects what makes a past project
 * a useful precedent: same domain matters most, then a shared stack, then a
 * shared archetype, then loose keyword hits.
 */
export function scoreEntry(entry: DatasetEntry, query: SearchQuery): SearchHit {
  let score = 0;
  const why: string[] = [];

  if (query.domain) {
    const q = lower(query.domain);
    const d = lower(entry.domain);
    if (d === q) { score += 10; why.push(`domain == ${entry.domain}`); }
    else if (d.includes(q) || q.includes(d)) { score += 4; why.push(`domain ~ ${entry.domain}`); }
  }

  if (query.stack?.length) {
    const j = jaccard(query.stack, entry.stack);
    if (j > 0) { const s = Math.round(j * 8); score += s; why.push(`stack overlap ${(j * 100).toFixed(0)}% (+${s})`); }
  }

  if (query.archetype && entry.workflows.some((w) => w.archetype === query.archetype)) {
    score += 6;
    why.push(`uses ${query.archetype}`);
  }

  if (query.keywords?.length) {
    const haystack = lower([entry.summary, entry.domain, ...entry.lessons, ...(entry.tags ?? [])].join(" \n "));
    for (const kw of query.keywords) {
      if (haystack.includes(lower(kw))) { score += 2; why.push(`keyword "${kw}"`); }
    }
  }

  return { entry, score, why };
}

/** Score every entry, drop zero-score hits, return the top `limit` (default 5). */
export function search(query: SearchQuery, entries: DatasetEntry[] = loadEntries()): SearchHit[] {
  const limit = query.limit && query.limit > 0 ? query.limit : 5;
  return entries
    .map((e) => scoreEntry(e, query))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Aggregate counts across the dataset — used by `dataset_stats`. */
export function stats(entries: DatasetEntry[] = loadEntries()): {
  entries: number;
  domains: Record<string, number>;
  archetypes: Record<string, number>;
  converged: number;
} {
  const domains: Record<string, number> = {};
  const archetypes: Record<string, number> = {};
  let converged = 0;
  for (const e of entries) {
    domains[e.domain] = (domains[e.domain] ?? 0) + 1;
    if (e.outcome.converged) converged++;
    for (const w of e.workflows) archetypes[w.archetype] = (archetypes[w.archetype] ?? 0) + 1;
  }
  return { entries: entries.length, domains, archetypes, converged };
}
