// Fixture test for Stage E: the version-gate countdown now surviving a
// backgrounded/throttled tab, where the old plain setInterval would stall
// forever -- the bug that let this week's stale tab never self-reload.
//
// Extracts the ACTUAL function source directly from index.html (brace-
// matched, not retyped) and runs it in a vm sandbox with mocked
// fetch/sessionStorage/document/setInterval -- proving the real shipped
// code, same discipline as the Stage A/B fixtures.
//
// Run with: node stage-e-version-gate-worker-countdown.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const INDEX_HTML = path.join('D:/SQUARE/ADMIN/SQUARE-Office/finalphase/01072026', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');
const scriptMatch = src.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(scriptMatch, 'could not find inline <script> block in index.html');
const fullScript = scriptMatch[1];

function extractFunction(source, name, fromIndex = 0) {
  let startIdx = source.indexOf(`async function ${name}(`, fromIndex);
  if (startIdx < 0) startIdx = source.indexOf(`function ${name}(`, fromIndex);
  assert.ok(startIdx >= 0, `could not find "function ${name}(" in index.html`);
  const braceStart = source.indexOf('{', startIdx);
  let depth = 0, i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  assert.ok(depth === 0, `brace matching failed for ${name}`);
  return { text: source.slice(startIdx, i + 1), start: startIdx, end: i + 1 };
}

function extractRegion(source, startMarker, endFunctionName) {
  const startIdx = source.indexOf(startMarker);
  assert.ok(startIdx >= 0, `could not find region start "${startMarker}"`);
  const endFn = extractFunction(source, endFunctionName, startIdx);
  return source.slice(startIdx, endFn.end);
}

const checkForNewVersionSrc = extractFunction(fullScript, 'checkForNewVersion').text;
let gateRegionSrc = extractRegion(fullScript, 'const VERSION_GATE_COUNTDOWN_SECS', 'showVersionGateModal');

console.log('--- extracted region start (constants + state) ---');
console.log(gateRegionSrc.split('\n').slice(0, 4).join('\n') + '\n  ...\n');
console.log('--- extracted worker-tick deadline check (top of showVersionGateModal) ---');
{
  const idx = gateRegionSrc.indexOf('function showVersionGateModal');
  const bodyStart = gateRegionSrc.indexOf('{', idx);
  console.log(gateRegionSrc.slice(idx, bodyStart + 500) + '\n  ...\n');
}

// Same vm gotcha as the Stage B fixture: `let` at the top of vm-run code
// doesn't attach to the sandbox object, only `var` does. Swap the state
// vars this harness needs to read/set directly. Real shipped file is
// untouched -- test-scaffolding-only transform on the extracted string.
gateRegionSrc = gateRegionSrc
  .replace('let staleVersionLockout = false;', 'var staleVersionLockout = false;')
  .replace('let versionGateMode = null;', 'var versionGateMode = null;')
  .replace('let versionGateCountdownDeadlineAt = null;', 'var versionGateCountdownDeadlineAt = null;')
  .replace('let versionGateReloadInFlight = false;', 'var versionGateReloadInFlight = false;');

function makeDomMock() {
  const registry = new Map();
  function makeElement() {
    return {
      id: '', style: {}, innerHTML: '',
      appendChild(child) { if (child.id) registry.set(child.id, child); return child; },
      addEventListener() {},
      remove() { if (this.id) registry.delete(this.id); },
    };
  }
  // The reload button stub captures its registered click handler so the
  // test can actually invoke it (simulating a real click), instead of
  // just asserting addEventListener was called with no way to exercise
  // what it does.
  const reloadBtnStub = { textContent: '', clickHandler: null, addEventListener(evt, fn) { if (evt === 'click') this.clickHandler = fn; }, remove() {} };
  const countdownStub = { textContent: '', addEventListener() {}, remove() {} };
  return {
    createElement: () => makeElement(),
    getElementById: (id) => {
      if (registry.has(id)) return registry.get(id);
      if (id === 'versionGateReloadBtn') return reloadBtnStub;
      if (id === 'versionGateCountdown') return countdownStub;
      return null;
    },
    body: { appendChild: (el) => { if (el.id) registry.set(el.id, el); return el; } },
    hasOverlay: () => registry.has('versionGateOverlay'),
    reloadBtnStub,
  };
}

