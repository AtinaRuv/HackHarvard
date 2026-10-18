# HackHarvard — Leash payment demo

## Chunk 3: Stripe checkout → simulated Nessie contribution

Stripe and Nessie are separate systems. Stripe test payments do not transfer money
into Nessie. Our signed webhook records a matching simulated deposit in Nessie.
Chunk 4 records authorized simulated withdrawals and tracks remaining funds locally.

### What changed

| File | Purpose |
| --- | --- |
| `nessie/client.js` | Adds `addContribution`: POST a simulated deposit with the verified amount and Stripe payment ID. Does not retry uncertain requests. |
| `stripe/webhook.js` | Handles paid `checkout.session.completed` and `checkout.session.async_payment_succeeded` events, verifies the raw-body signature, retrieves current Stripe checkout state, matches saved references/amount/currency, and records one contribution. |
| `payments/store.js` | SQLite storage for share/account mappings, checkout links, and contribution claims/results. Unique share/payment IDs stop duplicates, including simultaneous requests and restarts. |
| `stripe/routes.js` | Saves the server-controlled demo share and Nessie account before checkout, then saves/reuses its checkout link across restarts. |
| `server.js` | Mounts `POST /payments/webhook` before JSON parsing. |
| `stripe/webhook.test.js`, `nessie/client.test.js` | HTTP/signature, payment validation, persistence, concurrency, and deposit tests. |
| `scripts/payment-demo.js` | Local account-creation, read-only status, and duplicate-replay helpers. |
| `package.json`, `package-lock.json` | Test/start/helper commands and Node version requirement; no new dependency. |
| `.env.example`, `.gitignore` | Document new settings and exclude the local ledger from Git. |

The verified webhook calls the Nessie POST helper directly inside our backend.
There is no public, unauthenticated "add money" route.

### Requirements and limits

- Node **24.12 or newer** (`node --version`). This project uses Node's built-in SQLite;
  Node may print an ExperimentalWarning. That warning is not a test failure.
- Existing Stripe **test** account/key and Nessie API key/customer. Keep secrets in
  `.env`. A restricted Stripe key needs Checkout Session read/create and Events read
  for the replay helper. If Events read is unavailable, replay uses your existing
  Stripe CLI login to retrieve that saved event instead.
- Existing test-mode integration is preserved. Live Stripe keys/payments are rejected.
- The connected demo supports **whole USD dollars** because Nessie's published
  deposit schema uses an integer amount. Stripe 2500 cents becomes Nessie 25 dollars;
  fractional-dollar shares are rejected before creating the connected checkout.
- SQLite is for this **single-host local demo**, not separate deployed replicas.
  Keep `.data/payments.sqlite` across restarts. Never delete it to fix a retry.
  The team's shared booking storage must replace this before distributed deployment.
- We track **recorded** deposits, not settlement of real funds. Check Nessie's returned
  transaction status and balance; its processing may not be immediate. In the
  current Nessie environment, we observed a completed deposit without a change
  to the account balance field. A recorded deposit does not prove that field updated.

### Test 1 — automated checks (no real services or participants)

In a VS Code terminal:

```sh
cd /Users/nicomallen/Documents/GitHub/HackHarvard
npm test
```

Expected: **70 tests, 70 pass, 0 fail**. The tests use temporary databases, a local
HTTP listener, signed fake Stripe events, and fake Nessie responses. They do not
read `.env`, send links, call Stripe/Nessie, or charge anyone.

They check:

- Correct signature + matching paid checkout → one deposit to the saved account.
- Invalid signature → HTTP 400 and no Nessie request.
- Wrong amount, currency, account mapping references, session, or missing payment ID
  → no deposit. Unknown shares cannot be supplied by a browser.
- Unpaid checkout, live event, unrelated event → no deposit.
- Delayed payment success → contribution only once the checkout is paid.
- Duplicate event, different event IDs for the same payment, simultaneous delivery,
  and reopening the database → no second deposit.
