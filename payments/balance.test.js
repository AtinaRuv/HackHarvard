const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeContributions } = require('./balance');
const { openPaymentStore } = require('./store');
const contribution = { paymentId: 'pi_one', depositId: 'd1', amountCents: 2500 };
const deposit = { _id: 'd1', description: 'Stripe test contribution pi_one', amount: 25, status: 'completed' };

test('completed verified deposit gives 25 even when Nessie account balance remains zero', () => {
  assert.deepEqual(summarizeContributions({ contributions: [contribution], deposits: [deposit] }), {
    simulatedContributionBalance: 25, confirmedContributionCount: 1, unmatchedContributionCount: 0,
  });
});
test('unrelated deposits do not count, and repeated deposit records do not double count', () => {
  assert.equal(summarizeContributions({ contributions: [contribution], deposits: [deposit, { ...deposit, _id: 'other' }] }).simulatedContributionBalance, 25);
  assert.equal(summarizeContributions({ contributions: [contribution], deposits: [deposit, deposit] }).simulatedContributionBalance, 0);
});
test('pending, missing, wrong-amount or wrong-payment deposits are excluded and reported', () => {
  for (const deposits of [[], [{ ...deposit, status: 'pending' }], [{ ...deposit, amount: 26 }], [{ ...deposit, description: 'Stripe test contribution pi_wrong' }]]) {
    const result = summarizeContributions({ contributions: [contribution], deposits });
    assert.equal(result.simulatedContributionBalance, 0);
    assert.equal(result.unmatchedContributionCount, 1);
  }
});
test('contribution total includes all saved shares for only the requested account', () => {
  const store = openPaymentStore(':memory:');
  try {
    for (const [id, accountId] of [['one', 'a'], ['two', 'a'], ['three', 'b']]) {
      store.register({ shareId: id, bookingId: 'book', participantId: id, paymentAttemptId: id, accountId, amountCents: 2500, currency: 'usd' });
      store.claim(id, 'pi_' + id, 'evt_' + id);
      store.finish(id, 'd_' + id);
    }
    const contributions = store.recordedContributions('a');
    assert.equal(contributions.length, 2);
    const deposits = contributions.map(c => ({ _id: c.depositId, amount: 25, status: 'completed', description: `Stripe test contribution ${c.paymentId}` }));
    assert.equal(summarizeContributions({ contributions, deposits }).simulatedContributionBalance, 50);
  } finally { store.close(); }
});
