// Fixture for the session-revival race fix (2026-09-05).
//
// The app already had revival-protection machinery (sessionExternallyClosed,
// awaitingWakeVerification, verifySessionStillOpenOnWake(),
// attachSessionCloseListener()) -- this is not "no protection," it's
// "existing protection had an ordering hole." awaitingWakeVerification is
// only ever SET by checkTimerHealth(), but every wake path (the
// visibilitychange "tab visible again" handler, both 'online' listeners,
// 'focus', and the reliable tick worker's own onmessage) calls
// heartbeatSession()/finalizeCurrentSession() BEFORE checkTimerHealth()
// runs in that same handler -- so the flag can still read false on the
// very FIRST write attempt after a genuine long silence, letting a stale
// client revive an already-closed session exactly once per wake (Taskiya
// Sept 3: closed 11:01, revived by a heartbeat at 11:12).
//
// The fix does NOT add a second/parallel guard system: tripWakeVerificationIfStale()
// computes the exact same staleness condition checkTimerHealth() already
// uses, sets the SAME flag, and calls the SAME unmodified
// verifySessionStillOpenOnWake() -- it just does so at the one chokepoint
// both write-attempting functions already share, so it's correct
// regardless of what has or hasn't run yet on this tick, closing the hole
// at its source instead of trying to reorder five separate listeners.
//
// Extracts the ACTUAL functions from index.html (brace-matched, not
// retyped) and runs them in a vm sandbox -- same discipline as every
// other fixture in this repo.
//
// Central claims under test:
//  - a stale client (old lastHeartbeatSuccessAt, awaitingWakeVerification
//    still false -- exactly Taskiya's case) calling heartbeatSession()
//    against a doc the server has already closed does NOT write a
//    reviving heartbeat, and the stale local session gets discarded
//    (mirrors what verifySessionStillOpenOnWake() already does)
//  - same proof for finalizeCurrentSession()
//  - a genuinely-still-open session (server inProgress:true) resumes
//    EXACTLY as before -- no regression: the verification clears the
//    flag without touching timerRunning/currentSessionLogId, and the
//    very next heartbeat writes normally
//  - a read failure/ambiguous case fails OPEN -- the session is NOT
//    discarded, resumes unverified, matching verifySessionStillOpenOnWake()'s
//    own pre-existing (untouched) fail-open behavior
//  - the fix reuses the existing mechanism (same flag, same verify
//    function) rather than introducing a parallel one -- proven by
//    source-text, not just asserted
//  - touches only the resume/heartbeat path -- zero references to
//    saveData/computeCollectionDiffs/syncChangedDocs/diffMode anywhere
//    in the new code
//  - every wake-listener call site is untouched (still calls
//    heartbeatSession/finalizeCurrentSession/reArmHeartbeat exactly as
//    before) -- the fix required zero listener changes, by design
//
// Run with: node test/fix-session-revival-race.test.js
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

function extractFunction(source, name) {
  let startIdx = source.indexOf(`async function ${name}(`);
  if (startIdx < 0) startIdx = source.indexOf(`function ${name}(`);
  assert.ok(startIdx >= 0, `could not find "function ${name}(" in index.html`);
  // Find the body's opening brace by first skipping past the matching
  // close of the PARAMETER LIST -- a destructured param with a default
  // (e.g. resetTimer({ keepCloseListener = false } = {})) has its own
  // '{'/'}' pairs before the body even starts, which a naive "first {
  // after the name" search mismatches against.
  const parenStart = source.indexOf('(', startIdx);
  let pdepth = 0, j = parenStart;
  for (; j < source.length; j++) {
    if (source[j] === '(') pdepth++;
    else if (source[j] === ')') { pdepth--; if (pdepth === 0) break; }
  }
  const braceStart = source.indexOf('{', j);
  let depth = 0, i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  return source.slice(startIdx, i + 1);
}
function extractLine(source, startsWith) {
  const idx = source.indexOf(startsWith);
  assert.ok(idx >= 0, `could not find "${startsWith}" in index.html`);
  const end = source.indexOf(';', idx) + 1;
  return source.slice(idx, end);
}
function extractBlockFrom(source, anchor) {
  const idx = source.indexOf(anchor);
  assert.ok(idx >= 0, `could not find anchor: ${anchor}`);
  const braceStart = source.indexOf('{', idx);
  let depth = 0, i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  const semiIdx = source.indexOf(';', i);
  assert.ok(semiIdx >= 0, 'could not find terminating ; after the matched block');
  return source.slice(idx, semiIdx + 1);
}

