# Real read-only synchronization

The public `/web/` pages remain explicitly simulation-only. `/live` uses the existing administrator credential in a same-origin Bearer header. Business responses require authentication, canonical HTTPS origin/host, an explicit shop allowlist, an active matching authorization, and the resource scope. Credentials stay in page memory, with no URL or local storage persistence. Source responses and stored snapshots omit buyer contacts, addresses, messages, tokens and ciphers.

## Release gate

- Apply **only** `migrations/d1/0004_live_snapshots.sql` after separately approving the production database change. The previously applied authorization migration is version 3. Do not rerun the earlier migrations.
- Set `MUSE_LIVE_READ_ENABLED=true` only after approving real read-only calls. Missing flag defaults to disabled. Environment must be `test`, `staging` or `production`.
- Deployment configuration preserves Dashboard-managed flags using `keep_vars`; only the release label is in `wrangler.jsonc`. It does not reset an existing OAuth enablement.
- No new scopes, credentials, cron jobs, or webhook permissions are installed automatically.
- Initial production check: allowlisted first store only; complete product query plus an explicit recent order creation window. A successful authorization alone does not establish product or order access.

## Endpoint contract

All APIs below require the existing `MUSE_OAUTH_ADMIN_TOKEN`. Values must never appear in command lines, logs or URLs.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/live/shops` | Safe readiness and allowlisted shop/resource permissions. No upstream calls. |
| `GET /api/live/shops/:shop_id/products` | Last sanitized product/SKU/warehouse-inventory snapshot or `data:null` if never synchronized. |
| `GET /api/live/shops/:shop_id/orders` | Last selected-window order snapshot, its exact window and synchronization timestamp. |
| `POST /api/live/shops/:shop_id/products/sync`, body `{}` | Populate the entire bounded product search result. |
| `POST /api/live/shops/:shop_id/orders/sync`, body `{start_at,end_at}` | Populate the explicit order-creation window `[start_at,end_at)`, Unix milliseconds aligned to seconds, maximum 31 days, no future end. |

GET does not refresh or contact TikTok. POST updates the local cache, using only the two hardcoded TikTok **read** queries below. There are no upstream business write endpoints or generic request-forwarding endpoints. Existing refresh logic may renew a nearly expired seller access token internally.

## Official references and field mapping

- [Search Products](https://partner.tiktokshop.com/docv2/page/6503081a56e2bb0289dd6d7d): inspected current official reference for `POST /product/202309/products/search`; scope `seller.product.basic`; `status:ALL`; query `page_size`, `page_token`, `shop_cipher`. Product identity/title/status, SKU identity/seller code, SKU currency, `tax_exclusive_price`, `sale_price`, warehouse inventory quantity. Cross-border tax-inclusive sale price stays separate from tax-exclusive price. Missing values remain null.
- [Get Order List](https://partner.tiktokshop.com/docv2/page/get-order-list-202309): `POST /order/202309/orders/search`; scope `seller.order.info`; `create_time_ge` and `create_time_lt` use seconds; use ascending creation-time pagination. Retain only ID/status/create/update times and payment currency/total amount.
- [Common parameters](https://partner.tiktokshop.com/docv2/page/common-parameters): seconds timestamp, HMAC sign, and seller access token in `x-tts-access-token`. The exact JSON body bytes are included in the candidate request signature; production success must verify the complete signing implementation before declaring the data connection working. Do not infer official verification from a unit-test vector alone.

API versions above are the versions inspected and implemented, not a claim that all resources have the same latest version. No returned numerical identifier is converted through JavaScript Number. Decimal money remains text. Platform statuses are retained as returned rather than forced into the older simulation enums.

## Storage and failure behavior

`live_snapshots` is keyed by app hash, shop ID and resource. It stores only projected business data plus timestamps/window/error category and a durable lease. A run is limited to 20 pages of 50 entries, 1,000 records, 512 KiB projected JSON, and a bounded upstream time budget. Snapshot size/count/response limits fail explicitly; partial pages never replace a successful snapshot. Repeated cursors, duplicate identities, missing arrays, and count mismatches are failures, not empty results. An explicit successful empty array is distinct from never synchronized.

Concurrent Workers acquire one 90-second lease per app/shop/resource and a 30-second attempt cooldown. Completion is fenced by owner and current authorization version. A stale run cannot overwrite the new owner's data or release its lease. Failure keeps the previous payload, success timestamp and order window, while separately recording the failed attempt. Neither a resource count nor an order total is a settlement metric. There is no cross-currency addition.

The page initially selects a seven-day order window in Asia/Shanghai time and requires a manual sync action. It displays source, exact creation window, last success time, and any subsequent failure. It renders business text using DOM text nodes. Authentication input changes, logout and page exit clear the current view; pending old responses cannot populate a different credential's page.

## Remaining boundaries

This stage does not replace simulation analytics, MCP/Gateway authentication, fulfillment, order detail/PII, category/warehouse descriptive metadata, scheduled jobs, webhooks, or write approvals. Large catalogs/history require a future resumable background synchronizer, not removal of request-time limits. Platform search results are not a transactionally frozen point-in-time view; count changes during pagination cause failure and require a fresh attempt.
