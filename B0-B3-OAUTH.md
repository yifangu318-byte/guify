# B0–B3 OAuth lifecycle hardening

Local implementation based on main `59ea2edabce950d8f027e45aae7fb8256704d0cc`.
No production deployment, remote migration, Partner Center change, real authorization or paid service was performed.
This document supersedes the authorization implementation details in T10/T11 historical notes.

## Implemented behavior

- Authorization is disabled by default. `MUSE_ENV` must explicitly be `test`, `staging` or `production` AND `TIKTOK_OAUTH_ENABLED=true` before it can issue a state or exchange a code.
- `/api/tiktok/authorize` requires a strong administrator Bearer credential, an approved HTTPS host/origin and exact registered `shop_id` + `market`. Unknown or duplicate parameters fail closed.
- A Secure, HttpOnly, SameSite=Lax `__Host-muse_oauth` cookie binds the browser to a durable D1 session. HMAC verification alone does not authorize a callback. D1 atomically consumes the session before code exchange.
- Concurrent callbacks cannot exchange a code twice. A completed callback with the same browser, state and code replays only the saved safe result. Failed or uncertain attempts require a fresh authorization; they never release the consumed claim.
- Every successful exchange must contain an explicit success envelope, seller `user_type=0`, valid access/refresh strings, future absolute expiry timestamps, a seller `open_id` and granted scopes including `seller.authorization.info`.
- The callback always calls Get Authorized Shops, including when the token response contains shop IDs. It requires an exact shop ID + region match and nonempty cipher; duplicate IDs, missing fields, wrong market and ambiguous selection fail closed.
- A seller's app-specific `open_id` can be unknown at first enrollment. Omit `subjectId` only for that controlled first enrollment: a trusted operator still pre-registers the exact shop ID/market, the callback validates the seller token and official authorized-shop list, then pins the returned subject. Existing shop mappings cannot silently change subject. Where already known, configure `subjectId` to enforce it from the start.
- Verified authorizations and shops use new tables. Legacy `shop_tokens` remains intact and is never silently promoted. A verified seller authorization may serve multiple explicitly verified shops; unrelated seller authorizations are separate.
- Vault ciphertext uses AES-256-GCM, 32-byte hex keys, a version marker and authorization/token-purpose AAD. Existing legacy ciphertext functions remain available for explicitly controlled migration, but are not the new vault.
- `getValidAccessToken` is an internal lazy-refresh service, not an API returning tokens. It refreshes before expiry with D1 ownership/version CAS. There is no duplicate refresh across shops sharing an authorization. Expired leases are treated as uncertain upstream rotation and require reauthorization rather than stealing the old refresh token. A failed refresh can be repaired through a fresh explicit OAuth flow.
- HTTP fetch and body reads have an 8-second per-request deadline and a 1 MiB response limit. Redirects carrying credentials are rejected. Code exchange and refresh are never retried. Direct read-only shops requests retry only 429/502/503/504, at most twice with bounded delay. Failure does not invoke cross-host diagnostic probes.
- Relay remains optional and requires an explicitly pinned HTTPS origin plus a secret. Only the fixed shops operation can be forwarded. Relay requests are not retried. The relay service itself is outside this repository and has not been audited or verified.
- The public `/api/tiktok/diag-fetch` route is removed. Callback responses retain safe status/category/stage information, never upstream messages, bodies, URL signatures or credentials.

## Local verification

