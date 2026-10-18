const MAX_PAGE_BYTES = 2 * 1024 * 1024;

function validateUrl(input, approvedHosts) {
  if (typeof input !== "string" || input.length > 2048) throw new Error("A valid HTTPS URL is required.");
  let url;
  try { url = new URL(input); } catch { throw new Error("A valid HTTPS URL is required."); }
  const host = url.hostname;
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !host.includes(".") || require("node:net").isIP(host.replace(/^\[|\]$/g, "")) ||
      /(^|\.)(localhost|local|internal|lan|home|test|invalid|onion|arpa)$/.test(host) ||
      !approvedHosts.includes(host)) {
    throw new Error("Only approved public HTTPS destinations on port 443 are permitted.");
  }
  url.hash = "";
  return url.href;
}

function validateBookingUrl(input, approvedUrls) {
  const url = validateUrl(input, approvedUrls.map((value) => new URL(value).hostname));
  const parsed = new URL(url);
  // Exact approval is the primary boundary; these checks also reject common
  // action/capability URLs. Never approve GET endpoints that change a booking.
  const unsafePath = /\/(?:cancel|confirm|reserve|book|checkout|payment|purchase|delete|modify)(?:\/|$)/i;
  const unsafeQuery = /token|secret|password|credential|api.?key|auth|session|signature|redirect|return.?url|next|action|_method/i;
  let path;
  try { path = decodeURIComponent(parsed.pathname); } catch { throw new Error("Invalid URL encoding."); }
  if (!approvedUrls.includes(url) || unsafePath.test(path) || [...parsed.searchParams.keys()].some((key) => unsafeQuery.test(key))) {
    throw new Error("Only explicitly approved read-only listing URLs without credentials or action parameters are permitted.");
  }
  return url;
}

function isPublicIPv4(address) {
  if (require("node:net").isIP(address) !== 4) return false;
  const [a, b, c] = address.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) ||
    (a === 192 && b === 88 && c === 99) || (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
}

// Node HTTPS does not follow redirects. This lookup hands the socket a checked
// address directly, so a later DNS change cannot redirect it into a private net.
// The optional transport arguments let local tests run without any networking.
function fetchPublicHtml(input, approvedHosts, transport = {}) {
  const url = new URL(validateUrl(input, approvedHosts));
  const request = transport.request || require("node:https").request;
  const resolve = transport.lookup || require("node:dns").lookup;
  return new Promise((accept, reject) => {
    const signal = AbortSignal.timeout(15000);
    const req = request(url, {
      method: "GET",
      agent: false,
      family: 4,
      autoSelectFamily: false,
      servername: url.hostname,
      rejectUnauthorized: true,
      signal,
      headers: { accept: "text/html", "accept-encoding": "identity" },
      lookup(host, options, callback) {
        if (host !== url.hostname) return callback(new Error("Unexpected DNS destination."));
        resolve(host, { family: 4, all: true }, (error, records) => {
          if (error) return callback(error);
          if (!records.length || !records.every((record) => isPublicIPv4(record.address))) {
            const failure = new Error("DNS resolved to a non-public address.");
            failure.code = "DNS_BLOCKED";
            return callback(failure);
          }
          const address = records[0].address;
          if (options.all) callback(null, [{ address, family: 4 }]);
          else callback(null, address, 4);
        });
      },
    }, (response) => {
      response.on("error", reject);
      const contentType = response.headers["content-type"] || "";
      let error;
      if (response.statusCode >= 300 && response.statusCode < 400) error = "Redirects are blocked.";
      else if (response.statusCode < 200 || response.statusCode >= 300) error = `HTTP ${response.statusCode}.`;
      else if (/attachment/i.test(response.headers["content-disposition"] || "")) error = "Downloads are blocked.";
      else if (!/^text\/html\b/i.test(contentType)) error = "Only HTML pages are permitted.";
      else if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") {
        error = "The site returned compressed data despite requesting uncompressed HTML.";
      }
      if (error) {
        const failure = new Error(error);
        failure.statusCode = response.statusCode;
        if (response.statusCode >= 300 && response.statusCode < 400) failure.code = "REDIRECT_BLOCKED";
        if (/Downloads/.test(error)) failure.code = "DOWNLOAD_BLOCKED";
        reject(failure);
        req.destroy(failure);
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_PAGE_BYTES) {
          const failure = new Error("Page exceeds the 2 MiB limit.");
          reject(failure);
          req.destroy(failure);
        } else chunks.push(chunk);
      });
      response.on("end", () => accept({ body: Buffer.concat(chunks), contentType,
        httpRefresh: Boolean(response.headers.refresh) }));
    });
    req.on("error", (error) => {
      // Avoid logging request headers, environment values, or TLS credentials.
      if (error.name === "AbortError") reject(new Error("HTTPS request timed out after 15 seconds."));
      else reject(error);
    });
    req.end();
  });
}

module.exports = { validateUrl, validateBookingUrl, isPublicIPv4, fetchPublicHtml, MAX_PAGE_BYTES };
