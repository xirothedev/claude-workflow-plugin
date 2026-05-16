/**
 * dataset/search.ts — CLI over the dataset. Mirrors the `dataset_search` MCP
 * tool for use without an MCP client.
 *
 *   bun run dataset/search.ts '{"domain":"rest-api","stack":["bun"]}'
 */
import { search, type SearchQuery } from "./lib.ts";

const raw = process.argv[2];
if (!raw) {
  console.error('Usage: bun run dataset/search.ts \'{"domain":"rest-api","stack":["bun"],"archetype":"verified-swarm","keywords":["auth"],"limit":5}\'');
  process.exit(1);
}

let query: SearchQuery;
try {
  query = JSON.parse(raw) as SearchQuery;
} catch {
  console.error("invalid JSON query");
  process.exit(1);
}

const hits = search(query);
if (!hits.length) {
  console.log("No matching entries. Consider contributing a project in this area — see dataset/README.md.");
  process.exit(0);
}

for (const h of hits) {
  console.log(`\n${h.entry.id}  (score ${h.score})`);
  console.log(`  ${h.entry.summary}`);
  console.log(`  matched: ${h.why.join("; ")}`);
  console.log(`  stack: ${h.entry.stack.join(", ")}`);
  for (const l of h.entry.lessons) console.log(`  - ${l}`);
}
