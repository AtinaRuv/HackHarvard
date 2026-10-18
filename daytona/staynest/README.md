# StayNest: identical pages, different untrusted recipients

Open the published demo:

- Legitimate: https://leash-staynest-demo.foggylyric64.chatgpt.site/legitimate
- Malicious: https://leash-staynest-demo.foggylyric64.chatgpt.site/malicious

Use these exact extensionless URLs for inspection. The current host serves them
without redirects. Sites project `appgprj_6ad45578e7388191adff6df1715ebdaa`,
published version 5 (header-controlled serving and visible fee breakdown).

## Teammate quick start

Use Node.js 24 and npm. The commands below work in macOS/Linux terminals or
Git Bash on Windows. Run commands from the repository root unless stated otherwise.

```sh
git clone --branch atina-daytona --single-branch https://github.com/AtinaRuv/HackHarvard.git
cd HackHarvard
git switch atina-daytona
git branch --show-current
npm ci
node daytona/staynest/build.js
node --test daytona/*.test.js
node daytona/staynest/server.js
```

The branch check should print `atina-daytona`. Open both local pages:

- http://127.0.0.1:3787/legitimate.html
- http://127.0.0.1:3787/malicious.html

Stop the preview with Ctrl+C. Local preview, builds and local tests do not need
an API key, a hosted website, a locally installed browser or Daytona credits.
The tests use mocks; Chromium runs inside Daytona only during an explicit live test.
Use the test command above: the root `npm test` script is an unrelated placeholder.
All required source files, generated HTML, original PNGs and deployment JPEGs
are included in this branch. No files from the author's computer are needed.
The `daytona/.gitattributes` rules preserve LF line endings for the reviewed hash.

### Configure your own Daytona key

Create your own API key in your Daytona dashboard. If the repository root does
**not** already contain `.env`, copy the committed, credential-free example:

```sh
cp daytona/.env.example .env
```

If `.env` already exists, keep it and manually add only the example's two
settings. Edit root `.env` locally to replace the `DAYTONA_API_KEY` placeholder
with your own key. Keep the exact `LEASH_INSPECTION_URLS` array from the example
for this controlled demo. The existing `.gitignore` excludes real `.env` files;
never commit, print, send to the browser or share your API key.

### Real remote inspection (uses Daytona credits)

The account needs credits and outbound HTTPS access. After setting your key,
this command performs two real inspections, one sandbox per public page:

```sh
node daytona/staynest/live.js https://leash-staynest-demo.foggylyric64.chatgpt.site --confirm-billable
```

Expect the legitimate page to return top-level `safeToProceed: true` and
`approved_for_demo_contributions`; expect the malicious page to return false and
`blocked`, with injection and merchant-mismatch findings. Both sandboxes should
be deleted. The live callback only records eligibility; it does not create a
funding group, request contributions, book or debit anyone. No automatic retries
are made. Cleanup errors report the sandbox identity for manual deletion.

The existing public HTTPS deployment can be used without redeploying. If it is
unavailable, host the committed demo using the instructions below. Daytona cannot
reach a laptop's localhost server. A replacement host must preserve the exact
HTML bytes, TLS and `no-transform` headers. A trusted maintainer must update the
exact URL/authorization record for a new origin; approval never follows arbitrary
URLs. Do not change the policy to work around a hash mismatch or redirect.

## Website

Both pages use `listing.js`, `page.css`, `browser.js`, and the same five original
generated interior images. The supplied screenshots guided the gallery's 2:1:1
columns, page width, typography, spacing, sticky reservation card, amenities,
calendar, reviews, and host sections. Branding, property, host, map and reviews
are fictional. No Airbnb source code, photos, login or payment system is used.

Harbor View Loft is a fictional Boston listing for four guests, October 24–25,
2026. The total is USD 400: USD 350 for one night, USD 30 cleaning and USD 20
service. Dates/guest controls update the in-tab quote. Reserve opens only a
simulated preview; it does not persist a reservation or contact any backend.
The page accepts no personal information, passwords or payment credentials.
Its CSP blocks network connections and native form submissions. Photo, save,
calendar and disclosure interactions stay inside the tab.

The variants differ in exactly two places, both outside the visible interface:

