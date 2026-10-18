const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { extractPage } = require("./analysis");
const { fixtures, fixtureRoot } = require("./test-fixture");

test("controlled live-demo command redacts its private URL and revokes/deletes after success or failure", async () => {
  for (const fail of [false, true]) {
    const calls = [];
    const logs = [];
    const url = "https://3000-secret-preview.proxy.example.com/";
    const browser = {
      async createSandbox() { calls.push("create"); return { id: "cli-fixture" }; },
      async publishResultsPage() { calls.push("publish"); return url; },
      async interactWithBrowser() {
        calls.push("read");
        if (fail) throw new Error(url);
        return { finalUrl: url, title: "Fixture", ...extractPage(fixtureRoot(fixtures.normal), true) };
      },
      async releaseResultsPage() { calls.push("revoke"); },
      async deleteSandbox() { calls.push("delete"); },
    };
    const scope = { module: { exports: {} }, process: { argv: ["node", "daytona/test.js", "--demo", "normal"], exitCode: 0 },
      console: { log: (...args) => logs.push(args.join(" ")), error: (...args) => logs.push(args.join(" ")) },
      require(name) {
        if (name === "./sandbox") return browser;
        return require(name);
      },
    };
    vm.runInNewContext(`${fs.readFileSync(`${__dirname}/test.js`, "utf8")}\nmodule.exports = main;`, scope);
    await scope.module.exports();
    assert.deepEqual(calls, ["create", "publish", "read", "revoke", "delete"]);
    assert.ok(!logs.join(" ").includes("secret-preview"));
    assert.equal(scope.process.exitCode, fail ? 1 : 0);
  }
});
