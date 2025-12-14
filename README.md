# Create NodeJS Fn


> **⚡ A crazy Vite plugin that lets you transparently call Node.js native code from Cloudflare Workers**

**🚨 WARNING: This project uses INSANE black magic! DO NOT use in production!! 🚨**

---

## 🤯 What is this?

Cloudflare Workers are amazing, but they can't run Node.js native modules (binary addons).
Want to use `@napi-rs/canvas`, `sharp`, or `pdfjs-dist`? Too bad...?

**Nope. We don't give up that easily.** 🔥

`create-nodejs-fn` uses the following dark arts to make the impossible possible:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        🌐 Cloudflare Workers                                │
│                                                                             │
│   import { renderClock } from "./clock.container";                          │
│                          ↓                                                  │
│   // 😱 Looks like a normal function call, right?                           │
│   const image = await renderClock();                                        │
│   // But actually...                                                        │
│                          ↓                                                  │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  🧙 Auto-generated proxy (ts-morph AST magic)                       │   │
│   │  → Transforms to RPC client while preserving type info              │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                          ↓                                                  │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  📦 capnweb RPC (Cap'n Proto based. Fast. Really fast.)            │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                          ↓                                                  │
└─────────────────────────────────────────────────────────────────────────────┘
                           ↓ HTTP over Cloudflare Containers
┌─────────────────────────────────────────────────────────────────────────────┐
│                     🐳 Docker Container (Node.js)                           │
│                                                                             │
│   import { createCanvas } from "@napi-rs/canvas";                           │
│                                                                             │
│   // 🎨 Native modules running wild!!                                       │
│   const canvas = createCanvas(400, 200);                                    │
│   const ctx = canvas.getContext("2d");                                      │
│   ctx.font = "48px 'Noto Sans JP'";                                         │
│   ctx.fillText(new Date().toISOString(), 10, 100);                          │
│   return canvas.toDataURLAsync("image/png");                                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 🪄 The Black Magic Revealed

### 1️⃣ Transparent Proxy Generation via AST Transformation

Uses `ts-morph` to **statically analyze** `*.container.ts` files.
Detects exported functions and **auto-generates proxy functions with identical type signatures**.

```typescript
// Your code (clock.container.ts)
export const renderClock = nodejsFn(async () => {
  // Node.js native processing...
  return pngDataUrl;
});

// 🧙 The plugin auto-generates a proxy
// → Types fully preserved! IDE autocomplete works!
// → Calls are routed to the container via RPC!
```

### 2️⃣ Container Management via Durable Objects

Uses Cloudflare **Durable Objects** to manage container connections.
Stateful, with multi-instance routing support!

```typescript
// Route to specific instances with containerKey
export const renderClock = nodejsFn(
  async () => { /* ... */ },
  containerKey(({ args }) => {
    // Route to containers based on arguments! Load balancing!
    return `instance-${Math.floor(Math.random() * 3)}`;
  })
);
```

### 3️⃣ Fully Automated Build with esbuild + Docker

- Bundles container server code with **esbuild**
- **Auto-generates Dockerfile**
- Native deps specified in `external` are auto-extracted to `package.json`

---

## 🚀 Quick Start

### Prerequisites

You need a **Cloudflare Workers + Vite** project. Create one with:

```bash
# Using Hono (recommended)
pnpm create hono@latest my-app --template cloudflare-workers+vite

# Then cd into it
cd my-app
```

### 1. Install dependencies

```bash
pnpm add create-nodejs-fn @cloudflare/containers capnweb@0.2.0 @napi-rs/canvas
```

### 2. Initialize config

```bash
pnpm create-nodejs-fn init
```

This configures:
- Adds Containers & Durable Objects config to `wrangler.jsonc`
- Generates `.create-nodejs-fn/Dockerfile`
- Creates `src/__generated__/` directory
- Adds DO export to entry file

### 3. Configure Vite plugin

```typescript
// vite.config.ts
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import { createNodejsFnPlugin } from "create-nodejs-fn";

export default defineConfig({
  plugins: [
    createNodejsFnPlugin({
      // Native dependencies to install in the container
      external: ["@napi-rs/canvas"],
      // Docker config with fonts for text rendering
      docker: {
        baseImage: "node:20-bookworm-slim",
        systemPackages: [
          "fontconfig",
          "fonts-noto-core",
          "fonts-noto-cjk",
          "fonts-noto-color-emoji",
        ],
      },
    }),
    cloudflare(),
  ],
});
```

### 4. Write a container function

```typescript
// src/clock.container.ts
import { createCanvas } from "@napi-rs/canvas";
import { nodejsFn } from "./__generated__/create-nodejs-fn.runtime";

export const renderClock = nodejsFn(async () => {
  // 🎨 Create an image with current time using @napi-rs/canvas!
  const canvas = createCanvas(600, 200);
  const ctx = canvas.getContext("2d");

  // Background
  ctx.fillStyle = "#1a1a2e";
  ctx.fillRect(0, 0, 600, 200);

  // Text with Noto font (installed via systemPackages)
  ctx.font = "bold 36px 'Noto Sans CJK JP', 'Noto Color Emoji', sans-serif";
  ctx.fillStyle = "#eee";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const now = new Date().toISOString();
  ctx.fillText(`🕐 ${now}`, 300, 100);

  // Return as PNG data URL
  return await canvas.toDataURLAsync("image/webp");
});
```

### 5. Call it from your Worker like any normal function

```typescript
// src/index.ts
import { Hono } from "hono";
import { renderClock } from "./clock.container";

const app = new Hono();

app.get("/clock", async (c) => {
  // 😱 Looks like a normal function call!
  // But behind the scenes, RPC flies to the container!
  const pngDataUrl = await renderClock();

  // Convert data URL to response
  return fetch(pngDataUrl);
});

// Don't forget to export the DO
export { NodejsFnContainer } from "./__generated__/create-nodejs-fn.do";
export default { fetch: app.fetch };
```

### 6. Launch!

```bash
pnpm dev
```

Visit `http://localhost:5173/clock` to see a dynamically generated image with the current timestamp! 🎉

---

## ⚙️ Plugin Options

```typescript
createNodejsFnPlugin({
  // File patterns for container functions (default: ["src/**/*.container.ts"])
  files: ["src/**/*.container.ts"],
  
  // Output directory for generated files (default: "src/__generated__")
  generatedDir: "src/__generated__",
  
  // Durable Object binding name (default: "NODEJS_FN")
  binding: "NODEJS_FN",
  
  // Container class name (default: "NodejsFnContainer")
  className: "NodejsFnContainer",
  
  // Container port (default: 8080)
  containerPort: 8080,
  
  // External dependencies to install in container
  external: ["@napi-rs/canvas", "sharp"],
  
  // Docker image settings
  docker: {
    baseImage: "node:20-bookworm-slim",
    systemPackages: [
      "fontconfig",
      "fonts-noto-core",
      "fonts-noto-cjk",
      "fonts-noto-color-emoji",
    ],
    preInstallCommands: [],
    postInstallCommands: [],
    env: { MY_VAR: "value" },
  },
  
  // Environment variables to pass from Worker to Container
  workerEnvVars: ["API_KEY", "SECRET"],
  
  // Auto-rebuild on file changes (default: true)
  autoRebuildContainers: true,
  
  // Rebuild debounce time (default: 600ms)
  rebuildDebounceMs: 600,
});
```

---

## 🏗️ Internal Architecture

```
project/
├── src/
│   ├── clock.container.ts        # Your code
│   ├── index.ts                  # Worker entry
│   └── __generated__/            # 🧙 Auto-generated magic
│       ├── create-nodejs-fn.ts         # RPC client & type definitions
│       ├── create-nodejs-fn.do.ts      # Durable Object class
│       ├── create-nodejs-fn.context.ts # Container key resolution
│       ├── create-nodejs-fn.runtime.ts # nodejsFn / containerKey helpers
│       └── proxy.src__clock.container.ts # Proxy functions
│
└── .create-nodejs-fn/            # 🐳 Container build artifacts
    ├── Dockerfile                # Auto-generated
    ├── container.entry.ts        # Server entry (generated)
    ├── server.mjs                # Bundled with esbuild
    └── package.json              # Only external deps extracted
```

---

## 🔮 Black Magic Catalog

| Magic | Description |
|-------|-------------|
| **ts-morph** | Parses TypeScript AST for code generation. Preserves full type information. |
| **esbuild** | Blazing fast bundler. Generates container code in an instant. |
| **capnweb** | Cap'n Proto-based RPC. Zero-copy serialization = fast. |
| **Cloudflare Containers** | Operate Docker containers from Workers. Paired with Durable Objects. |
| **Vite Plugin API** | Hijacks imports via `resolveId` hook and swaps them with proxies. |

---

## ⚠️ Limitations & Caveats

- **Not for production**: This is an experimental project
- Requires **Cloudflare Containers** (currently in beta)
- Function arguments and return values must be **serializable**
- Container cold starts exist (adjust with `sleepAfter`)
- Debugging is hard (check your logs if something breaks)

---

## 📝 License

MIT

---

## 🙏 Acknowledgments

- [Cloudflare Workers](https://workers.cloudflare.com/) - The future of edge computing
- [Cloudflare Containers](https://developers.cloudflare.com/containers/) - The tech that made this madness possible
- [@napi-rs/canvas](https://github.com/Brooooooklyn/canvas) - Canvas in Node.js, what a time to be alive
- [ts-morph](https://github.com/dsherret/ts-morph) - The godly TypeScript AST manipulation library
- [capnweb](https://github.com/nicoco007/capnweb) - Lightning-fast RPC

---

<p align="center">
  <strong>🧙‍♂️ Use at your own risk. Welcome to the world of insane black magic. 🧙‍♂️</strong>
</p>