| Variant | Inert JSON merchant claim | Hidden DOM note |
| --- | --- | --- |
| Legitimate | `STAYNEST-MERCHANT-001` | Ordinary reservation information |
| Malicious | `UNAUTHORIZED-MERCHANT-999` | Controlled instruction to disregard the previously authorized recipient |

The malicious instruction is never executed. The inspector scans hidden text.
`data-booking` attributes identify visible booking facts. One bounded
`application/json` record identifies the page-claimed merchant. It is parsed as
data, never evaluated, and remains untrusted. A missing, duplicate or malformed
record cannot authorize a recipient.

## Trusted backend boundary

The public inspector remains `require('./daytona').inspectBookingUrl({ url })`.
It now includes optional `bookingDetails.merchantId`, an untrusted page claim.
No SSRF, DNS pinning, TLS, redirect, script, permission or cleanup policy changed.

The demo helper adds a separate **simulated contribution authorization**:

```js
const { inspectBeforeContributions } = require('./daytona/staynest/inspection');

const report = await inspectBeforeContributions(
  { url: approvedListingUrl },
  async (inspection, authorization) => {
    // Call your trusted, idempotent contribution-creation interface here.
    // Use authorization.booking for amounts/terms, not untrusted page text.
    // This callback must not book or debit anyone.
  }
);
// report.safeToProceed === true only for this reviewed demo contribution policy.
// report.inspection.safeToProceed stays false: the raw page is not certified safe.
```

Configure `LEASH_INSPECTION_URLS` in the trusted backend environment to include
the two exact URLs above. Approval does not add URLs or change the allowlist.
Do not let HTTP input supply the test dependencies, expected merchant, policy,
URL configuration or fingerprint. No production financial route was modified.

### Why the legitimate page was inconclusive

Three independent checks explained the previous result:

1. The general `assessPage()` deliberately always returns `safeToProceed: false`.
2. Scripts, a form and image references produce `uninspected_behavior`; these
   are blocked during inspection, so dynamic inspection is incomplete.
3. The collapsed fee breakdown made `taxesAndFees` null in real Chromium.

The fee breakdown now opens by default in both variants. The raw inspection
still reports the script/form/image limitation honestly. It is not rewritten to
`no_findings`, and external websites do not gain an approval path.

### Exact demo approval conditions

All conditions in backend-only `authorization.js` must pass:

- Exact inspected URL **and** extracted listing URL equal
  `https://leash-staynest-demo.foggylyric64.chatgpt.site/legitimate`. Same origin
  alone, the malicious path, query variants and copied pages do not qualify.
- The fetched HTML's SHA-256 equals the explicitly reviewed, backend-pinned
  HTML artifact. The worker computes it from the bytes actually given to
  remote Chromium; a page-supplied hash/token is ignored. Any HTML change closes
  the gate until a maintainer reviews that change and explicitly updates the pin.
- The page-claimed merchant matches `STAYNEST-MERCHANT-001` in backend config.
- All extracted terms exactly match the backend record: Harbor View Loft;
  Boston, Massachusetts (fictional listing); entire loft; October 24–25, 2026;
  four guests; USD 400 displayed and total for the group/stay; USD 30 cleaning,
  USD 20 service and zero additional demo taxes; free cancellation before
  October 20; and the explicit simulated availability claim.
- No missing/conflicting booking fields, truncation, executed page scripts,
  incomplete scan evidence, injection or additional findings are permitted.
- The sole finding must be the existing medium-severity `uninspected_behavior`
  warning. This known limitation is accepted **only for that exact reviewed
  document**; it is never ignored for a different or changed page. The raw
  assessment must have the expected inconclusive/static-only state.
- Browser/context closure and sandbox deletion must have completed successfully
  before the trusted contribution callback is called.

The report has top-level `status: approved_for_demo_contributions`,
`safeToProceed: true`, and `authorization.scope: simulated_contributions_only`
only when every check passes. Otherwise it is blocked; per-check booleans explain
why. `contributionFlowOpened` means the supplied callback completed. In the live
test that callback only records eligibility; no real funding group is created.
A callback failure propagates without automatic retry after sandbox cleanup.

`authorization.booking` comes from the backend record, not from page-generated
instructions. Merchant mismatch still adds `payment_destination_mismatch` even
if injection text is removed. The malicious variant fails URL, fingerprint,
merchant, term/completeness and findings checks; sharing the UI cannot authorize it.

