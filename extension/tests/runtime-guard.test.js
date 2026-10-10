/* eslint-disable */
/**
 * "Extension context invalidated" — the error Chrome reports when the
 * extension is reloaded or updated while an AI tab is open.
 *
 * Locks in the behaviour of src/content/runtime-guard.js:
 *   - extension calls never throw once the copy is disconnected
 *   - when a fresh copy is re-injected, the old one stops acting
 *   - an orphaned copy that was NOT replaced keeps protecting the page
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const GUARD = path.join(__dirname, "..", "src", "content", "runtime-guard.js");

// minimal DOM: one shared <html> element, as in a real page
const attrs = {};
globalThis.document = {
  documentElement: {
    setAttribute: (k, v) => { attrs[k] = String(v); },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
  },
};

function connectedChrome(sendImpl) {
  return {
    runtime: {
      id: "abcdefghijklmnop",
      lastError: undefined,
      getURL: (p) => "chrome-extension://abcdefghijklmnop/" + p,
      sendMessage: sendImpl || ((msg, cb) => cb({ ok: true, echo: msg.type })),
    },
  };
}

/** Load a fresh copy of the guard, like a new content-script injection. */
function loadCopy() {
  delete require.cache[require.resolve(GUARD)];
  return require(GUARD);
}

test("a connected copy works normally", async () => {
  globalThis.chrome = connectedChrome();
  const g = loadCopy();
  g.claim();
  assert.equal(g.alive(), true);
  assert.equal(g.isCurrent(), true);
  assert.equal(g.getURL("x.css"), "chrome-extension://abcdefghijklmnop/x.css");
  assert.deepEqual(await g.sendMessage({ type: "PING" }), { ok: true, echo: "PING" });
});

test("after an extension reload, calls return safely instead of throwing", async () => {
  globalThis.chrome = connectedChrome();
  const g = loadCopy();
  g.claim();
  // What Chrome does to an orphaned content script: runtime.id disappears
  // and every runtime call throws "Extension context invalidated".
  globalThis.chrome = { runtime: {
    get id() { return undefined; },
    getURL() { throw new Error("Extension context invalidated."); },
    sendMessage() { throw new Error("Extension context invalidated."); },
  } };
  assert.equal(g.alive(), false);
  assert.equal(g.getURL("x.css"), null);
  assert.deepEqual(await g.sendMessage({ type: "LOG_EVENT" }), { ok: false, error: "context_invalidated" });
});

test("even touching chrome.runtime throwing is handled", async () => {
  globalThis.chrome = connectedChrome();
  const g = loadCopy();
  globalThis.chrome = { get runtime() { throw new Error("Extension context invalidated."); } };
  assert.equal(g.alive(), false);
  assert.equal(g.getURL("x.css"), null);
  assert.equal((await g.sendMessage({ type: "X" })).ok, false);
});

test("sendMessage that throws mid-call still resolves", async () => {
  globalThis.chrome = connectedChrome(() => { throw new Error("Extension context invalidated."); });
  const g = loadCopy();
  assert.deepEqual(await g.sendMessage({ type: "X" }), { ok: false, error: "context_invalidated" });
});

test("a re-injected copy takes over and the old copy goes quiet", () => {
  globalThis.chrome = connectedChrome();
  const oldCopy = loadCopy();
  oldCopy.claim();
  assert.equal(oldCopy.isCurrent(), true);

  const newCopy = loadCopy();   // service worker re-injects after the update
  newCopy.claim();
  assert.notEqual(oldCopy.instanceId, newCopy.instanceId);
  assert.equal(newCopy.isCurrent(), true, "new copy protects the page");
  assert.equal(oldCopy.isCurrent(), false, "old copy must not act — no duplicate dialog, no errors");
});

test("an orphaned copy that was NOT replaced keeps protecting the page", () => {
  globalThis.chrome = connectedChrome();
  const g = loadCopy();
  g.claim();
  globalThis.chrome = { runtime: { get id() { return undefined; } } };
  // Disconnected, but nobody took over: it still owns the page, so the
  // local detector keeps blocking sensitive sends until the tab refreshes.
  assert.equal(g.alive(), false);
  assert.equal(g.isCurrent(), true);
});
