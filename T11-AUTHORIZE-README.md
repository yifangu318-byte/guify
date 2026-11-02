# T11 authorize endpoint — local implementation only

Status: LOCAL ONLY, 2026-11-02. Not merged, not deployed, no PR,
no Cloudflare or Partner Center change, no real credential used.
Working copy: ~/workspace/muse-erp-authorize/ (copy of muse-erp-t10,
node_modules symlinked, no .git). Original ~/workspace/muse-erp-t10/
was not edited by this step.

## Endpoint
- `GET /api/tiktok/authorize?market=MY|PH|SG|TH|VN`
- Market required, allowlist exactly MY/PH/SG/TH/VN; anything else,
  blank, or array → 400 INVALID_REQUEST, no redirect.
- Missing/blank TOKEN_ENCRYPTION_KEY → 503 TOKEN_ENCRYPTION_KEY_MISSING.
- Missing/blank TIKTOK_SERVICE_ID → 503 SERVICE_ID_MISSING (new code).
- Does NOT read TIKTOK_APP_KEY / TIKTOK_APP_SECRET in this endpoint.
- Success: 302, Cache-Control: no-store, Location:
  `https://services.tiktokshop.com/open/authorize?service_id=<SERVICE_ID>&state=<STATE>`
  (ROW host only, never US host; no app_key, redirect_uri, scope, sign).
- State: reused `issueState(secret, { market })` only — purpose
  tiktok-oauth-state-v1, 10 min TTL, random nonce, NO shop_code in v1.
- Log: success logs `tiktok_authorize_issued` + market only; errors log
  event names only. Never logs state, Service ID, or full redirect URL.
- Not a Gateway/MCP tool. Callback /api/tiktok/callback unchanged.

## Files changed in this copy
- src/app.ts — TiktokRuntime.getServiceId + GET /api/tiktok/authorize route.
- workers/entry.js — getServiceId: () => env.TIKTOK_SERVICE_ID + comment
  (Dashboard variable, no value in code).
- test/t11-authorize.test.ts — 7 new tests (synthetic values only).

## Verification
- Baseline in this copy before change: 348/348 pass.
- After change: 355/355 pass, fail 0 (348 existing + 7 new).
- npm run build: pass (tsc exit 0).

## Still required before production use (separate, approved step)
- User adds TIKTOK_SERVICE_ID to Worker env on own device (Dashboard
  Variables, never through chat); without it the endpoint 503s by design.
- PR → user approval → merge (triggers production deploy) → smoke:
  /health 200, /api/tiktok/authorize?market=MY → 302 to
  services.tiktokshop.com with service_id/state present only,
  /api/tiktok/callback with no params → 400 INVALID_REQUEST.