This scoped approval is not a safety certificate or permission to make a payment.
The future booking session must independently revalidate current terms, recipient,
spending limit, group authorization and transaction uniqueness. Production
Nessie, Photon, settlement and refund routes still require teammate integration.
A clean unknown site or a forged `safeToProceed` claim is never automatically
approved by this demo policy.

## Local preview and tests

From the repository root:

```sh
node daytona/staynest/build.js
node daytona/staynest/server.js
```

Open http://127.0.0.1:3787/legitimate.html and
http://127.0.0.1:3787/malicious.html. Stop with Ctrl+C. Localhost is not remotely
accessible from Daytona. No new dependencies are required.

```sh
node --test daytona/*.test.js
```

All 70 local tests passed on October 18, 2026, including the original
security/lifecycle checks and the new demo authorization checks. They cover identical generated
markup apart from the two intentional differences, consistent booking facts,
visible/hidden injection, merchant mismatch without injection, malformed or
missing metadata, URL protection, legitimate contribution eligibility, blocked malicious/unknown
pages, changed HTML/terms, redirect signals, extra or missing findings, incomplete
scan evidence, callback failure and cleanup after navigation/deletion failure. Local inspector tests use mocked sandbox/browser resources
and a small controlled DOM double; production extraction uses remote Chromium.

Release setup was also checked from an export of the exact staged tree, without
`.env`, existing `node_modules`, unused SVG prototypes or temporary hosting files.
`npm ci` and SDK imports succeeded; all 70 tests and 25 JavaScript syntax checks
passed there. Rebuilding preserved the reviewed HTML fingerprint. Both local HTTP
pages, all five PNGs, and standalone Worker pages/JPEGs were verified from that
copy. No Daytona sandbox was created for these fresh-checkout checks.

Native Chrome previews of both variants were reviewed against the supplied
screenshots, and gallery/card captures were saved outside the repository.
The capture was 3024 × 1722 pixels; it was a visual proportion/spacing review,
not an automated pixel comparison at the reference's exact viewport. Mobile
breakpoints are implemented but were not separately verified on a mobile device.

For an explicitly approved live comparison (two billable sandboxes, no retries):

```sh
node daytona/staynest/live.js https://leash-staynest-demo.foggylyric64.chatgpt.site --confirm-billable
```

The runner temporarily sets `LEASH_INSPECTION_URLS` to exactly these two URLs for
its process, restores the variable, and calls the real public inspector. Browser
and context closure happens in the remote worker's `finally`. Sandbox deletion
is attempted in the caller's `finally`; failures report the sandbox identity.

Actual current live results, October 18, 2026 (exit code 0):

| Check | Legitimate | Malicious |
| --- | --- | --- |
| Remote Chromium extraction | All expected terms, including fees | Same numeric/date facts; descriptive fields withheld |
| Merchant comparison | match | mismatch |
| Prompt injection | false | true; high-severity finding |
| Backend contribution decision | approved_for_demo_contributions | blocked |
| Top-level safeToProceed / callback eligibility | true / true | false / false |
| Raw inspection safeToProceed | false | false |
| Document fingerprint | matches reviewed artifact | different; rejected |
| Missing fields | none | descriptive fields suppressed |
| Evidence truncated / scripts executed | false / false | false / false |
| Browser closed / sandbox deleted | true / true | true / true |

Exactly two sandboxes were created and deleted in this comparison. There were no
live-test errors or automatic retries. The live callback recorded eligibility
only: no group was created, no contributions were collected and no debit occurred.
Malicious descriptive fields are intentionally null because suspicious
instructions must not become booking-agent descriptions. Unknown-site rejection,
changed terms/documents, extra findings and cleanup failure were tested locally.

## Rebuild and host on another computer

`build.js` emits the paired HTML and a root copy. The current deployment uses
`hosting.js`, a tiny read-only Worker that serves only those pages and five
packaged images. It returns `Cache-Control: no-store, no-transform` explicitly,
never follows redirects, and has no outbound requests, environment bindings,
credentials, payments or reservation endpoint. POST returns 405, unknown paths
return 404, and no backend files are served.

