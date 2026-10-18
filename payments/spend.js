const { summarizeContributions } = require('./balance');
const { readAccountDeposits, subtractFromAccount } = require('../nessie/client');

// authorizeBooking is an application-owned backend callback, not browser input.
// It must check the booking rules and return the stored spending amount and a
// stable authorizationId. Retries must reuse that same authorization and operation.
function buildBookingSpender({ store, authorizeBooking, readDeposits = readAccountDeposits, withdraw = subtractFromAccount }) {
  if (typeof authorizeBooking !== 'function') throw new Error('A trusted booking authorization callback is required.');
  return async function spendBooking({ bookingId, operationId } = {}) {
    for (const value of [bookingId, operationId]) {
      if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw new Error('Invalid booking or spending operation ID.');
    }
    const approval = await authorizeBooking(bookingId);
    if (!approval || approval.bookingId !== bookingId ||
        typeof approval.authorizationId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(approval.authorizationId)) {
      throw new Error('Booking spending is not authorized.');
    }
    const { amountCents } = approval;
    if (!Number.isSafeInteger(amountCents) || amountCents < 100 || amountCents > 99_999_999 || amountCents % 100 !== 0) {
      throw new Error('Authorized amount must be positive whole USD dollars in cents.');
    }
    const accountId = store.bookingAccount(bookingId);
    if (approval.accountId !== accountId) throw new Error('Authorization account does not match the saved booking.');
    const input = { bookingId, operationId, accountId, amountCents, authorizationId: approval.authorizationId };
    const deposits = await readDeposits(accountId);
    const summary = summarizeContributions({ contributions: store.recordedContributions(accountId), deposits });
    if (summary.unmatchedContributionCount > 0) throw new Error('Saved contributions need reconciliation before spending.');
    const reservation = store.reserveSpending(input, Math.round(summary.simulatedContributionBalance * 100));
    if (!reservation.claimed) {
      if (reservation.record.status === 'recorded') return { status: 'already_recorded', withdrawalId: reservation.record.withdrawalId };
      throw new Error('Spending is in progress or needs review. No additional withdrawal was sent.');
    }
    try {
      const { withdrawalId } = await withdraw({ accountId, amountCents, operationId });
      if (typeof withdrawalId !== 'string' || !withdrawalId.trim()) throw new Error('Missing withdrawal ID.');
      store.finishSpending(operationId, withdrawalId);
      return { status: 'recorded', withdrawalId };
    } catch {
      store.reviewSpending(operationId);
      throw new Error('Withdrawal needs review. Funds remain reserved; do not repeat the Nessie POST.');
    }
  };
}
module.exports = { buildBookingSpender };
