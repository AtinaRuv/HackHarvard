# CONTRACT.md — integration branch

Repo is **CommonJS** (`"type": "commonjs"` in package.json). Use `require`, not `import`.
Port **6767**. Everything in `lib/` is an adapter: it wraps what a teammate already wrote,
never rewrites it. Each adapter must work with **no env vars at all** (stub path) and with
real env vars (real path). Each prints exactly one line at startup.

## What exists today, per lane

### fraud/ — DONE, TESTED, DO NOT MODIFY (`node fraud/test_tokens.js`, 32 passing)
CommonJS. `require('../fraud/tokens')` exports, all **sync**:
- `listingSignals(html, url)` -> `{ status, codes, signals }`  (status `OK` | `WARN`)
- `createInitialToken(html, url)` -> token object (signed)
- `editToken(token, edit)` -> `{ token }` (re-signs). Editable: `checkIn checkOut currency guests totalPrice`. `listingId` NOT editable.
- `createFinalToken(html, url)` -> token object
- `compareTokens(initial, final)` -> `{ status, reasons }`, status `OK` | `BLOCK`, reasons are plain English strings e.g. `"total price changed from 900 to 1240"`
- also `signToken`, `verifyToken`, `TokenError`, `ExtractError`
Signed fields: `checkIn checkOut currency guests listingId totalPrice`.
**The listing id comes from the URL**, so every URL you hand fraud MUST contain `/rooms/<digits>`.
Env: `TOKEN_SIGNING_SECRET` (dev fallback exists, prints a warning).
Fixtures live in `fraud/fixtures/`: `paris_listing.html`, `paris_final.html`,
`attack_price_final.html`, `attack_dates_final.html`, `attack_swap_final.html`, `scam_listing.html`.

### photon/ — chat, partially real
ESM files using `spectrum-ts` (NOT `@photon-ai/api`). They will NOT load under CommonJS as-is.
- `photon/sendText.js` — `export async function sendText(to, body)`; hardcoded projectId/secret.
- `photon/receiveText.js` — `export async function startPhoton()`; infinite `for await` over `photon.messages`; swallows all errors in an empty catch; imports `addUser` from `../main.js`.
- `photon/old/*` — older variants. `temp.js` at root uses `@photon-ai/api` + a `/photonWebhook` route reading `req.body.data.object` (`sentBy.handle`, `content.text`, `space.id`).
To use these from CJS: `await import('./photon/sendText.js')` (dynamic import works from CJS), or copy the few lines you need.
Env (now in `.env`): `PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET`.

### daytona/ — browser, real-ish, over-engineered for our purpose
CommonJS, uses `@daytonaio/sdk`.
- `daytona/index.js` -> `{ inspectBookingUrl }`
- `daytona/sandbox.js` -> `createSandbox()`, `interactWithBrowser(sandbox, url, {offline, inspection})`, `deleteSandbox(sandbox)`, `publishResultsPage`, `releaseResultsPage`
- `daytona/security.js` -> `validateUrl`, `validateBookingUrl`, `fetchPublicHtml`, `isPublicIPv4`
- `daytona/config.js` -> `getApprovedUrls()` reads `LEASH_INSPECTION_URLS` (JSON array)
**Blocker for us:** `security.js` rejects non-public IPs and non-HTTPS, and `config.js`
allowlists URLs from env. Local `http://localhost:6767/airbnb/...` will be rejected.
Do not fight it — bypass `security.js` for localhost in the adapter, or use plain `fetch`.
Env: `DAYTONA_API_KEY`, `LEASH_INSPECTION_URLS`, `PUBLIC_BASE_URL`.

### nessie/ — bank, real HTTP client
CommonJS, `nessie/client.js`, all **async**, amounts in **cents** already:
- `createBookingAccount({customerId, nickname})`
- `addContribution({accountId, amountCents, paymentId})`
- `readAccountDeposits(accountId)`
- `subtractFromAccount({accountId, amountCents, operationId})`
Env: `NESSIE_API_KEY`, `NESSIE_BASE_URL`, `NESSIE_CUSTOMER_ID`, `NESSIE_ACCOUNT_ID`.
Nessie's own API is dollars; check whether client.js already converts before converting again.

### stripe/ + payments/ — payments, real-ish
CommonJS.
- `stripe/client.js` -> `buildCheckoutCreator({stripeClient, appBaseUrl})`, `createParticipantCheckout(share)`
- `stripe/routes.js` -> an Express router: `POST /demo/checkout`, `GET /success`, `GET /cancel`
- `stripe/webhook.js` -> `buildWebhookHandler({stripeClient, store, webhookSecret, deposit, logger})`, `stripeWebhook(req,res)` (needs `express.raw` before `express.json`)
- `payments/store.js` -> `openPaymentStore(filename)` — **SQLite**, may fail with no deps; do not depend on it in the stub path, use a Map.
- `payments/balance.js`, `payments/spend.js` — summaries + `buildBookingSpender`.
Env: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `APP_BASE_URL`.

