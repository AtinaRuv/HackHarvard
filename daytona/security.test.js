const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { validateUrl, validateBookingUrl, isPublicIPv4, fetchPublicHtml, MAX_PAGE_BYTES } = require("./security");
const hosts = ["example.com"];

// This fake request never opens a socket or performs DNS lookup.
function fakeTransport({ addresses = ["93.184.216.34"], status = 200, type = "text/html", body = "<title>Example</title>", headers = {} } = {}) {
  const calls = [];
  return {
    calls,
    lookup(host, options, callback) {
      callback(null, addresses.map((address) => ({ address, family: 4 })));
    },
    request(url, options, callback) {
      const req = new EventEmitter();
      let destroyed = false;
      req.destroy = (error) => { destroyed = true; req.emit("error", error); };
      req.end = () => queueMicrotask(() => {
        options.lookup(url.hostname, { all: false }, (error, address) => {
          if (error) return req.destroy(error);
          calls.push({ url: url.href, address, options });
          const response = new EventEmitter();
          response.statusCode = status;
          response.headers = { "content-type": type, location: "https://127.0.0.1/", ...headers };
          callback(response);
          if (!destroyed) response.emit("data", Buffer.from(body));
          if (!destroyed) response.emit("end");
        });
      });
      return req;
    },
  };
}

test("accepts exact approved HTTPS hosts", () => {
  assert.equal(validateUrl("https://example.com/search?q=Boston#top", hosts), "https://example.com/search?q=Boston");
});

test("rejects unsafe schemes, credentials, ports, hosts, and IP literals", () => {
  const urls = ["invalid", "http://example.com/", "file:///etc/passwd", "https://user:secret@example.com/",
    "https://example.com:8443/", "https://localhost/", "https://service.internal/", "https://169.254.169.254/",
    "https://127.0.0.1/", "https://[::1]/", "https://[::ffff:127.0.0.1]/", "https://0x7f000001/",
    "https://example.com.evil.org/", "https://sub.example.com/"];
  for (const url of urls) assert.throws(() => validateUrl(url, hosts), undefined, url);
});

test("rejects private, metadata, reserved, multicast, and mapped addresses", () => {
  for (const address of ["0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254",
    "172.16.1.1", "192.168.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1",
    "224.0.0.1", "255.255.255.255", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(isPublicIPv4(address), false, address);
  }
  assert.equal(isPublicIPv4("93.184.216.34"), true);
});

test("fetches HTML using a pinned public address and verified HTTPS", async () => {
  const transport = fakeTransport();
  const result = await fetchPublicHtml("https://example.com/", hosts, transport);
  assert.equal(result.body.toString(), "<title>Example</title>");
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].address, "93.184.216.34");
  assert.equal(transport.calls[0].options.rejectUnauthorized, true);
  assert.equal(transport.calls[0].options.servername, "example.com");
  assert.equal(transport.calls[0].options.agent, false);
  assert.ok(transport.calls[0].options.signal instanceof AbortSignal);
});

test("rejects DNS changes to private addresses before a connection", async () => {
  const transport = fakeTransport();
  await fetchPublicHtml("https://example.com/", hosts, transport);
  transport.lookup = (host, options, callback) => callback(null, [{ address: "10.0.0.1", family: 4 }]);
  await assert.rejects(fetchPublicHtml("https://example.com/", hosts, transport), /non-public/);
  assert.equal(transport.calls.length, 1);
});

test("rejects mixed public/private DNS answers", async () => {
  const transport = fakeTransport({ addresses: ["93.184.216.34", "169.254.169.254"] });
  await assert.rejects(fetchPublicHtml("https://example.com/", hosts, transport), /non-public/);
  assert.equal(transport.calls.length, 0);
});

test("rejects redirects without requesting their destination", async () => {
  const transport = fakeTransport({ status: 302 });
  await assert.rejects(fetchPublicHtml("https://example.com/", hosts, transport), /Redirects/);
  assert.equal(transport.calls.length, 1);
});

test("rejects downloads and oversized pages", async () => {
  await assert.rejects(fetchPublicHtml("https://example.com/", hosts, fakeTransport({ type: "application/pdf" })), /HTML/);
  await assert.rejects(fetchPublicHtml("https://example.com/", hosts, fakeTransport({ body: "x".repeat(MAX_PAGE_BYTES + 1) })), /2 MiB/);
});

test("even an approved URL cannot contain obvious action or capability parameters", () => {
  const allowed = "https://example.com/hotel/123";
  assert.equal(validateBookingUrl(allowed, [allowed]), allowed);
  for (const url of ["https://example.com/cancel/123", "https://example.com/hotel/123?token=secret",
    "https://example.com/hotel/123?redirect=https://attacker.example", "https://example.com/hotel/123?action=reserve"]) {
    assert.throws(() => validateBookingUrl(url, [url]), /read-only/);
  }
  assert.throws(() => validateBookingUrl("https://example.com/hotel/456", [allowed]), /read-only/);
});

test("HTTP redirect and download failures have machine-readable policy codes", async () => {
  await assert.rejects(fetchPublicHtml("https://example.com/", hosts, fakeTransport({ status: 302 })), (error) => error.code === "REDIRECT_BLOCKED");
  await assert.rejects(fetchPublicHtml("https://example.com/", hosts, fakeTransport({ headers: { "content-disposition": "attachment; filename=page.html" } })), (error) => error.code === "DOWNLOAD_BLOCKED");
  const response = await fetchPublicHtml("https://example.com/", hosts, fakeTransport({ headers: { refresh: "0; url=https://attacker.example/" } }));
  assert.equal(response.httpRefresh, true); // It is reported, not sent to Chromium.
});

test("trusted allowlist configuration is exact, bounded and defaults to no booking sites", () => {
  const { getApprovedBookingUrls } = require("./config");
  const original = process.env.LEASH_INSPECTION_URLS;
  try {
    delete process.env.LEASH_INSPECTION_URLS;
    assert.deepEqual(getApprovedBookingUrls(), []);
    process.env.LEASH_INSPECTION_URLS = '["https://example.com/hotel/123"]';
    assert.deepEqual(getApprovedBookingUrls(), ["https://example.com/hotel/123"]);
    for (const value of ["bad JSON", "{}", '["http://example.com/"]', '["https://127.0.0.1/"]', '["https://example.com/cancel/123"]', JSON.stringify(Array(26).fill("https://example.com/"))]) {
      process.env.LEASH_INSPECTION_URLS = value;
      assert.throws(() => getApprovedBookingUrls());
    }
  } finally {
    if (original === undefined) delete process.env.LEASH_INSPECTION_URLS;
    else process.env.LEASH_INSPECTION_URLS = original;
  }
});
