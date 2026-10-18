# Leash — an iMessage booking agent

Leash lives in an iMessage group chat. Add its Photon number to the group. The
agent asks the organizer for the Airbnb listing, dates, and booking name, and
any other shared details in the group. Everyone in the group is assumed to attend.
Each attendee supplies their own email privately in a DM. It opens a browser, prepares the simulated
booking, and privately messages every attendee their share and payment link.
There is no booking website, intake form, organizer dashboard, or approval step.

The only web pages are:

- **`http://localhost:6767/watch`**: permanent Mac operator view. Leave it open;
  it follows the latest booking automatically, including intake and the initial
  browser session, and waits for the next booking after a reset. It is available
  only locally and is not exposed through the public tunnel.
  Click the status label's **Clear** control after an idle/completed session to
  clear the browser image, tokens, and trace. This only clears the viewer on that
  browser; it preserves bookings and payments. A running/new session appears
  automatically, and cleared screens remain clear after a page reload.

- **`/pay/<private-token>`**: a single black screen with the attendee's amount and
  an Apple Pay-style fake payment button. No scrolling or card details.
- **`/watch/<private-token>`**: a read-only live view of the actual agent browser
  filling the checkout, checking the final token, applying the simulated payment,
  and reaching completion. The agent also sends the watch link to the group.

After paying, each attendee sees only "Confirmed." Once everyone has paid, the
agent shares the live view in the group. Shared booking questions, status updates,
confirmation, and refunds are communicated in iMessage. Final-token mismatch
stops fulfillment and automatically refunds everyone who paid. Photon email
confirmation remains available as requested in the original pipeline.

## Run

To run the browser passes separately without Photon:

```sh
# Terminal 1
npm start
# Terminal 2: fetch the listing, save the initial token/screenshot, delete sandbox
npm run test_daytona_1
# Fill checkout in a fresh sandbox, compare tokens, spend or refund, return email
npm run test_daytona_2
```

Watch both at **http://localhost:6767/watch**. Session #1 fetches the supplied
real Airbnb listing and exits with a saved run. Session #2 resumes that run,
fills the simulated checkout with the saved guest details, compares signed
tokens, then debits a new simulated Nessie account or refunds every contribution
on a mismatch. Each sandbox is deleted at the end of its command. The live view
includes a cursor, click feedback and typing indicators from actual browser
actions. Session #2 refuses to repeat a completed run.

The explicitly simulated total defaults to $960; it is not presented as Airbnb's
verified price. `confirmation.eml`, tokens, screenshots/live frames, and
`result.json` are saved under the printed `data/browser-tests/<run>/` directory.
The email is returned as a file, not sent to anyone. The npm start server keeps
the viewer available after each command exits.

```sh
# Exercise the automatic refund path:
npm run test_daytona_1 -- --scenario price --total 200
npm run test_daytona_2
# Both passes in one command, if desired:
npm run test_browser
# Require a verified public Airbnb price (stops if unavailable):
npm run test_daytona_1 -- --real-price
```

`--total` is cents, `--bank demo` uses an in-memory fake bank, and
`--port 6769` targets an npm start server running on that port. The default uses
Nessie's sandbox API and checks that the account returns to zero. It needs
`DAYTONA_API_KEY`, `NESSIE_API_KEY`, `NESSIE_BASE_URL`, and `NESSIE_CUSTOMER_ID`
from `.env`. These commands do not connect to Photon or charge Stripe. No real
Airbnb reservation is made. `--real-price` never substitutes the demo amount.

Use Node.js 24+ (developed with Node.js 26).

```sh
cd /Users/shashvathsrivatsa/Code/javascript/node/HackHarvard
npm ci
npx playwright install chromium
npm start
```

Configure the variables in `.env.example` inside the existing `.env`; do not
replace existing credentials. `APP_BASE_URL` must be a publicly reachable HTTPS
URL so people in the group can open their payment/watch links. A tunnel to port
6767 works for development. Stop with Ctrl+C. There is no frontend build step.

**Start in iMessage, not at localhost.** Add the dedicated Photon number to the
group and send a message, or let the group membership event trigger the greeting.
The first human who adds/messages the agent becomes the organizer. It asks for
missing details conversationally. All attendees must be in the group so it can
send their private payment requests. No web API exists to create a booking or
answer intake questions.

The group receives one PNG status card when everyone has paid. It shows each
person's share and paid checkmark. Split-ready, partial payment, completion,
refund and requested status updates are text only. Personal emails and private
payment URLs are never included in the image.

