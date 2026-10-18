const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { publishResultsPage, releaseResultsPage, getResultsPageUrl } = require("./page");
const { fixtureUrl } = require("./test-fixture");

function sandboxDouble({ url = fixtureUrl, startFails = false, revokeFails = false } = {}) {
  const files = new Map();
  const calls = [];
  const sandbox = {
    files, calls,
    fs: { async uploadFile(buffer, path) { files.set(path, buffer.toString()); } },
    process: { async executeCommand(command) {
      calls.push("start");
      const source = command.slice("node -e '".length, -1).replace(/'\\''/g, "'");
      new vm.Script(source);
      return { exitCode: startFails ? 1 : 0, result: "Results server ready" };
    } },
    async getSignedPreviewUrl(port, seconds) {
      calls.push("sign"); assert.equal(port, 3000); assert.equal(seconds, 120);
      return { url, token: "fixture-preview-token" };
    },
    async expireSignedPreviewUrl(port, token) {
      calls.push("revoke"); assert.equal(port, 3000); assert.equal(token, "fixture-preview-token");
      if (revokeFails) throw new Error("revocation failed");
    },
  };
  return sandbox;
}

test("uploads HTML separately from fixed executable code and grants only a temporary own preview", async () => {
  const sandbox = sandboxDouble();
  assert.equal(getResultsPageUrl(sandbox), undefined);
  const html = '<p>$(do-not-execute) `not-a-command`</p>';
  assert.equal(await publishResultsPage(sandbox, html), fixtureUrl);
  assert.equal(sandbox.files.get("/tmp/leash-hotels.html"), html);
  assert.ok(!sandbox.files.get("/tmp/leash-hotels.cjs").includes("do-not-execute"));
  new vm.Script(sandbox.files.get("/tmp/leash-hotels.cjs"));
  assert.equal(getResultsPageUrl(sandbox), fixtureUrl);
  assert.equal(getResultsPageUrl({}), undefined);
  await releaseResultsPage(sandbox);
  assert.equal(getResultsPageUrl(sandbox), undefined);
  assert.deepEqual(sandbox.calls, ["start", "sign", "revoke"]);
});

test("results server serves only its HTML and stops on its deadline", async () => {
  const sandbox = sandboxDouble();
  await publishResultsPage(sandbox, "<p>Historical fixture</p>");
  let handler;
  let expire;
  let closed = false;
  let disconnected = false;
  const server = {
    listen(port, host, ready) { assert.equal(port, 3000); assert.equal(host, "0.0.0.0"); ready(); },
    closeAllConnections() { disconnected = true; }, close() { closed = true; },
  };
  vm.runInNewContext(sandbox.files.get("/tmp/leash-hotels.cjs"), {
    require(name) {
      if (name === "node:fs") return { readFileSync: () => Buffer.from("<p>Historical fixture</p>") };
      if (name === "node:http") return { createServer: (callback) => { handler = callback; return server; } };
      throw new Error("Unexpected server dependency");
    },
    process: { send: (message) => assert.equal(message, "ready") },
    setTimeout(callback, ms) { assert.equal(ms, 180000); expire = callback; },
  });
  for (const [method, url, expectedStatus] of [["GET", "/", 200], ["POST", "/", 404], ["GET", "/.env", 404]]) {
    let status;
    let body;
    const response = { writeHead(value, headers) { status = value; if (headers) assert.match(headers["content-security-policy"], /default-src 'none'/); return this; }, end(value) { body = value; } };
    handler({ method, url }, response);
    assert.equal(status, expectedStatus);
    if (status === 200) assert.equal(body.toString(), "<p>Historical fixture</p>");
  }
  expire();
  assert.equal(closed, true);
  assert.equal(disconnected, true);
  await releaseResultsPage(sandbox);
});

test("start failures never approve a URL; unsafe preview URLs still get revoked", async () => {
  const failed = sandboxDouble({ startFails: true });
  await assert.rejects(publishResultsPage(failed, "<p>test</p>"), /failed to start/);
  assert.equal(getResultsPageUrl(failed), undefined);
  assert.deepEqual(failed.calls, ["start"]);
  const unsafe = sandboxDouble({ url: "https://169.254.169.254/" });
  await assert.rejects(publishResultsPage(unsafe, "<p>test</p>"), /approved/);
  await releaseResultsPage(unsafe);
  assert.deepEqual(unsafe.calls, ["start", "sign", "revoke"]);
});

test("revocation errors are reported and local approval is removed", async () => {
  const sandbox = sandboxDouble({ revokeFails: true });
  await publishResultsPage(sandbox, "<p>test</p>");
  await assert.rejects(releaseResultsPage(sandbox), /revocation failed/);
  assert.equal(getResultsPageUrl(sandbox), undefined);
});
