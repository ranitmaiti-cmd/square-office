// Fixture test for Bug A Stage A: backstopFullSave() moved onto the
// reliable tick worker's 5th tick, with a plain-interval fallback via
// startBackstopMonitor() if the worker never initializes.
//
// index.html is not a module (plain classic script, browser globals
// throughout) so these tests extract the ACTUAL function source directly
// from the real file (brace-matched, not retyped/duplicated) and run it in
// a vm sandbox with mocked Worker/Blob/URL/setInterval and stubbed
// collaborator functions -- proving the real shipped code, not a
// reimplementation of it.
//
// Run with: node stage-a-backstop-worker-tick.test.js
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

// Brace-matched extraction of `function NAME(...) { ... }` starting from
// the first occurrence of `function NAME(`.
function extractFunction(source, name) {
  const startMarker = `function ${name}(`;
  const startIdx = source.indexOf(startMarker);
  assert.ok(startIdx >= 0, `could not find "${startMarker}" in index.html`);
  const braceStart = source.indexOf('{', startIdx);
  assert.ok(braceStart >= 0, `could not find opening brace for ${name}`);
  let depth = 0;
  let i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  assert.ok(depth === 0, `brace matching failed for ${name}`);
  return source.slice(startIdx, i + 1);
}

const initReliableTickWorkerSrc = extractFunction(fullScript, 'initReliableTickWorker');
const startBackstopMonitorSrc = extractFunction(fullScript, 'startBackstopMonitor');

console.log('--- extracted initReliableTickWorker() (from real index.html) ---');
console.log(initReliableTickWorkerSrc.split('\n').slice(0, 3).join('\n') + '\n  ...\n');
console.log('--- extracted startBackstopMonitor() (from real index.html) ---');
console.log(startBackstopMonitorSrc);
console.log('');

// ── Mock Worker -- captures the created instance so the test can fire
// onmessage manually, simulating ticks. ─────────────────────────────────
let lastCreatedWorker = null;
class MockWorker {
  constructor(_url) {
    this.onmessage = null;
    this.onerror = null;
    lastCreatedWorker = this;
  }
  postMessage() {}
  terminate() {}
}

function fireTick(worker) {
  worker.onmessage({ data: 'tick' });
}

// ── Sandbox builder -- fresh state per test case, real extracted function
// source, mocked/stubbed collaborators. ─────────────────────────────────
function buildSandbox({ workerAvailable }) {
  const calls = {
    heartbeatSession: 0,
    runEndOfDayCheck: 0,
    checkTimerHealth: 0,
    checkForNewVersion: 0,
    finalizeStaleHeartbeatSessionsAllUsers: 0,
    backstopFullSave: 0,
    setIntervalCalls: [], // {fn, ms}
  };

  const sandbox = {
    console,
    Blob: class Blob { constructor() {} },
    URL: { createObjectURL: () => 'blob:mock' },
    Worker: workerAvailable ? MockWorker : undefined,
    setInterval: (fn, ms) => { calls.setIntervalCalls.push({ fn, ms }); return calls.setIntervalCalls.length; },
    clearInterval: () => {},
    timerRunning: false,
    workerTickCount: 0,
    lastWorkerTickAt: null,
    reliableTickWorker: null,
    reliableTickWorkerActive: false,
    backstopFullSaveInterval: null,
    heartbeatSession: () => { calls.heartbeatSession++; },
    runEndOfDayCheck: () => { calls.runEndOfDayCheck++; },
    checkTimerHealth: () => { calls.checkTimerHealth++; },
    checkForNewVersion: () => { calls.checkForNewVersion++; },
    finalizeStaleHeartbeatSessionsAllUsers: () => { calls.finalizeStaleHeartbeatSessionsAllUsers++; },
    backstopFullSave: () => { calls.backstopFullSave++; },
  };
  vm.createContext(sandbox);
  vm.runInContext(initReliableTickWorkerSrc, sandbox);
  vm.runInContext(startBackstopMonitorSrc, sandbox);
  return { sandbox, calls };
}

let passCount = 0, failCount = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); passCount++; }
  else { console.log(`  FAIL: ${label}`); failCount++; }
}

