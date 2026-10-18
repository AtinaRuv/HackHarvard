const { randomUUID } = require("node:crypto");
const { Daytona, Image } = require("@daytonaio/sdk");
require("dotenv").config({ quiet: true });
const { validateUrl, isPublicIPv4, fetchPublicHtml, MAX_PAGE_BYTES } = require("./security");
const { EXAMPLE_URL, getApprovedUrls } = require("./config");
const { extractPage } = require("./analysis");
const { publishResultsPage, releaseResultsPage, getResultsPageUrl } = require("./page");

const daytona = new Daytona({
  apiKey: process.env.DAYTONA_API_KEY,
  requestTimeoutMs: 30000,
});

async function createSandbox() {
  if (!process.env.DAYTONA_API_KEY) {
    throw new Error("DAYTONA_API_KEY is required in .env or the environment.");
  }

  // Preserve the working remote image setup. The matching Node package is
  // included in the image build; no local dependencies or credentials are sent.
  const image = Image.base("mcr.microsoft.com/playwright:v1.64.0-noble")
    .runCommands(
      "npm install --prefix /opt/leash-browser --save-exact --ignore-scripts --no-audit --no-fund playwright@1.64.0"
    );
  const name = `leash-browser-${randomUUID()}`;

  try {
    const sandbox = await daytona.create({
      name,
      language: "javascript",
      image,
      public: false,
      autoStopInterval: 2,
      autoDeleteInterval: 0,
      ttlMinutes: 10,
    }, { timeout: 300 });
    console.log("Sandbox created:", sandbox.id);
    return sandbox;
  } catch (error) {
    // A failed startup may still allocate a sandbox. Recover our unique name
    // and clean it up here because the caller has not received its handle.
    let allocated;
    let cleanupError;
    try {
      allocated = await daytona.get(name);
    } catch (lookupError) {
      if (lookupError.statusCode !== 404) cleanupError = lookupError;
    } finally {
      if (allocated) {
        try {
          await deleteSandbox(allocated);
        } catch (deleteError) {
          cleanupError = deleteError;
        }
      }
    }
    const cleanup = cleanupError ? ` Cleanup could not be confirmed: ${cleanupError.message}` : "";
    const failure = new Error(`Sandbox creation failed (${name}): ${error.message}.${cleanup}`);
    if (cleanupError) failure.cleanup = { deleted: false, sandboxId: allocated?.id || null, sandboxName: name };
    throw failure;
  }
}

