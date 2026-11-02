# Cloudflare Workers deployment

This repository is a Node 24 / TypeScript / Fastify server, not a static site.
HTML is rendered by the existing `/web/` routes. The dashboard project `guify`
uses Workers Builds, not Pages. Do not configure `dist` as static assets or use
`wrangler pages deploy`.

## Dashboard settings

| Setting | Value |
| --- | --- |
| Repository | `yifangu318-byte/guify` |
| Production branch | `main` (push only after production approval) |
| Root directory | `/` |
| Production Build command | `npm run build` (optional TypeScript compilation) |
| Production Deploy command | `npx wrangler deploy` |
| Preview baseline Build command | `npm run build` (optional TypeScript compilation) |
| Preview baseline deploy command | Default `npx wrangler preview` |
| Node | `24.x`, already specified by `package.json` |
| Static output directory / framework preset | Not applicable to this Worker |

Dependencies are installed from the lockfile by Workers Builds. Wrangler is
pinned locally. The Worker entry at `workers/entry.js` imports the TypeScript
modules directly; Wrangler bundles them, so Preview does not depend on the
separately compiled `dist/` directory. `npm run build` compiles the standalone
Node server and can be retained as an optional CI build step. Workers Builds
does not honor Wrangler's custom build section.

`dist/server.js` remains the standalone Node entry point. Wrangler generates
and uploads a Worker module bundle, not an HTML directory. No assets binding is
needed.

## Runtime adapter

The Worker reuses `buildApp` and Cloudflare's `httpServerHandler` bridge. The
Pino alias selects its Node implementation so Fastify's logger symbols and
existing redacting log stream work. Fastify boots at module startup, where
router code generation is supported. Only the Worker disables the plugin boot
timeout: timers cannot complete during module startup. Standalone Node retains
its original timeout and lifecycle. No business routes have been changed.

Compatibility date is pinned to `2026-10-30`, supported by the installed workerd.
Node compatibility and startup code generation are available on that date. The
empty `previews` block is required by `wrangler preview`, which Workers Builds
runs for non-production branches.

## Local verification (no upload)

```sh
npm ci
npm run build
npm test
npx wrangler deploy --dry-run --outdir .wrangler/dry-run
npx wrangler dev --local --ip 127.0.0.1 --port 8787
```

In another terminal:

```sh
node scripts/cloudflare-smoke.mjs
```

Inspect `dist/app.js`, `dist/server.js`, and `.wrangler/dry-run/entry.js`.
The smoke check verifies rendered HTML, health, authorization, error handling,
the callback placeholder, and concurrent reuse of the server.

No database, real shop credentials, or production environment is needed for
these checks. Existing demonstration data remains isolate-local and ephemeral.
The TikTok callback no longer returns the old 501 placeholder: T10 implements
state verification, App-credential checks, real code exchange (endpoint/signing
per third-party documentation, not yet officially verified), AES-256-GCM
encryption and D1 storage; see T10-README.md. Real OAuth, D1-backed token
persistence in production, and stdio MCP are not validated by this HTTP
deployment until a real authorization is completed and verified.
Keep secrets in Cloudflare secrets, not committed files. Configure public URL
and any real integrations separately when those features are implemented.

Do not retry the production build or push to the connected production branch
until the user approves deployment.

References:
- https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
- https://developers.cloudflare.com/workers/previews/configuration/
- https://developers.cloudflare.com/workers/wrangler/custom-builds/
- https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/
- https://developers.cloudflare.com/workers/configuration/compatibility-flags/