## TARGET ADAPTER INTERFACE — build exactly this

Every function `async` unless marked sync. Every adapter exports `status()` (sync) returning
the one-line string, and prints it once at require time.

### lib/chat.js
```
send(groupId, text)            -> void
sendToNumber(phone, text)      -> void
onInbound(handler)             -> void   // handler({from, groupId, text})
mountWebhook(app)              -> void   // POST /webhook/photon
log(groupId)                   -> [{dir:'in'|'out', from, text, ts}]  (sync, for the demo page)
```
Real when `PHOTON_PROJECT_ID` && `PHOTON_PROJECT_SECRET` exist. Else in-memory log.
Prints `[chat] real (photon)` or `[chat] stub`.
Group id mapping: one group per inbound number set, in a plain `Map`, default group `demo`.

### lib/browser.js
```
openPage(url)                        -> {html, url, screenshot?}
reachCheckout(listingUrl, fields)    -> {html, url, submit}   // submit is an async fn
destroy()                            -> void
mountFixtures(app)                   -> void
```
`mountFixtures` serves the fake Airbnb off `fraud/fixtures/`:
- `GET /airbnb/rooms/:id`             -> `paris_listing.html`
- `GET /airbnb/rooms/:id/book`        -> `paris_final.html`
- `GET /airbnb/rooms/:id/book?attack=1` -> `attack_price_final.html`
- `GET /airbnb/rooms/:id?scam=1`      -> `scam_listing.html`
URLs MUST keep `/rooms/<digits>`.
`reachCheckout(listingUrl, fields)` where `fields = {guests, attack}` -> hits the `/book` URL,
appending `?attack=1` when `fields.attack`.
Real when `DAYTONA_API_KEY` exists, else plain `fetch` against `http://localhost:6767`.
Prints `[browser] real (daytona)` or `[browser] stub`.

### lib/bank.js
```
createAccount(label)           -> id (string)
deposit(id, cents, key)        -> {balance, applied:boolean}   // key = `${groupId}:${member}`, idempotent
withdraw(id, cents)            -> {balance}
balance(id)                    -> cents (number)
```
Adapter takes **cents**, converts to dollars for Nessie if client.js does not.
Real when `NESSIE_API_KEY` exists, else in-memory Map.
Prints `[bank] real (nessie)` or `[bank] stub`.

### lib/payments.js
```
createPayLink(groupId, member, cents) -> url (string)
mountRoutes(app)                      -> void   // POST /webhook/stripe, GET /pay/:groupId/:member, POST /pay/:groupId/:member
onPaid(handler)                       -> void   // handler({groupId, member, cents})
```
Webhook idempotent on `event.id`. On success: call the `onPaid` handler (the orchestrator
wires it to `bank.deposit` + `chat.send`). Do NOT call bank/chat directly from payments.
Real Stripe Checkout (test mode) when `STRIPE_SECRET_KEY` exists; else a local
`GET /pay/:groupId/:member` HTML page with one big Pay button that POSTs and then
delivers a Stripe-shaped event (`{id, type:'checkout.session.completed', data:{object:{...}}}`)
to the same `/webhook/stripe` handler.
Prints `[payments] real (stripe)` or `[payments] stub`.

### lib/fraud.js — thin wrapper, no logic of its own
```
signals(html, url)                  -> {status, codes, signals}
approve(group, checkoutHtml, url)   -> token           (createInitialToken, stored on group.approvedToken)
amend(group, changes)               -> token           (editToken)
clear(group, finalHtml, url)        -> {status, reasons}  (createFinalToken + compareTokens)
```
`group` is the in-memory group object from `lib/flow.js`; `approve`/`amend` set
`group.approvedToken`. Prints `[fraud] real`.

## Rules for agents
- CommonJS only. Work only in your own files. Do not touch `fraud/`.
- Keep both paths (real + stub) working. If real cannot be made to work in 15 min, stub it and say so.
- Write `lib/<name>.test.js`: runs with **no env vars**, under 5 seconds, `node lib/<name>.test.js`,
  prints `ok` lines and exits non-zero on failure. No test framework.
- Mark unfinished real work with `// TODO(service): ...`.
- Commit on branch `integration`, message prefixed `[chat]` / `[browser]` / `[bank]` / `[payments]` / `[demo]`.
- `server.js` is the orchestrator's file. Do NOT edit it. Export a `mount*(app)` function instead.
- `.env` exists at root and is gitignored. Read config with `process.env` only.
