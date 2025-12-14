import fs from "node:fs";
import path from "node:path";
import { globSync } from "glob";
import type { SourceFile } from "ts-morph";
import type { Plugin, ResolvedConfig, ViteDevServer } from "vite";

import { buildContainerServer } from "./build-container-server";
import { ARTIFACTS_DIR_NAME, GENERATED_FILENAMES } from "./constants";
import { extractExports } from "./extractors";
import { ensureDir } from "./fs-utils";
import { generateProxyFiles } from "./generate-proxy-files";
import { generateRuntime } from "./generate-runtime";
import { generateStubBatch } from "./generate-stub-batch";
import { generateWorkerFiles } from "./generate-worker-files";
import { proxyFilePath, sanitizeNamespace } from "./path-utils";
import { makeProject } from "./project-utils";
import type { DiscoveredModule, Opts, RegenKind } from "./types";

export function createNodejsFnPlugin(opts: Opts = {}): Plugin {
  const files = opts.files ?? ["src/**/*.container.ts"];
  const generatedDir = opts.generatedDir ?? "src/__generated__";
  const binding = opts.binding ?? "NODEJS_FN";
  const className = opts.className ?? "NodejsFnContainer";
  const containerPort = opts.containerPort ?? 8080;
  const external = opts.external ?? [];
  const docker = opts.docker ?? {};
  const workerEnvVars = opts.workerEnvVars ?? [];
  const autoRebuildContainers = opts.autoRebuildContainers ?? true;
  const rebuildDebounceMs = opts.rebuildDebounceMs ?? 600;

  let root = process.cwd();
  let outDir = "dist";
  let config: ResolvedConfig | null = null;
  let devServer: ViteDevServer | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let restartingDevServer = false;
  let serveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  const pendingChanged = new Set<string>();
  const pendingRemoved = new Set<string>();
  let pendingForce = false;
  let pendingReason: string | null = null;

  const project = makeProject();
  const moduleCache = new Map<string, DiscoveredModule>(); // abs path -> module info
  const containerFiles = new Set<string>();
  let regenQueue: Promise<void> = Promise.resolve();
  let generatedOnce = false;

  function discoverFileList() {
    const patterns = files;
    const absFiles = patterns.flatMap((p) => globSync(p, { cwd: root, absolute: true }));
    absFiles.forEach((f) => {
      containerFiles.add(path.normalize(f));
    });
    return absFiles;
  }

  function loadSourceFile(fileAbs: string): SourceFile | undefined {
    const existing = project.getSourceFile(fileAbs);
    if (existing) {
      existing.refreshFromFileSystemSync();
      return existing;
    }
    if (fs.existsSync(fileAbs)) {
      return project.addSourceFileAtPath(fileAbs);
    }
    return undefined;
  }

  function refreshModules(changed?: string[], removed?: string[]) {
    let dirty = false;

    if (removed?.length) {
      for (const abs of removed) {
        moduleCache.delete(path.normalize(abs));
        const sf = project.getSourceFile(abs);
        if (sf) project.removeSourceFile(sf);
        containerFiles.delete(path.normalize(abs));
        dirty = true;
      }
    }

    const targets = changed?.length ? changed : Array.from(containerFiles);
    for (const absRaw of targets) {
      const abs = path.normalize(absRaw);
      if (!fs.existsSync(abs)) continue;
      const sf = loadSourceFile(abs);
      if (!sf) continue;
      const exportsWithKeys = extractExports(sf);
      const rel = path.relative(root, abs).replace(/\\/g, "/");
      const relNoExt = rel.replace(/\.[^.]+$/, "");
      if (exportsWithKeys.length === 0) {
        dirty = dirty || moduleCache.delete(abs);
        continue;
      }
      const mod: DiscoveredModule = {
        fileAbs: abs,
        fileRelFromRoot: rel,
        namespace: sanitizeNamespace(relNoExt),
        exports: exportsWithKeys,
      };
      const prev = moduleCache.get(abs);
      const changedJson = JSON.stringify(prev) !== JSON.stringify(mod);
      if (changedJson || !prev) {
        moduleCache.set(abs, mod);
        dirty = true;
      }
    }

    return dirty;
  }

  async function regenerate(
    kind: RegenKind,
    delta?: { changed?: string[]; removed?: string[]; force?: boolean },
  ) {
    if (!generatedOnce) {
      discoverFileList();
    }

    const dirty = refreshModules(delta?.changed, delta?.removed) || delta?.force || !generatedOnce;
    const mods = Array.from(moduleCache.values()).sort((a, b) =>
      a.namespace.localeCompare(b.namespace),
    );

    if (!dirty && generatedOnce) {
      return;
    }

    const gdirAbs = path.join(root, generatedDir);
    ensureDir(gdirAbs);

    generateRuntime(gdirAbs, GENERATED_FILENAMES.runtime);
    generateStubBatch(gdirAbs, GENERATED_FILENAMES.stubBatch);
    generateWorkerFiles({
      gdirAbs,
      mods,
      root,
      binding,
      className,
      containerPort,
      workerEnvVars,
      clientFileName: GENERATED_FILENAMES.client,
      doFileName: GENERATED_FILENAMES.durableObject,
      contextFileName: GENERATED_FILENAMES.context,
      stubBatchFileName: GENERATED_FILENAMES.stubBatch,
    });
    generateProxyFiles({
      gdirAbs,
      mods,
      root,
      generatedContextFileName: GENERATED_FILENAMES.context,
      generatedClientFileName: GENERATED_FILENAMES.client,
    });

    await buildContainerServer({
      mods,
      outBaseAbs: path.join(root, ARTIFACTS_DIR_NAME),
      dockerOpts: docker,
      containerPort,
      external,
      root,
    });
    if (kind === "build") {
      const distAbs = path.join(root, outDir);
      await buildContainerServer({
        mods,
        outBaseAbs: path.join(distAbs, ARTIFACTS_DIR_NAME),
        dockerOpts: docker,
        containerPort,
        external,
        root,
      });
    }

    generatedOnce = true;
  }

  function enqueueRegeneration(
    kind: RegenKind,
    delta?: { changed?: string[]; removed?: string[]; force?: boolean },
  ) {
    regenQueue = regenQueue
      .then(() => regenerate(kind, delta))
      .catch((err) => {
        console.error("[create-nodejs-fn] regeneration failed", err);
      });
    return regenQueue;
  }

  function scheduleContainerRebuild(reason: string) {
    if (!autoRebuildContainers) return;
    if (config?.command !== "serve") return;
    if (!devServer) return;
    if (restartingDevServer) return;

    const serverForRestart = devServer;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      regenQueue
        .then(async () => {
          if (restartingDevServer) return;
          restartingDevServer = true;
          try {
            serverForRestart?.config.logger?.info?.(
              `[create-nodejs-fn] Restarting Vite dev server to rebuild containers (${reason})`,
            );
            await serverForRestart?.restart();
          } catch (err) {
            console.error(
              "[create-nodejs-fn] failed to restart dev server for container rebuild",
              err,
            );
          } finally {
            restartingDevServer = false;
          }
        })
        .catch((err) => {
          console.error("[create-nodejs-fn] regeneration failed before restart", err);
        });
    }, rebuildDebounceMs);
  }

  function scheduleServeRegeneration(
    reason: string,
    delta: { changed?: string[]; removed?: string[]; force?: boolean },
  ) {
    delta.changed?.map((p) => pendingChanged.add(path.normalize(p)));
    delta.removed?.map((p) => pendingRemoved.add(path.normalize(p)));
    if (delta.force) pendingForce = true;
    pendingReason = reason;

    if (serveDebounceTimer) clearTimeout(serveDebounceTimer);
    serveDebounceTimer = setTimeout(() => {
      serveDebounceTimer = null;
      const changed = pendingChanged.size ? Array.from(pendingChanged) : undefined;
      const removed = pendingRemoved.size ? Array.from(pendingRemoved) : undefined;
      const force = pendingForce;
      pendingChanged.clear();
      pendingRemoved.clear();
      pendingForce = false;

      enqueueRegeneration("serve", { changed, removed, force });
      const reasonText = pendingReason ?? "changes";
      pendingReason = null;
      scheduleContainerRebuild(reasonText);
    }, rebuildDebounceMs);
  }

  return {
    name: "vite-plugin-create-nodejs-fn",
    enforce: "pre",

    config(userConfig) {
      if (!external.length) return;
      const cur = userConfig.optimizeDeps?.exclude ?? [];
      const merged = Array.from(new Set([...cur, ...external]));
      return { optimizeDeps: { exclude: merged } };
    },

    configResolved(c) {
      config = c;
      root = c.root;
      outDir = c.build.outDir || "dist";
    },

    async buildStart() {
      await enqueueRegeneration("serve");
    },

    async closeBundle() {
      await enqueueRegeneration("build");
    },

    async resolveId(id, importer, options) {
      const r = await this.resolve(id, importer, {
        ...options,
        skipSelf: true,
      });
      const resolved = r?.id?.split("?")[0];
      if (!resolved || !resolved.endsWith(".container.ts")) return null;

      const gdirAbs = path.join(root, generatedDir);
      const proxyPath = proxyFilePath(gdirAbs, resolved);

      if (!fs.existsSync(proxyPath)) {
        await enqueueRegeneration(config?.command === "build" ? "build" : "serve", {
          changed: [resolved],
          force: true,
        });
      }

      return proxyPath;
    },

    configureServer(server) {
      devServer = server;
      const patterns = files.map((g) => path.join(root, g));
      server.watcher.add(patterns);

      const onAddOrChange = (p: string) => {
        if (!p.endsWith(".container.ts")) return;
        containerFiles.add(path.normalize(p));
        scheduleServeRegeneration(`changed ${path.relative(root, p)}`, { changed: [p] });
      };
      const onUnlink = (p: string) => {
        if (!p.endsWith(".container.ts")) return;
        scheduleServeRegeneration(`removed ${path.relative(root, p)}`, { removed: [p] });
      };

      server.watcher.on("add", onAddOrChange);
      server.watcher.on("change", onAddOrChange);
      server.watcher.on("unlink", onUnlink);
    },
  };
}
