const assert = require("node:assert/strict");
const browser = require("./sandbox");
const { inspectBookingUrl } = require("./index");
const { inspectInSandbox } = require("./inspector");

async function main() {
  let sandbox;
  let preview = false;
  const args = process.argv.slice(2);
  const offline = args.includes("--offline");
  try {
    if (args[0] === "--inspect") {
      if (args.length !== 2) throw new Error("Usage: node daytona/test.js --inspect <approved HTTPS URL>");
      const result = await inspectBookingUrl({ url: args[1] });
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== "inspected") process.exitCode = 1;
      return;
    }
    if (args[0] === "--demo") {
      const { fixtures } = require("./test-fixture");
      const name = args[1] || "normal";
      if (args.length > 2 || !Object.hasOwn(fixtures, name)) throw new Error("Unknown controlled fixture.");
      sandbox = await browser.createSandbox();
      preview = true;
      const url = await browser.publishResultsPage(sandbox, fixtures[name]);
      const result = await inspectInSandbox(sandbox, url, browser);
      // Signed preview URLs are credentials, not public listing source URLs.
      result.url = result.bookingDetails.listingUrl = null;
      console.log(JSON.stringify(result, null, 2));
      assert.equal(result.safeToProceed, false);
      if (name === "normal") assert.equal(result.bookingDetails.propertyName, "Leash Fixture Hotel");
      else assert.ok(result.security.findings.length > 0, "Expected a controlled security finding.");
    } else {
      if (args.length > 1 || args.some((arg) => arg !== "--offline")) throw new Error("Usage: node daytona/test.js [--offline | --inspect <url> | --demo [fixture]]");
      sandbox = await browser.createSandbox();
      const result = await browser.interactWithBrowser(sandbox, "https://example.com/", { offline });
      console.log(JSON.stringify({ finalUrl: result.finalUrl, title: result.title, contentPreview: result.content.slice(0, 500) }, null, 2));
      assert.equal(result.finalUrl, "https://example.com/");
      assert.equal(result.title, offline ? "Leash offline test" : "Example Domain");
      if (offline) assert.ok(result.content.includes("Synthetic HTML; no website fetched."));
      else {
        assert.equal(typeof result.content, "string");
        assert.ok(result.content.trim().length > 0, "Expected nonempty page content.");
      }
    }
  } catch (error) {
    console.error("Daytona test failed:", preview ? "Controlled inspection failed; private URL details withheld." : error.message);
    process.exitCode = 1;
  } finally {
    if (sandbox) {
      if (preview) {
        try { await browser.releaseResultsPage(sandbox); }
        catch { console.error("Preview revocation failed; automatic expiry is 120 seconds."); process.exitCode = 1; }
      }
      try { await browser.deleteSandbox(sandbox); }
      catch { console.error(`Sandbox deletion failed. Sandbox ID: ${sandbox.id}`); process.exitCode = 1; }
    }
  }
  if (!process.exitCode) console.log("Browser test completed; sandbox deleted. Inspection does not authorize booking.");
}

// Every mode can create a real sandbox. Run only with explicit permission.
if (require.main === module) main();
