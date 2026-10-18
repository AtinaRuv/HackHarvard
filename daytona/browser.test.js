const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { fixtureRoot, fixtureHtml, fixtureUrl } = require("./test-fixture");

// Load the real module with fake SDK/Playwright clients. No API key is read and
// no Daytona client, browser, DNS lookup, or network connection is created.
function loadBrowser({ navigationError, contextCloseError, extraRequests = [], text = "Real page text", body, url = "https://example.com/" } = {}) {
  const closed = [];
  let handler;
  let fulfilled;
  let aborted = false;
  const frame = {};
  const page = {
    mainFrame: () => frame,
    async goto(destination, options) {
      assert.equal(destination, url);
      assert.equal(options.waitUntil, "load");
      assert.equal(options.timeout, 30000);
      if (navigationError) throw new Error(navigationError);
      await handler({
        request: () => ({ url: () => url, method: () => "GET",
          isNavigationRequest: () => true, frame: () => frame, redirectedFrom: () => null }),
        async fulfill(value) { fulfilled = value; },
        async abort() { aborted = true; },
      });
      for (const extra of extraRequests) {
        await handler({
          request: () => ({ url: () => extra.url, method: () => extra.method || "GET",
            isNavigationRequest: () => Boolean(extra.navigation), frame: () => frame, redirectedFrom: () => null }),
          async fulfill() { throw new Error("Unexpected extra fulfillment"); },
          async abort() { if (extra.navigation) aborted = true; },
        });
      }
      if (aborted) throw new Error("Navigation aborted");
    },
    url: () => url,
    async title() { return "Example Domain"; },
    locator: () => ({ evaluate: async (extract, inspection) => extract(body || { innerText: text }, inspection) }),
  };
  const context = {
    async newPage() { return page; },
    async route(pattern, callback) { handler = callback; },
    async close() { closed.push("context"); if (contextCloseError) throw new Error("close failed"); },
  };
  const browser = { async newContext(options) {
    assert.equal(options.javaScriptEnabled, false);
    assert.equal(options.acceptDownloads, false);
    assert.equal(options.ignoreHTTPSErrors, false);
    assert.equal(options.serviceWorkers, "block");
    assert.equal(options.permissions.length, 0);
    return context;
  }, async close() { closed.push("browser"); } };
  const scope = {
    module: { exports: {} }, URL, Buffer, AbortSignal, TextDecoder, setTimeout, clearTimeout,
    process: { env: {} }, console: { log() {} },
    require(name) {
      if (name === "@daytonaio/sdk") return { Daytona: class {}, Image: {} };
      if (name === "dotenv") return { config() {} };
      if (name === "./security") return require("./security");
      if (name === "./analysis") return require("./analysis");
      if (name === "./page") return require("./page");
      if (name === "./config") return {
        EXAMPLE_URL: "https://example.com/", getApprovedUrls: () => ["https://example.com/", fixtureUrl],
      };
      if (name === "node:crypto") return require("node:crypto");
      if (name === "/opt/leash-browser/node_modules/playwright") return { chromium: { launch: async () => browser } };
      throw new Error(`Unexpected dependency in local test: ${name}`);
    },
  };
  const source = fs.readFileSync(`${__dirname}/sandbox.js`, "utf8");
  vm.runInNewContext(`${source}\nmodule.exports.readPage = (url, offline, hosts, fetch, hotels = false) =>
    readPageInSandbox(url, offline, hosts, fetch, hotels, extractPage);`, scope);
  return { ...scope.module.exports, closed, response: () => fulfilled };
}

test("returns page URL, title and visible text, then closes browser resources", async () => {
  const browser = loadBrowser();
  const outcome = await browser.readPage("https://example.com/", false, ["example.com"],
    async () => ({ body: Buffer.from("<p>Real page text</p>"), contentType: "text/html" }));
  assert.equal(outcome.errors.length, 0);
  assert.equal(outcome.data.finalUrl, "https://example.com/");
  assert.equal(outcome.data.title, "Example Domain");
  assert.equal(outcome.data.content, "Real page text");
  assert.deepEqual(browser.closed, ["context", "browser"]);
});

test("offline mode fulfills synthetic HTML without fetching a website", async () => {
  const browser = loadBrowser();
  const outcome = await browser.readPage("https://example.com/", true, ["example.com"],
    async () => { throw new Error("The offline test must not fetch a website"); });
  assert.equal(outcome.errors.length, 0);
  assert.match(browser.response().body, /Synthetic HTML/);
  assert.deepEqual(browser.closed, ["context", "browser"]);
});

test("navigation errors still close the context and browser", async () => {
  const browser = loadBrowser({ navigationError: "navigation failed" });
  const outcome = await browser.readPage("https://example.com/", false, ["example.com"], async () => {});
  assert.match(outcome.errors.join("; "), /navigation failed/);
  assert.deepEqual(browser.closed, ["context", "browser"]);
});

