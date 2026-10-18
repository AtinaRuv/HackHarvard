// Explicitly billable: two inspections, each with a new sandbox. No automatic retries.
const assert = require('node:assert/strict');
const { getDemoUrls, inspectBeforeContributions } = require('./inspection');

async function main() {
  if (process.argv.length !== 4 || process.argv[3] !== '--confirm-billable') {
    throw new Error('Usage (only with approval): node daytona/staynest/live.js https://YOUR-DEPLOYED-ORIGIN --confirm-billable');
  }
  const urls = getDemoUrls(process.argv[2]);
  const original = process.env.LEASH_INSPECTION_URLS;
  try {
    process.env.LEASH_INSPECTION_URLS = JSON.stringify(urls);
    for (const [index, url] of urls.entries()) {
      let contributionCallbacks = 0;
      const report = await inspectBeforeContributions({ url }, (inspection, authorization) => {
        // Record eligibility only. Never call Nessie or create a funding group.
        assert.equal(index, 0, 'Malicious pages must never reach contributions.');
        assert.equal(authorization.scope, 'simulated_contributions_only');
        assert.equal(authorization.booking.totalPrice, 400);
        contributionCallbacks++;
      });
      console.log(JSON.stringify(report, null, 2));
      assert.equal(report.contributionFlowOpened, index === 0);
      assert.equal(contributionCallbacks, index === 0 ? 1 : 0);
      assert.equal(report.safeToProceed, index === 0);
      assert.equal(report.authorization.status, index === 0 ? 'approved' : 'blocked');
      assert.equal(report.inspection.safeToProceed, false);
      assert.ok(!report.inspection.cleanup, 'Cleanup was not confirmed; see the reported sandbox identity.');
      assert.equal(report.inspection.bookingDetails.totalPrice, 400, 'Expected booking fields from the rendered demo.');
      assert.equal(report.inspection.bookingDetails.guests, 4);
      assert.equal(report.inspection.security.promptInjectionDetected, index === 1);
      assert.equal(report.merchantVerification.status, index === 1 ? 'mismatch' : 'match');
      if (index === 1) assert.ok(report.inspection.security.findings.some((finding) => finding.type === 'payment_destination_mismatch'));
      if (index === 1) assert.ok(report.inspection.security.findings.some((finding) => finding.type === 'prompt_injection' && finding.severity === 'high'));
    }
  } finally {
    if (original === undefined) delete process.env.LEASH_INSPECTION_URLS;
    else process.env.LEASH_INSPECTION_URLS = original;
  }
}
if (require.main === module) main().catch(() => {
  console.error('Live comparison failed; inspect the structured reports above. No retry was attempted.');
  process.exitCode = 1;
});
