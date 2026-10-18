const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { renderListing, injection, normalNote, booking } = require('./staynest/listing');
const { extractPage } = require('./analysis');
const { inspectBookingUrl } = require('./index');
const { fixtureRoot } = require('./test-fixture');
const { getDemoUrls, inspectBeforeContributions } = require('./staynest/inspection');
const { demoAuthorization, authorizeDemoContributions } = require('./staynest/authorization');

// Real configured URLs, used with mocks only; never contacted by these tests.
const urls = getDemoUrls(new URL(demoAuthorization.listingUrl).origin);
function client(html, fail = false) {
  const calls = [];
  let evidence;
  return { calls, get evidence() { return evidence; }, browser: {
    async createSandbox() { calls.push('create'); return { id: 'mock-staynest' }; },
    async interactWithBrowser(sandbox, url) {
      calls.push('read');
      if (fail) throw new Error('controlled navigation failure');
      evidence = extractPage(fixtureRoot(html), true);
      return { finalUrl: url, title: 'Harbor View Loft · StayNest Demo', ...evidence, blockedRequests: 5,
        documentSha256: createHash('sha256').update(html).digest('hex') };
    },
    async deleteSandbox() { calls.push('delete'); },
  } };
}

async function cleanInspection() {
  const deps = client(renderListing('legitimate'));
  return inspectBookingUrl({ url: urls[0] }, { browser: deps.browser, approvedUrls: urls });
}

