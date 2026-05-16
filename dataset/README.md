# Workflow dataset

Real orchestrate-run records, contributed by users. Each entry captures one
project: its domain, stack, architecture, the workflows used, the outcome, and
the **lessons** — the best practices that worked.

The `orchestrate` and `dataset` skills search this dataset so every new project
starts from accumulated real-world experience instead of a blank page. The more
projects people contribute, the richer that signal becomes.

## Layout

```
dataset/
├── schema.json        # JSON Schema every entry must satisfy
├── entries/           # one *.json file per project (file name == id)
├── lib.ts             # load / validate / search — shared by CLI + MCP
├── search.ts          # CLI: bun run dataset/search.ts '<query-json>'
├── validate.ts        # CLI: bun run dataset/validate.ts  (CI gate)
└── lib.test.ts        # bun test
```

## Searching

**MCP (preferred)** — the `dataset-server` MCP server exposes `dataset_search`,
`dataset_get`, `dataset_stats`. The `dataset` skill drives them.

**CLI** — no MCP client needed:

```bash
bun run dataset/search.ts '{"domain":"rest-api","stack":["bun"],"archetype":"verified-swarm","keywords":["auth"],"limit":5}'
```

Scoring weights what makes a past project a useful precedent: same domain (+10),
shared stack (Jaccard ×8), shared archetype (+6), keyword hits (+2 each).

## Contributing an entry

You contribute after orchestrating (or hand-building) a real project.

1. Copy an existing file in `entries/` as a starting point.
2. Name it `entries/<id>.json` where `<id>` is a unique kebab-case id matching
   the `id` field.
3. Fill in every required field — see `schema.json`. Be honest about `outcome`
   and `pitfalls`; a failed run with a clear lesson is as valuable as a clean one.
4. Validate: `bun run dataset/validate.ts` — must print `N/N entries valid`.
5. Open a PR (or file a **Dataset contribution** issue and let a maintainer add it).

### Entry fields

| Field | Required | Notes |
|-------|----------|-------|
| `id` | ✓ | kebab-case, unique, == file name |
| `domain` | ✓ | `rest-api`, `saas-dashboard`, `cli-tool`, `language-port`, … |
| `summary` | ✓ | one line |
| `stack` | ✓ | languages / frameworks / libraries |
| `architecture` | ✓ | `backend`, `frontend` (`n/a` if none), `designSystem`, `notes` |
| `workflows` | ✓ | per phase: `archetype`, `agents`, `notes` |
| `outcome` | ✓ | `converged`, `rounds`, `totalAgents`, `note` |
| `lessons` | ✓ | what worked — the searchable payload |
| `pitfalls` | | what went wrong and how it was caught |
| `tags` | | free keywords to aid search |
| `contributor` | ✓ | `name`, `url` |
| `contributedAt` | ✓ | ISO date |
| `license` | | default `CC0-1.0` |

Entries are licensed `CC0-1.0` by default so the dataset stays freely reusable.