- Timeout/rejection/unreadable deposit result → needs_review, no automatic second POST.
- Stripe 2500 cents → Nessie amount 25; invalid/fractional amounts fail before POST.

### Test 2 — one actual Stripe test payment connected to Nessie

No friends or messages are needed. You open the checkout link yourself.
This test really creates a **simulated** Nessie deposit.

**1. Configure `.env` in VS Code.** Keep the existing Stripe/Nessie keys. Add or fill:

```dotenv
APP_BASE_URL=http://localhost:6767
ENABLE_PAYMENT_DEMO=true
NESSIE_ACCOUNT_ID=YOUR_EXISTING_SIMULATED_ACCOUNT_ID
DEMO_PAYMENT_ATTEMPT_ID=demo-chunk3-001
```

Use the account created in chunk 1. For an easy balance check, use an empty account.
If you do not have an account yet, set `NESSIE_CUSTOMER_ID` and run this **once**:

```sh
npm run payments:account -- --create
```

Copy the returned `accountId` into `NESSIE_ACCOUNT_ID` in `.env`. This command creates
an account; it is not a status command. If it reports an uncertain outcome, inspect
Nessie before running it again.

**2. Start Stripe forwarding in terminal A.** Install the official Stripe CLI if
`stripe --version` is unavailable (see the installation link below), then:

```sh
stripe login
stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded --forward-to http://localhost:6767/payments/webhook
```

Sign into the **same Stripe account/test environment** as the key in `.env`.
Copy the `whsec_...` signing secret printed by `stripe listen` into
`STRIPE_WEBHOOK_SECRET` in `.env`. Keep terminal A running. Do not share the secret.

**3. Start our updated backend in terminal B.** Stop the old server with Ctrl+C in
its terminal first; otherwise port 6767 may still serve the old code.

```sh
npm start
```

Expected: `Server running on port 6767`. Start/restart the server after editing `.env`.

**4. Check the starting balance in terminal C.**

```sh
npm run payments:status
```

Expected for a new account: `nessieAccountBalance: 0` and `simulatedContributionBalance: 0`, `contribution: null`, and an empty
`stripeDeposits` list. Save the starting balance if you use an existing account.

**5. Create the new connected checkout in terminal C.**

```sh
curl -sS -X POST http://localhost:6767/payments/demo/checkout \
  -H 'Content-Type: application/json' \
  -d '{}'
```

Expected: JSON containing `sessionId`, `checkoutUrl`, `amountCents: 2500`, and
`currency: "usd"`. Open the **new** `checkoutUrl`, not the old paid chunk-2 link.
The browser/command does not supply the amount or destination account.

**6. Complete the test payment in the browser.**

For the card test, use `4242 4242 4242 4242`, any future expiration, any three-digit
CVC, and a postal code if requested. You can instead use your working Apple Pay
setup in **test checkout**. One payment is sufficient for this connection test;
both methods lead to the same server verification path.

Expected:

- Browser returns to a page saying server verification is still required. That
  page itself never credits Nessie.
- Terminal A shows a checkout event and HTTP **200** from our webhook.
- Terminal B prints `Nessie contribution recorded for share demo-chunk3-001-share.`

**7. Inspect the result in terminal C.**

```sh
npm run payments:status
```

Expected: `contribution.status: "recorded"`, a saved `depositId`, and one deposit
with amount **25** and description `Stripe test contribution pi_...`. The `simulatedContributionBalance` should be **25**. This is computed from saved
contributions matched to completed Nessie deposits. `nessieAccountBalance` is the
raw account field; this Nessie environment leaves it at **0** despite completed
deposits. These fields are deliberately separate. The contribution total excludes
opening funds and spending, so spending uses the separate `simulatedAvailableBalance` introduced in chunk 4.
If it is pending, inspect its status and check again; do not pay again. If the
deposit is completed but balance stays unchanged, report this Nessie behavior
separately; do not create another deposit or overwrite the account balance.