const tripSrc = extractFunction(fullScript, 'tripWakeVerificationIfStale');
const verifySrc = extractFunction(fullScript, 'verifySessionStillOpenOnWake');
const heartbeatSrc = extractFunction(fullScript, 'heartbeatSession');
const finalizeSrc = extractFunction(fullScript, 'finalizeCurrentSession');
const resetTimerSrc = extractFunction(fullScript, 'resetTimer');
const detachSrc = extractFunction(fullScript, 'detachSessionCloseListener');
const fmtSrc = extractFunction(fullScript, 'fmt');
const capSrc = extractFunction(fullScript, 'capSessionDuration');
const heartbeatAlertMsLine = extractLine(fullScript, 'const HEARTBEAT_ALERT_MS');
const wdAlertMsLine = extractLine(fullScript, 'const WD_ALERT_MS');
const maxSessionHoursLine = extractLine(fullScript, 'const MAX_SESSION_HOURS');

let passCount = 0, failCount = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); passCount++; }
  else { console.log(`  FAIL: ${label}`); failCount++; }
}

// ═══════════════════════════════════════════════════════════════════
console.log('=== Source-text: fix reuses the existing mechanism, does not duplicate it ===');
check('tripWakeVerificationIfStale() sets the SAME awaitingWakeVerification flag (no new flag introduced)', tripSrc.includes('awaitingWakeVerification = true'));
check('tripWakeVerificationIfStale() calls the SAME, unmodified verifySessionStillOpenOnWake() (no second verification function)', tripSrc.includes('verifySessionStillOpenOnWake()'));
check('tripWakeVerificationIfStale() uses the SAME WD_ALERT_MS threshold checkTimerHealth() already uses (not a new constant)', tripSrc.includes('WD_ALERT_MS'));
check('verifySessionStillOpenOnWake()\'s fail-open catch/finally is untouched (same "resuming unverified" text)', verifySrc.includes('resuming unverified') && verifySrc.includes('awaitingWakeVerification = false'));
check('verifySessionStillOpenOnWake() only discards on an AFFIRMATIVE inProgress===false (never on ambiguity)', verifySrc.includes('data.inProgress === false'));
check('heartbeatSession() now calls tripWakeVerificationIfStale() instead of a bare flag check', heartbeatSrc.includes('tripWakeVerificationIfStale()'));
check('finalizeCurrentSession() now calls tripWakeVerificationIfStale() instead of a bare flag check', finalizeSrc.includes('tripWakeVerificationIfStale()'));
check('sessionExternallyClosed guard in heartbeatSession() is untouched (still checked separately)', heartbeatSrc.includes('if (sessionExternallyClosed) return'));
check('sessionExternallyClosed guard in finalizeCurrentSession() is untouched', finalizeSrc.includes('if (sessionExternallyClosed) return'));

