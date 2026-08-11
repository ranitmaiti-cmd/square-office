// Fixture test for Bug A Stage B: staleVersionLockout write-lockout.
//
// Extracts the ACTUAL function source directly from index.html (brace-
// matched, not retyped) and runs it in a vm sandbox with mocked
// fetch/sessionStorage/document/db/firebase -- proving the real shipped
// code, same discipline as the Stage A fixture.
//
// Run with: node stage-b-stale-version-lockout.test.js
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
  // Try `async function NAME(` first -- a bare `function NAME(` search
  // would still find a match inside that (starting at "function", not
  // "async"), silently dropping the async keyword from the extracted text
  // and turning every `await` inside it into a SyntaxError.
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

// Region extraction: from a literal start marker through the end of a
// named function further down -- captures the version-gate state
// (staleVersionLockout, versionGateMode, the constants) and every function
// that reads/writes it as ONE block, exactly as authored, preserving their
// real mutual references instead of me hand-wiring 8 separate pieces.
function extractRegion(source, startMarker, endFunctionName) {
  const startIdx = source.indexOf(startMarker);
  assert.ok(startIdx >= 0, `could not find region start "${startMarker}"`);
  const endFn = extractFunction(source, endFunctionName, startIdx);
  return source.slice(startIdx, endFn.end);
}

const checkForNewVersionSrc = extractFunction(fullScript, 'checkForNewVersion').text;
let gateRegionSrc = extractRegion(fullScript, 'const VERSION_GATE_COUNTDOWN_SECS', 'showVersionGateModal');

// Node's vm module gives `var` declarations at the top of vm-run code as
// real properties on the sandbox object, but `let`/`const` create a
// SEPARATE lexical binding that sandbox.propertyName can't see or set --
// a well-known vm gotcha, not a bug in the extracted code. Only these two
// specific top-level `let`s need external read/write from the test
// harness between simulated calls (everything else in this region is
// fine staying block-scoped); swap just those two to `var` in THIS
// harness's copy of the text so `sandbox.staleVersionLockout = true` /
// reading it back actually works. The real shipped file is untouched --
// this is a test-scaffolding-only transform on the extracted string.
gateRegionSrc = gateRegionSrc
  .replace('let staleVersionLockout = false;', 'var staleVersionLockout = false;')
  .replace('let versionGateMode = null;', 'var versionGateMode = null;');

const saveDataSrc = extractFunction(fullScript, 'saveData').text;
const backstopFullSaveSrc = extractFunction(fullScript, 'backstopFullSave').text;
const heartbeatSessionSrc = extractFunction(fullScript, 'heartbeatSession').text;
const saveTimeLogSrc = extractFunction(fullScript, 'saveTimeLog').text;
const savePlanEntrySrc = extractFunction(fullScript, 'savePlanEntry').text;
const saveProjectSrc = extractFunction(fullScript, 'saveProject').text;

console.log('--- extracted gate region (first 4 lines) ---');
console.log(gateRegionSrc.split('\n').slice(0, 4).join('\n') + '\n  ...\n');

// ── Minimal DOM mock -- enough for showVersionGateModal's actual DOM
// calls, no HTML parsing. Any id not explicitly registered by real
// appendChild/remove calls returns a harmless stub instead of null, so
// incidental innerHTML-only elements (the countdown span, the reload
// button) don't crash a getElementById().addEventListener() call. ────────
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
  // Only these two incidental innerHTML-only ids (never real registry
  // entries, since they're never created via createElement/appendChild)
  // get a harmless stub -- returning a truthy stub for EVERY missing id
  // would silently break the real "is versionGateOverlay actually in the
  // DOM" signal the fix under test depends on.
  const stubIds = new Set(['versionGateCountdown', 'versionGateReloadBtn']);
  const stub = { textContent: '', addEventListener() {}, remove() {} };
  return {
    createElement: () => makeElement(),
    getElementById: (id) => (registry.has(id) ? registry.get(id) : (stubIds.has(id) ? stub : null)),
    body: { appendChild: (el) => { if (el.id) registry.set(el.id, el); return el; } },
    hasOverlay: () => registry.has('versionGateOverlay'),
    removeOverlay: () => registry.delete('versionGateOverlay'),
  };
}

