#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import { cli, define } from "gunshi";

import { ensureDir, writeFileIfChanged } from "./fs-utils";

type InitOptions = {
  yes: boolean;
  force: boolean;
  dryRun: boolean;

  // Defaults are fine for most users; override only when needed.
  className: string;
  binding: string;
  image: string;
  maxInstances: number;

  // If omitted: keep existing compatibility_date; if missing, use today's UTC date.
  compatibilityDate?: string;

  // If omitted: use wrangler.jsonc main; else try common files; if not found, skip export injection.
  entry?: string;
};

type Prompter = {
  confirm: (message: string, defaultValue?: boolean) => Promise<boolean>;
  close: () => void;
};

type WranglerReadResult = {
  raw: string;
  data: any;
  hasJsoncComments: boolean;
};

const moduleDir =
  typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
const pkgJsonPath = path.resolve(moduleDir, "../package.json");
const pkg = fs.existsSync(pkgJsonPath)
  ? JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"))
  : { version: "0.0.0" };
const VERSION = pkg.version ?? "0.0.0";

const DEFAULTS = {
  className: "NodejsFnContainer",
  binding: "NODEJS_FN",
  image: "./.create-nodejs-fn/Dockerfile",
  maxInstances: 10,
} as const;

const initCommand = define({
  name: "init",
  description:
    "Configure create-nodejs-fn for an existing Workers project (requires wrangler.jsonc)",
  args: {
    yes: {
      type: "boolean",
      short: "y",
      description: "Non-interactive. Assume defaults and skip confirmations (safe defaults).",
    },
    force: {
      type: "boolean",
      short: "f",
      description:
        "Overwrite existing files without asking (also rewrites wrangler.jsonc even if it has comments).",
    },
    "dry-run": {
      type: "boolean",
      description: "Show what would change, but do not write files.",
    },

    "class-name": {
      type: "string",
      description: `Container class name (default: ${DEFAULTS.className})`,
    },
    binding: {
      type: "string",
      description: `Durable Object binding name (default: ${DEFAULTS.binding})`,
    },
    image: {
      type: "string",
      description: `Container Dockerfile path for wrangler containers.image (default: ${DEFAULTS.image})`,
    },
    "max-instances": {
      type: "number",
      description: `Max container instances (default: ${DEFAULTS.maxInstances})`,
    },
    "compatibility-date": {
      type: "string",
      description: "Compatibility date. If omitted, keeps existing; if missing, uses today (UTC).",
    },
    entry: {
      type: "string",
      description:
        "Entry file to append export to. If omitted, uses wrangler.jsonc main; otherwise tries common files; else skips.",
    },
  },
  run: async (ctx) => {
    const opts: InitOptions = {
      yes: Boolean(ctx.values.yes),
      force: Boolean(ctx.values.force),
      dryRun: Boolean(ctx.values["dry-run"]),

      className: String(ctx.values["class-name"] ?? DEFAULTS.className),
      binding: String(ctx.values.binding ?? DEFAULTS.binding),
      image: String(ctx.values.image ?? DEFAULTS.image),
      maxInstances: Number(ctx.values["max-instances"] ?? DEFAULTS.maxInstances),

      compatibilityDate: ctx.values["compatibility-date"]
        ? String(ctx.values["compatibility-date"])
        : undefined,

      entry: ctx.values.entry ? String(ctx.values.entry) : undefined,
    };

    await runInit(opts);
  },
});

