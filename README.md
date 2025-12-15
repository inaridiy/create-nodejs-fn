# Create NodeJS Fn


> **⚡ A crazy Vite plugin that lets you transparently call Node.js native code from Cloudflare Workers**

**🚨 WARNING: This project uses INSANE black magic! DO NOT use in production!! 🚨**


## 🤯 What is this?

Cloudflare Workers are amazing, but they run on the V8 JavaScript engine—**not Node.js**. This means native modules (binary addons compiled with node-gyp) simply don't work. Want to use `@napi-rs/canvas` for image generation, `sharp` for image processing, or `pdfjs-dist` with canvas rendering? You're out of luck...

**...or are you?** 🔥

`create-nodejs-fn` bridges this gap by leveraging **Cloudflare Containers** (currently in beta). Here's how it works:

1. **You write functions in `*.container.ts` files** using any Node.js native modules you want
2. **The Vite plugin analyzes your code** using `ts-morph` (TypeScript AST manipulation)
3. **It auto-generates type-safe proxy functions** that look identical to your original exports
4. **Your container code is bundled with esbuild** and packaged into a Docker image
5. **At runtime, the proxy transparently routes calls** via Cap'n Proto RPC to the container
6. **Cloudflare Durable Objects manage container lifecycle** and connection state

The result? You `import { myFunction } from "./native.container"` and call it like any normal function—but it actually executes inside a Docker container running full Node.js with native module support!

![alt](./assets/black-magic.jpg)

## 🎮 Live Demo

**Try it now!** This example uses `@napi-rs/canvas` + `pdfjs-dist` to render PDF pages as images:

👉 **[Render Bitcoin Whitepaper (Page 1)](https://example-create-nodejs-fn.inaridiy.workers.dev/renderPdf?url=https://bitcoin.org/bitcoin.pdf&pageNum=1&scale=3)**

```
https://example-create-nodejs-fn.inaridiy.workers.dev/renderPdf?url=https://bitcoin.org/bitcoin.pdf&pageNum=1&scale=3
```

Yes, this is running on Cloudflare Workers. Yes, it's using native Node.js modules. Yes, it's black magic. 

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


## 🪄 The Black Magic Revealed

### 1️⃣ Extract `nodejsFn` Contents (Clip & Crop)

The plugin uses `ts-morph` to **statically analyze** `*.container.ts` files and **extracts the function bodies** wrapped in `nodejsFn()`.

```typescript
// Your code (clock.container.ts)
export const renderClock = nodejsFn(async () => {
  const canvas = createCanvas(600, 200);
  // ... Node.js native processing
  return pngDataUrl;
});

// 🧙 Plugin extracts the inner function from nodejsFn()
// → Only the function body is clipped out for the container!
```

### 2️⃣ Bundle & Build Docker Image

The extracted functions are **bundled with esbuild** and combined with an auto-generated **Dockerfile** to create a Docker image.

- Functions are bundled as a Cap'n Proto RPC server
- Native dependencies specified in `external` are auto-extracted to `package.json`
- Dockerfile is auto-generated and image is built

### 3️⃣ Deploy as Cloudflare Containers

The generated Docker image is **bundled as Cloudflare Containers**, with **Durable Objects** managing the container lifecycle.

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

### 4️⃣ Auto-Replace Imports with Container Calls

Imports to `*.container.ts` files are **automatically replaced with proxy module imports** by the Vite plugin.

```typescript
// Your code
import { renderClock } from "./clock.container";

// 🧙 Plugin auto-transforms this!
// → Actually imports a generated proxy function
// → Calls are transparently converted to Container RPC!
// → Types are fully preserved! IDE autocomplete works!
```

**Result**: Code that looks like normal function calls actually executes inside Docker containers!


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
│       ├── create-nodejs-fn.ts            # RPC client & type definitions
│       ├── create-nodejs-fn.do.ts         # Durable Object class
│       ├── create-nodejs-fn.context.ts    # Container key resolution
│       ├── create-nodejs-fn.runtime.ts    # nodejsFn / containerKey helpers
│       ├── create-nodejs-fn-stub-batch.ts # Cap'n Proto RPC batch client
│       └── __proxies__/
│           └── p-XXXXXXXX.ts              # Proxy functions (hashed)
│
└── .create-nodejs-fn/            # 🐳 Container build artifacts
    ├── Dockerfile                # Auto-generated
    ├── container.entry.ts        # Server entry (generated)
    ├── server.mjs                # Bundled with esbuild
    └── package.json              # Only external deps extracted
```

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