function buildSandbox() {
  let sessionStore = {};
  let fetchImpl = async () => ({ ok: true, json: async () => ({ version: '2026-08-15.2' }) });
  const dom = makeDomMock();
  const setIntervalCalls = [];

  const sandbox = {
    console,
    APP_VERSION: '2026-08-15.1',
    fetch: (...args) => fetchImpl(...args),
    sessionStorage: {
      getItem: (k) => (k in sessionStore ? sessionStore[k] : null),
      setItem: (k, v) => { sessionStore[k] = String(v); },
      removeItem: (k) => { delete sessionStore[k]; },
    },
    document: dom,
    location: { href: '' },
    // V16.3 (Stage E) fixture's whole point: setInterval registers the
    // call but NEVER invokes it -- this is the literal simulation of a
    // backgrounded/throttled tab where the plain main-thread timer stalls
    // completely. If the reload still happens in this sandbox, it can
    // only be because the worker-tick deadline check did it, not the
    // interval -- exactly what CASE 1 below proves.
    setInterval: (fn, ms) => { setIntervalCalls.push({ fn, ms }); return setIntervalCalls.length; },
    clearInterval: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(checkForNewVersionSrc, sandbox);
  vm.runInContext(gateRegionSrc, sandbox);
  return {
    sandbox, dom, setIntervalCalls,
    sessionStore: () => sessionStore,
    setFetch: (fn) => { fetchImpl = fn; },
  };
}

let passCount = 0, failCount = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); passCount++; }
  else { console.log(`  FAIL: ${label}`); failCount++; }
}