async function runInit(opts: InitOptions) {
  const cwd = process.cwd();
  const prompter = createPrompter(opts.yes);

  const wranglerPath = path.join(cwd, "wrangler.jsonc");
  if (!fs.existsSync(wranglerPath)) {
    logError(`wrangler.jsonc not found: ${wranglerPath}`);
    logInfo("This CLI is designed for existing Workers projects with wrangler.jsonc.");
    process.exitCode = 1;
    return;
  }

  const wrangler = readWranglerJsonc(wranglerPath);
  if (!wrangler.data || typeof wrangler.data !== "object") {
    logError("Failed to parse wrangler.jsonc (it might be invalid JSONC).");
    process.exitCode = 1;
    return;
  }

  const plan: { created: string[]; updated: string[]; skipped: string[]; notes: string[] } = {
    created: [],
    updated: [],
    skipped: [],
    notes: [],
  };

  // 1) Dockerfile
  pushResult(plan, await ensureDockerfileFromImagePath(cwd, opts, prompter));

  // 2) .gitignore
  pushResult(plan, updateGitignore(cwd, opts));

  // 3) src/__generated__/
  pushResult(plan, ensureGeneratedDir(cwd, opts));

  // 4) wrangler.jsonc merge (never touch name/main)
  pushResult(
    plan,
    await writeWranglerJsoncForExistingProject(wranglerPath, wrangler, opts, prompter),
  );

  // 5) Inject export into entry (do not prompt for main; infer or skip)
  const entry = resolveEntryFile(cwd, wrangler.data, opts);
  if (!entry) {
    plan.skipped.push("(entry) export injection (could not determine entry file)");
    plan.notes.push(
      `Could not determine an entry file, so export injection was skipped. If needed, manually export ${opts.className}.`,
    );
  } else {
    pushResult(plan, ensureEntryExportsDo(cwd, entry, opts));
  }

  prompter.close();
  printSummary(plan, opts);
  printReminders(cwd);
}

/** ---------- Actions ---------- */

async function ensureDockerfileFromImagePath(cwd: string, opts: InitOptions, prompter: Prompter) {
  const dockerfileRel = normalizePathLike(opts.image);
  const dockerfileAbs = path.resolve(cwd, dockerfileRel);
  const dockerDir = path.dirname(dockerfileAbs);
  ensureDir(dockerDir);

  const relDisplay = path.relative(cwd, dockerfileAbs).replace(/\\/g, "/");
  const beforeExists = fs.existsSync(dockerfileAbs);

  const content = [
    "# create-nodejs-fn container image",
    "# Generated by `create-nodejs-fn init`. The build step will refresh this file.",
    "FROM node:20-slim",
    "WORKDIR /app",
    "RUN corepack enable",
    "",
    "# Dependencies are injected via the generated package.json during build.",
    "COPY package.json ./",
    "RUN pnpm install --prod --no-frozen-lockfile",
    "",
    "# The server bundle is generated at build time.",
    "COPY ./server.mjs ./server.mjs",
    "ENV NODE_ENV=production",
    "EXPOSE 8080",
    'CMD ["node", "./server.mjs"]',
    "",
  ].join("\n");

  if (beforeExists && !opts.force) {
    const existing = fs.readFileSync(dockerfileAbs, "utf8");
    if (existing === content) return { status: "skipped" as const, file: relDisplay };

    const overwrite = await prompter.confirm(`${relDisplay} already exists. Overwrite it?`, false);
    if (!overwrite) return { status: "skipped" as const, file: relDisplay };
  }

  if (!opts.dryRun) writeFileIfChanged(dockerfileAbs, content);
  return { status: beforeExists ? "updated" : "created", file: relDisplay } as const;
}

function updateGitignore(cwd: string, opts: InitOptions) {
  const target = path.join(cwd, ".gitignore");
  const beforeExists = fs.existsSync(target);
  const existing = beforeExists ? fs.readFileSync(target, "utf8").split(/\r?\n/) : [];

  const block = [
    "# create-nodejs-fn",
    ".create-nodejs-fn/*",
    "!.create-nodejs-fn/Dockerfile",
    "src/__generated__",
  ];

  const lines = [...existing];
  const present = new Set(lines);
  const missing = block.filter((line) => !present.has(line));
  const changed = missing.length > 0;

  if (!changed) return { status: "skipped" as const, file: ".gitignore" };

  if (lines.length && lines[lines.length - 1] !== "") lines.push("");
  for (const line of block) if (!present.has(line)) lines.push(line);

  const cleaned = trimBlankDuplicates(lines).join("\n");
  const next = cleaned.endsWith("\n") ? cleaned : `${cleaned}\n`;

  if (!opts.dryRun) fs.writeFileSync(target, next);
  return { status: beforeExists ? "updated" : "created", file: ".gitignore" } as const;
}