The existing `.env` does not automatically supply the Spectrum project secret,
voice JWT, or verified Photon email sender. Those integrations need their own
configured credentials; demo browser tests do not verify delivery to a real phone.

## Clear everything for a fresh demo

If Photon connects but no reply appears, run `npm run photon:status`. This reads
the latest outgoing records for saved demo conversations without sending any
messages. A nonzero `sendErrorCode` means Apple rejected the outgoing message;
a successful SDK request alone does not establish sending. The agent now checks
that native status. An outcome that remains unknown is not blindly resent.
Remote line failures must be investigated in Photon; clearing local bookings or
restarting the local listener cannot prove that the line can send again.

Listing fraud screening is removed from the booking flow. Page keywords,
review counts, host age, and prices do not generate risk warnings or reject a
listing. Final token comparisons still verify the amount, dates, guest count,
and payment destination before the simulated debit.

The running agent writes message fingerprints and browser errors to
`DATA_DIR/debug.jsonl`. The startup record reports `listingFraudScreening: false`.

Run this command to stop matching agents across local checkouts and clear this checkout's runtime data:

```sh
npm run reset
# When you want to start fresh:
npm start
```

This clears all local booking/chat state, fake payments and refunds, screenshots,
live browser frames, test screenshots, and generated signing keys. Old private
links stop working; the next group message starts a new flow. It preserves `.env`
credentials, code, installed packages, and the running tunnel. Existing iMessage
history and remote Stripe/Nessie records are not deleted. The script verifies
working directories and matches the repository or shared Photon/Spectrum project
credentials. It finds legacy entrypoints, declared start scripts, nodemon, and
duplicates on other ports. It stops matching processes gracefully, forces
unresponsive copies to exit, then clears this checkout's data. Reset locks prevent
updated agents in discovered checkouts from restarting during cleanup. Other
checkouts' data, unrelated projects, and the tunnel are preserved.

To stop agents on other machines too, configure explicit SSH targets in `.env`:

```dotenv
RESET_REMOTE_TARGETS=[{"host":"user@demo-server","project":"/home/user/HackHarvard"}]
```

Each target needs working noninteractive SSH access, Node/npm on its PATH, and
this updated reset script in that checkout. Reset invokes
`npm run reset -- --local-only --stop-only` there, preserving remote runtime data.
Use `--local-only` to skip remote connections or `--stop-only` to preserve this
checkout's data too. No remote target is guessed or stopped without configuration.
If a target fails, the command reports a partial reset and exits with an error.
With no configured targets, it explicitly says other machines were not stopped.

Preview the exact directories without clearing anything:

```sh
npm run reset -- --dry-run
```

## Settings

| Setting | Purpose |
| --- | --- |
| `APP_MODE=connected` | Connect the actual Photon iMessage listener (default). |
| `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET` | Photon Spectrum Stable project with a dedicated group-capable iMessage line. |
| `BOOKING_SOURCE=airbnb` | Read public Airbnb quote facts; use `demo` for synthetic Airbnb checkout facts while retaining the iMessage interface. |
| `BROWSER_PROVIDER=daytona` | Run each browser pass inside a private Daytona sandbox. `local` is supported only for synthetic checkout tests. |
| `DAYTONA_API_KEY` | Allocates/deletes the two remote browser sandboxes. |
| `PAYMENT_PROVIDER=demo` | Fake payment links, no Stripe account/card required (default). Optional `stripe` uses Stripe test checkout. |
| `BANK_PROVIDER=nessie` | Nessie simulated banking; `demo` uses the persisted local fake balance. |
| `NESSIE_API_KEY`, `NESSIE_BASE_URL`, `NESSIE_CUSTOMER_ID` | Creates a distinct fake booking account and records deposits/withdrawals. |
| `PHOTON_VOICE_TOKEN`, `PHOTON_VOICE_FROM` | Photon calls for organizer progress updates. Requires its own voice JWT. |
| `PHOTON_EMAIL_API_KEY`, `PHOTON_EMAIL_PROJECT_ID`, `PHOTON_EMAIL_SENDER_ID` | Photon email API project and verified sender for confirmation emails. |
| `APP_BASE_URL`, `HOST`, `PORT` | Public link origin and HTTP listener settings. |
| `DATA_DIR` | Private SQLite data, signing key, screenshot, and current browser frames (default `data/`). |

