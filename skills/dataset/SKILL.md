---
name: dataset
description: |
  Search the workflow dataset for best practices from past projects, and help
  users contribute new run records. Each dataset entry is a real orchestrate-run:
  domain, stack, architecture, workflows, outcome, lessons. Search it before
  designing a project so new work starts from accumulated experience.
  Use when: "search the dataset", "find similar projects", "what worked for X",
  "contribute to the dataset", "add a dataset entry", "best practices for X".
---

# Dataset

The plugin ships a dataset of real orchestrate-run records under `dataset/`.
This skill searches it and helps users grow it. The richer the dataset, the
better every future `orchestrate` run starts.

## Searching — pull best practices

Two interfaces over the same scoring (`dataset/lib.ts`):

### Via the MCP server (preferred)

The plugin registers the `dataset-server` MCP server. Call its tools:

- **`dataset_search`** — args: `domain`, `stack[]`, `archetype`, `keywords[]`,
  `limit`. Returns ranked entries with their `lessons`.
- **`dataset_get`** — args: `id`. Returns one full entry.
- **`dataset_stats`** — no args. Returns entry/domain/archetype counts.

If the MCP server is not connected, fall back to the CLI.

### Via the CLI

```bash
bun run dataset/search.ts '{"domain":"rest-api","stack":["bun"],"archetype":"verified-swarm","keywords":["auth"],"limit":5}'
```

### When to search

- **Before an architecture interview** — search by `domain` + `stack`, surface
  the `architecture` and `lessons` of similar past projects to the user.
- **Before workflow synthesis** — search by `domain` to see which archetype each
  phase used and how many rounds it took to converge.
- **When a project hits a pitfall** — search by `keywords` for entries whose
  `pitfalls` describe the same trap.

Always tell the user *which* entries informed a recommendation — cite the entry
`id`. Treat lessons as evidence, not law: an entry reflects one project.

## Contributing — grow the dataset

Run this after a real project ships (orchestrated or hand-built).

1. Read `dataset/README.md` and `dataset/schema.json`.
2. Draft `dataset/entries/<id>.json`. Required: `id`, `domain`, `summary`,
   `stack`, `architecture`, `workflows`, `outcome`, `lessons`, `contributor`,
   `contributedAt`. Be honest about `outcome` and `pitfalls` — a failed run with
   a clear lesson is as valuable as a clean one.
3. Validate: `bun run dataset/validate.ts` — must print `N/N entries valid`.
4. Open a PR with the new file, or file a **Dataset contribution** GitHub issue
   (`.github/ISSUE_TEMPLATE/dataset-contribution.yml`) for a maintainer to add.

To help a user contribute: interview them for each required field, write the
JSON file, run the validator, and show them the result before opening the PR.

## Notes

- Entry ids are unique and match the file name.
- The dataset feeds the `orchestrate` skill — Steps 4 (architecture) and 5
  (workflow synthesis) should search it first.
