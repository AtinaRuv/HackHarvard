const { validateUrl, MAX_PAGE_BYTES } = require("./security");
const previews = new WeakMap();
const PORT = 3000;

// This fixed server runs inside the sandbox, never on the developer's laptop.
function serveResults() {
  const html = require("node:fs").readFileSync("/tmp/leash-hotels.html");
  const server = require("node:http").createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
    });
    response.end(html);
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.listen(3000, "0.0.0.0", () => process.send("ready"));
  setTimeout(() => { server.closeAllConnections(); server.close(); }, 180000);
}

function startServer() {
  const child = require("node:child_process").spawn(process.execPath, ["/tmp/leash-hotels.cjs"], {
    detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], env: {},
  });
  const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 10000);
  child.once("error", () => { clearTimeout(timer); process.exitCode = 1; });
  child.once("exit", () => { clearTimeout(timer); process.exitCode = 1; });
  child.once("message", (message) => {
    if (message !== "ready") return;
    clearTimeout(timer);
    child.removeAllListeners("exit");
    child.disconnect();
    child.unref();
    console.log("Results server ready");
  });
}

async function publishResultsPage(sandbox, html) {
  if (typeof html !== "string" || Buffer.byteLength(html) > MAX_PAGE_BYTES) throw new Error("Invalid results HTML.");
  await sandbox.fs.uploadFile(Buffer.from(html), "/tmp/leash-hotels.html", 30);
  await sandbox.fs.uploadFile(Buffer.from(`(${serveResults.toString()})();`), "/tmp/leash-hotels.cjs", 30);
  const source = `(${startServer.toString()})();`;
  const result = await sandbox.process.executeCommand(`node -e '${source.replace(/'/g, "'\\''")}'`, undefined, undefined, 15);
  if (result.exitCode !== 0 || !result.result.includes("Results server ready")) throw new Error("Results page server failed to start.");
  const signed = await sandbox.getSignedPreviewUrl(PORT, 120);
  // Store before validation so even an invalid SDK response gets a revocation attempt.
  previews.set(sandbox, signed);
  signed.url = validateUrl(signed.url, [new URL(signed.url).hostname]);
  return signed.url;
}

function getResultsPageUrl(sandbox) {
  return previews.get(sandbox)?.url;
}

async function releaseResultsPage(sandbox) {
  const signed = previews.get(sandbox);
  previews.delete(sandbox);
  if (signed) await sandbox.expireSignedPreviewUrl(PORT, signed.token);
}

module.exports = { publishResultsPage, releaseResultsPage, getResultsPageUrl };