function buildSandbox() {
  const calls = { terminate: 0, firestoreCalls: 0, clearPersistence: 0 };
  let sessionStore = {};
  let fetchImpl = async () => ({ ok: true, json: async () => ({ version: '2026-08-10.2' }) });

  function makeDbInstance() {
    return {
      terminate: async () => { calls.terminate++; },
      clearPersistence: async () => { calls.clearPersistence++; },
      // Also spy write-shaped methods so fixture 1/4 can assert zero
      // interactions when locked -- if a guard ever regresses and lets
      // execution fall through, these register instead of throwing, so
      // the failure shows up as a clean assertion rather than a crash.
      collection: () => ({ doc: () => ({ set: async () => {}, update: async () => {} }) }),
      batch: () => ({ set() {}, delete() {}, commit: async () => {} }),
    };
  }

  const dom = makeDomMock();
  const sandbox = {
    console,
    APP_VERSION: '2026-08-10.2',
    fetch: (...args) => fetchImpl(...args),
    sessionStorage: {
      getItem: (k) => (k in sessionStore ? sessionStore[k] : null),
      setItem: (k, v) => { sessionStore[k] = String(v); },
      removeItem: (k) => { delete sessionStore[k]; },
    },
    document: dom,
    location: { href: '' },
    setInterval: () => 1,
    clearInterval: () => {},
    db: makeDbInstance(),
    firebase: { firestore: () => { calls.firestoreCalls++; return makeDbInstance(); } },
    // ── the 6 write-path globals, minimal, guard-only fixtures don't need
    // these to be functional since the lockout guard returns before any
    // of them are touched -- present only so a regressed guard fails on a
    // clean assertion instead of a ReferenceError.
    dataLoaded: true, currentUser: { id: 'u1', name: 'Fixture User' },
    window: { _saveInProgress: false },
    useGranularSaves: true,
    timerRunning: true, timerStartedAt: Date.now() - 60000, currentSessionLogId: 'sess1', timerLinkedPlan: { project: 'X', projectId: 'p1', phase: '', typology: '', type: 'work' },
    sessionExternallyClosed: false, awaitingWakeVerification: false,
  };
  vm.createContext(sandbox);
  vm.runInContext(checkForNewVersionSrc, sandbox);
  vm.runInContext(gateRegionSrc, sandbox);
  return { sandbox, calls, sessionStore: () => sessionStore, setSession: (k, v) => { sessionStore[k] = String(v); }, dom, setFetch: (fn) => { fetchImpl = fn; } };
}

let passCount = 0, failCount = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); passCount++; }
  else { console.log(`  FAIL: ${label}`); failCount++; }
}