// ═══════════════════════════════════════════════════════════════════════
// CASE 1: backstop fires on the worker's 5th tick, not every tick, not
// zero times.
// ═══════════════════════════════════════════════════════════════════════
console.log('=== CASE 1: fires on 5th tick ===');
{
  lastCreatedWorker = null;
  const { sandbox, calls } = buildSandbox({ workerAvailable: true });
  vm.runInContext('startBackstopMonitor();', sandbox);
  check('worker initialized (reliableTickWorkerActive)', sandbox.reliableTickWorkerActive === true);
  check('a MockWorker instance was created', lastCreatedWorker !== null);

  // Fire 4 ticks -- backstop should NOT have fired yet.
  for (let i = 0; i < 4; i++) fireTick(lastCreatedWorker);
  check('after 4 ticks: backstopFullSave NOT yet called', calls.backstopFullSave === 0);
  check('after 4 ticks: heartbeat/EOD/watchdog/version-check DID fire each tick (unrelated paths unaffected)',
    calls.runEndOfDayCheck === 4 && calls.checkTimerHealth === 4 && calls.checkForNewVersion === 4);

  // 5th tick -- backstop should fire exactly once.
  fireTick(lastCreatedWorker);
  check('after 5th tick: backstopFullSave called exactly once', calls.backstopFullSave === 1);
  check('after 5th tick: finalizeStaleHeartbeatSessionsAllUsers also fired (same 5th-tick cadence, unrelated path unaffected)',
    calls.finalizeStaleHeartbeatSessionsAllUsers === 1);

  // 10 ticks total -- backstop should have fired exactly twice (5th and 10th).
  for (let i = 0; i < 5; i++) fireTick(lastCreatedWorker);
  check('after 10 ticks total: backstopFullSave called exactly twice', calls.backstopFullSave === 2);
}

// ═══════════════════════════════════════════════════════════════════════
// CASE 2: fallback path -- Worker construction unavailable, backstop still
// gets SOME timer (not silently dropped forever).
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== CASE 2: fallback when Worker is unavailable ===');
{
  lastCreatedWorker = null;
  const { sandbox, calls } = buildSandbox({ workerAvailable: false });
  vm.runInContext('startBackstopMonitor();', sandbox);
  check('worker did NOT initialize (Worker unavailable)', sandbox.reliableTickWorkerActive === false);
  check('no MockWorker instance was created', lastCreatedWorker === null);

  const backstopFallbackCalls = calls.setIntervalCalls.filter((c) => c.ms === 5 * 60 * 1000);
  check('startBackstopMonitor() registered a plain-interval fallback for backstopFullSave (not silently dropped)',
    backstopFallbackCalls.length === 1);

  // Confirm the fallback interval actually invokes backstopFullSave when fired.
  if (backstopFallbackCalls.length === 1) {
    backstopFallbackCalls[0].fn();
    check('fallback interval callback actually calls backstopFullSave', calls.backstopFullSave === 1);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// CASE 3: no double-firing -- when the worker IS active, startBackstopMonitor()
// must NOT also register a plain-interval fallback (both paths running at
// once would double write frequency, the opposite of the goal).
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== CASE 3: no double-firing when worker is active ===');
{
  lastCreatedWorker = null;
  const { sandbox, calls } = buildSandbox({ workerAvailable: true });
  vm.runInContext('startBackstopMonitor();', sandbox);
  const backstopFallbackCalls = calls.setIntervalCalls.filter((c) => c.ms === 5 * 60 * 1000);
  check('worker active: startBackstopMonitor() registered ZERO plain-interval fallbacks (worker tick is the only path)',
    backstopFallbackCalls.length === 0);

  // Static source check: the OLD unconditional standalone wiring must be
  // fully gone from the real file, not left running alongside the new path.
  const oldWiringPattern = /backstopFullSaveInterval\s*=\s*setInterval\(\s*\(\)\s*=>\s*\{\s*backstopFullSave\(\);\s*\},\s*5 \* 60 \* 1000\)/;
  check('old standalone unconditional backstopFullSaveInterval wiring is fully removed from index.html',
    !oldWiringPattern.test(fullScript));

  // Confirm exactly one `let backstopFullSaveInterval` declaration remains
  // (inside startBackstopMonitor's scope-adjacent declaration) -- a
  // duplicate `let` in the same top-level script scope would be a syntax
  // error, already covered by node --check, but assert the count directly
  // here too since that's the specific regression this stage could cause.
  const letDeclCount = (fullScript.match(/let backstopFullSaveInterval\s*=\s*null;/g) || []).length;
  check('exactly one `let backstopFullSaveInterval` declaration in the file (no duplicate)', letDeclCount === 1);
}

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