(async () => {
// ═══════════════════════════════════════════════════════════════════════
// CASE 1: countdown started, tab "backgrounded" (setInterval callback
// NEVER fires -- the old-behavior stall condition), but a later
// worker-tick-driven call (checkForNewVersion(), which the reliable tick
// worker calls unconditionally every ~60s regardless of visibility)
// still reaches its deadline and fires the reload.
// ═══════════════════════════════════════════════════════════════════════
console.log('=== CASE 1: setInterval never fires (simulated backgrounding), worker tick still reloads ===');
{
  const { sandbox, setFetch, sessionStore, setIntervalCalls } = buildSandbox();
  sandbox.staleVersionLockout = false;
  sandbox.versionGateMode = null;
  setFetch(async () => ({ ok: true, json: async () => ({ version: '2026-08-15.2' }) }));
  delete sessionStore()['versionGateReloadAttempts'];

  await vm.runInContext('checkForNewVersion()', sandbox); // 1st worker-tick-equivalent call: starts the countdown
  check('countdown started (mode=countdown)', sandbox.versionGateMode === 'countdown');
  check('a deadline was recorded', typeof sandbox.versionGateCountdownDeadlineAt === 'number');
  check('setInterval WAS registered (the visual countdown exists)', setIntervalCalls.length === 1);
  check('but its callback was never invoked by this sandbox (simulated stall)', sandbox.location.href === '');

  // Simulate real time passing past the deadline WITHOUT ever invoking the
  // setInterval callback -- this is the part a real backgrounded tab would
  // do via actual wall-clock time; here it's done directly since we can't
  // wait 15s+ in a test. This does not fabricate a pass -- it forces the
  // exact real-world condition (deadline in the past) that the guard is
  // supposed to detect on its own next call.
  sandbox.versionGateCountdownDeadlineAt = Date.now() - 1000;

  await vm.runInContext('checkForNewVersion()', sandbox); // 2nd worker-tick-equivalent call, ~60s later in reality
  check('reload fired via the worker-tick path (location.href set)', sandbox.location.href.includes('/?v='));
  check('deadline cleared after firing (no dangling state)', sandbox.versionGateCountdownDeadlineAt === null);
  check('attempts counter incremented exactly once', sessionStore()['versionGateReloadAttempts'] === '1');
}

// ═══════════════════════════════════════════════════════════════════════
// CASE 2: negative case -- deadline NOT yet passed, worker tick call must
// NOT reload prematurely (only the actually-expired case should fire).
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== CASE 2: deadline not yet passed -- worker tick must NOT reload early ===');
{
  const { sandbox, setFetch, sessionStore } = buildSandbox();
  sandbox.staleVersionLockout = false;
  sandbox.versionGateMode = null;
  setFetch(async () => ({ ok: true, json: async () => ({ version: '2026-08-15.2' }) }));
  delete sessionStore()['versionGateReloadAttempts'];

  await vm.runInContext('checkForNewVersion()', sandbox); // starts the countdown, deadline in the future
  check('deadline is in the future', sandbox.versionGateCountdownDeadlineAt > Date.now());

  await vm.runInContext('checkForNewVersion()', sandbox); // another tick arrives, but deadline hasn't passed
  check('no reload yet (location.href still empty)', sandbox.location.href === '');
  check('still in countdown mode, not reloaded', sandbox.versionGateMode === 'countdown');
}

// ═══════════════════════════════════════════════════════════════════════
// CASE 3: manual "Reload now" click path still works and clears the
// deadline (no leftover state causing a stray double-reload later).
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== CASE 3: manual reload-now click clears the deadline, no leftover state ===');
{
  const { sandbox, setFetch, sessionStore, dom } = buildSandbox();
  sandbox.staleVersionLockout = false;
  sandbox.versionGateMode = null;
  setFetch(async () => ({ ok: true, json: async () => ({ version: '2026-08-15.2' }) }));
  delete sessionStore()['versionGateReloadAttempts'];

  await vm.runInContext('checkForNewVersion()', sandbox); // registers the real click handler on the button stub
  check('a deadline was recorded before the click', typeof sandbox.versionGateCountdownDeadlineAt === 'number');
  check('click handler was actually registered on the button', typeof dom.reloadBtnStub.clickHandler === 'function');

  dom.reloadBtnStub.clickHandler(); // simulate the real click, invoking the REAL extracted handler

  check('reload fired via the click path', sandbox.location.href.includes('/?v='));
  check('deadline cleared by the click handler (no leftover state for a later stray worker tick to act on)',
    sandbox.versionGateCountdownDeadlineAt === null);
  check('attempts counter incremented exactly once', sessionStore()['versionGateReloadAttempts'] === '1');
}

// ═══════════════════════════════════════════════════════════════════════
// CASE 4: reentrancy guard -- if both the (hypothetically still-alive)
// interval AND the worker-tick path were to fire around the same moment,
// forceReloadToVersion() must not double-count the attempt.
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== CASE 4: double-fire does not double-count the attempts counter ===');
{
  const { sandbox, setFetch, sessionStore } = buildSandbox();
  sandbox.staleVersionLockout = false;
  sandbox.versionGateMode = null;
  setFetch(async () => ({ ok: true, json: async () => ({ version: '2026-08-15.2' }) }));
  delete sessionStore()['versionGateReloadAttempts'];

  await vm.runInContext('checkForNewVersion()', sandbox);
  sandbox.versionGateCountdownDeadlineAt = Date.now() - 1000;
  await vm.runInContext('checkForNewVersion()', sandbox); // fires once, sets versionGateReloadInFlight
  check('attempts = 1 after first fire', sessionStore()['versionGateReloadAttempts'] === '1');

  // Re-use the SAME contextified sandbox (not a spread copy -- vm.runInContext
  // needs the object that actually went through vm.createContext(), a plain
  // copy of its properties is not itself a valid context and would silently
  // lose every function/state already defined on it).
  sandbox.remoteVersionForTest = '2026-08-15.2';
  vm.runInContext('forceReloadToVersion(remoteVersionForTest);', sandbox);
  check('a second direct call is a no-op (reentrancy guard), attempts still 1', sessionStore()['versionGateReloadAttempts'] === '1');
}

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
})().catch((e) => { console.error('FIXTURE ERROR:', e); process.exit(1); });
