# Leash Daytona booking-page security inspection

For the paired fictional rental website, local preview, tests, hosting setup,
and current funding-policy limitations, see [StayNest demo](staynest/README.md).

Daytona is an isolated, read-only browser boundary for the booking agent.
It inspects a specific, approved booking URL and returns typed **untrusted page
claims** plus a security assessment. It does not search for hotels, reserve,
submit forms, enter credentials, make payments, or authorize a booking.
The old research API and historical dataset have been removed.

## Backend API

```js
const { inspectBookingUrl } = require("./daytona");

const result = await inspectBookingUrl({ url: approvedListingUrl });
```

`index.js` exports only `inspectBookingUrl`. An optional second argument injects
mocked browser clients and approved URLs for local tests; never populate it from
a user's request. The backend supplies only the first argument in production.

The JSON-compatible result includes:

- `status`: `inspected`, `inconclusive` or `blocked`.
- `security.status`: `no_findings`, `review_required`, `inconclusive` or `blocked`.
- `security.promptInjectionDetected`: whether a heuristic instruction pattern
  matched; false does not mean the page was fully inspected or is safe.
- Fixed-description `findings`, missing fields, coverage and limitations.
- `bookingDetails`: property name, validated listing URL, address, dates, guest
  count, room type, displayed price/currency/basis, total price, taxes/fees,
  cancellation policy, availability claim, and an optional page-claimed merchant ID. Missing or conflicting facts are
  null. Nothing is verified inventory or payment authorization.
- `dataTrust: "untrusted_page_claims"` and **`safeToProceed: false`**.

**The general inspector never automatically opens the booking gate**, including a clean,
complete fixture. Every report requires the trusted backend to independently
verify details, the actual target, group approval and authorization. Absence of
heuristic findings is not enough to permit a booking. The field is deliberately
conservative, not a security guarantee or a future payment instruction.