(async () => {
// ═══════════════════════════════════════════════════════════════════════
// CASE 1: zero writes across saveData/backstopFullSave/heartbeatSession
// while already locked.
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== CASE 1: zero writes while locked (saveData/backstopFullSave/heartbeatSession) ===');
{
  const { sandbox } = buildSandbox();
  sandbox.staleVersionLockout = true;
  vm.runInContext(saveDataSrc, sandbox);
  vm.runInContext(backstopFullSaveSrc, sandbox);
  vm.runInContext(heartbeatSessionSrc, sandbox);

  const dbSpy = sandbox.db;
  let collectionCalls = 0, batchCalls = 0;
  const origCollection = dbSpy.collection, origBatch = dbSpy.batch;
  dbSpy.collection = (...a) => { collectionCalls++; return origCollection(...a); };
  dbSpy.batch = (...a) => { batchCalls++; return origBatch(...a); };

  vm.runInContext('saveData();', sandbox);
  vm.runInContext('backstopFullSave();', sandbox);
  vm.runInContext('heartbeatSession();', sandbox);

  check('db.collection() never called across all three', collectionCalls === 0);
  check('db.batch() never called across all three', batchCalls === 0);
}

// ═══════════════════════════════════════════════════════════════════════
// CASE 2: fail-open vs lockout, both directions.
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== CASE 2: fail-open on check-failure, lockout only at the attempt cap ===');
{
  const { sandbox, setFetch, sessionStore } = buildSandbox();
  sandbox.staleVersionLockout = false;
  sandbox.versionGateMode = null;

  setFetch(async () => { throw new Error('simulated network error'); });
  await vm.runInContext('checkForNewVersion()', sandbox);
  check('2a: fetch rejecting -- staleVersionLockout stays false', sandbox.staleVersionLockout === false);
  check('2a: fetch rejecting -- versionGateMode untouched (no gate shown at all)', sandbox.versionGateMode === null);

  setFetch(async () => ({ ok: false, status: 500 }));
  await vm.runInContext('checkForNewVersion()', sandbox);
  check('2a: fetch non-ok -- staleVersionLockout stays false', sandbox.staleVersionLockout === false);

  setFetch(async () => ({ ok: true, json: async () => ({ version: '2026-08-10.3' }) })); // confirmed mismatch from here on
  sessionStore()[sandbox.VERSION_GATE_ATTEMPTS_KEY] = undefined; delete sessionStore()['versionGateReloadAttempts'];

  await vm.runInContext('checkForNewVersion()', sandbox); // attempts=0
  check('2b: 1st confirmed mismatch (attempts=0) -- lockout stays false', sandbox.staleVersionLockout === false);
  check('2b: 1st confirmed mismatch -- shows countdown mode, not lockout', sandbox.versionGateMode === 'countdown');

  sessionStore()['versionGateReloadAttempts'] = '1';
  await vm.runInContext('checkForNewVersion()', sandbox); // attempts=1, still under cap of 2
  check('2b: 2nd confirmed mismatch (attempts=1) -- lockout STILL false', sandbox.staleVersionLockout === false);

  sessionStore()['versionGateReloadAttempts'] = '2';
  await vm.runInContext('checkForNewVersion()', sandbox); // attempts=2, cap reached
  check('2b: 3rd confirmed mismatch (attempts=2, at cap) -- lockout NOW true', sandbox.staleVersionLockout === true);
  check('2b: escalated to lockout mode WITHOUT a reload in between (the bug this stage fixes)', sandbox.versionGateMode === 'lockout');
}

// ═══════════════════════════════════════════════════════════════════════
// CASE 3: indicator re-display -- overlay removed (simulating "gone
// while backgrounded"), then re-shown on the next check, same as
// visibilitychange/focus would trigger.
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== CASE 3: lockout indicator re-displays, not suppressed after the first show ===');
{
  const { sandbox, setFetch, sessionStore, dom, calls } = buildSandbox();
  sandbox.staleVersionLockout = false;
  sandbox.versionGateMode = null;
  setFetch(async () => ({ ok: true, json: async () => ({ version: '2026-08-10.3' }) }));
  sessionStore()['versionGateReloadAttempts'] = '2'; // already at cap -- straight to lockout

  await vm.runInContext('checkForNewVersion()', sandbox);
  check('lockout engaged, overlay present', sandbox.staleVersionLockout === true && dom.hasOverlay());
  const terminateCallsAfterFirst = calls.terminate;

  dom.removeOverlay(); // simulate it somehow not being in the DOM anymore
  check('setup: overlay confirmed gone before the re-check', !dom.hasOverlay());

  await vm.runInContext('checkForNewVersion()', sandbox); // as if visibilitychange/focus fired this again
  check('overlay re-displayed on the next check (old versionGateModalShown would have permanently no-op\'d here)', dom.hasOverlay());
  check('still locked, no state regression', sandbox.staleVersionLockout === true);
}

// ═══════════════════════════════════════════════════════════════════════
// CASE 4: granular write paths (saveTimeLog/savePlanEntry/saveProject)
// also refuse to write while locked.
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== CASE 4: granular paths blocked while locked ===');
{
  const { sandbox } = buildSandbox();
  sandbox.staleVersionLockout = true;
  vm.runInContext(saveTimeLogSrc, sandbox);
  vm.runInContext(savePlanEntrySrc, sandbox);
  vm.runInContext(saveProjectSrc, sandbox);

  let collectionCalls = 0;
  sandbox.db.collection = () => { collectionCalls++; return { doc: () => ({ set: async () => {}, update: async () => {} }) }; };

  await vm.runInContext('saveTimeLog({id:"t1"})', sandbox);
  await vm.runInContext('savePlanEntry({id:"p1"})', sandbox);
  await vm.runInContext('saveProject({id:"pr1"})', sandbox);

  check('db.collection() never called by any of the three granular paths', collectionCalls === 0);
}

// ═══════════════════════════════════════════════════════════════════════
// CASE 5: purge is wired to fire exactly once on lockout engage, not
// re-fired on subsequent already-locked calls. (Lighter than re-proving
// the SDK behavior itself -- that's the 2026-08-11 spike's job, already
// done against real Firestore. This just confirms the wiring.)
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== CASE 5: purge (terminate + clearPersistence) fires exactly once on lockout engage ===');
{
  const { sandbox, setFetch, sessionStore, calls } = buildSandbox();
  sandbox.staleVersionLockout = false;
  sandbox.versionGateMode = null;
  setFetch(async () => ({ ok: true, json: async () => ({ version: '2026-08-10.3' }) }));

  sessionStore()['versionGateReloadAttempts'] = '0';
  await vm.runInContext('checkForNewVersion()', sandbox);
  check('not yet at cap -- purge NOT fired', calls.terminate === 0);

  sessionStore()['versionGateReloadAttempts'] = '2';
  await vm.runInContext('checkForNewVersion()', sandbox); // escalates to lockout this call
  // purgePendingWritesOnLockout() is fire-and-forget inside showVersionGateModal -- give its microtasks a tick to run.
  await new Promise((r) => setTimeout(r, 0));
  check('lockout engaged -- terminate() called exactly once', calls.terminate === 1);
  check('firebase.firestore() called again for the fresh instance', calls.firestoreCalls === 1);
  check('clearPersistence() called exactly once', calls.clearPersistence === 1);

  await vm.runInContext('checkForNewVersion()', sandbox); // still at cap, already locked -- must NOT re-fire
  await new Promise((r) => setTimeout(r, 0));
  check('already locked -- purge NOT fired again on a subsequent still-stale check', calls.terminate === 1);
}

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
})().catch((e) => { console.error('FIXTURE ERROR:', e); process.exit(1); });
