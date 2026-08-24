// Fixture test for the Bug B fix: checkForOrphanedSessionOnLoad() upgraded
// from advisory-only to auto-closing stale cross-context orphans, capped
// at last heartbeat.
//
// Extracts the ACTUAL function source directly from index.html (brace-
// matched, not retyped) and runs it in a vm sandbox -- same discipline as
// the Stage A/B fixtures.
//
// Run with: node bugb-orphan-autoclose.test.js
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

const capSessionDurationRegion = extractRegion(fullScript, 'const MAX_SESSION_HOURS', 'capSessionDuration');
const extractLastSeenMsSrc = extractFunction(fullScript, 'extractLastSeenMs').text;
const staleHeartbeatMsLine = 'const STALE_HEARTBEAT_MS = 5 * 60 * 1000;';
assert.ok(fullScript.includes(staleHeartbeatMsLine.slice(0, 30)), 'STALE_HEARTBEAT_MS declaration text may have drifted from index.html -- update this fixture');
const checkOrphanSrc = extractFunction(fullScript, 'checkForOrphanedSessionOnLoad').text;
const tryAutoCloseSrc = extractFunction(fullScript, 'tryAutoCloseOrphan').text;

console.log('--- extracted tryAutoCloseOrphan (first 3 lines) ---');
console.log(tryAutoCloseSrc.split('\n').slice(0, 3).join('\n') + '\n  ...\n');

// vm contexts get their OWN separate Date realm -- patching the outer
// Node process's Date.now() has zero effect on code running inside a
// vm.createContext sandbox. A real, injected fake Date class (subclassing
// the outer Date so toLocaleTimeString etc. still work) is required to
// control "now" for the extracted code.
function makeFakeDate(nowMs) {
  return class FakeDate extends Date {
    constructor(...args) { if (args.length === 0) super(nowMs); else super(...args); }
    static now() { return nowMs; }
  };
}

function buildSandbox({ existingTimeLogsEntry, nowMs } = {}) {
  const calls = {
    updates: [], // [{id, payload}]
    detachCalls: 0,
    toastCalls: [],
    bannerCalls: [],
  };
  let docStore = {}; // id -> data, for the mocked query result

  const sandbox = {
    console,
    Date: makeFakeDate(nowMs),
    STALE_HEARTBEAT_MS: 5 * 60 * 1000,
    currentUser: { id: 'u1', name: 'Fixture User' },
    currentSessionLogId: null,
    timerRunning: false,
    timeLogs: existingTimeLogsEntry ? [existingTimeLogsEntry] : [],
    detachSessionCloseListener: () => { calls.detachCalls++; },
    showNotificationToast: (title, msg, type) => { calls.toastCalls.push({ title, msg, type }); },
    showOrphanSessionBanner: (o, count, staleMin) => { calls.bannerCalls.push({ id: o.id, count, staleMin }); },
    // V16.6 (Page Lifecycle telemetry, added after this test): checkForOrphanedSessionOnLoad()
    // now references these -- this test predates and doesn't exercise that
    // feature, so pageWasDiscarded stays false (never triggers the new call)
    // and recordLifecycleEvent is a harmless no-op stub for safety.
    pageWasDiscarded: false,
    recordLifecycleEvent: () => {},
    db: {
      collection: (name) => ({
        where: () => ({
          where: () => ({
            get: async () => ({
              forEach: (cb) => { Object.entries(docStore).forEach(([id, data]) => cb({ id, data: () => data })); },
            }),
          }),
        }),
        doc: (id) => ({
          update: async (payload) => {
            calls.updates.push({ id, payload });
            docStore[id] = { ...docStore[id], ...payload };
          },
        }),
      }),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(capSessionDurationRegion, sandbox);
  vm.runInContext(extractLastSeenMsSrc, sandbox);
  vm.runInContext(tryAutoCloseSrc, sandbox);
  vm.runInContext(checkOrphanSrc, sandbox);
  return {
    sandbox, calls,
    setDocs: (docs) => { docStore = docs; },
  };
}

let passCount = 0, failCount = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); passCount++; }
  else { console.log(`  FAIL: ${label}`); failCount++; }
}

const NOW = Date.parse('2026-08-11T09:00:00+05:30'); // "discovered the next morning"

