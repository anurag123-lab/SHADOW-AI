/* eslint-disable */
/**
 * Composer write-back verification.
 *
 * ChatGPT uses a plain <textarea>. Claude and Gemini use contenteditable
 * editors managed by a framework that keeps its own copy of the value —
 * such an editor can accept a DOM mutation visually and still submit its
 * internal state.
 *
 * The dangerous outcome is not "redaction failed". It is "redaction
 * failed silently, and we sent the original anyway while showing the
 * employee a redacted preview". These tests pin the behaviour that
 * prevents that: the writer reports the truth, and the caller fails
 * CLOSED when the write did not stick.
 *
 * The write-back logic lives in a content script that needs a DOM, so the
 * strategy sequence is reimplemented here against a minimal fake DOM.
 * The assertions are about the CONTRACT: verify after every strategy,
 * and never report success you cannot see.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

/* ------------------------------------------------------------------ *
 * A fake editor, parameterised by how hostile it is
 * ------------------------------------------------------------------ */
function makeEditor(behaviour) {
  return {
    tagName: "DIV",
    isContentEditable: true,
    _text: "original sensitive text",
    // What a framework-controlled editor would report back
    get innerText() { return this._text; },
    set innerText(v) { this._text = v; },

    acceptsExecCommand: behaviour.acceptsExecCommand,
    acceptsPaste: behaviour.acceptsPaste,
    acceptsDirectWrite: behaviour.acceptsDirectWrite,
  };
}

function sameText(a, b) {
  return String(a).replace(/\s+/g, " ").trim() === String(b).replace(/\s+/g, " ").trim();
}

/** Mirrors writeComposer()'s contenteditable path: try, then VERIFY. */
function writeContentEditable(node, text) {
  // Strategy 1 — execCommand("insertText")
  if (node.acceptsExecCommand) node.innerText = text;
  if (sameText(node.innerText, text)) return true;

  // Strategy 2 — synthetic paste event
  if (node.acceptsPaste) node.innerText = text;
  if (sameText(node.innerText, text)) return true;

  // Strategy 3 — direct DOM write + synthetic InputEvent
  if (node.acceptsDirectWrite) node.innerText = text;
  if (sameText(node.innerText, text)) return true;

  return false;
}

const REDACTED = "my card is 4242 4242 4242 4242 please help";

/* =================================================================== *
 * Each strategy, in isolation
 * =================================================================== */
test("succeeds on the first strategy when execCommand is accepted", () => {
  const node = makeEditor({ acceptsExecCommand: true, acceptsPaste: false, acceptsDirectWrite: false });
  assert.equal(writeContentEditable(node, REDACTED), true);
  assert.equal(node.innerText, REDACTED);
});

test("falls through to synthetic paste when execCommand is ignored", () => {
  const node = makeEditor({ acceptsExecCommand: false, acceptsPaste: true, acceptsDirectWrite: false });
  assert.equal(writeContentEditable(node, REDACTED), true);
  assert.equal(node.innerText, REDACTED);
});

test("falls through to a direct write when both events are ignored", () => {
  const node = makeEditor({ acceptsExecCommand: false, acceptsPaste: false, acceptsDirectWrite: true });
  assert.equal(writeContentEditable(node, REDACTED), true);
  assert.equal(node.innerText, REDACTED);
});

/* =================================================================== *
 * THE ONE THAT MATTERS
 * =================================================================== */
test("reports FAILURE when a hostile editor rejects every strategy", () => {
  const node = makeEditor({ acceptsExecCommand: false, acceptsPaste: false, acceptsDirectWrite: false });

  const wrote = writeContentEditable(node, REDACTED);

  assert.equal(wrote, false, "must not claim success it cannot verify");
  assert.equal(node.innerText, "original sensitive text", "editor kept its own state");
});

test("a failed write must NOT be followed by a send", () => {
  const node = makeEditor({ acceptsExecCommand: false, acceptsPaste: false, acceptsDirectWrite: false });

  // Mirrors handleSendAttempt(): send only when the write verified.
  let sent = null;
  const wrote = writeContentEditable(node, REDACTED);
  if (wrote) sent = node.innerText;

  assert.equal(sent, null, "sending here would transmit the ORIGINAL text");
});

test("a successful write sends the redacted text, never the original", () => {
  const node = makeEditor({ acceptsExecCommand: true, acceptsPaste: true, acceptsDirectWrite: true });

  let sent = null;
  if (writeContentEditable(node, REDACTED)) sent = node.innerText;

  assert.equal(sent, REDACTED);
  assert.ok(!String(sent).includes("original sensitive"));
});

/* =================================================================== *
 * Verification is whitespace-insensitive but not content-blind
 * =================================================================== */
test("normalised whitespace still counts as a successful write", () => {
  const node = makeEditor({ acceptsExecCommand: true, acceptsPaste: false, acceptsDirectWrite: false });
  node.innerText = "my card is  4242 4242 4242 4242\n please help";
  assert.equal(sameText(node.innerText, REDACTED), true, "editors reflow whitespace; that is fine");
});

test("a partial write counts as a FAILURE", () => {
  // An editor that truncates, or applies only some of the text.
  const node = makeEditor({ acceptsExecCommand: false, acceptsPaste: false, acceptsDirectWrite: false });
  node.innerText = "my card is 4111 1111 1111 1111 please help";
  assert.equal(sameText(node.innerText, REDACTED), false, "still holds the card number");
  assert.equal(writeContentEditable(node, REDACTED), false);
});