The separate StayNest helper has an explicit backend-only authorization policy
for simulated contributions. It requires the exact controlled listing URL,
reviewed HTML fingerprint, trusted merchant, matching complete booking terms,
full static scan evidence and confirmed cleanup. Only that pinned demo artifact's
known blocked-UI warning is accepted. The raw inspection remains inconclusive;
external sites retain the default closed gate. See [the demo policy](staynest/README.md#exact-demo-approval-conditions).

Do not insert descriptions or other page claims into an agent's system prompt,
treat them as tool commands, evaluate them, or render them as unescaped HTML.
Keep their untrusted-data label across component boundaries. Findings contain
fixed explanations, not attacker instructions or raw page excerpts. Suspected
injection suppresses descriptive booking fields; dates and numeric fields still
undergo type/format checks. The public API returns no raw DOM/text dump.

## Setup and permitted URLs

Use Node.js 24 (tested locally), with the existing package and lockfile:

```sh
npm ci
node --test daytona/*.test.js
```

Only `@daytonaio/sdk` and dotenv are needed by this module; both are already
project dependencies. Playwright/Chromium remain inside the existing Daytona
image. No local browser installation, new dependency or external hotel API is
needed. The root `npm test` command is still the original placeholder.

Configure `DAYTONA_API_KEY` in the backend environment or an uncommitted local
`.env`. Do not commit or share the key. No key is sent to an inspected page.

**No real booking URLs are enabled by default.** A trusted maintainer must set
`LEASH_INSPECTION_URLS` to a JSON array of at most 25 exact approved HTTPS URLs.
For example, this is a reserved illustrative address, not a hosted service:

```text
LEASH_INSPECTION_URLS=["https://your-controlled-site.example/hotel/123"]
```

Replace it with a real page you control or have permission to inspect. The
maintainer must verify that fetching it with GET is read-only and that its site
permits automation. User consent alone does not establish a website's permission.
Do not add Booking.com, Airbnb or similar unauthorized sites. URL approval does
not label its content trustworthy; compromised approved pages are still untrusted.

Approval includes the exact path and query, not arbitrary pages on the hostname
or wildcard subdomains. IP literals, credentials, non-HTTPS, non-443 ports,
localhost/internal domains and common action/token/redirect query parameters
are rejected. Action-path checks add a safeguard, but cannot prove that every
server treats GET as read-only. Exact approval and maintainer review are required.
The allowlist is backend configuration, never copied from page content or input.

## Browser and network boundary

1. Validate the URL and approval before allocating a sandbox.
2. Use the existing SDK image recipe, private sandbox and remote Chromium.
3. Perform only one main-document GET, using the existing Node HTTPS helper
   **inside Daytona**. DNS answers must be public IPv4, and the checked address
   is passed directly to the socket. TLS certificate verification stays enabled.
4. Give the downloaded HTML to Chromium through intercepted `route.fulfill`,
   then inspect its rendered DOM using a fixed Playwright evaluate function.
   This is genuine browser DOM extraction, not regex parsing of HTML in production.
5. Block other requests, redirects, POST/actions, downloads and page permissions.
   Website JavaScript and service workers are disabled; restrictive CSP blocks
   scripts, frames, subresources, base URL overrides and form actions. No cookies,
   authorization headers, backend environment or payment credentials are forwarded.
6. Close context/browser independently in `finally`; the caller deletes the
   sandbox in `finally` after success or failure. Startup failures retain the
   existing best-effort recovery/deletion by unique name. TTL is ten minutes.

DNS rebinding of the inspected GET is prevented by connection pinning; IPv6-only
sites are unsupported. Every HTTP redirect is rejected, including same-host ones.
The response Refresh header is inspected as a signal but not forwarded/followed.

**Conservative preflight:** inspection accepts UTF-8/ASCII HTML only and refuses
any HTML containing a `<link>` element before rendering. Such elements can create
speculative connections outside ordinary request interception. This also refuses
benign favicons/stylesheets and even matching text in comments; it is a deliberate
false-positive tradeoff. A new site adapter must address that boundary rather
than simply removing the check. Smoke-test mode retains the existing behavior.
This is an application-level policy, not a claimed OS-wide egress firewall.

Navigation/fetch/command timeouts are bounded (30/15/75 seconds). HTML is limited
to 2 MiB. Inspection scans up to 3,000 elements, 30,000 visible characters,
100,000 DOM-text characters, 8,000 comment characters, 16,000 attribute characters
and 100 referenced URLs. Limits or malformed evidence produce an inconclusive
result. Browser/context cleanup has separate five-second deadlines. Cleanup
failures keep the gate closed and report sandbox ID/name when manual action is
needed; lower-level SDK diagnostics and signed preview credentials are withheld.

## Layered assessment and extraction

Isolation and restricted actions/networking are the main protections. Detection
is an additional warning layer, not a classifier that certifies pages safe:

- Scan visible text, hidden DOM text, comments, script text and attributes.
- Normalize Unicode, invisible characters, percent encoding and a small bounded
  set of base64 candidates as data only. Never execute decoded strings.
- Flag instruction overrides, role impersonation, secret disclosure requests,
  command execution, booking-behavior changes and fake payment routing.
- Inspect structural signals: meta/JavaScript redirects, base overrides, unsafe
  links, cross-origin payment links, forms, active scripts, frames, payment
  controls and blocked resources. Referenced URLs are not visited.
- Extract only whitelisted, uniquely valued visible fields with bounded lengths.
  Data fields use `data-booking="propertyName"`, `address`, `checkIn`, `checkOut`,
  `guests`, `roomType`, `price`, `currency`, `priceBasis`, `taxesAndFees`,
  `cancellationPolicy` and `availability`. A small set of matching visible
  microdata fields is also read; arbitrary site layouts are not guessed.

A numeric `displayedPrice` is distinct from `totalPrice`: the latter is set only
when the page explicitly claims `priceBasis=total_group_stay` and a currency.
Nightly/per-person prices are not multiplied into invented totals. Availability
is an explicit page claim (`available`, `unavailable`, `request_only`), not an
independent inventory check. Generic pages may legitimately return all nulls.
JSON-LD is scanned as untrusted DOM text, not executed or accepted as verified
hidden booking facts. Hidden fact fields do not override visible values.
The optional merchant ID has one explicit exception: a single inert
`<script type="application/json" data-booking="merchantId">` record of at most
512 characters. Only a bounded identifier is accepted; it is never authorization.
The StayNest backend helper compares it with its separate trusted configuration.
The visible phrase `Total for your group` maps to the existing `total_group_stay`
price basis; it does not establish a verified price or grant permission.

Important limits: JavaScript-dependent content, external resources, iframe/shadow
content not covered by the static DOM, later DOM changes, visual-only attacks,
unknown encodings/languages, sophisticated obfuscation and conflicting page
semantics are not comprehensively evaluated. Heuristics can miss attacks and
flag legitimate policy text. Suppressed scripts/forms/resources make the report
inconclusive. A page with no findings is never guaranteed safe. The trusted
booking component must revalidate its own live page and group authorization;
this inspection cannot prevent later page changes or attacks in another browser.

## Local tests and controlled demonstration

```sh
node --test daytona/*.test.js
```

Tests use the normal controlled listing in `demo/hotels.html`, attack variants
in `test-fixture.js`, a small test-only DOM double and mocked Daytona/Playwright/
HTTPS clients. They cover visible/hidden/comment/encoded injections, redirects,
fake payments, missing/ambiguous facts, unsafe URLs/DNS, unsupported documents,
resource blocking, and cleanup after failures. They do not create a sandbox,
execute page commands, launch local Chromium, or contact external websites.
Production DOM parsing happens only in Chromium.

The old historical research API/data are removed. The existing image, sandbox,
preview and example.com flow succeeded live before this purpose change. One
controlled live security test also passed: remote Chromium read the injection
fixture through a private HTTPS preview, and `inspectBookingUrl()` returned
three high-severity findings with `safeToProceed: false`. Only that exact URL
was approved in the process environment. Context/browser closure, preview
revocation and sandbox deletion completed without errors. This does not verify
arbitrary websites or establish injection-detector completeness.

Local verification: **70 tests passed**, including the existing security and
cleanup checks and narrowly scoped demo authorization tests. See the demo README
for current live results and the separate raw-inspection/contribution decisions.
The current real two-page Daytona test passed: the legitimate demo qualified for
simulated contributions, the malicious demo was blocked, and both sandboxes were
deleted. The live callback did not collect contributions or debit anyone.

Each command below creates a real sandbox and requires explicit approval:

```sh
node daytona/test.js --demo normal
node daytona/test.js --demo hidden
node daytona/test.js --inspect 'https://your-approved-real-listing-url'
```

Run only the individually approved command, with no automatic retry. `--demo`
serves the chosen fixture **inside Daytona**, reached through a private signed
HTTPS preview. No external deployment or laptop-localhost access is assumed.
Preview revocation and sandbox deletion are both attempted; signed URLs are
removed from printed results. Other fixture names are `injection`, `redirect`,
`payment`, `script`, `comment` and `encoded`.

Preserved smoke tests (also require separate permission and real resources):

```sh
node daytona/test.js
node daytona/test.js --offline
```

`--offline` refers only to synthetic page loading, not free Daytona usage.
Only the smoke test prints a short example.com content preview; inspections do
not print raw attacker text. Keep `.env`, installed dependencies and private
preview URLs out of Git. The package changes add the Daytona SDK and dotenv;
no teammate code is part of this integration.

## Files

- `index.js`, `inspector.js`: public API, URL gate, structured failures, lifecycle.
- `analysis.js`: bounded browser DOM extraction, assessment and typed page claims.
- `sandbox.js`, `security.js`, `config.js`: existing remote browser and strict URL/HTTPS controls.
- `page.js`, `demo/hotels.html`: controlled fixture publishing through a private HTTPS preview.
- `*.test.js`, `test-fixture.js`: mocked local checks and attack fixtures.
- `test.js`: explicit live inspection/demo and preserved smoke-test runner.

References: [Playwright routing](https://playwright.dev/docs/api/class-browsercontext#browser-context-route),
[isolated contexts and permissions](https://playwright.dev/docs/api/class-browser#browser-new-context),
and [OWASP prompt-injection prevention](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html).