// Runs inside Daytona. API keys stay on the client; the private preview URL is temporary.
async function readPageInSandbox(url, offline, approvedHosts, fetchHtml, inspection = false, extract = null) {
  let browser;
  let context;
  let navigationError;
  let failureCode;
  let blockedRequests = 0;
  let httpRefresh = false;
  let stage = "Browser startup";
  const outcome = { data: null, errors: [] };

  async function close(resource, label) {
    if (!resource) return;
    let timer;
    try {
      await Promise.race([
        resource.close(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("cleanup timed out after 5 seconds")), 5000);
        }),
      ]);
    } catch (error) {
      outcome.errors.push(`${label} cleanup failed: ${error.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    const { chromium } = require("/opt/leash-browser/node_modules/playwright");
    browser = await chromium.launch({ headless: true, timeout: 20000 });
    context = await browser.newContext({
      javaScriptEnabled: false,
      serviceWorkers: "block",
      acceptDownloads: false,
      ignoreHTTPSErrors: false,
      permissions: [],
    });
    const page = await context.newPage();
    let documentRequested = false;

    await context.route("**/*", async (route) => {
      try {
        const request = route.request();
        const allowed = !documentRequested && request.url() === url &&
          request.method() === "GET" && request.isNavigationRequest() &&
          request.frame() === page.mainFrame() && !request.redirectedFrom();
        if (!allowed) {
          blockedRequests++;
          if (request.isNavigationRequest()) {
            navigationError = "Additional navigation was blocked.";
            failureCode = "NAVIGATION_BLOCKED";
          }
          await route.abort("blockedbyclient");
          return;
        }
        documentRequested = true;

        if (offline) {
          await route.fulfill({
            status: 200,
            contentType: "text/html",
            body: "<!doctype html><title>Leash offline test</title><h1>Offline browser works</h1><p>Synthetic HTML; no website fetched.</p>",
          });
        } else {
          // Fetch with a checked DNS address, then give Chromium only this HTML.
          // Subresources and redirects never reach the network.
          const response = await fetchHtml(url, approvedHosts);
          httpRefresh = Boolean(response.httpRefresh);
          if (inspection) {
            // Speculative <link> connections can bypass request routing. Fail
            // closed before rendering them rather than relying on heuristics.
            const charset = response.contentType.match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1];
            if (charset && !/^(utf-8|utf8|us-ascii)$/i.test(charset)) throw new Error("Unsupported HTML encoding.");
            const html = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
            if (/<link\b/i.test(html)) throw new Error("Link elements require unsupported network behavior; inspection is inconclusive.");
          }
          await route.fulfill({ status: 200, body: response.body, contentType: inspection ? "text/html; charset=utf-8" : response.contentType,
            headers: { "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'",
              "x-dns-prefetch-control": "off" } });
        }
      } catch (error) {
        navigationError = error.message;
        failureCode = error.code || "BROWSER_FAILED";
        try {
          await route.abort("blockedbyclient");
        } catch {
          navigationError += " The request could not be aborted; browser cleanup will still run.";
        }
      }
    });

    stage = "Navigation";
    await page.goto(url, { waitUntil: "load", timeout: 30000 });
    if (navigationError) throw new Error(navigationError);
    if (page.url() !== url) throw new Error("The final URL is outside the permitted destination.");

    stage = "Extraction";
    const extracted = await page.locator(inspection ? "html" : "body").evaluate(extract, inspection, { timeout: 5000 });
    outcome.data = {
      finalUrl: page.url(),
      title: (await page.title()).slice(0, 500),
      ...extracted,
      ...(inspection ? { blockedRequests, httpRefresh } : {}),
    };
    if (navigationError) throw new Error(navigationError);
  } catch (error) {
    outcome.errors.push(`${stage} failed: ${navigationError || error.message}`);
    outcome.failureCode = failureCode || "BROWSER_FAILED";
  } finally {
    await close(context, "Browser context");
    await close(browser, "Browser");
  }
  return outcome;
}

// Only example.com and this sandbox's temporary preview are permitted. DNS pinning
// also blocks private networks. The caller must delete the sandbox in finally.
async function interactWithBrowser(sandbox, websiteUrl = EXAMPLE_URL, { offline = false, inspection = false } = {}) {
  const approvedUrls = [...getApprovedUrls(), getResultsPageUrl(sandbox)].filter(Boolean);
  const approvedHosts = approvedUrls.map((value) => new URL(value).hostname);
  const url = validateUrl(websiteUrl, approvedHosts);
  if (!approvedUrls.includes(url)) throw new Error("Only an explicitly approved page URL is permitted.");
  if (typeof offline !== "boolean" || typeof inspection !== "boolean") throw new Error("Browser options must be booleans.");
  if (offline && url !== EXAMPLE_URL) throw new Error("Offline mode is only for the synthetic example.com test.");

  const source = `const MAX_PAGE_BYTES = ${MAX_PAGE_BYTES};
    const validateUrl = ${validateUrl.toString()};
    const isPublicIPv4 = ${isPublicIPv4.toString()};
    const fetchPublicHtml = ${fetchPublicHtml.toString()};
    (${readPageInSandbox.toString()})(${JSON.stringify(url)}, ${offline}, ${JSON.stringify(approvedHosts)}, fetchPublicHtml,
      ${inspection}, ${extractPage.toString()})
    .then((outcome) => console.log(JSON.stringify(outcome)))
    .catch(() => { console.error("Browser worker failed unexpectedly."); process.exitCode = 1; });`;
  // Shell-quote our own source as one argument. Page content is never executed
  // as a command. The approved page URL goes to the worker, never API keys.
  const quotedSource = "'" + source.replace(/'/g, "'\\''") + "'";
  let result;
  try {
    result = await sandbox.process.executeCommand(`node -e ${quotedSource}`, undefined, undefined, 75);
  } catch (error) {
    if (inspection) throw new Error("Inspection browser command failed; URL details were withheld.");
    throw error;
  }
  if (result.exitCode !== 0) throw new Error(`Browser worker exited with code ${result.exitCode}.`);

  let outcome;
  try {
    outcome = JSON.parse(result.result.trim());
  } catch {
    throw new Error("Browser worker returned an invalid structured result.");
  }
  if (!Array.isArray(outcome.errors)) throw new Error("Browser worker returned an invalid error report.");
  // A signed preview URL is a temporary credential. Never expose worker errors
  // containing it to callers or logs.
  if (outcome.errors.length) {
    const stages = outcome.errors.map((message) => String(message).match(/^(Browser startup|Navigation|Extraction|Browser context cleanup|Browser cleanup) failed/)?.[0] || "Hotel browser failed");
    const error = new Error(inspection ? `${stages.join("; ")}; URL details were withheld.` : outcome.errors.join("; "));
    error.code = ["DNS_BLOCKED", "REDIRECT_BLOCKED", "DOWNLOAD_BLOCKED", "NAVIGATION_BLOCKED"].includes(outcome.failureCode) ? outcome.failureCode : "BROWSER_FAILED";
    if (stages.some((stage) => /^Browser(?: context)? cleanup failed$/.test(stage))) error.code = "BROWSER_CLEANUP_FAILED";
    throw error;
  }
  if (!outcome.data || outcome.data.finalUrl !== url ||
      typeof outcome.data.title !== "string" || (inspection ? !outcome.data.scan || !outcome.data.facts : typeof outcome.data.content !== "string")) {
    throw new Error("Browser worker returned incomplete page data.");
  }
  return outcome.data;
}

async function deleteSandbox(sandbox) {
  try {
    await daytona.delete(sandbox, 60, true);
    console.log("Sandbox deleted:", sandbox.id);
  } catch (error) {
    throw new Error(`Sandbox cleanup failed. Sandbox ID: ${sandbox.id}. ${error.message}`);
  }
}

module.exports = { createSandbox, interactWithBrowser, deleteSandbox, publishResultsPage, releaseResultsPage };