### Test 3 — duplicate delivery and restart

After the contribution is `recorded`, keep the server running and run in terminal C:

```sh
npm run payments:replay
npm run payments:status
```

Expected replay response:

```json
{"received":true,"status":"already_recorded"}
```

Expected status: the **same deposit ID**, still one matching deposit, unchanged
balance. No new checkout link or new payment is needed.

This developer tool retrieves the saved original event from Stripe and locally
signs a fresh delivery with your local signing secret. It tests our duplicate
handling, not Stripe's Dashboard resend interface. It refuses to replay an
unrecorded contribution.

Now stop terminal B with Ctrl+C, run `npm start` again, and repeat the two commands.
Expected: `already_recorded` again with the same deposit ID and unchanged balance.
Keep the database and `DEMO_PAYMENT_ATTEMPT_ID` unchanged for this test.

### If something fails

- **Webhook 400 / signature:** use the signing secret from the currently running
  `stripe listen`, then restart the server. A secret for a different endpoint does
  not work.
- **Webhook 400 / share mismatch:** ensure you used the new locally generated link
  and the same Stripe account/environment. Synthetic `stripe trigger` checkouts
  are not registered shares and are intentionally rejected.
- **Webhook 503 / needs review:** run `npm run payments:status`. A failed/uncertain
  deposit stays blocked to prevent a duplicate. Check Nessie's deposits for the
  stored payment ID/description. Do not delete the database, reset a claim, pay
  again, or manually repeat the POST to "fix" it. Reconcile the result first.
- **`processing` after a restart:** treat it as uncertain too; the process may have
  stopped after Nessie accepted the deposit but before saving its response.
- **Account/settings changed:** keep IDs stable during retries. For a deliberately
  new payment, after finishing/reconciling the old one, choose a fresh
  `DEMO_PAYMENT_ATTEMPT_ID` and restart the server. That creates another $25 test
  payment; it is not a duplicate-delivery test.
- **Old checkout expired:** do not keep retrying the expired link. After verifying
  it was not paid, choose a fresh demo attempt ID and restart.

### Team handoff

The production booking backend should register its trusted saved share/account
mapping, create checkout through `createParticipantCheckout`, and bind the returned
session with `bindCheckout` before distributing its URL. Browser input must not
choose amounts or account IDs. Currently only the fixed local demo route performs
this handoff. Chunk 4 adds an internal spending module; there is no public spending endpoint.

### References