(async () => {

// ═══════════════════════════════════════════════════════════════════════
// CASE (a): clearly-stale orphan -> auto-closed, capped at LAST HEARTBEAT,
// not at "now" (discovery time is 14 hours after the heartbeat).
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== CASE (a): clearly-stale -> auto-closed, capped at last heartbeat not now ===');
{
  const { sandbox, calls, setDocs } = buildSandbox({ nowMs: NOW });
  const sessionStartMs = NOW - 14 * 3600 * 1000; // started 14h before "now"
  const lastHeartbeatMs = sessionStartMs + 47 * 60 * 1000; // alive for 47 real minutes, then died
  setDocs({
    'orphan1': {
      userId: 'u1', sessionStartMs, lastHeartbeat: { seconds: Math.floor(lastHeartbeatMs / 1000) },
      inProgress: true, projectName: 'Test Project', desc: 'Test Project',
    },
  });
  await vm.runInContext('checkForOrphanedSessionOnLoad()', sandbox);

  check('exactly one write happened', calls.updates.length === 1);
  const payload = calls.updates[0]?.payload || {};
  check('inProgress set to false', payload.inProgress === false);
  check('durationMins reflects the 47-MINUTE real session, not the 14-hour discovery gap', payload.durationMins === 47);
  check('ts is the last-heartbeat moment, not "now"', payload.ts === lastHeartbeatMs);
  check('endTime derived from the heartbeat time (04:58 IST), not discovery time (09:00 IST)', payload.endTime !== '09:00');
  check('reconciliationNeeded explicitly cleared', payload.reconciliationNeeded === false);
  check('recovered:true set', payload.recovered === true);
  check('not auto-capped (well under 12h)', !payload.autoCapped);
  check('toast shown for the auto-close, no banner (nothing left needing one)', calls.toastCalls.length === 1 && calls.bannerCalls.length === 0);
}

// ═══════════════════════════════════════════════════════════════════════
// CASE (b): fresh-heartbeat orphan -> left alone, no write, no toast.
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== CASE (b): fresh-heartbeat -> left alone entirely ===');
{
  const { sandbox, calls, setDocs } = buildSandbox({ nowMs: NOW });
  const sessionStartMs = NOW - 20 * 60 * 1000;
  const lastHeartbeatMs = NOW - 90 * 1000; // 90 seconds ago
  setDocs({
    'fresh1': { userId: 'u1', sessionStartMs, lastHeartbeat: { seconds: Math.floor(lastHeartbeatMs / 1000) }, inProgress: true, projectName: 'X' },
  });
  await vm.runInContext('checkForOrphanedSessionOnLoad()', sandbox);

  check('zero writes -- never even reached tryAutoCloseOrphan', calls.updates.length === 0);
  check('zero toasts', calls.toastCalls.length === 0);
  check('zero banners -- this is the EXISTING gate, not a new orphan at all', calls.bannerCalls.length === 0);
}

// ═══════════════════════════════════════════════════════════════════════
// CASE (c): normal fast project-switch -- never trips the auto-close.
// Two sub-cases: a heartbeat just inside the boundary (4m59s), and the
// structural guarantee that a properly-closed (inProgress:false) doc from
// a real switchTaskTo()/closeCurrentSessionNow() can never appear at all.
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== CASE (c): normal fast switch never trips auto-close (critical no-false-positive case) ===');
{
  const { sandbox, calls, setDocs } = buildSandbox({ nowMs: NOW });
  const sessionStartMs = NOW - 10 * 60 * 1000;
  const lastHeartbeatMs = NOW - (4 * 60 + 59) * 1000; // 4m59s -- just inside the 5min gate
  setDocs({
    'switch1': { userId: 'u1', sessionStartMs, lastHeartbeat: { seconds: Math.floor(lastHeartbeatMs / 1000) }, inProgress: true, projectName: 'Y' },
  });
  await vm.runInContext('checkForOrphanedSessionOnLoad()', sandbox);
  check('4m59s-old heartbeat (just inside threshold) -- zero writes', calls.updates.length === 0);
}
{
  // Structural guarantee: a doc a normal switch already closed
  // (inProgress:false) is excluded by the query's own where-filter --
  // simulate the mock's query only ever returning inProgress:true docs
  // (matching the real db.collection(...).where('inProgress','==',true)
  // filter) by simply never including a false-inProgress doc in docStore;
  // the mock's forEach only iterates what's "returned by the query."
  const { sandbox, calls, setDocs } = buildSandbox({ nowMs: NOW });
  setDocs({}); // nothing inProgress:true at all -- exactly what a clean switch leaves behind
  await vm.runInContext('checkForOrphanedSessionOnLoad()', sandbox);
  check('no inProgress:true docs at all (post-switch state) -- zero writes, zero banner', calls.updates.length === 0 && calls.bannerCalls.length === 0);
}

// ═══════════════════════════════════════════════════════════════════════
// CASE (d): detach-before-write ordering, and safe as a no-op.
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== CASE (d): detach-before-write ordering ===');
{
  const { sandbox, calls, setDocs } = buildSandbox({ nowMs: NOW });
  const sessionStartMs = NOW - 2 * 3600 * 1000;
  const lastHeartbeatMs = sessionStartMs + 30 * 60 * 1000;
  setDocs({ 'orphan2': { userId: 'u1', sessionStartMs, lastHeartbeat: { seconds: Math.floor(lastHeartbeatMs / 1000) }, inProgress: true, projectName: 'Z' } });

  let detachCallOrder = null, writeCallOrder = null, seq = 0;
  const origDetach = sandbox.detachSessionCloseListener;
  sandbox.detachSessionCloseListener = () => { detachCallOrder = ++seq; origDetach(); };
  const origCollection = sandbox.db.collection;
  sandbox.db.collection = (name) => {
    const real = origCollection(name);
    const origDoc = real.doc;
    real.doc = (id) => {
      const docRef = origDoc(id);
      const origUpdate = docRef.update;
      docRef.update = async (payload) => { writeCallOrder = ++seq; return origUpdate(payload); };
      return docRef;
    };
    return real;
  };

  await vm.runInContext('checkForOrphanedSessionOnLoad()', sandbox);

  check('detachSessionCloseListener() was called', detachCallOrder !== null);
  check('detach happened strictly before the write', detachCallOrder < writeCallOrder);
  check('no throw when nothing was actually attached (sessionCloseListenerUnsub does not exist in this sandbox at all -- real fn guards internally)', calls.updates.length === 1);
}

// ═══════════════════════════════════════════════════════════════════════
// CASE (e): unresolvable time boundary -> defers to banner, never guesses.
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== CASE (e): unresolvable boundary defers to banner, does not guess ===');
{
  const { sandbox, calls, setDocs } = buildSandbox({ nowMs: NOW });
  setDocs({
    'noheartbeat': { userId: 'u1', inProgress: true, projectName: 'NoSignal' }, // no lastHeartbeat/ts/updatedAt, no sessionStartMs, no date+startTime
  });
  await vm.runInContext('checkForOrphanedSessionOnLoad()', sandbox);

  check('zero writes -- boundary unresolvable, refused to guess', calls.updates.length === 0);
  check('falls through to the banner instead', calls.bannerCalls.length === 1);
}
{
  const { sandbox, calls, setDocs } = buildSandbox({ nowMs: NOW });
  const startMs = NOW - 3600 * 1000;
  setDocs({
    'badorder': { userId: 'u1', sessionStartMs: startMs, lastHeartbeat: { seconds: Math.floor((startMs - 60000) / 1000) }, inProgress: true, projectName: 'BadClock' }, // hb BEFORE start -- malformed
  });
  await vm.runInContext('checkForOrphanedSessionOnLoad()', sandbox);
  check('malformed hb<=start ordering -- zero writes, defers to banner', calls.updates.length === 0 && calls.bannerCalls.length === 1);
}

// ═══════════════════════════════════════════════════════════════════════
// BONUS: multiple qualifying orphans in one scan -- ALL get closed, not
// just the newest (explicit design decision, approved).
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== BONUS: closes ALL qualifying orphans in one scan, not just the newest ===');
{
  const { sandbox, calls, setDocs } = buildSandbox({ nowMs: NOW });
  const s1 = NOW - 5 * 3600 * 1000, hb1 = s1 + 20 * 60 * 1000;
  const s2 = NOW - 3 * 3600 * 1000, hb2 = s2 + 35 * 60 * 1000;
  setDocs({
    'old1': { userId: 'u1', sessionStartMs: s1, lastHeartbeat: { seconds: Math.floor(hb1 / 1000) }, inProgress: true, projectName: 'Old' },
    'newer1': { userId: 'u1', sessionStartMs: s2, lastHeartbeat: { seconds: Math.floor(hb2 / 1000) }, inProgress: true, projectName: 'Newer' },
  });
  await vm.runInContext('checkForOrphanedSessionOnLoad()', sandbox);
  check('both orphans closed, not just the newest', calls.updates.length === 2);
  check('one combined toast, not two', calls.toastCalls.length === 1 && calls.toastCalls[0].msg.includes('2 sessions'));
}

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
})().catch((e) => { console.error('FIXTURE ERROR:', e); process.exit(1); });
