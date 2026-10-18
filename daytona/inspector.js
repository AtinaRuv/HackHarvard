const { getApprovedBookingUrls } = require("./config");
const { validateBookingUrl } = require("./security");
const { assessPage, failedInspection } = require("./analysis");

async function inspectInSandbox(sandbox, url, browser) {
  const page = await browser.interactWithBrowser(sandbox, url, { inspection: true });
  if (page.finalUrl !== url) return failedInspection(url, "blocked", "navigation_policy", "Unexpected final URL; the page cannot be trusted.");
  const result = assessPage(url, page);
  // Computed by our remote worker from the exact bytes given to Chromium,
  // never read from a page-provided hash or token.
  if (/^[a-f0-9]{64}$/.test(page.documentSha256 || '')) {
    result.evidence = { documentSha256: page.documentSha256, browserClosed: true, sandboxDeleted: false };
  }
  return result;
}

// Only the first argument is the public API; optional dependencies are for local tests.
async function inspectBookingUrl(input, { browser: injected, approvedUrls } = {}) {
  let url;
  try {
    if (!injected) require("dotenv").config({ quiet: true });
    url = validateBookingUrl(input?.url, approvedUrls || getApprovedBookingUrls());
  } catch {
    // Do not echo an invalid URL: it may contain credentials or a capability token.
    return failedInspection(null, "blocked", "url_policy", "URL is invalid, unapproved, or not a permitted public read-only HTTPS listing.");
  }
  let sandbox;
  let result;
  let browser;
  try {
    browser = injected || require("./sandbox");
    sandbox = await browser.createSandbox();
    result = await inspectInSandbox(sandbox, url, browser);
  } catch (error) {
    const blocked = ["DNS_BLOCKED", "REDIRECT_BLOCKED", "DOWNLOAD_BLOCKED", "NAVIGATION_BLOCKED"].includes(error.code);
    result = failedInspection(url, blocked ? "blocked" : "inconclusive", blocked ? "network_policy" : "inspection_failed",
      blocked ? "A disallowed network destination, redirect, or download was blocked." : "Browser startup, navigation, extraction or browser cleanup failed; inspection is inconclusive.");
    if (error.code === "BROWSER_CLEANUP_FAILED") result.security.findings.push({ type: "browser_cleanup_failed", severity: "high", description: "Browser cleanup failed; sandbox deletion is still attempted." });
    if (error.cleanup) {
      result.cleanup = error.cleanup;
      result.security.findings.push({ type: "cleanup_failed", severity: "high", description: "Startup cleanup could not be confirmed; find the sandbox by the reported ID or name." });
    }
  } finally {
    if (sandbox) {
      try {
        await browser.deleteSandbox(sandbox);
        if (result?.evidence) result.evidence.sandboxDeleted = true;
      }
      catch {
        result = result || failedInspection(url, "inconclusive", "inspection_failed", "Inspection did not complete.");
        result.status = result.security.status = "inconclusive";
        result.security.inspectionComplete = false;
        result.safeToProceed = false;
        result.security.findings.push({ type: "cleanup_failed", severity: "high", description: "Sandbox deletion failed; manual cleanup is required." });
        result.cleanup = { deleted: false, sandboxId: sandbox.id };
      }
    }
  }
  return result;
}

module.exports = { inspectBookingUrl, inspectInSandbox };
