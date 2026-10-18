// Nessie's current API can persist completed deposits without updating account.balance.
// Calculate ONLY confirmed contributions belonging to our saved account mappings.
// This is a contribution total, not spendable funds or the Nessie account balance.
function summarizeContributions({ contributions, deposits }) {
  if (!Array.isArray(deposits)) throw new Error('Expected a Nessie deposit list.');
  const seen = new Set();
  let totalCents = 0;
  let confirmedCount = 0;
  let unmatchedCount = 0;
  for (const contribution of contributions) {
    if (seen.has(contribution.depositId)) throw new Error('Duplicate saved Nessie deposit ID.');
    seen.add(contribution.depositId);
    const matches = deposits.filter(d => d._id === contribution.depositId);
    const deposit = matches[0];
    if (matches.length !== 1 || deposit.status !== 'completed' ||
        deposit.description !== `Stripe test contribution ${contribution.paymentId}` ||
        !Number.isSafeInteger(deposit.amount) || deposit.amount * 100 !== contribution.amountCents) {
      unmatchedCount++;
      continue;
    }
    totalCents += contribution.amountCents;
    if (!Number.isSafeInteger(totalCents)) throw new Error('Contribution total is too large.');
    confirmedCount++;
  }
  return { simulatedContributionBalance: totalCents / 100, confirmedContributionCount: confirmedCount, unmatchedContributionCount: unmatchedCount };
}
module.exports = { summarizeContributions };

function summarizeSpending({ contributionSummary, spending, withdrawals }) {
  if (!Array.isArray(withdrawals)) throw new Error('Expected Nessie withdrawals.');
  let reservedCents = 0;
  let confirmedWithdrawalCount = 0;
  let unmatchedWithdrawalCount = 0;
  for (const record of spending) {
    reservedCents += record.amountCents;
    if (record.status !== 'recorded') continue;
    const matches = withdrawals.filter(w => w._id === record.withdrawalId);
    const withdrawal = matches[0];
    if (matches.length === 1 && withdrawal.status === 'completed' &&
        withdrawal.description === `Leash spending ${record.operationId}` &&
        Number.isSafeInteger(withdrawal.amount) && withdrawal.amount * 100 === record.amountCents) {
      confirmedWithdrawalCount++;
    } else { unmatchedWithdrawalCount++; }
  }
  return {
    simulatedSpendingReserved: reservedCents / 100,
    simulatedAvailableBalance: (Math.round(contributionSummary.simulatedContributionBalance * 100) - reservedCents) / 100,
    confirmedWithdrawalCount, unmatchedWithdrawalCount,
    spendingNeedsReview: spending.some(s => s.status !== 'recorded') || unmatchedWithdrawalCount > 0 || contributionSummary.unmatchedContributionCount > 0,
  };
}
module.exports.summarizeSpending = summarizeSpending;
