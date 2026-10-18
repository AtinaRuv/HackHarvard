const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { openPaymentStore } = require('./store');
const { buildBookingSpender } = require('./spend');
const { summarizeContributions, summarizeSpending } = require('./balance');
const approval = { bookingId: 'book', accountId: 'account', amountCents: 1000, authorizationId: 'approval-1' };
const input = { bookingId: 'book', operationId: 'spend-1' };
const deposits = [{ _id: 'd1', status: 'completed', amount: 25, description: 'Stripe test contribution pi_one' }];
function setup(t, options = {}) {
  const folder = mkdtempSync(path.join(tmpdir(), 'leash-spend-'));
  const filename = path.join(folder, 'ledger.sqlite');
  const store = openPaymentStore(filename);
  store.register({ shareId: 'share', bookingId: 'book', participantId: 'person', paymentAttemptId: 'attempt', accountId: 'account', amountCents: 2500, currency: 'usd' });
  store.claim('share', 'pi_one', 'evt_one');store.finish('share', 'd1');
  let calls = 0;
  const makeSpender = (overrides = {}) => buildBookingSpender({
    store, authorizeBooking: async () => approval, readDeposits: async () => deposits,
    withdraw: async args => { calls++; assert.deepEqual(args, { accountId: 'account', amountCents: 1000, operationId: input.operationId }); return options.withdraw ? options.withdraw(args) : { withdrawalId: 'w1' }; },
    ...overrides,
  });
  t.after(() => { store.close();rmSync(folder, { recursive: true, force: true }); });
  return { store, filename, spend: makeSpender(), makeSpender, calls: () => calls };
}

test('authorized ten-dollar spending is recorded and leaves fifteen available', async t => {
  const x = setup(t);
  assert.deepEqual(await x.spend(input), { status: 'recorded', withdrawalId: 'w1' });
  const result = summarizeSpending({ contributionSummary: summarizeContributions({ contributions: x.store.recordedContributions('account'), deposits }), spending: x.store.spendingForAccount('account'), withdrawals: [{ _id: 'w1', amount: 10, status: 'completed', description: 'Leash spending spend-1' }] });
  assert.equal(result.simulatedAvailableBalance, 15);
  assert.equal(result.confirmedWithdrawalCount, 1);
  assert.equal(result.spendingNeedsReview, false);
});
test('same operation replay never sends a second withdrawal', async t => {
  const x = setup(t);await x.spend(input);
  assert.equal((await x.spend(input)).status, 'already_recorded');assert.equal(x.calls(), 1);
});
test('same booking authorization cannot be spent under a new operation ID', async t => {
  const x = setup(t);await x.spend(input);
  await assert.rejects(x.spend({ ...input, operationId: 'other' }), /authorization already/);
  assert.equal(x.calls(), 1);
});
test('insufficient verified funds reject before withdrawal or reservation', async t => {
  const x = setup(t);
  const spend = x.makeSpender({ authorizeBooking: async () => ({ ...approval, amountCents: 2600 }) });
  await assert.rejects(spend(input), /Insufficient/);
  assert.equal(x.store.spending(input.operationId), undefined);assert.equal(x.calls(), 0);
});
test('missing authorization, wrong booking, and wrong account cannot spend', async t => {
  const x = setup(t);
  for (const value of [null, { ...approval, bookingId: 'wrong' }, { ...approval, accountId: 'wrong' }]) {
    await assert.rejects(x.makeSpender({ authorizeBooking: async () => value })(input));
  }
  assert.equal(x.calls(), 0);
});
test('invalid amounts and input IDs never start spending', async t => {
  const x = setup(t);
  for (const amountCents of [0, -100, 1050, '1000', NaN, 100000000]) {
    await assert.rejects(x.makeSpender({ authorizeBooking: async () => ({ ...approval, amountCents }) })(input));
  }
  await assert.rejects(x.spend({ ...input, operationId: '../x' }));
  assert.equal(x.calls(), 0);
});
test('pending/missing deposits and Nessie read failures cannot fund spending', async t => {
  const x = setup(t);
  for (const readDeposits of [async () => [], async () => [{ ...deposits[0], status: 'pending' }], async () => { throw new Error('unavailable'); }]) {
    await assert.rejects(x.makeSpender({ readDeposits })(input));
  }
  assert.equal(x.calls(), 0);
});
test('uncertain withdrawal remains reserved across restart and is not retried', async t => {
  const x = setup(t, { withdraw: async () => { throw new Error('timeout'); } });
  await assert.rejects(x.spend(input), /needs review/);
  assert.equal(x.store.spending(input.operationId).status, 'needs_review');
  const reopened = openPaymentStore(x.filename);
  try {
    const spend = x.makeSpender({ store: reopened });
    await assert.rejects(spend(input), /needs review/);
    assert.equal(x.calls(), 1);
    const result = summarizeSpending({ contributionSummary: { simulatedContributionBalance: 25 }, spending: reopened.spendingForAccount('account'), withdrawals: [] });
    assert.equal(result.simulatedAvailableBalance, 15);assert.equal(result.spendingNeedsReview, true);
  } finally { reopened.close(); }
});
test('recorded withdrawal survives restart and rejects changed retry details', async t => {
  const x = setup(t);await x.spend(input);const reopened = openPaymentStore(x.filename);
  try {
    assert.equal((await x.makeSpender({ store: reopened })(input)).status, 'already_recorded');
    await assert.rejects(x.makeSpender({ authorizeBooking: async () => ({ ...approval, amountCents: 1200 }) })(input), /different spending details/);
    assert.equal(x.calls(), 1);
  } finally { reopened.close(); }
});
test('concurrent operations across database connections cannot overspend', async t => {
  let release;const wait = new Promise(resolve => { release = resolve; });
  const x = setup(t, { withdraw: async () => { await wait; return { withdrawalId: 'w1' }; } });
  const first = x.spend(input);
  while (!x.calls()) await new Promise(resolve => setImmediate(resolve));
  const reopened = openPaymentStore(x.filename);
  try {
    // First request holds $10; the new $20 request must fail with only $15 left.
    await assert.rejects(x.makeSpender({ store: reopened, authorizeBooking: async () => ({ ...approval, amountCents: 2000, authorizationId: 'approval-2' }) })({ ...input, operationId: 'spend-2' }), /Insufficient/);
    await assert.rejects(x.makeSpender({ store: reopened })(input), /in progress/);
    assert.equal(x.calls(), 1);
  } finally { release();await first;reopened.close(); }
});
test('deleted or mismatched completed withdrawals stay reserved and are flagged', async t => {
  const x = setup(t);await x.spend(input);
  const summary = summarizeSpending({ contributionSummary: { simulatedContributionBalance: 25 }, spending: x.store.spendingForAccount('account'), withdrawals: [] });
  assert.equal(summary.simulatedAvailableBalance, 15);
  assert.equal(summary.unmatchedWithdrawalCount, 1);assert.equal(summary.spendingNeedsReview, true);
});

test('a shared account cannot spend another booking funds', async t => {
  const x = setup(t);
  x.store.register({ shareId: 'other-share', bookingId: 'other-booking', participantId: 'person-2', paymentAttemptId: 'attempt-2', accountId: 'account', amountCents: 2500, currency: 'usd' });
  await assert.rejects(x.spend(input), /dedicated account/);
  assert.equal(x.calls(), 0);
});