Use Node 24 and the lockfile. No production credentials or existing cloud database are required.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm test
npm run mcp:smoke
npm run worker:check
```

`npm test` and MCP smoke launch a child with an environment allowlist: no inherited account credentials or NODE_OPTIONS. The OAuth tests use synthetic credentials and actual ephemeral Miniflare D1, including all three migrations, SQL claims, rollback and CAS behavior. The original product/order/analytics/inspection/Gateway tests remain in place. Historical OAuth/probe tests asserting the former unsafe contracts were replaced with stricter contract and runtime tests; the final test count must be taken from the latest run, not computed as old tests plus new tests.

`worker:check` uses `wrangler.test.jsonc`, a synthetic local database ID, `--local`, and a dry-run only. It refuses common auto-loaded secret files. It verifies the existing HTTP smoke, concurrent health, protected authorization and removed diagnostics. Do not replace `--local` with `--remote` or remove `--dry-run` as part of verification.

## Configuration for a separately approved staging test

Do not put real values in source control or chat. Required secure/runtime configuration:

| Variable | Meaning |
|---|---|
| MUSE_ENV | Explicit environment; simulation cannot exchange codes |
| TIKTOK_OAUTH_ENABLED | Explicit feature switch; defaults false |
| PUBLIC_URL | Canonical HTTPS origin; host must match incoming authorization/callback requests |
| MUSE_OAUTH_ADMIN_TOKEN | Strong unique 32+ character Bearer credential, configured only in the trusted operator client |
| TOKEN_ENCRYPTION_KEY | 64 hex characters representing a random 32-byte key; do not replace an existing vault key without migration |
| TIKTOK_APP_KEY / TIKTOK_APP_SECRET | Application credentials, server-side only |
| TIKTOK_SERVICE_ID | Seller authorization service ID from the same app |
| TIKTOK_SHOP_TARGETS | JSON array of `{shopId, market, subjectId?}`; shopId is the exact TikTok Shop ID, not a seller ID/local shop code |
| DB | Dedicated environment D1 binding with schema version 3 |
| RELAY_URL / RELAY_SECRET / RELAY_ALLOWED_ORIGIN | Optional, independently reviewed and pinned relay; omit for direct mode |

The Node server still has no default D1 binding; the Worker injects the runtime DB and variables. This change does not provision any cloud resources. Use a separately approved staging binding rather than the production DB listed in the historical configuration. The test configuration is for local verification only, not a staging deployment template.

The GET authorization path and callback path are retained. An authenticated same-origin client can request `Accept: application/json` to receive an `authorization_url` while the cookie is set, then navigate the browser to it. Ordinary browser navigation without the operator credential cannot start authorization. Do not put an administrator credential in a query string or give it to an Agent. Production callers must use the canonical HTTPS origin so the Secure host-only cookie is sent on callback.

## Migration and recovery gate

`0003_oauth_lifecycle.sql` is additive and has not been applied remotely. It does not modify/drop/copy `shop_tokens`. No request handler runs CREATE/ALTER statements. Before code exchange, schema version/readiness and a durable session claim must succeed.

For a NEW isolated test database, tests apply 0001 → 0002 → 0003. For an EXISTING database that received earlier manual migrations, **do not blindly run the whole migrations directory**: first reconcile actual columns and the migration ledger. Rerunning 0002 can fail with duplicate column. The reviewed deployment procedure must apply 0003 exactly once after confirming the baseline. This is a future separately approved operation, not an instruction to run it now.

If saving fails after code exchange, the attempt is consumed and may be marked failed/processing; it never claims authorization succeeded. Start a fresh authorization. If refresh times out or its lease expires, the upstream rotation outcome is unknown, so the vault refuses use until reauthorization. If rollback is needed, disable OAuth and investigate; do not restore the former public authorization behavior or drop credential tables. Key rotation and conversion of legacy ciphertext require a separately reviewed migration; v1 does not automatically rotate keys.

## Official contract and remaining verification

Public official sources consulted:

- [Get Authorized Shops](https://partner.tiktokshop.com/docv2/page/6507ead7b99d5302be949ba9): seller token, official path, required content type and scopes.
- [Create your app](https://partner.us.tiktokshop.com/docv2/page/create-your-app): app and redirect configuration, code exchange and refresh endpoints.
- [Common parameters](https://partner.tiktokshop.com/docv2/page/common-parameters): token header and Unix-seconds signing timestamp.
- [Official signing example](https://github.com/tiktok/ttspc-server-sample/blob/main/src/utils/sign.ts): reference only, not copied wholesale.

Some Partner Center pages expose only a JavaScript shell. Full Seller refresh semantics and expiry-field definitions could not be completely verified from public documentation. The parser therefore has a deliberately narrow fail-closed contract for absolute `access_token_expire_in` / `refresh_token_expire_in`, numeric seller identity, open_id and granted scopes. Unsupported response shapes are rejected rather than assigned invented default lifetimes. These fixtures do not prove the real app returns the same shape. Exact token fields, scope policy, authorization URL, target markets and the app's effective settings must be checked before any real authorization test. The alternative FS scope is not automatically substituted for this implementation's explicit `seller.authorization.info` policy.

This delivery does not include real product/order reads, remote MCP, production scheduling, production key rotation or write operations. The existing seven simulation MCP tools continue to be simulation tools. Historical Worker TypeError resolution still requires a separately approved real authorization test; local mocks and Worker smoke cannot prove it fixed upstream.