function ensureGeneratedDir(cwd: string, opts: InitOptions) {
  const dir = path.join(cwd, "src", "__generated__");
  const rel = "src/__generated__/";
  if (fs.existsSync(dir)) return { status: "skipped" as const, file: rel };
  if (!opts.dryRun) ensureDir(dir);
  return { status: "created" as const, file: rel };
}

async function writeWranglerJsoncForExistingProject(
  wranglerPath: string,
  read: WranglerReadResult,
  opts: InitOptions,
  prompter: Prompter,
) {
  const before = read.data;

  const merged = mergeWranglerConfigExisting(before, {
    className: opts.className,
    binding: opts.binding,
    image: opts.image,
    maxInstances: opts.maxInstances,
  });

  const nextBody = JSON.stringify(merged, null, 2);
  const next = `${nextBody}\n`;

  const beforeBody = JSON.stringify(before, null, 2);
  if (beforeBody === nextBody) return { status: "skipped" as const, file: "wrangler.jsonc" };

  // This implementation cannot preserve JSONC comments; confirm unless forced/non-interactive.
  if (read.hasJsoncComments && !opts.force && !opts.yes) {
    const ok = await prompter.confirm(
      "wrangler.jsonc contains comments. This CLI cannot preserve JSONC comments and will rewrite it as JSON. Continue?",
      false,
    );
    if (!ok) return { status: "skipped" as const, file: "wrangler.jsonc" };
  }

  if (!opts.dryRun) writeFileIfChanged(wranglerPath, next);
  return { status: "updated" as const, file: "wrangler.jsonc" };
}

function mergeWranglerConfigExisting(
  base: any,
  params: {
    className: string;
    binding: string;
    image: string;
    maxInstances: number;
  },
) {
  const out: any = { ...base };

  // containers: upsert by class_name
  const containers = Array.isArray(out.containers) ? [...out.containers] : [];
  const idx = containers.findIndex((c) => c?.class_name === params.className);
  const entry = {
    class_name: params.className,
    image: normalizePathLike(params.image),
    max_instances: params.maxInstances,
  };
  if (idx >= 0) containers[idx] = { ...containers[idx], ...entry };
  else containers.push(entry);
  out.containers = containers;

  // durable_objects.bindings: upsert by name
  const durable =
    typeof out.durable_objects === "object" && out.durable_objects !== null
      ? { ...out.durable_objects }
      : {};
  const bindings = Array.isArray(durable.bindings) ? [...durable.bindings] : [];
  const bidx = bindings.findIndex((b) => b?.name === params.binding);
  const be = { name: params.binding, class_name: params.className };
  if (bidx >= 0) bindings[bidx] = { ...bindings[bidx], ...be };
  else bindings.push(be);
  durable.bindings = bindings;
  out.durable_objects = durable;

  // migrations:
  // If the class is already declared (new_sqlite_classes or new_classes), do nothing.
  // Otherwise, append a new migration with a safe next tag.
  const migrations = Array.isArray(out.migrations) ? [...out.migrations] : [];
  const already =
    migrations.some(
      (m) =>
        Array.isArray(m?.new_sqlite_classes) && m.new_sqlite_classes.includes(params.className),
    ) ||
    migrations.some(
      (m) => Array.isArray(m?.new_classes) && m.new_classes.includes(params.className),
    );

  if (!already) {
    const tag = nextMigrationTag(migrations);
    migrations.push({ tag, new_sqlite_classes: [params.className] });
  }
  out.migrations = migrations;

  return out;
}

