// Backend-owned demo authorization. This file is never served with the website.
// The webpage cannot supply or edit this expected recipient.
const demoAuthorization = Object.freeze({
  policy: 'staynest-demo-contributions-v1',
  listingReference: 'staynest-harbor-view-loft',
  listingUrl: 'https://leash-staynest-demo.foggylyric64.chatgpt.site/legitimate',
  // Reviewed build with visible fees. A changed deployment must be reviewed
  // and explicitly re-pinned here; never learn this value from a website.
  documentSha256: '18dc460b600c79d00b3ca892d14b777f1c128ea048790179da88e7250d2dac57',
  merchantId: 'STAYNEST-MERCHANT-001',
  terms: Object.freeze({
    propertyName: 'Harbor View Loft', address: 'Boston, Massachusetts (fictional listing)',
    roomType: 'Entire loft in Boston, Massachusetts',
    checkIn: '2026-10-24', checkOut: '2026-10-25', guests: 4,
    displayedPrice: 400, totalPrice: 400, currency: 'USD', priceBasis: 'total_group_stay',
    taxesAndFees: 'Includes $30 cleaning and $20 service; $0 additional demo taxes.',
    cancellationPolicy: 'Free cancellation before 2026-10-20.', availability: 'available',
  }),
});

function verifyMerchant(observedId) {
  const observed = typeof observedId === 'string' && /^[A-Z0-9_-]{1,80}$/.test(observedId) ? observedId : null;
  return { status: observed === null ? 'unverified' : observed === demoAuthorization.merchantId ? 'match' : 'mismatch',
    expectedMerchantId: demoAuthorization.merchantId, observedMerchantId: observed };
}

// This authorizes simulated contributions only, never booking or payment.
// Raw inspection stays conservative; only this reviewed artifact has a policy.
function authorizeDemoContributions(inspection) {
  const security = inspection?.security;
  const details = inspection?.bookingDetails;
  const evidence = inspection?.evidence;
  const coverage = security?.coverage;
  const findings = security?.findings;
  const checks = {
    approvedListing: inspection?.url === demoAuthorization.listingUrl && details?.listingUrl === demoAuthorization.listingUrl,
    reviewedDocument: evidence?.documentSha256 === demoAuthorization.documentSha256,
    merchant: verifyMerchant(details?.merchantId).status === 'match',
    bookingTerms: Object.entries(demoAuthorization.terms).every(([key, value]) => details?.[key] === value),
    completeFields: Array.isArray(security?.missingFields) && security.missingFields.length === 0,
    completeScan: coverage?.staticDomOnly === true && coverage.hiddenTextIncluded === true &&
      coverage.scriptsExecuted === false && coverage.truncated === false && Number.isInteger(coverage.nodesScanned) && coverage.nodesScanned > 0 && coverage.nodesScanned <= 3000,
    expectedAssessment: inspection?.status === 'inconclusive' && security?.status === 'inconclusive' &&
      security.inspectionComplete === false && security.promptInjectionDetected === false && inspection.dataTrust === 'untrusted_page_claims',
    // Only the known script/form/image limitation of the exact pinned UI is
    // accepted. Any other finding, missing evidence or changed HTML blocks.
    findings: Array.isArray(findings) && findings.length === 1 && findings[0]?.type === 'uninspected_behavior' && findings[0]?.severity === 'medium',
    cleanup: evidence?.browserClosed === true && evidence.sandboxDeleted === true && !inspection?.cleanup,
  };
  const approved = Object.values(checks).every(value => value === true);
  return { policy: demoAuthorization.policy, scope: 'simulated_contributions_only',
    status: approved ? 'approved' : 'blocked', safeToProceed: approved, checks,
    acceptedLimitations: approved ? ['Known UI scripts, forms and images remained blocked; dynamic behavior is not certified.'] : [],
    // Contribution amounts come from this backend record, never from page instructions.
    booking: approved ? { listingReference: demoAuthorization.listingReference, listingUrl: demoAuthorization.listingUrl,
      merchantId: demoAuthorization.merchantId, ...demoAuthorization.terms } : null };
}
module.exports = { demoAuthorization, verifyMerchant, authorizeDemoContributions };
