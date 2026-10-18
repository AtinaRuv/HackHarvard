const { inspectBookingUrl } = require('../index');
const { validateUrl } = require('../security');
const { verifyMerchant, authorizeDemoContributions } = require('./authorization');

function getDemoUrls(origin) {
  const parsed = new URL(origin);
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('Use the deployed HTTPS origin, without a path or query.');
  const approved = validateUrl(origin, [parsed.hostname]);
  // Use the exact canonical paths; alternate spellings do not grant approval.
  return ['legitimate', 'malicious'].map((name) => new URL(name, approved).href);
}

// Demonstration boundary only: real evidence plus backend-owned authorization.
// Pass trusted backend dependencies here, never values from an HTTP request.
async function inspectBeforeContributions({ url }, openContributions, { inspect = inspectBookingUrl } = {}) {
  const inspection = await inspect({ url });
  const merchantVerification = verifyMerchant(inspection.bookingDetails?.merchantId);
  if (merchantVerification.status === 'mismatch') {
    inspection.security.findings.push({ type: 'payment_destination_mismatch', severity: 'high',
      description: 'The page-claimed recipient differs from the backend-authorized demo merchant.' });
    inspection.status = 'blocked';
    inspection.security.status = 'review_required';
    inspection.safeToProceed = false;
  }
  const authorization = authorizeDemoContributions(inspection);
  const canOpen = authorization.safeToProceed;
  if (canOpen) {
    if (typeof openContributions !== 'function') throw new Error('A trusted backend contribution handler is required.');
    await openContributions(inspection, authorization);
  }
  return { status: canOpen ? 'approved_for_demo_contributions' : 'blocked', safeToProceed: canOpen,
    inspection, merchantVerification, authorization, contributionFlowOpened: canOpen };
}
module.exports = { getDemoUrls, inspectBeforeContributions };