function ensureEntryExportsDo(cwd: string, entryRelInput: string, opts: InitOptions) {
  const entryRel = normalizeEntryRel(entryRelInput);
  const entryAbs = path.join(cwd, entryRel);
  ensureDir(path.dirname(entryAbs));

  const doAbs = path.join(cwd, "src", "__generated__", "create-nodejs-fn.do.ts");
  const doRel = path
    .relative(path.dirname(entryAbs), doAbs)
    .replace(/\\/g, "/")
    .replace(/\.ts$/, "");

  const exportLine = `export { ${opts.className} } from "${doRel.startsWith(".") ? doRel : `./${doRel}`}";`;
  const display = entryRel.replace(/\\/g, "/");

  const beforeExists = fs.existsSync(entryAbs);
  if (beforeExists) {
    const content = fs.readFileSync(entryAbs, "utf8");
    const already =
      content.includes(exportLine) ||
      content.match(
        new RegExp(
          `export\\s+\\{\\s*${escapeRegExp(opts.className)}\\s*\\}.*create-nodejs-fn\\.do`,
        ),
      );
    if (already) return { status: "skipped" as const, file: display };

    const next = content.endsWith("\n")
      ? `${content}${exportLine}\n`
      : `${content}\n${exportLine}\n`;
    if (!opts.dryRun) writeFileIfChanged(entryAbs, next);
    return { status: "updated" as const, file: display };
  }

  if (!opts.dryRun) writeFileIfChanged(entryAbs, `${exportLine}\n`);
  return { status: "created" as const, file: display };
}

/** ---------- Wrangler / Entry detection ---------- */