For a hackathon run with real iMessage and a simulated checkout, use
`APP_MODE=connected`, `BOOKING_SOURCE=demo`, `PAYMENT_PROVIDER=demo`, and
`BANK_PROVIDER=demo`. Keep `BROWSER_PROVIDER=daytona` to demonstrate remote
isolation, or `local` for local development. The synthetic total is configured by
`DEMO_TOTAL_CENTS` (default 96000), not entered through a website.

`APP_MODE=demo` disconnects Photon only for automated tests/development. It does
not expose a replacement chat website. Tests inject inbound iMessage events
through the same production chat handler.

## Actual browser streaming

The browser worker captures JPEG frames as the page changes. Local runs publish
frames directly. Daytona runs publish them inside the sandbox; the backend polls
those files while the remote browser command is still running. Private viewers
receive frame updates over server-sent events and retrieve the current image.
This is an actual screenshot stream, not a pre-recorded video or a step animation.

In the second pass the browser stays open while the backend compares the signed
facts and applies the fake bank debit. Only a matching token permits the browser
to click **Complete simulated booking** and show its confirmation. On mismatch,
that click never happens. The sandbox is deleted after the flow finishes; viewers
retain the final frame and outcome. The live view exposes no interactive controls.

## Simulation and Airbnb limits

Neither browser pass submits an Airbnb reservation or charges a real card. With
`BOOKING_SOURCE=airbnb`, the agent loads the listing in Daytona with site
JavaScript enabled, an Airbnb/muscache network allowlist, and GET-only browser
routing. It reads explicit selected dates, guests, USD, and a total including tax.
It then fills a local simulated checkout with those independently read facts.
The second pass independently re-reads the quote before finishing the simulation.

Airbnb may change its DOM, require login, or present a browser challenge. Missing,
ambiguous, unavailable, or pre-tax quotes stop before collection. A second-pass
failure refunds contributors. A real listing has not been verified in this
workspace; passing synthetic checkout tests does not establish production Airbnb
compatibility. The agent never invents taxes or treats a nightly price as a final
post-tax total.

Photon's Stable iMessage and newer API email projects use distinct credential
contracts. Configure them separately. Voice uses the Photon voice SDK with local
`espeak` and `ffmpeg` audio synthesis (`brew install espeak ffmpeg` on macOS).
Optional `VOICE_TRANSCRIBE_URL` accepts POST `audio/basic` (8kHz mono PCMU) and
returns `{"text":"answer"}`. Without speech recognition, calls request a text
reply; ordinary intake questions always work in iMessage. No other email provider
is used.

## Persistence, payments, and recovery

A project-level process lock allows only one running agent, even if a second copy uses a different port. The Photon listener starts only after the HTTP server binds successfully. Incoming message IDs are saved before handling, so replayed events are ignored across restarts. During payment collection, ordinary group chatter is ignored; send `status` for an update.

One server process owns the SQLite database in `DATA_DIR`. Random private tokens
gate payment and viewing pages. Signed tokens bind the booking/listing, dates,
guests, exact USD cents, destination, and organizer answers. Shares divide integer
cents exactly in both local demo and Nessie modes. New Nessie accounts use
integer USD cents (one provider unit = $0.01), identified in their nickname and
persisted account metadata. This avoids Nessie silently truncating decimal
amounts. Legacy accounts retain their original dollar units.
The data directory and credentials are Git-ignored.

Nessie uses a distinct account per booking. Every deposit is read back and checked
against its payment reference, amount, and completed status before confirming the
share. Final spending verifies all contributions again; it does not trust the
account balance field, which Nessie may leave unchanged for simulated deposits.

Duplicate/concurrent payment events do not add money twice. A 30-minute timeout
refunds partial funding; late successful payments for closed bookings are also
refunded. Stripe test refunds, if enabled, use stable idempotency keys, poll pending
status, and retry failed attempts. Fake payments/refunds update the same lifecycle
without any provider charge. Unknown Nessie outcomes are recorded for reconciliation
rather than repeating an ambiguous debit. Notifications retry independently.

Optional Stripe test mode needs `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`.
Forward signed webhooks to `/webhooks/stripe`:

```sh
stripe listen --forward-to localhost:6767/webhooks/stripe
```

A success redirect does not prove payment. Only a verified paid test session
matching the saved attendee, amount, currency, and checkout funds the share.
The server also retrieves saved Stripe sessions every five seconds, so payment
confirmation works when webhook registration is unavailable. Returning from
Checkout immediately requests server verification and stays on a simple
"Confirmed" payment receipt. Each verified contribution posts the paid count in
the iMessage group. The live browser link is shared in the group only after
everyone has paid; initial browser frames are hidden from viewers.