test("fetch failures are reported and cleaned up without retrying", async () => {
  const browser = loadBrowser();
  let attempts = 0;
  const outcome = await browser.readPage("https://example.com/", false, ["example.com"], async () => {
    attempts++;
    throw new Error("ECONNRESET");
  });
  assert.equal(attempts, 1);
  assert.match(outcome.errors.join("; "), /ECONNRESET/);
  assert.deepEqual(browser.closed, ["context", "browser"]);
});

test("a context cleanup failure does not skip browser cleanup", async () => {
  const browser = loadBrowser({ contextCloseError: true });
  const outcome = await browser.readPage("https://example.com/", true, ["example.com"], async () => {});
  assert.match(outcome.errors.join("; "), /Browser context cleanup failed/);
  assert.deepEqual(browser.closed, ["context", "browser"]);
});

test("extracted content is limited and truncation is reported", async () => {
  const browser = loadBrowser({ text: "x".repeat(25000) });
  const outcome = await browser.readPage("https://example.com/", true, ["example.com"], async () => {});
  assert.equal(outcome.data.content.length, 20000);
  assert.equal(outcome.data.contentTruncated, true);
});

test("unsafe URLs are rejected before running remote commands", async () => {
  const browser = loadBrowser();
  const sandbox = { process: { executeCommand() { throw new Error("Must not execute"); } } };
  await assert.rejects(browser.interactWithBrowser(sandbox, "https://169.254.169.254/"), /approved/);
});

test("generated remote script compiles and contains no client credentials", async () => {
  const browser = loadBrowser();
  let source;
  const sandbox = { process: { async executeCommand(command) {
    source = command.slice("node -e '".length, -1).replace(/'\\''/g, "'");
    new vm.Script(source);
    return { exitCode: 0, result: JSON.stringify({ errors: [], data: {
      finalUrl: "https://example.com/", title: "Example Domain", content: "Text", contentTruncated: false,
    } }) };
  } } };
  const result = await browser.interactWithBrowser(sandbox, "https://example.com/");
  assert.equal(result.content, "Text");
  assert.ok(!source.includes("DAYTONA_API_KEY"));
});

test("browser worker uses the DOM extraction function on controlled booking fields", async () => {
  const browser = loadBrowser({ body: fixtureRoot(), url: fixtureUrl });
  const outcome = await browser.readPage(fixtureUrl, false, ["hotels.example.com"],
    async () => ({ body: Buffer.from(fixtureHtml), contentType: "text/html" }), true);
  assert.equal(outcome.errors.length, 0);
  assert.equal(outcome.data.facts.propertyName, "Leash Fixture Hotel");
  assert.equal(outcome.data.facts.currency, "USD");
  assert.equal(outcome.data.scan.activeScripts, 0);
  assert.deepEqual(browser.closed, ["context", "browser"]);
});

test("inspection refuses speculative-link HTML and non-UTF8 documents before rendering", async () => {
  for (const response of [
    { body: Buffer.from('<link rel="preconnect" href="https://169.254.169.254/">'), contentType: "text/html" },
    { body: Buffer.from("test"), contentType: "text/html; charset=utf-16" },
  ]) {
    const browser = loadBrowser({ body: fixtureRoot(), url: fixtureUrl });
    const result = await browser.readPage(fixtureUrl, false, ["hotels.example.com"], async () => response, true);
    assert.equal(result.data, null);
    assert.ok(result.errors.length > 0);
    assert.deepEqual(browser.closed, ["context", "browser"]);
  }
});

test("external subrequests and POST actions are never fetched or fulfilled", async () => {
  const browser = loadBrowser({ body: fixtureRoot(), url: fixtureUrl, extraRequests: [
    { url: "https://169.254.169.254/latest/meta-data/" },
    { url: fixtureUrl, method: "POST" },
  ] });
  let fetched = 0;
  const result = await browser.readPage(fixtureUrl, false, ["hotels.example.com"], async () => {
    fetched++;
    return { body: Buffer.from(fixtureHtml), contentType: "text/html" };
  }, true);
  assert.equal(fetched, 1);
  assert.equal(result.data.blockedRequests, 2);
  assert.match(browser.response().headers["content-security-policy"], /form-action 'none'/);
});

test("other paths on an approved hostname are still rejected before execution", async () => {
  const browser = loadBrowser();
  await assert.rejects(browser.interactWithBrowser({}, "https://hotels.example.com/admin"), /approved page/);
});

test("signed-preview credentials in command or worker errors are withheld", async () => {
  const browser = loadBrowser();
  const failedCommand = { process: { async executeCommand() { throw new Error("secret preview URL"); } } };
  await assert.rejects(browser.interactWithBrowser(failedCommand, fixtureUrl, { inspection: true }),
    (error) => error.message.includes("withheld") && !error.message.includes("secret preview"));
  const failedWorker = { process: { async executeCommand() {
    return { exitCode: 0, result: JSON.stringify({ errors: ["secret preview URL"], data: null }) };
  } } };
  await assert.rejects(browser.interactWithBrowser(failedWorker, fixtureUrl, { inspection: true }),
    (error) => error.message.includes("withheld") && !error.message.includes("secret preview"));
});