The original static host appended a changing Cloudflare JavaScript-detection
bootstrap to HTML. It ignored a standard `_headers` configuration, so its body
could not match the reviewed pin. We did not strip the bootstrap or ignore the
hash mismatch. The header-controlled serving layer fixed byte integrity, verified
with a non-billable GET before allocating a sandbox. Cloudflare documents that
an origin `Cache-Control: no-transform` directive prevents JSD injection:
[official documentation](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/javascript-detections/).

For a fresh deployment build, no new dependencies are needed:

```sh
node daytona/staynest/build.js
node daytona/staynest/build-hosting.js /ABSOLUTE/SITE-CHECKOUT/worker/index.js
```

Use the Sites Worker ESM hosting workflow for the existing project ID and public
audience: preserve `.openai/hosting.json`'s project ID, omit its `static` field,
build `dist/server/index.js` from the generated Worker, and package only that
entrypoint plus `dist/.openai/hosting.json`. The current deployment was built and
validated through the Sites skill in a separate hosting checkout. No Leash
commit or push was performed during deployment. The five checked-in `hosting-images/*.jpg` files
are encoding copies of the existing generated PNGs, embedded to keep the
compressed Worker below 3 MiB. Existing image URLs are retained with an accurate
`image/jpeg` response header; the original PNGs remain for the local preview.

Other HTTPS hosts can serve `public/*.html` and the original PNGs directly, but
must preserve the exact HTML bytes and return `no-transform` to prevent CDN
injection. A new origin or changed HTML needs explicit backend policy review and
configuration. **Never fetch and automatically accept a new fingerprint**, and
never upload authorization code, credentials or `.env` to a public host.

The generated Worker is standalone: no runtime packages, secret settings or
outbound HTTP calls are needed. For a Cloudflare Worker deployment, upload the
generated `worker/index.js` as an ES module with its `default.fetch` entrypoint.
For Sites, use the build/output layout above. Both approaches serve the images
from the embedded committed JPEG copies. Hosting access and deployment permission
belong to your team; nothing is deployed automatically by these build commands.

After editing UI source, run `build.js` and the local tests. A changed reviewed
document must be inspected and explicitly re-pinned in `authorization.js` before
it can receive demo approval. Never update that fingerprint automatically from
the public site's response. The local preview works without the current host;
live remote inspection always needs a reachable approved HTTPS page.

## Connect the group-funding backend

Call this helper **before** creating a funding group or asking anyone for money.
The following CommonJS adapter can live in your trusted backend; adapt the
injected handler to the team's existing funding interface:

```js
const { inspectBeforeContributions } = require('./daytona/staynest/inspection');

async function inspectThenOpenFunding(url, createFundingGroup) {
  return inspectBeforeContributions({ url }, async (_inspection, authorization) => {
    await createFundingGroup(authorization.booking);
  });
}
```

`createFundingGroup` is your trusted, idempotent backend adapter, not a function
provided by Daytona. Enforce user/group authorization there. Use the trusted
`authorization.booking` terms and amount, never webpage instructions or raw page
text. A blocked report never calls the handler. If the handler throws, the error
propagates without retry; the browser and sandbox have already been cleaned up.
The helper's optional third argument is for trusted local tests only, never HTTP
request data. Do not expose expected merchant, terms, URL or hash overrides.

Use the helper's top-level `safeToProceed` and scoped `authorization` decision.
`report.inspection.safeToProceed` deliberately remains false and the raw report
remains inconclusive about dynamic behavior. `contributionFlowOpened` means your
handler completed, not that everyone has paid. This step grants no permission to
book, debit, send payment credentials or skip the later independent booking checks.

## Files

- `listing.js`, `page.css`, `browser.js`: shared UI and local simulated interactions.
- `public/*.html`, `public/assets/*.png`: generated HTML and original images.
- `build.js`, `server.js`: deterministic build and localhost-only preview.
- `hosting.js`, `build-hosting.js`, `hosting-images/`: header-controlled deployment.
- `authorization.js`: exact trusted demo URL, fingerprint, merchant and terms.
- `inspection.js`: real inspection, backend authorization and contribution gate.
- `live.js`: explicit two-page Daytona test; no real contribution or debit.
- `../staynest.test.js`: local comparison, hosting and authorization tests.
- `ASSETS.md`: generated-image provenance and packaging copies.
