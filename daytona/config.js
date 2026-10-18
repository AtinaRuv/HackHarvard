const { validateUrl, validateBookingUrl } = require("./security");
const EXAMPLE_URL = "https://example.com/";

// Backend configuration only: exact, public, read-only URLs with permission to inspect.
function getApprovedBookingUrls() {
  let values;
  try { values = JSON.parse(process.env.LEASH_INSPECTION_URLS || "[]"); }
  catch { throw new Error("LEASH_INSPECTION_URLS must be a JSON array of approved HTTPS page URLs."); }
  if (!Array.isArray(values) || values.length > 25) throw new Error("Configure at most 25 approved inspection URLs.");
  const urls = values.map((value) => validateUrl(value, [new URL(value).hostname]));
  return urls.map((url) => validateBookingUrl(url, urls));
}

function getApprovedUrls() { return [EXAMPLE_URL, ...getApprovedBookingUrls()]; }

module.exports = { EXAMPLE_URL, getApprovedUrls, getApprovedBookingUrls };