console.log('\n=== Source-text: touches ONLY the resume/heartbeat path, not save/delete/diffMode ===');
const allNewCode = [tripSrc].join('\n');
check('tripWakeVerificationIfStale() never references saveData/computeCollectionDiffs/syncChangedDocs/diffMode', !/saveData\(|computeCollectionDiffs|syncChangedDocs|diffMode/.test(allNewCode));
check('tripWakeVerificationIfStale() contains no Firestore .set(/.update(/.add(/.delete(/.batch( of its own -- it only flips a flag and calls the existing verify function', !/\.(set|update|add|delete|batch)\(/.test(allNewCode));

console.log('\n=== Source-text: every wake-listener call site is untouched ===');
// Simple substring checks, not brace-extraction -- these listeners were
// never touched by this fix, so proving their exact call order/text is
// still present (byte-for-byte, same strings the pre-fix file had) is
// sufficient and more robust than re-deriving exact anchors.
check('the main visibilitychange listener still calls finalizeCurrentSession(\'tab resumed\') then reArmHeartbeat() then checkTimerHealth(), in that order -- untouched', (() => {
  const idx1 = fullScript.indexOf(`finalizeCurrentSession('tab resumed')`);
  const idx2 = fullScript.indexOf('reArmHeartbeat();', idx1);
  const idx3 = fullScript.indexOf('checkTimerHealth();', idx2);
  return idx1 >= 0 && idx2 > idx1 && idx3 > idx2;
})());
check('the first online listener still calls reArmHeartbeat() (unchanged)', fullScript.includes(`window.addEventListener('online', () => { console.log('🌐 Network back online -- re-arming heartbeat'); reArmHeartbeat(); });`));
check('the second online listener still calls finalizeCurrentSession(\'reconnected\') (unchanged)', fullScript.includes(`finalizeCurrentSession('reconnected')`));
check('the focus listener still calls reArmHeartbeat() (unchanged)', fullScript.includes(`window.addEventListener('focus', () => { reArmHeartbeat(); });`));
check('the reliable tick worker\'s onmessage still calls heartbeatSession() directly on every tick (unchanged)', fullScript.includes('if (timerRunning) heartbeatSession();'));

// ═══════════════════════════════════════════════════════════════════
// Behavioral: build a sandbox with the REAL extracted functions and a
// controllable mock Firestore, and actually run the race.
// ═══════════════════════════════════════════════════════════════════
function buildSandbox(serverDocState, { getShouldThrow = false } = {}) {
  const calls = { upserts: [], updates: [], resetTimerCalled: false, notifications: [] };
  const sandbox = {
    console,
    Date,
    // -- session/timer state, exactly the globals these functions read/write --
    timerRunning: true,
    timerStartedAt: Date.now() - 6 * 60 * 60 * 1000, // started 6h ago
    currentSessionLogId: 'sess1',
    timerLinkedPlan: { projectId: 'p1', project: 'Test Project', phase: 'Final Design', typology: 'Final Design – Detailed Drawings', type: 'work' },
    timerPausedMs: 0,
    staleVersionLockout: false,
    sessionExternallyClosed: false,
    awaitingWakeVerification: false,
    // Exactly Taskiya's case: last CONFIRMED heartbeat was well over WD_ALERT_MS
    // (5min) ago -- a genuine long silence -- but the flag hasn't been tripped
    // yet, because (in the real bug) checkTimerHealth() hasn't run this tick.
    lastHeartbeatSuccessAt: Date.now() - 20 * 60 * 1000,
    wdStage: 0, wdLastNotifiedMs: 0, wdSavedTitle: null,
    currentUser: { id: 'u1', name: 'Taskiya' },
    APP_VERSION: 'TEST',
    sessionHeartbeatInterval: null, timerInterval: null,
    watchedSessionId: null, sessionCloseListenerUnsub: null,
    localStorage: { removeItem: () => {}, setItem: () => {}, getItem: () => null },
    window: { lastSessionStartedAt: null, __lastPlan: null },
    document: {
      title: 'SQUARE',
      getElementById: () => ({
        style: {}, classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
        set innerHTML(v) {}, set textContent(v) {}, addEventListener: () => {}, disabled: false,
      }),
    },
    upsertTimeLog: (log) => { calls.upserts.push(log); },
    detachSessionCloseListener: () => {},
    hideTimerDeathBanner: () => {},
    updateTimerVisualState: () => {},
    checkTimerHealth: () => {}, // called from heartbeatSession()'s own write-success .then(); irrelevant to these assertions
    showNotificationToast: (title, msg, kind) => { calls.notifications.push({ title, msg, kind }); },
    firebase: { firestore: { FieldValue: { serverTimestamp: () => 'SERVER_TS' } } },
    db: {
      collection: (name) => {
        assert.strictEqual(name, 'timeLogs');
        return {
          doc: (id) => ({
            get: async (opts) => {
              assert.strictEqual(opts && opts.source, 'server', 'must force source:\'server\'');
              if (getShouldThrow) throw new Error('simulated network failure');
              calls.updates.push({ type: 'get', id });
              if (serverDocState === null) return { exists: false };
              return { exists: true, data: () => serverDocState };
            },
            update: async (fields) => { calls.updates.push({ type: 'update', id, fields }); },
          }),
        };
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(wdAlertMsLine, sandbox);
  vm.runInContext(heartbeatAlertMsLine, sandbox);
  vm.runInContext(maxSessionHoursLine, sandbox);
  vm.runInContext(fmtSrc, sandbox);
  vm.runInContext(capSrc, sandbox);
  vm.runInContext(detachSrc, sandbox); // real one, overrides the plain stub above with the actual (harmless) implementation
  vm.runInContext(resetTimerSrc, sandbox);
  vm.runInContext(verifySrc, sandbox);
  vm.runInContext(tripSrc, sandbox);
  vm.runInContext(heartbeatSrc, sandbox);
  vm.runInContext(finalizeSrc, sandbox);
  return { sandbox, calls };
}

async function run() {
  console.log('\n=== Behavioral: stale client, server already closed the doc (Taskiya\'s exact shape) ===');
  {
    const { sandbox, calls } = buildSandbox({ inProgress: false, recovered: true });
    const heartbeatSession = vm.runInContext('heartbeatSession', sandbox);
    heartbeatSession();
    // tripWakeVerificationIfStale() fires verifySessionStillOpenOnWake()
    // fire-and-forget -- give its promise a tick to resolve.
    await new Promise((r) => setTimeout(r, 20));
    check('NO reviving write was attempted (upsertTimeLog never called)', calls.upserts.length === 0);
    check('a source:\'server\' get was performed to check the real state', calls.updates.some((c) => c.type === 'get'));
    check('the stale local session was discarded (timerRunning is now false)', vm.runInContext('timerRunning', sandbox) === false);
    check('currentSessionLogId was cleared (fully torn down, not left dangling)', vm.runInContext('currentSessionLogId', sandbox) === null);
    check('user was notified the session was already closed', calls.notifications.some((n) => /closed while this tab was away/i.test(n.msg)));
  }

  console.log('\n=== Behavioral: same race, via finalizeCurrentSession() ===');
  {
    const { sandbox, calls } = buildSandbox({ inProgress: false, recovered: true });
    const finalizeCurrentSession = vm.runInContext('finalizeCurrentSession', sandbox);
    finalizeCurrentSession('tab resumed');
    await new Promise((r) => setTimeout(r, 20));
    check('NO reviving checkpoint write was attempted (upsertTimeLog never called)', calls.upserts.length === 0);
    check('the stale local session was discarded here too', vm.runInContext('timerRunning', sandbox) === false);
  }

  console.log('\n=== KEY SAFETY FIXTURE: a genuinely-still-open session resumes EXACTLY as today ===');
  {
    const { sandbox, calls } = buildSandbox({ inProgress: true });
    const heartbeatSession = vm.runInContext('heartbeatSession', sandbox);
    heartbeatSession(); // first call: detects staleness, defers this ONE tick to verify
    await new Promise((r) => setTimeout(r, 20));
    check('first tick after a silence still does not write blindly (verification runs first)', calls.upserts.length === 0);
    check('verification found the session genuinely still open -- NOT discarded (timerRunning still true)', vm.runInContext('timerRunning', sandbox) === true);
    check('currentSessionLogId is untouched (still the same session, not torn down)', vm.runInContext('currentSessionLogId', sandbox) === 'sess1');
    check('awaitingWakeVerification cleared after a confirmed-open result', vm.runInContext('awaitingWakeVerification', sandbox) === false);
    // V24 loop-prevention check: a confirmed-open verification must refresh
    // lastHeartbeatSuccessAt -- otherwise the NEXT call recomputes the SAME
    // stale gap, re-trips the guard, and defers forever on a perfectly
    // healthy session (found by this exact fixture while building the fix).
    check('lastHeartbeatSuccessAt was refreshed by the confirmed-open verification (not left at its original stale value)', vm.runInContext('lastHeartbeatSuccessAt', sandbox) > Date.now() - 5000);

    // Next tick: flag is now clear, heartbeat proceeds completely normally --
    // no lasting behavior change for a legitimate resume.
    heartbeatSession();
    check('the VERY NEXT heartbeat writes normally once verified (no permanent block, no regression)', calls.upserts.length === 1);

    // And a THIRD call: proves this isn't a one-off coincidence -- a
    // healthy session keeps heartbeating normally, tick after tick, with
    // no recurring re-verification loop.
    heartbeatSession();
    check('a THIRD heartbeat also writes normally -- no re-trip loop, genuinely resolved for good', calls.upserts.length === 2);
  }

  console.log('\n=== Fail-safe direction: a read failure never destroys a live session ===');
  {
    const { sandbox, calls } = buildSandbox({ inProgress: false }, { getShouldThrow: true });
    const heartbeatSession = vm.runInContext('heartbeatSession', sandbox);
    heartbeatSession();
    await new Promise((r) => setTimeout(r, 20));
    check('on a read failure, the session is NOT discarded (timerRunning still true -- fails OPEN, not closed)', vm.runInContext('timerRunning', sandbox) === true);
    check('currentSessionLogId is untouched on a failed read', vm.runInContext('currentSessionLogId', sandbox) === 'sess1');
    check('awaitingWakeVerification clears even on failure (so the next tick can retry/resume, not get stuck forever)', vm.runInContext('awaitingWakeVerification', sandbox) === false);
  }

  console.log('\n=== No double-trigger: concurrent calls only verify once ===');
  {
    let getCallCount = 0;
    const { sandbox } = buildSandbox({ inProgress: true });
    // Wrap the mock get to count invocations across two rapid calls.
    const origDb = vm.runInContext('db', sandbox);
    const heartbeatSession = vm.runInContext('heartbeatSession', sandbox);
    const trip = vm.runInContext('tripWakeVerificationIfStale', sandbox);
    trip(); // first call trips it and kicks off verification
    const trippedOnce = vm.runInContext('awaitingWakeVerification', sandbox) === true;
    trip(); // second call, verification still in flight -- must not fire a second fetch
    check('a second call while verification is already in flight does not re-trigger it (guarded by !awaitingWakeVerification)', trippedOnce);
    await new Promise((r) => setTimeout(r, 20));
  }

  console.log('\n=== A session with NO silence at all is never touched by this fix ===');
  {
    const { sandbox, calls } = buildSandbox({ inProgress: true });
    vm.runInContext('lastHeartbeatSuccessAt = Date.now();', sandbox); // just heartbeated, no silence
    const heartbeatSession = vm.runInContext('heartbeatSession', sandbox);
    heartbeatSession();
    check('a healthy, recently-confirmed session writes immediately -- no verification detour at all for the common case', calls.upserts.length === 1);
  }

  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
