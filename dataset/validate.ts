/**
 * dataset/validate.ts — validate every entry in `dataset/entries/` against
 * `dataset/schema.json`. Run in CI on every dataset contribution.
 *
 *   bun run dataset/validate.ts
 */
import { loadEntries, validateEntry, type DatasetEntry } from "./lib.ts";

let entries: DatasetEntry[];
try {
  entries = loadEntries();
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

if (!entries.length) {
  console.log("No entries in dataset/entries/.");
  process.exit(0);
}

let failed = 0;
const seen = new Set<string>();

for (const entry of entries) {
  const r = validateEntry(entry);
  const id = entry.id || "(no id)";
  if (!r.ok) {
    failed++;
    console.error(`  FAIL  ${id}`);
    for (const err of r.errors ?? []) console.error(`        ${err}`);
    continue;
  }
  if (seen.has(entry.id)) {
    failed++;
    console.error(`  FAIL  ${id} — duplicate id`);
    continue;
  }
  seen.add(entry.id);
  console.log(`  ok    ${id}`);
}

console.log(`\n${entries.length - failed}/${entries.length} entries valid`);
process.exit(failed > 0 ? 1 : 0);
