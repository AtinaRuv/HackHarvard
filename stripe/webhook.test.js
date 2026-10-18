const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const express = require('express');
const Stripe = require('stripe');
const { openPaymentStore } = require('../payments/store');
const { buildWebhookHandler } = require('./webhook');

const secret = 'whsec_local_test_only';
const stripe = new Stripe('sk_test_fake');
const share = { shareId: 'share-1', bookingId: 'booking-1', participantId: 'person-1', paymentAttemptId: 'attempt-1', accountId: 'account-1', amountCents: 2500, currency: 'usd' };
const session = { id: 'cs_test_one', livemode: false, mode: 'payment', payment_status: 'paid', client_reference_id: share.shareId, amount_total: 2500, currency: 'usd', payment_intent: 'pi_test_one', metadata: { bookingId: share.bookingId, participantId: share.participantId, shareId: share.shareId, paymentAttemptId: share.paymentAttemptId } };
function event(type = 'checkout.session.completed', id = 'evt_one') {
  return { id, type, livemode: false, data: { object: { id: session.id } } };
}
async function setup(t, options = {}) {
  const folder = mkdtempSync(path.join(tmpdir(), 'leash-webhook-'));
  const filename = path.join(folder, 'ledger.sqlite');
  let store = openPaymentStore(filename);
  store.register(share);
  store.bindCheckout(share.shareId, { sessionId: session.id, checkoutUrl: 'https://checkout.stripe.com/example' });
  let calls = 0;
  const handler = buildWebhookHandler({
    stripeClient: { webhooks: stripe.webhooks, checkout: { sessions: { retrieve: async () => options.session || session } } },
    store,
    webhookSecret: secret,
    deposit: async (input) => { calls++; assert.deepEqual(input, { accountId: share.accountId, amountCents: 2500, paymentId: session.payment_intent }); return options.deposit ? options.deposit(input) : { depositId: 'deposit-1' }; },
    logger: { info() {}, warn() {}, error() {} },
  });
  const app = express();
  app.post('/payments/webhook', express.raw({ type: 'application/json' }), handler);
  app.use(express.json());
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); rmSync(folder, { recursive: true, force: true }); });
  return {
    filename, store, calls: () => calls,
    async send(body = event(), signatureSecret = secret) {
      const payload = JSON.stringify(body);
      const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: signatureSecret });
      const response = await fetch(`http://127.0.0.1:${server.address().port}/payments/webhook`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature }, body: payload,
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

test('signed paid checkout creates one contribution using saved account and amount', async t => {
  const x = await setup(t);
  assert.deepEqual(await x.send(), { status: 200, body: { received: true, status: 'recorded' } });
  assert.equal(x.store.contribution(share.shareId).depositId, 'deposit-1');
  assert.equal(x.calls(), 1);
});

test('different event IDs and both checkout success types cannot double-credit a payment', async t => {
  const x = await setup(t);
  await x.send();
  const replay = await x.send(event('checkout.session.async_payment_succeeded', 'evt_two'));
  assert.equal(replay.body.status, 'already_recorded');
  assert.equal(x.calls(), 1);
});

test('concurrent deliveries send only one Nessie deposit', async t => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const x = await setup(t, { deposit: async () => { await wait; return { depositId: 'deposit-1' }; } });
  const first = x.send();
  // Wait for the first handler to reach the external deposit.
  while (x.calls() === 0) await new Promise(resolve => setImmediate(resolve));
  try {
    const second = await x.send(event(undefined, 'evt_two'));
    assert.equal(second.status, 503);
    assert.equal(x.calls(), 1);
  } finally { release(); }
  assert.equal((await first).status, 200);
});

test('bad signature never contacts Nessie', async t => {
  const x = await setup(t);
  assert.equal((await x.send(event(), 'whsec_forged')).status, 400);
  assert.equal(x.calls(), 0);
});

test('unpaid, unrelated, and live events do not create deposits', async t => {
  const x = await setup(t, { session: { ...session, payment_status: 'unpaid' } });
  assert.equal((await x.send()).body.status, 'not_paid');
  assert.equal((await x.send(event('payment_intent.succeeded'))).body.status, 'ignored');
  assert.equal((await x.send({ ...event(), livemode: true })).body.status, 'ignored');
  assert.equal(x.calls(), 0);
});

test('async payment success can be the first paid notification', async t => {
  const x = await setup(t);
  assert.equal((await x.send(event('checkout.session.async_payment_succeeded'))).body.status, 'recorded');
});

for (const [name, changes] of Object.entries({
  amount: { amount_total: 2600 }, currency: { currency: 'eur' }, session: { id: 'cs_other' },
  metadata: { metadata: {} },
  share: { metadata: { ...session.metadata, shareId: 'unknown' } },
  participant: { metadata: { ...session.metadata, participantId: 'wrong' } },
  attempt: { metadata: { ...session.metadata, paymentAttemptId: 'wrong' } },
  booking: { metadata: { ...session.metadata, bookingId: 'wrong' } },
  reference: { client_reference_id: 'wrong' }, payment: { payment_intent: null },
})) {
  test(`mismatched ${name} is rejected before depositing`, async t => {
    const x = await setup(t, { session: { ...session, ...changes } });
    assert.equal((await x.send()).status, 400);
    assert.equal(x.calls(), 0);
  });
}

test('uncertain Nessie failure is persisted and never automatically posted twice', async t => {
  const x = await setup(t, { deposit: async () => { throw new Error('timeout'); } });
  assert.equal((await x.send()).status, 503);
  assert.equal(x.store.contribution(share.shareId).status, 'needs_review');
  assert.equal((await x.send()).status, 503);
  assert.equal(x.calls(), 1);
  const reopened = openPaymentStore(x.filename);
  try {
    assert.equal(reopened.contribution(share.shareId).status, 'needs_review');
    assert.equal(reopened.claim(share.shareId, session.payment_intent, 'evt_retry'), false);
  } finally { reopened.close(); }
});

test('recorded and processing claims survive reopening and competing database connections', async t => {
  const x = await setup(t);
  await x.send();
  const reopened = openPaymentStore(x.filename);
  try {
    assert.equal(reopened.contribution(share.shareId).status, 'recorded');
    assert.equal(reopened.claim(share.shareId, session.payment_intent, 'evt_retry'), false);
    reopened.register({ ...share, shareId: 'share-2', paymentAttemptId: 'attempt-2' });
    assert.equal(reopened.claim('share-2', 'pi_other', 'evt_first'), true);
    assert.equal(x.store.claim('share-2', 'pi_other', 'evt_second'), false);
    reopened.register({ ...share, shareId: 'share-3', paymentAttemptId: 'attempt-3' });
    assert.equal(reopened.claim('share-3', session.payment_intent, 'evt_reused_payment'), false);
  } finally { reopened.close(); }
});

test('saved mapping cannot be changed and fractional dollars are rejected before checkout', () => {
  const store = openPaymentStore(':memory:');
  try {
    store.register(share);
    assert.throws(() => store.register({ ...share, accountId: 'other-account' }), /Saved share differs/);
    assert.throws(() => store.register({ ...share, amountCents: 2550 }), /whole USD/);
  } finally { store.close(); }
});