## Validation

To skip attendee checkout during a demo, keep the server running and use another terminal:

```sh
npm run bypass
```

Separate demo shortcuts are also available:

```sh
npm run bypass_email
npm run bypass_applepay
```

`bypass_email` skips missing emails using demo placeholders, preserves supplied
addresses, and continues intake. Placeholder addresses never receive email.
`bypass_applepay` is the payment bypass above; it still requires completed intake.
Both accept an optional booking ID after `--`.

This confirms all remaining shares on the single booking collecting payments,
records simulated Nessie deposits, updates the group, and continues fulfillment.
Already paid shares are preserved. Existing unpaid Stripe sessions are expired;
bypassed shares never charge or refund through Stripe. With multiple active
bookings, use `npm run bypass -- BOOKING_ID`. The command uses a private local
socket and is unavailable through the public website.
The booking organizer can also send `bypass` (or `/bypass`) directly in the
iMessage booking group. The agent confirms the paid count in chat and continues
the same simulated booking flow. Other attendees cannot trigger this command.

```sh
npm test
npm run test:browser
```

The browser test starts with injected **group membership and iMessage messages**,
collects all inputs through the chat handler, opens the private fake payment links,
then watches multiple real browser frames through completion or refunds. It
checks the group receives the live link and confirmations. Normal, changed-price,
and rerouted-destination flows each use two fresh browser sessions. There is no
web-created booking in this test. Provider calls/messages are mocked; local
Chromium and the payment/view pages run for real.

HTTP tests also assert the removed web booking/dashboard endpoints return 404,
private links require the correct token, and Stripe raw webhook signatures are
checked. Live Photon/Daytona/Nessie/Stripe delivery still requires configured
accounts and runtime verification.

## Main files

- `app/messenger.js`: group join, conversational intake, private messages, emails.
- `app/pipeline.js`: booking lifecycle, token gate, fake payments, automatic refunds.
- `app/browser.js`, `app/browser-worker.cjs`: fresh browser passes and live frames.
- `app/live.js`: private frame/state publishing.
- `server.js`, `public/`: only payment and read-only live viewing pages.
- `daytona/`, `fraud/`, `nessie/`, `stripe/`: integrated branch modules and tests.

The shared simulated checkout now has three browser steps: trip dates and guest
count, primary guest details, and payment review. The agent moves the visible
cursor through each step. A receipt replaces checkout only after backend token
verification permits the simulated payment. Daytona carries a rendered photo
from the supplied listing into the offline checkout when available; the shown
price remains explicitly a configured demo price. This renderer is shared by
`test_daytona_2` and the iMessage booking worker.

The simulated checkout follows an Airbnb-style request flow with numbered,
editable sections: payment timing, payment method, guest details, and request
review. It includes a persistent trip summary and expandable price breakdown.
Pay-later is explicitly preview-only; the automation selects full payment from
the group account. An optional offline test-card form validates sandbox inputs
but does not contact Stripe or Airbnb. The backend still verifies tokens before
allowing the final simulated payment.

For the connected preliminary check, `BOOKING_SOURCE=airbnb-reserve` opens the
real listing, scrolls to its bottom and back, clicks Reserve, and reads the real
USD checkout total including taxes. `test_daytona_1` now uses this source by
default. It fills guest name/email only if the real page exposes those inputs;
it never enters card details or submits a real reservation. Unavailable pricing,
login requirements or browser challenges stop collection rather than falling
back to the configured demo total. Session two still completes only the
simulated payment after rechecking the real quote and signed booking fields.

After all contributions arrive, the final pass opens a fresh browser and repeats
the real listing → Reserve quote check. It then re-enters dates, guest count,
guest name and email in the offline simulated checkout, selects the pooled
account, reviews the breakdown, and requests backend token verification before
simulated payment. Brief pauses occur at trip review, payment-method review,
guest review, token review and confirmation; individual clicks have no blanket
sleep. No real Airbnb reservation or payment is submitted.

Same-listing URL normalization is allowed during reads; another listing, trip or
merchant remains blocked. Initial navigation gets up to three read-only loading
attempts. Browser failures are reported separately from signed-token mismatches.
After a failed/refunded attempt, the organizer can send `retry` in the group to
reuse saved booking details with a fresh bank account and new payment links.
Previous refunds and payment records remain intact; pending reconciliation blocks
retry.
