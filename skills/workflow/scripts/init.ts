import { existsSync, mkdirSync, symlinkSync, writeFileSync, copyFileSync, readdirSync } from "node:fs";
import { resolve, relative } from "node:path";

const SKILL_DIR = resolve(import.meta.dir, "..");
const RUNTIME_DIR = resolve(SKILL_DIR, "src");
const TEMPLATES_DIR = resolve(SKILL_DIR, "templates");

const CLI_CONTENT = `import { loadWorkflow, buildPlan, formatPlan } from "./src/runtime.ts";
import { validate } from "./src/validator.ts";
import type { JsonSchema } from "./src/types.ts";
import { resolve, relative } from "node:path";
import { glob } from "node:fs/promises";

const DIR = resolve(import.meta.dir);
const TMPL = resolve(import.meta.dir, "templates");

async function find(): Promise<string[]> {
  const files: string[] = [];
  for await (const f of glob("*.workflow.ts", { cwd: DIR })) files.push(resolve(DIR, f));
  for await (const f of glob("*.workflow.ts", { cwd: TMPL })) files.push(resolve(TMPL, f));
  return files.sort();
}

function parse(j?: string): Record<string, unknown> {
  if (!j) return {};
  try { return JSON.parse(j); } catch { console.error("Invalid JSON"); process.exit(1); }
}

async function findWorkflow(name: string): Promise<string> {
  const exact = resolve(name);
  try { await Bun.file(exact).stat(); return exact; } catch {}
  const all = await find();
  const m = all.find(f => { const b = f.split("/").pop() || ""; return b === name + ".workflow.ts" || b === name; });
  if (m) return m;
  throw new Error("Workflow not found: " + name);
}

async function main() {
  const cmd = process.argv[2], name = process.argv[3], argsJson = process.argv[4];
  if (!cmd) { console.log("Usage: cli.ts <list|plan|show|validate|meta> [workflow] [args-json]"); process.exit(0); }
  switch (cmd) {
    case "list": for (const f of await find()) { try { const m = await loadWorkflow(f); console.log("  " + relative(DIR, f)); console.log("    " + m.meta.name + ": " + m.meta.phases.map(p=>p.title).join(" -> ")); } catch {} } break;
    case "meta": if (!name) { console.error("meta <workflow>"); process.exit(1); } console.log(JSON.stringify((await loadWorkflow(await findWorkflow(name))).meta, null, 2)); break;
    case "validate": { if (!name) { console.error("validate <workflow> [args]"); process.exit(1); } const mod = await loadWorkflow(await findWorkflow(name)); const a = parse(argsJson); if (!mod.meta.args_schema) { console.log("No args_schema."); break; } const r = validate(a, mod.meta.args_schema as JsonSchema); console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); }
    case "plan": { if (!name) { console.error("plan <workflow> [args]"); process.exit(1); } console.log(JSON.stringify(buildPlan(await loadWorkflow(await findWorkflow(name)), parse(argsJson)), null, 2)); break; }
    case "show": { if (!name) { console.error("show <workflow> [args]"); process.exit(1); } console.log(formatPlan(buildPlan(await loadWorkflow(await findWorkflow(name)), parse(argsJson)))); break; }
    default: console.error("Unknown: " + cmd); process.exit(1);
  }
}
main().catch(e => { console.error((e as Error).message); process.exit(1); });
`;

const README_CONTENT = `# Workflows

Multi-phase agent orchestration. Bootstrapped by claude-workflow-plugin.

## CLI
\`\`\`bash
bun run .claude/workflows/cli.ts list
bun run .claude/workflows/cli.ts show <name> '<args>'
bun run .claude/workflows/cli.ts plan <name> '<args>'
bun run .claude/workflows/cli.ts validate <name> '<args>'
bun run .claude/workflows/cli.ts meta <name>
\`\`\`

## Create
Copy from templates/ to .claude/workflows/<name>.workflow.ts,
then rewrite the import \`../src/types.ts\` -> \`./src/types.ts\`.

## Regenerate
Re-run init. Existing files never overwritten.
`;

// ── Main ──────────────────────────────────────────────────────────────

const projectDir = resolve(process.argv[2] || process.cwd());
const wfDir = resolve(projectDir, ".claude/workflows");
const srcDir = resolve(wfDir, "src");
const tmplDir = resolve(wfDir, "templates");

console.log(`Bootstrapping workflows in: ${projectDir}\n`);

for (const dir of [wfDir, srcDir, tmplDir]) {
  if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); console.log(`  created: ${relative(projectDir, dir)}/`); }
  else console.log(`  exists:  ${relative(projectDir, dir)}/`);
}

for (const file of ["types.ts", "runtime.ts", "validator.ts"]) {
  const target = resolve(srcDir, file);
  const source = resolve(RUNTIME_DIR, file);
  if (existsSync(target)) { console.log(`  exists:  src/${file}`); continue; }
  if (!existsSync(source)) { console.log(`  missing: ${source}`); continue; }
  // Symlink keeps runtime as single source of truth. Falls back to copy when
  // symlinks are unavailable (Windows without privilege, restricted FS).
  try {
    symlinkSync(source, target);
    console.log(`  linked:  src/${file}`);
  } catch {
    copyFileSync(source, target);
    console.log(`  copied:  src/${file} (symlink unavailable — re-run init after plugin updates)`);
  }
}

if (existsSync(TEMPLATES_DIR)) {
  for (const file of readdirSync(TEMPLATES_DIR).filter(f => f.endsWith(".workflow.ts"))) {
    const target = resolve(tmplDir, file);
    if (existsSync(target)) { console.log(`  exists:  templates/${file}`); continue; }
    copyFileSync(resolve(TEMPLATES_DIR, file), target);
    console.log(`  copied:  templates/${file}`);
  }
}

const cliPath = resolve(wfDir, "cli.ts");
if (existsSync(cliPath)) console.log(`  exists:  cli.ts`);
else { writeFileSync(cliPath, CLI_CONTENT); console.log(`  wrote:   cli.ts`); }

const readmePath = resolve(wfDir, "README.md");
if (existsSync(readmePath)) console.log(`  exists:  README.md`);
else { writeFileSync(readmePath, README_CONTENT); console.log(`  wrote:   README.md`); }

console.log(`\nDone. Run 'bun run .claude/workflows/cli.ts list' to see workflows.`);