test('the two generated pages differ only in merchant identity and reservation note', () => {
  const legitimate = renderListing('legitimate');
  const malicious = renderListing('malicious');
  assert.equal(malicious.replace(injection, normalNote).replaceAll('UNAUTHORIZED-MERCHANT-999', booking.merchantId), legitimate);
  for (const variant of ['legitimate', 'malicious']) {
    const html = renderListing(variant);
    assert.equal(fs.readFileSync(`${__dirname}/staynest/public/${variant}.html`, 'utf8'), html, 'Rebuild changed source before publishing.');
    assert.ok(!/<link\b|https?:\/\//i.test(html), 'No external services or speculative links.');
    assert.ok(html.includes('connect-src \'none\'; form-action \'none\''));
    assert.ok(!/type="(?:password|email|tel)"|autocomplete="cc-|<iframe/i.test(html));
    assert.ok(Buffer.byteLength(html) < 2 * 1024 * 1024);
  }
  new vm.Script(fs.readFileSync(`${__dirname}/staynest/browser.js`, 'utf8'));
});

for (const [index, variant] of ['legitimate', 'malicious'].entries()) {
  test(`${variant}: real inspection and backend policy control the contribution callback`, async () => {
    const deps = client(renderListing(variant));
    let contributions = 0;
    const report = await inspectBeforeContributions({ url: urls[index] }, async (inspection, authorization) => {
      contributions++;
      assert.deepEqual(deps.calls, ['create', 'read', 'delete'], 'Cleanup finishes before funding is considered.');
      assert.equal(authorization.booking.totalPrice, 400);
      assert.equal(authorization.booking.merchantId, demoAuthorization.merchantId);
      assert.equal(inspection.safeToProceed, false, 'Raw assessment is preserved.');
    }, {
      inspect: (input) => inspectBookingUrl(input, { browser: deps.browser, approvedUrls: urls }),
    });
    assert.equal(report.inspection.security.promptInjectionDetected, index === 1);
    assert.equal(report.inspection.bookingDetails.totalPrice, 400);
    assert.equal(report.inspection.bookingDetails.currency, 'USD');
    assert.equal(report.inspection.bookingDetails.guests, 4);
    assert.equal(report.inspection.bookingDetails.checkIn, '2026-10-24');
    assert.equal(report.inspection.bookingDetails.checkOut, '2026-10-25');
    assert.equal(report.inspection.status, index === 1 ? 'blocked' : 'inconclusive');
    assert.equal(report.merchantVerification.status, index === 1 ? 'mismatch' : 'match');
    assert.equal(report.contributionFlowOpened, index === 0);
    assert.equal(report.safeToProceed, index === 0);
    assert.equal(report.authorization.status, index === 0 ? 'approved' : 'blocked');
    assert.equal(contributions, index === 0 ? 1 : 0);
    assert.ok(deps.evidence.scan.domText.includes(index === 1 ? 'UNAUTHORIZED-MERCHANT-999' : booking.merchantId));
    if (index === 1) assert.ok(report.inspection.security.findings.some((finding) => finding.type === 'prompt_injection' && finding.severity === 'high'));
    else assert.equal(report.inspection.bookingDetails.propertyName, booking.propertyName);
    assert.deepEqual(deps.calls, ['create', 'read', 'delete']);
  });
}

test('navigation failure is inconclusive, keeps contributions closed, and deletes the sandbox', async () => {
  const deps = client('', true);
  const report = await inspectBeforeContributions({ url: urls[1] }, () => assert.fail('Must not request money'), {
    inspect: (input) => inspectBookingUrl(input, { browser: deps.browser, approvedUrls: urls }),
  });
  assert.equal(report.contributionFlowOpened, false);
  assert.equal(report.inspection.status, 'inconclusive');
  assert.deepEqual(deps.calls, ['create', 'read', 'delete']);
});

test('backend merchant mismatch blocks funding even without any injection instruction', async () => {
  const deps = client(renderListing('malicious').replace(injection, normalNote));
  const report = await inspectBeforeContributions({ url: urls[1] }, () => assert.fail('Must not request money'), {
    inspect: (input) => inspectBookingUrl(input, { browser: deps.browser, approvedUrls: urls }),
  });
  assert.equal(report.inspection.security.promptInjectionDetected, false);
  assert.equal(report.merchantVerification.status, 'mismatch');
  assert.equal(report.inspection.status, 'blocked');
  assert.equal(report.contributionFlowOpened, false);
  assert.ok(report.inspection.security.findings.some((finding) => finding.type === 'payment_destination_mismatch'));
  assert.deepEqual(deps.calls, ['create', 'read', 'delete']);
});

test('missing, malformed, duplicated or oversized merchant metadata cannot authorize a recipient', () => {
  const { verifyMerchant } = require('./staynest/authorization');
  const html = renderListing('legitimate');
  const record = /<script type="application\/json" data-booking="merchantId">[\s\S]*?<\/script>/;
  for (const replacement of ['', '<script type="application/json" data-booking="merchantId">invalid</script>',
    html.match(record)[0].repeat(2), '<script type="application/json" data-booking="merchantId">' + ' '.repeat(513) + '</script>']) {
    const facts = extractPage(fixtureRoot(html.replace(record, () => replacement)), true).facts;
    assert.equal(facts.merchantId, null);
    assert.equal(verifyMerchant(facts.merchantId).status, 'unverified');
  }
});

test('page claims cannot change backend-owned merchant authorization', () => {
  const { verifyMerchant, demoAuthorization } = require('./staynest/authorization');
  assert.ok(Object.isFrozen(demoAuthorization));
  const claimed = extractPage(fixtureRoot(renderListing('malicious')), true).facts.merchantId;
  assert.equal(verifyMerchant(claimed).expectedMerchantId, 'STAYNEST-MERCHANT-001');
  assert.equal(verifyMerchant(claimed).status, 'mismatch');
  assert.equal(verifyMerchant(booking.merchantId).status, 'match');
});

test('demo URL configuration accepts only HTTPS origins, never localhost, credentials or paths', () => {
  for (const origin of ['http://example.com', 'https://localhost', 'https://127.0.0.1', 'https://169.254.169.254', 'https://service.internal', 'https://user:secret@example.com', 'https://example.com/path', 'https://example.com/?next=bad']) assert.throws(() => getDemoUrls(origin));
  assert.deepEqual(getDemoUrls('https://staynest.example.com'), ['https://staynest.example.com/legitimate', 'https://staynest.example.com/malicious']);
});

test('demo gate cannot treat a clean-looking but incomplete inspection as permission', async () => {
  let opened = false;
  const result = await inspectBeforeContributions({ url: urls[0] }, () => { opened = true; }, {
    inspect: async () => ({ status: 'inconclusive', safeToProceed: true, security: { status: 'no_findings', inspectionComplete: false } }),
  });
  assert.equal(result.contributionFlowOpened, false); assert.equal(opened, false);
});

test('unknown URLs and the malicious path cannot inherit approval from identical HTML or a safe flag', async () => {
  const clean = await cleanInspection();
  assert.equal(authorizeDemoContributions(clean).status, 'approved');
  for (const url of ['https://unknown.example.com/legitimate', urls[1], urls[0] + '?copy=1', urls[0] + '/other']) {
    let opened = false;
    const report = await inspectBeforeContributions({ url }, () => { opened = true; }, {
      inspect: async () => ({ ...structuredClone(clean), url, safeToProceed: true,
        bookingDetails: { ...clean.bookingDetails, listingUrl: url } }),
    });
    assert.equal(report.safeToProceed, false, url);
    assert.equal(report.authorization.checks.approvedListing, false);
    assert.equal(opened, false);
  }
});

test('every backend-owned booking term is checked independently of merchant and fingerprint', async () => {
  const clean = await cleanInspection();
  for (const key of Object.keys(demoAuthorization.terms)) {
    const changed = structuredClone(clean);
    changed.bookingDetails[key] = null;
    const decision = authorizeDemoContributions(changed);
    assert.equal(decision.safeToProceed, false, key);
    assert.equal(decision.checks.bookingTerms, false, key);
  }
  for (const [key, value] of [['totalPrice', 401], ['currency', 'EUR'], ['guests', 5], ['checkOut', '2026-10-26']]) {
    const changed = structuredClone(clean);
    changed.bookingDetails[key] = value;
    assert.equal(authorizeDemoContributions(changed).safeToProceed, false, key);
  }
});

test('changed HTML fails the reviewed-document check even without injection or changed booking fields', async () => {
  const html = renderListing('legitimate').replace('</body>', '<!-- ordinary changed content --></body>');
  const deps = client(html);
  const report = await inspectBeforeContributions({ url: urls[0] }, () => assert.fail('Changed build must not open funding'), {
    inspect: input => inspectBookingUrl(input, { browser: deps.browser, approvedUrls: urls }),
  });
  assert.equal(report.inspection.security.promptInjectionDetected, false);
  assert.equal(report.authorization.checks.bookingTerms, true);
  assert.equal(report.authorization.checks.reviewedDocument, false);
  assert.equal(report.safeToProceed, false);
});

test('missing or unexpected findings, scan evidence and cleanup results always close the demo gate', async () => {
  const clean = await cleanInspection();
  const changes = [
    report => { delete report.evidence; },
    report => { report.evidence.browserClosed = false; },
    report => { report.evidence.sandboxDeleted = false; },
    report => { report.cleanup = { deleted: false, sandboxId: 'mock' }; },
    report => { report.security.coverage.truncated = true; },
    report => { report.security.coverage.scriptsExecuted = true; },
    report => { report.security.coverage.hiddenTextIncluded = false; },
    report => { delete report.security.coverage; },
    report => { report.security.promptInjectionDetected = true; },
    report => { report.security.missingFields.push('taxesAndFees'); },
    report => { report.security.findings = []; },
    report => { report.security.findings = [null]; },
    report => { report.security.findings[0].severity = 'high'; },
    report => { report.security.findings.push({ type: 'unknown_warning', severity: 'low' }); },
    report => { report.status = 'blocked'; },
  ];
  for (const change of changes) {
    const report = structuredClone(clean); change(report);
    assert.equal(authorizeDemoContributions(report).safeToProceed, false, change.toString());
  }
  assert.equal(authorizeDemoContributions(null).safeToProceed, false);
});

test('a failed sandbox deletion prevents funding even for the reviewed legitimate document', async () => {
  const deps = client(renderListing('legitimate'));
  deps.browser.deleteSandbox = async () => { deps.calls.push('delete'); throw new Error('controlled cleanup failure'); };
  const report = await inspectBeforeContributions({ url: urls[0] }, () => assert.fail('Must not open funding'), {
    inspect: input => inspectBookingUrl(input, { browser: deps.browser, approvedUrls: urls }),
  });
  assert.equal(report.safeToProceed, false);
  assert.equal(report.inspection.evidence.sandboxDeleted, false);
  assert.equal(report.inspection.cleanup.sandboxId, 'mock-staynest');
  assert.deepEqual(deps.calls, ['create', 'read', 'delete']);
});

test('redirect response behavior blocks approval even when the HTML fingerprint matches', async () => {
  const deps = client(renderListing('legitimate'));
  const read = deps.browser.interactWithBrowser;
  deps.browser.interactWithBrowser = async (...args) => ({ ...await read(...args), httpRefresh: true });
  const report = await inspectBeforeContributions({ url: urls[0] }, () => assert.fail('Redirect behavior must block funding'), {
    inspect: input => inspectBookingUrl(input, { browser: deps.browser, approvedUrls: urls }),
  });
  assert.equal(report.authorization.checks.reviewedDocument, true);
  assert.equal(report.authorization.checks.findings, false);
  assert.equal(report.safeToProceed, false);
  assert.ok(report.inspection.security.findings.some(finding => finding.type === 'redirect_attempt'));
});

test('contribution handler failure is propagated after sandbox cleanup, without retrying the handler', async () => {
  const deps = client(renderListing('legitimate'));
  let calls = 0;
  await assert.rejects(inspectBeforeContributions({ url: urls[0] }, () => {
    calls++; throw new Error('controlled contribution failure');
  }, { inspect: input => inspectBookingUrl(input, { browser: deps.browser, approvedUrls: urls }) }), /controlled contribution failure/);
  assert.equal(calls, 1);
  assert.deepEqual(deps.calls, ['create', 'read', 'delete']);
});

test('preview serves only its fixed files, never accepts reservation POSTs or exposes secrets', () => {
  let handler;
  const scope = { module: { exports: {} }, __dirname: `${__dirname}/staynest`, require(name) {
    if (name === 'node:http') return { createServer(callback) { handler = callback; return {}; } };
    return require(name);
  } };
  vm.runInNewContext(fs.readFileSync(`${__dirname}/staynest/server.js`, 'utf8'), scope);
  scope.module.exports.createDemoServer();
  for (const [method, url, expected] of [['GET','/legitimate.html',200],['GET','/malicious.html',200],['GET','/assets/living.png',200],['POST','/legitimate.html',405],['GET','/.env',404],['GET','/authorization.js',404],['GET','/../server.js',404]]) {
    let status;
    handler({ method, url }, { writeHead(value) { status = value; return this; }, end() {} });
    assert.equal(status, expected);
  }
});

test('header-controlled host serves exact reviewed HTML, no redirects, and no actions or private files', async () => {
  const { serveDemo, makeWorkerSource } = require('./staynest/hosting');
  const files = { '/legitimate': { type: 'text/html; charset=utf-8', body: renderListing('legitimate') },
    '/malicious': { type: 'text/html; charset=utf-8', body: renderListing('malicious') },
    '/assets/test.png': { type: 'image/jpeg', base64: true, body: Buffer.from('test image bytes').toString('base64') } };
  const worker = (await import('data:text/javascript;base64,' + Buffer.from(makeWorkerSource(files)).toString('base64'))).default;
  for (const [method, pathname, status] of [['GET','/legitimate',200], ['GET','/malicious',200],
    ['GET','/legitimate.html',200], ['HEAD','/legitimate',200], ['POST','/legitimate',405],
    ['GET','/.env',404], ['GET','/authorization.js',404], ['GET','/legitimate?changed=1',404]]) {
    const response = await worker.fetch(new Request('https://staynest.example.com' + pathname, { method }));
    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'no-store, no-transform');
    assert.equal(response.headers.get('location'), null);
    if (method === 'HEAD') assert.equal(await response.text(), '');
  }
  const response = serveDemo(new Request('https://staynest.example.com/legitimate'), files);
  assert.equal(createHash('sha256').update(await response.text()).digest('hex'), demoAuthorization.documentSha256);
  const image = serveDemo(new Request('https://staynest.example.com/assets/test.png'), files);
  assert.equal(image.headers.get('content-type'), 'image/jpeg');
  assert.equal(await image.text(), 'test image bytes');
});
