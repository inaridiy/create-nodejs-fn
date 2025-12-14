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

## ⚠️ Limitations & Caveats

- **Not for production**: This is an experimental project
- Requires **Cloudflare Containers** (currently in beta)
- Function arguments and return values must be **serializable**
- Container cold starts exist (adjust with `sleepAfter`)
- Debugging is hard (check your logs if something breaks)

---

## 📝 License

MIT