- [Stripe Checkout fulfillment and webhook testing](https://docs.stripe.com/checkout/fulfillment?payment-ui=stripe-hosted)
- [Install Stripe CLI](https://docs.stripe.com/stripe-cli/install)
- [Nessie API documentation](https://prod.nessieisreal.com/docs)
- [Nessie published OpenAPI schema](https://prod.nessieisreal.com/nessie-openapi-spec.yaml)

### Balance calculation fix

`payments/balance.js` matches locally recorded contributions to completed Nessie
deposits by deposit ID, Stripe payment reference, and exact amount. The status
command reports `simulatedContributionBalance` from those matched records,
`confirmedContributionCount`, and `unmatchedContributionCount`.
The raw `nessieAccountBalance` remains visible. No additional deposit is created
and no amount is added to the raw balance (which could double-count if Nessie
starts updating it later). Automated coverage is in `payments/balance.test.js`.

## Chunk 4: authorized simulated spending

### Files

| File | Purpose |
| --- | --- |
| `nessie/client.js` | Adds `subtractFromAccount` (Nessie withdrawal POST) and deposit reads. Amounts stay in cents internally and convert to whole simulated dollars only at Nessie. |
| `payments/spend.js` | Adds `buildBookingSpender`. Requires a trusted backend authorization callback, checks the dedicated booking account and verified contributions, reserves funds, then records the withdrawal. |
| `payments/store.js` | Persists spending reservations/results. One operation ID and one authorization ID can create only one withdrawal. A database transaction prevents simultaneous overspending. |
| `payments/balance.js` | Adds remaining funds and withdrawal reconciliation to status. Processing/uncertain operations remain reserved. |
| `payments/spend.test.js`, `nessie/client.test.js` | Spending authorization, amounts, insufficient funds, replay, restart, concurrency and failure coverage. |
| `scripts/payment-demo.js`, `package.json` | Adds the fixed local $10 test command and withdrawal status output. |

### Backend handoff

Your teammates must inject `authorizeBooking(bookingId)` into `buildBookingSpender`.
That callback must check their saved booking rules and return trusted saved values:

```js
{
  bookingId: 'booking-123',
  accountId: 'the-booking-nessie-account-id',
  amountCents: 1000,
  authorizationId: 'one-stable-id-for-this-approved-booking-charge'
}
```

If unauthorized, it must return null or throw. The caller invokes the resulting
`spendBooking({ bookingId, operationId })` with a stable operation ID. Retry with
both IDs unchanged. The operation cannot be reused with a different amount or
account; changing only operationId cannot reuse an already-spent authorization.
The browser must never provide the authorization callback or approved amount.

The actual team booking flow is not present in this repo, so that team integration
remains a handoff. The demo CLI uses a fixed internal test approval for $10, not a
real booking authorization. The low-level Nessie helper is internal; application
code should call the spending module to preserve reservation/duplicate protection.

Use a dedicated Nessie account per booking. This local ledger tracks app-recorded
contributions and app-authorized spending; external/manual purchases, transfers,
withdrawals or refunds are not included. It does not transfer real money or pay a
merchant. All app processes must share the same local SQLite file.

### Run the chunk 4 test yourself

No checkout link, Stripe forwarding, or friends are needed for this test. The CLI
calls the internal module directly; it does not require the web server to be running.

1. Run `npm test` in the VS Code terminal. Expected: **70 pass, 0 fail**. All service
   calls in automated tests are fake.
2. Run `npm run payments:status`. Before the first withdrawal, your current test
   account has $25 in contributions and $25 available.
3. Run this command to record the fixed **$10 simulated withdrawal**:

   ```sh
   npm run payments:spend -- --confirm
   ```

   First-run expected output: `status: "recorded"` and a `withdrawalId`.
4. Run `npm run payments:status`. Expected:

   ```text
   simulatedContributionBalance: 25
   simulatedSpendingReserved: 10
   simulatedAvailableBalance: 15
   confirmedWithdrawalCount: 1
   unmatchedWithdrawalCount: 0
   spendingNeedsReview: false
   ```

   The raw `nessieAccountBalance` may still be 0. Our available balance is computed
   from verified contributions minus persisted spending reservations. Reservations
   include recorded withdrawals as well as any pending/uncertain operations.
5. Repeat `npm run payments:spend -- --confirm`. Expected: `already_recorded` and
   the **same withdrawalId**. Check status again: still one $10 withdrawal and $15
   available. Each CLI run opens a fresh process/database connection, so this also
   verifies persistence across process restarts.

The development run already performed steps 3–5 against your current test account:
**one $10 completed withdrawal, repeat rejected as already_recorded, $15 available**.
Running the same command now should return `already_recorded`; it will not create
another $10 withdrawal. Do not change the fixed IDs merely to repeat this test.

Automated tests additionally attempt more spending than available, invalid or
missing authorization, a wrong booking account, changed retry details, duplicate
approvals with new operation IDs, simultaneous spending across database connections,
and uncertain responses. Invalid requests produce no Nessie POST. Uncertain POSTs
remain `needs_review` with funds reserved, including after restarting. Inspect and
reconcile those in Nessie instead of resetting the reservation or posting again.