function readWranglerJsonc(filePath: string): WranglerReadResult {
  const raw = fs.readFileSync(filePath, "utf8");
  const hasJsoncComments = /\/\*[\s\S]*?\*\//.test(raw) || /(^|[^:])\/\/.*$/m.test(raw);

  // Best-effort JSONC stripping.
  const withoutBlock = raw.replace(/\/\*[\s\S]*?\*\//g, "");
  const withoutLine = withoutBlock.replace(/(^|[^:])\/\/.*$/gm, "$1");

  try {
    const data = JSON.parse(withoutLine);
    return { raw, data, hasJsoncComments };
  } catch {
    return { raw, data: null, hasJsoncComments };
  }
}

function resolveEntryFile(cwd: string, wrangler: any, opts: InitOptions): string | null {
  if (opts.entry) return opts.entry;

  const main = typeof wrangler?.main === "string" ? wrangler.main.trim() : "";
  if (main) return main;

  // Common entry candidates in existing projects.
  const candidates = [
    "src/index.ts",
    "src/index.tsx",
    "src/worker.ts",
    "src/worker.tsx",
    "src/main.ts",
    "src/main.tsx",
    "index.ts",
  ];

  for (const c of candidates) {
    if (fs.existsSync(path.join(cwd, c))) return c;
  }
  return null;
}

function normalizeEntryRel(input: string) {
  const s = input.startsWith("./") ? input.slice(2) : input;
  return s.replace(/\\/g, "/");
}

function normalizePathLike(input: string) {
  const s = input.trim();
  if (!s) return input;
  const withDot = s.startsWith("./") || s.startsWith("/") ? s : `./${s}`;
  return withDot.replace(/\\/g, "/");
}

function defaultCompatibilityDate() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = `${d.getUTCMonth() + 1}`.padStart(2, "0");
  const dd = `${d.getUTCDate()}`.padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function nextMigrationTag(migrations: any[]): string {
  const tags = new Set<string>();
  for (const m of migrations) if (m?.tag) tags.add(String(m.tag));

  const lastTag = migrations.length ? String(migrations[migrations.length - 1]?.tag ?? "") : "";
  const m = lastTag.match(/^v(\d+)$/);
  if (m) {
    let n = Number(m[1]) + 1;
    while (tags.has(`v${n}`)) n++;
    return `v${n}`;
  }

  // If tags aren't vN, fall back to cnfN.
  let i = 1;
  while (tags.has(`cnf${i}`)) i++;
  return migrations.length ? `cnf${i}` : "v1";
}

/** ---------- Prompter ---------- */

function createPrompter(skip: boolean): Prompter {
  if (skip || !process.stdin.isTTY) {
    return {
      confirm: async (_message, defaultValue = false) => defaultValue,
      close: () => {},
    };
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    async confirm(message, defaultValue = false) {
      const suffix = defaultValue ? " [Y/n] " : " [y/N] ";
      const answer = (await rl.question(`${message}${suffix}`)).trim().toLowerCase();
      if (!answer) return defaultValue;
      return answer.startsWith("y");
    },
    close() {
      rl.close();
    },
  };
}

/** ---------- Reporting ---------- */

function pushResult(
  plan: { created: string[]; updated: string[]; skipped: string[]; notes: string[] },
  r: { status: "created" | "updated" | "skipped"; file: string },
) {
  if (r.status === "created") plan.created.push(r.file);
  else if (r.status === "updated") plan.updated.push(r.file);
  else plan.skipped.push(r.file);
}

function printSummary(
  plan: { created: string[]; updated: string[]; skipped: string[]; notes: string[] },
  opts: InitOptions,
) {
  const header = opts.dryRun
    ? "🧪 Dry run: previewing changes"
    : "✅ create-nodejs-fn: setup complete";
  console.log(`\n${header}`);

  const printBlock = (title: string, items: string[]) => {
    if (!items.length) return;
    console.log(`\n${title}`);
    for (const it of items) console.log(`  - ${it}`);
  };

  printBlock("Created", plan.created);
  printBlock("Updated", plan.updated);
  printBlock("Skipped", plan.skipped);

  if (plan.notes.length) {
    console.log("\nNotes");
    for (const n of plan.notes) console.log(`  - ${n}`);
  }

  console.log("");
}

function printReminders(cwd: string) {
  const pkgPath = path.join(cwd, "package.json");
  const pkg = fs.existsSync(pkgPath) ? safeJsonRead(pkgPath) : null;

  // Vite reminder
  const viteConfig = findFirstExisting(cwd, [
    "vite.config.ts",
    "vite.config.js",
    "vite.config.mjs",
    "vite.config.cjs",
  ]);

  if (viteConfig) {
    const raw = fs.readFileSync(viteConfig, "utf8");
    const hasPlugin = raw.includes("createNodejsFnPlugin");
    if (!hasPlugin) {
      console.log(
        "📌 Reminder: If you use Vite, add the plugin to your Vite config (not detected).",
      );
      console.log('  import { createNodejsFnPlugin } from "create-nodejs-fn";');
      console.log("  export default defineConfig({ plugins: [createNodejsFnPlugin()] });\n");
    }
  } else {
    console.log("📌 Reminder: If you use Vite, add the plugin to your Vite config.");
    console.log('  import { createNodejsFnPlugin } from "create-nodejs-fn";');
    console.log("  export default defineConfig({ plugins: [createNodejsFnPlugin()] });\n");
  }

  // Dependencies reminder
  const missing: string[] = [];
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };

  if (!deps["@cloudflare/containers"]) missing.push("@cloudflare/containers");
  if (!deps["capnweb"]) missing.push("capnweb@0.2.0");

  if (missing.length) {
    const pm = detectPackageManager(cwd, pkg);
    console.log("📌 Reminder: Install required dependencies for Workers containers.");
    console.log(`  ${pm} add ${missing.join(" ")}\n`);
  }
}

function safeJsonRead(p: string) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function findFirstExisting(cwd: string, files: string[]) {
  for (const f of files) {
    const abs = path.join(cwd, f);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

function detectPackageManager(cwd: string, pkg: any) {
  const pmField = typeof pkg?.packageManager === "string" ? pkg.packageManager : "";
  if (pmField.startsWith("pnpm")) return "pnpm";
  if (pmField.startsWith("yarn")) return "yarn";
  if (pmField.startsWith("bun")) return "bun";

  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(cwd, "bun.lockb"))) return "bun";
  return "npm";
}

/** ---------- Small utils ---------- */

function trimBlankDuplicates(lines: string[]) {
  const out: string[] = [];
  for (const line of lines) {
    if (line === "" && out.length > 0 && out[out.length - 1] === "") continue;
    out.push(line);
  }
  return out;
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function logInfo(msg: string) {
  console.log(`ℹ️  ${msg}`);
}
function logError(msg: string) {
  console.error(`✖ ${msg}`);
}

async function main() {
  await cli(process.argv.slice(2), initCommand, {
    name: "create-nodejs-fn",
    version: VERSION,
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
