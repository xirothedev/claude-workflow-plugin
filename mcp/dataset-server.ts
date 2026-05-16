/**
 * mcp/dataset-server.ts — stdio MCP server over the workflow dataset.
 *
 * Hand-rolled JSON-RPC 2.0 over stdin/stdout (newline-delimited), no SDK —
 * matching this repo's dependency-free philosophy. Exposes three tools:
 *   - dataset_search  — rank past projects similar to a query, return lessons
 *   - dataset_get     — fetch one full entry by id
 *   - dataset_stats   — aggregate counts across the dataset
 *
 * Registered in `.claude-plugin/plugin.json` under `mcpServers`. The `dataset`
 * skill tells Claude when and how to call these tools.
 */
import { loadEntries, search, stats, type SearchQuery } from "../dataset/lib.ts";

const SERVER = { name: "claude-workflow-dataset", version: "1.0.0" };

interface RpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

function send(msg: RpcMessage): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id: number | string | null, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id: number | string | null, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

const TOOLS = [
  {
    name: "dataset_search",
    description:
      "Search the workflow dataset for past projects similar to a query. Returns ranked entries with their lessons (best practices). Call this before designing a new project's architecture or synthesising its workflows.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "project category, e.g. rest-api, saas-dashboard, language-port" },
        stack: { type: "array", items: { type: "string" }, description: "languages / frameworks / libraries" },
        archetype: { type: "string", description: "workflow archetype to match" },
        keywords: { type: "array", items: { type: "string" } },
        limit: { type: "number", description: "max results (default 5)" },
      },
    },
  },
  {
    name: "dataset_get",
    description: "Fetch one full dataset entry by id.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "dataset_stats",
    description: "Aggregate counts across the dataset: entries, domains, archetypes, convergence rate.",
    inputSchema: { type: "object", properties: {} },
  },
];

/** Wrap any value as an MCP tool-result content block. */
function content(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

/** Build a typed SearchQuery from raw tool arguments. */
function toQuery(a: Record<string, unknown>): SearchQuery {
  return {
    domain: typeof a.domain === "string" ? a.domain : undefined,
    stack: Array.isArray(a.stack) ? a.stack.map(String) : undefined,
    archetype: typeof a.archetype === "string" ? (a.archetype as SearchQuery["archetype"]) : undefined,
    keywords: Array.isArray(a.keywords) ? a.keywords.map(String) : undefined,
    limit: typeof a.limit === "number" ? a.limit : undefined,
  };
}

function callTool(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case "dataset_search": {
      const hits = search(toQuery(args));
      if (!hits.length) {
        return content("No matching dataset entries. The dataset may be sparse for this domain — consider contributing this project once it ships.");
      }
      const blocks = hits.map((h) =>
        `## ${h.entry.id}  (score ${h.score})\n` +
        `${h.entry.summary}\n` +
        `matched: ${h.why.join("; ")}\n` +
        `stack: ${h.entry.stack.join(", ")}\n` +
        `lessons:\n${h.entry.lessons.map((l) => `  - ${l}`).join("\n")}`,
      );
      return content(blocks.join("\n\n"));
    }
    case "dataset_get": {
      const id = String(args.id ?? "");
      const entry = loadEntries().find((e) => e.id === id);
      if (!entry) throw new Error(`no dataset entry with id "${id}"`);
      return content(entry);
    }
    case "dataset_stats":
      return content(stats());
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function handle(msg: RpcMessage): void {
  const id = msg.id ?? null;
  switch (msg.method) {
    case "initialize":
      reply(id, { protocolVersion: "2024-11-05", serverInfo: SERVER, capabilities: { tools: {} } });
      return;
    case "notifications/initialized":
      return; // notification — no reply
    case "tools/list":
      reply(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const params = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      try {
        reply(id, callTool(params.name ?? "", params.arguments ?? {}));
      } catch (e) {
        reply(id, { content: [{ type: "text", text: `error: ${(e as Error).message}` }], isError: true });
      }
      return;
    }
    default:
      if (id !== null) fail(id, -32601, `method not found: ${msg.method ?? "(none)"}`);
  }
}

// ── stdio read loop — newline-delimited JSON-RPC ────────────────────────────
let buffer = "";
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk as Uint8Array);
  let nl = buffer.indexOf("\n");
  while (nl >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) {
      try {
        handle(JSON.parse(line) as RpcMessage);
      } catch {
        fail(null, -32700, "parse error");
      }
    }
    nl = buffer.indexOf("\n");
  }
}
