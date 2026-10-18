const test = require("node:test");
const assert = require("node:assert/strict");
const { inspectBookingUrl } = require("./index");
const { extractPage } = require("./analysis");
const { fixtureRoot, fixtureUrl, fixtures } = require("./test-fixture");

function dependencies({ html = fixtures.normal, createError, readError, deleteError, pageOverrides = {} } = {}) {
  const calls = [];
  return { calls, approvedUrls: [fixtureUrl], browser: {
    async createSandbox() { calls.push("create"); if (createError) throw createError instanceof Error ? createError : new Error("create failed"); return { id: "fixture-sandbox" }; },
    async interactWithBrowser(sandbox, url, options) {
      calls.push("read");
      assert.equal(url, fixtureUrl); assert.equal(options.inspection, true);
      if (readError) throw readError;
      return { finalUrl: url, title: "Fixture", ...extractPage(fixtureRoot(html), true), blockedRequests: 0, httpRefresh: false, ...pageOverrides };
    },
    async deleteSandbox() { calls.push("delete"); if (deleteError) throw new Error("sensitive SDK error must be withheld"); },
  } };
}

test("public export is only inspectBookingUrl, with remote read and guaranteed deletion attempt", async () => {
  assert.deepEqual(Object.keys(require("./index")), ["inspectBookingUrl"]);
  const deps = dependencies();
  const result = await inspectBookingUrl({ url: fixtureUrl }, deps);
  assert.equal(result.status, "inspected");
  assert.equal(result.bookingDetails.totalPrice, 320);
  assert.equal(result.safeToProceed, false);
  assert.deepEqual(deps.calls, ["create", "read", "delete"]);
});

test("every malicious fixture returns findings and still deletes its sandbox", async () => {
  for (const name of ["injection", "hidden", "redirect", "payment", "script", "comment", "encoded"]) {
    const deps = dependencies({ html: fixtures[name] });
    const result = await inspectBookingUrl({ url: fixtureUrl }, deps);
    assert.ok(result.security.findings.length > 0, name);
    assert.equal(result.safeToProceed, false);
    assert.deepEqual(deps.calls, ["create", "read", "delete"]);
  }
});

test("unsafe and unapproved URLs fail before allocation, without echoing credentials", async () => {
  const deps = dependencies();
  for (const url of [undefined, "bad", "http://example.com/", "https://localhost/", "https://127.0.0.1/",
    "https://10.0.0.1/", "https://[::1]/", "https://169.254.169.254/", "file:///etc/passwd",
    "https://user:password@example.com/", "https://booking.com/hotel/123", "https://hotels.example.com/other"]) {
    const result = await inspectBookingUrl({ url }, deps);
    assert.equal(result.status, "blocked");
    assert.equal(result.url, null);
    assert.equal(result.safeToProceed, false);
  }
  assert.deepEqual(deps.calls, []);
});

test("network policy failures are blocked and navigation/extraction failures are inconclusive", async () => {
  for (const code of ["DNS_BLOCKED", "REDIRECT_BLOCKED", "DOWNLOAD_BLOCKED", "NAVIGATION_BLOCKED", "ECONNRESET"]) {
    const error = new Error("sensitive transport diagnostic"); error.code = code;
    const deps = dependencies({ readError: error });
    const result = await inspectBookingUrl({ url: fixtureUrl }, deps);
    assert.equal(result.status, code === "ECONNRESET" ? "inconclusive" : "blocked");
    assert.equal(result.safeToProceed, false);
    assert.ok(!JSON.stringify(result).includes("sensitive"));
    assert.deepEqual(deps.calls, ["create", "read", "delete"]);
  }
});

test("invalid extraction and changed final URLs cannot establish an inspection", async () => {
  for (const pageOverrides of [{ scan: null }, { finalUrl: "https://attacker.example/" }]) {
    const deps = dependencies({ pageOverrides });
    const result = await inspectBookingUrl({ url: fixtureUrl }, deps);
    assert.ok(["blocked", "inconclusive"].includes(result.status));
    assert.deepEqual(deps.calls, ["create", "read", "delete"]);
  }
});

test("failed deletion reports the sandbox ID and cannot return a passing result", async () => {
  const deps = dependencies({ deleteError: true });
  const result = await inspectBookingUrl({ url: fixtureUrl }, deps);
  assert.equal(result.status, "inconclusive");
  assert.equal(result.cleanup.sandboxId, "fixture-sandbox");
  assert.equal(result.cleanup.deleted, false);
  assert.equal(result.safeToProceed, false);
  assert.ok(!JSON.stringify(result).includes("sensitive"));
});

test("failed creation returns inconclusive without deleting a nonexistent handle", async () => {
  const deps = dependencies({ createError: true });
  const result = await inspectBookingUrl({ url: fixtureUrl }, deps);
  assert.equal(result.status, "inconclusive");
  assert.deepEqual(deps.calls, ["create"]);
});

test("partial startup cleanup failure preserves the sandbox identity without SDK diagnostics", async () => {
  const error = new Error("sensitive SDK diagnostic");
  error.cleanup = { deleted: false, sandboxId: "startup-sandbox", sandboxName: "leash-browser-fixture" };
  const deps = dependencies({ createError: error });
  const result = await inspectBookingUrl({ url: fixtureUrl }, deps);
  assert.equal(result.cleanup.sandboxId, "startup-sandbox");
  assert.equal(result.status, "inconclusive");
  assert.ok(!JSON.stringify(result).includes("sensitive"));
});
