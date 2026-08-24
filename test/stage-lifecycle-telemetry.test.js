// Fixture test for the Page Lifecycle telemetry addition (V16.6):
// document.wasDiscarded (on load) + freeze/resume events, recorded
// additively on the relevant session doc as lifecycleEvent/lifecycleEventAt.
// Diagnosed 2026-08-20/21 -- see FINDINGS-2026-08-10.md, "Backgrounded-tab
// heartbeat survival gap." Goal: prove (a) the new telemetry records
// correctly in every trigger case, and (b) existing orphan-recovery/
// restore behavior is byte-for-byte unchanged whether or not this fires.
//
// index.html is not a module (plain classic script) so this test extracts
// the ACTUAL function/block source directly from the real file (brace- or
// span-matched, not retyped) and runs it in a vm sandbox with mocked
// Firestore `db` and `document` -- proving the real shipped code.
//
// Run with: node test/stage-lifecycle-telemetry.test.js
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

function extractSpan(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `could not find start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end >= 0, `could not find end marker: ${endMarker}`);
  return source.slice(start, end);
}

const lifecycleBlockSrc = extractSpan(
  fullScript,
  '// V16.6: PAGE LIFECYCLE TELEMETRY',
  '// V14.3.19: DEPLOY VERSION CHECK'
);
assert.ok(lifecycleBlockSrc.includes('const pageWasDiscarded'), 'lifecycle block extraction missed pageWasDiscarded');
assert.ok(lifecycleBlockSrc.includes('async function recordLifecycleEvent'), 'lifecycle block extraction missed recordLifecycleEvent');
assert.ok(lifecycleBlockSrc.includes(`addEventListener('freeze'`), 'lifecycle block extraction missed freeze listener');
assert.ok(lifecycleBlockSrc.includes(`addEventListener('resume'`), 'lifecycle block extraction missed resume listener');

const extractLastSeenMsSrc = extractFunction(fullScript, 'extractLastSeenMs');
const capSessionDurationSrc = extractFunction(fullScript, 'capSessionDuration');
const tryAutoCloseOrphanSrc = extractFunction(fullScript, 'tryAutoCloseOrphan');
const checkForOrphanedSessionOnLoadSrc = extractFunction(fullScript, 'checkForOrphanedSessionOnLoad');
const restoreTimerStateSrc = extractFunction(fullScript, 'restoreTimerState');

// Confirm the real call sites actually wire the new telemetry in -- not a
// hand-verified detail, checked directly against the extracted source.
assert.ok(checkForOrphanedSessionOnLoadSrc.includes('recordLifecycleEvent'), 'checkForOrphanedSessionOnLoad() does not call recordLifecycleEvent -- not wired in as expected');
assert.ok(restoreTimerStateSrc.includes('recordLifecycleEvent'), 'restoreTimerState() does not call recordLifecycleEvent -- not wired in as expected');

console.log('--- confirmed: both hook call sites reference recordLifecycleEvent() ---');

function fakeElement() {
  return { classList: { add() {}, remove() {}, contains: () => false }, style: {}, set textContent(v) {}, get textContent() { return ''; }, addEventListener() {} };
}

function buildSandbox({ wasDiscarded = false, writeShouldFail = false } = {}) {
  const writes = []; // { id, data } for every db update() call, in order
  const listeners = {};

  const sandbox = {
    console,
    window: { _saveInProgress: false },
    currentSessionLogId: null,
    timerRunning: false,
    timerLogs: [],
    timeLogs: [],
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      wasDiscarded,
      addEventListener(type, cb) { listeners[type] = cb; },
      getElementById: () => fakeElement(),
    },
    // Dependencies of restoreTimerState()/checkForOrphanedSessionOnLoad()
    // unrelated to the lifecycle question -- stubbed as no-ops so the real
    // functions run for genuine coverage without needing a full DOM/UI.
    MAX_SESSION_HOURS: 12,
    STALE_HEARTBEAT_MS: 5 * 60 * 1000, // matches the real const, seeded directly (see docSnapshots precedent in other fixtures)
    orphanTimerState: null,
    showOrphanRecoveryModal() {},
    showNotificationToast() {},
    showOrphanSessionBanner() {},
    detachSessionCloseListener() {},
    attachSessionCloseListener() {},
    initReliableTickWorker() {},
    reliableTickWorkerActive: true,
    sessionHeartbeatInterval: null,
    timerStartedAt: null,
    timerPausedMs: 0,
    timerLinkedPlan: null,
    timerInterval: null,
    wdStage: 0,
    checkTimerHealth() {},
    updateTimerVisualState() {},
    secsToHMS: () => '',
    getElapsed: () => 0,
    heartbeatSession() {},
    setInterval: () => 0,
    clearInterval() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(extractLastSeenMsSrc, sandbox);
  vm.runInContext(capSessionDurationSrc, sandbox);
  vm.runInContext(lifecycleBlockSrc, sandbox);
  vm.runInContext(tryAutoCloseOrphanSrc, sandbox);
  vm.runInContext(checkForOrphanedSessionOnLoadSrc, sandbox);
  vm.runInContext(restoreTimerStateSrc, sandbox);

  sandbox.db = {
    collection(collectionName) {
      return {
        doc(id) {
          return {
            id,
            get(opts) {
              const doc_ = sandbox.__serverDocs && sandbox.__serverDocs[id];
              return Promise.resolve({ exists: !!doc_, id, data: () => doc_ });
            },
            update(data) {
              if (writeShouldFail) return Promise.reject(new Error('simulated write failure'));
              writes.push({ id, data });
              return Promise.resolve();
            },
          };
        },
      };
    },
  };

  return { sandbox, writes, listeners };
}

let passCount = 0, failCount = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); passCount++; }
  else { console.log(`  FAIL: ${label}`); failCount++; }
}

function lifecycleWritesFor(writes, id) {
  return writes.filter(w => w.id === id && w.data.lifecycleEvent !== undefined);
}

async function run() {
  // ═══════════════════════════════════════════════════════
  // CASE 1: freeze event with an active session -> tagged 'frozen'.
  // ═══════════════════════════════════════════════════════
  console.log('=== CASE 1: freeze event, active session -> tagged "frozen" ===');
  {
    const { sandbox, writes, listeners } = buildSandbox({});
    sandbox.currentSessionLogId = 'sess1';
    listeners.freeze();
    await new Promise(r => setTimeout(r, 0)); // let the fire-and-forget async call resolve
    const w = lifecycleWritesFor(writes, 'sess1');
    check('exactly one lifecycle write for sess1', w.length === 1);
    check('tagged "frozen"', w[0] && w[0].data.lifecycleEvent === 'frozen');
    check('lifecycleEventAt is an ISO timestamp string', w[0] && typeof w[0].data.lifecycleEventAt === 'string' && !isNaN(Date.parse(w[0].data.lifecycleEventAt)));
  }

  // ═══════════════════════════════════════════════════════
  // CASE 2: resume event with an active session -> tagged 'resumed'.
  // ═══════════════════════════════════════════════════════
  console.log('\n=== CASE 2: resume event, active session -> tagged "resumed" ===');
  {
    const { sandbox, writes, listeners } = buildSandbox({});
    sandbox.currentSessionLogId = 'sess2';
    listeners.resume();
    await new Promise(r => setTimeout(r, 0));
    const w = lifecycleWritesFor(writes, 'sess2');
    check('exactly one lifecycle write for sess2', w.length === 1);
    check('tagged "resumed"', w[0] && w[0].data.lifecycleEvent === 'resumed');
  }

  // ═══════════════════════════════════════════════════════
  // CASE 3: freeze/resume with NO active session -> no write attempted.
  // ═══════════════════════════════════════════════════════
  console.log('\n=== CASE 3: freeze/resume, no active session -> no write ===');
  {
    const { sandbox, writes, listeners } = buildSandbox({});
    sandbox.currentSessionLogId = null;
    listeners.freeze();
    listeners.resume();
    await new Promise(r => setTimeout(r, 0));
    check('zero lifecycle writes when no session is active', writes.filter(w => w.data.lifecycleEvent !== undefined).length === 0);
  }

  // ═══════════════════════════════════════════════════════
  // CASE 4: checkForOrphanedSessionOnLoad(), pageWasDiscarded=false, an
  // orphan found and closed -> normal recovery fields set, NO lifecycle
  // tag. Proves existing behavior is unchanged when the signal is absent.
  // ═══════════════════════════════════════════════════════
  console.log('\n=== CASE 4: orphan recovered, wasDiscarded=false -> no lifecycle tag (regression check) ===');
  {
    const { sandbox, writes } = buildSandbox({ wasDiscarded: false });
    sandbox.currentUser = { id: 'u1' };
    sandbox.currentSessionLogId = null;
    sandbox.timerRunning = false;
    // Fixed, deterministic, whole-second timestamps -- extractLastSeenMs()
    // floors lastHeartbeat.seconds to whole seconds, so a Date.now()-relative
    // value risks losing a sub-second remainder non-deterministically across
    // test runs, occasionally shaving sessionSecs from 3600 to 3599 and
    // flipping durationMins between 60/59. Fixed base avoids that entirely.
    const hbMs = 1755600000000; // 2025-08-19T09:20:00.000Z, exact whole second
    const startMs = hbMs - 60 * 60 * 1000; // exactly 1h earlier
    sandbox.db.collection = (name) => ({
      where() { return this; },
      get(opts) {
        return Promise.resolve({
          forEach(cb) {
            cb({ id: 'orphan1', data: () => ({ id: 'orphan1', userId: 'u1', sessionStartMs: startMs, lastHeartbeat: { seconds: Math.floor(hbMs / 1000) }, desc: 'Work', inProgress: true }) });
          },
        });
      },
      doc(id) {
        return { id, update: (data) => { writes.push({ id, data }); return Promise.resolve(); } };
      },
    });
    await vm.runInContext('checkForOrphanedSessionOnLoad', sandbox)();
    const recoveryWrite = writes.find(w => w.id === 'orphan1' && w.data.recovered === true);
    check('orphan was recovered normally (recovered:true written)', !!recoveryWrite);
    check('no lifecycleEvent field on the recovery write itself', recoveryWrite && recoveryWrite.data.lifecycleEvent === undefined);
    check('no separate lifecycle write happened at all', lifecycleWritesFor(writes, 'orphan1').length === 0);
  }

  // ═══════════════════════════════════════════════════════
  // CASE 5: same scenario, pageWasDiscarded=true -> normal recovery fields
  // STILL set identically, PLUS a separate lifecycleEvent:'discarded' tag.
  // ═══════════════════════════════════════════════════════
  console.log('\n=== CASE 5: orphan recovered, wasDiscarded=true -> recovery unchanged + tagged "discarded" ===');
  {
    const { sandbox, writes } = buildSandbox({ wasDiscarded: true });
    sandbox.currentUser = { id: 'u1' };
    sandbox.currentSessionLogId = null;
    sandbox.timerRunning = false;
    // Same fixed, deterministic timestamps as Case 4 -- must match exactly
    // so the "identical to the wasDiscarded=false case" comparison is
    // actually meaningful, not just coincidentally equal.
    const hbMs = 1755600000000;
    const startMs = hbMs - 60 * 60 * 1000;
    sandbox.db.collection = (name) => ({
      where() { return this; },
      get() {
        return Promise.resolve({
          forEach(cb) {
            cb({ id: 'orphan2', data: () => ({ id: 'orphan2', userId: 'u1', sessionStartMs: startMs, lastHeartbeat: { seconds: Math.floor(hbMs / 1000) }, desc: 'Work', inProgress: true }) });
          },
        });
      },
      doc(id) {
        return { id, update: (data) => { writes.push({ id, data }); return Promise.resolve(); } };
      },
    });
    await vm.runInContext('checkForOrphanedSessionOnLoad', sandbox)();
    const recoveryWrite = writes.find(w => w.id === 'orphan2' && w.data.recovered === true);
    const lifecycleWrite = writes.find(w => w.id === 'orphan2' && w.data.lifecycleEvent === 'discarded');
    check('orphan still recovered normally (recovered:true written)', !!recoveryWrite);
    check('recovery write itself carries no lifecycle field (separate call, not merged in)', recoveryWrite && recoveryWrite.data.lifecycleEvent === undefined);
    check('a SEPARATE write tagged lifecycleEvent:"discarded" happened', !!lifecycleWrite);
    check('recovery fields (durationMins) identical to the wasDiscarded=false case', recoveryWrite && typeof recoveryWrite.data.durationMins === 'number' && recoveryWrite.data.durationMins === 60);
  }

  // ═══════════════════════════════════════════════════════
  // CASE 6: pageWasDiscarded=true but no orphan found -> nothing to tag,
  // no lifecycle write at all.
  // ═══════════════════════════════════════════════════════
  console.log('\n=== CASE 6: wasDiscarded=true, no orphan found -> no lifecycle write ===');
  {
    const { sandbox, writes } = buildSandbox({ wasDiscarded: true });
    sandbox.currentUser = { id: 'u1' };
    sandbox.currentSessionLogId = null;
    sandbox.timerRunning = false;
    sandbox.db.collection = () => ({
      where() { return this; },
      get() { return Promise.resolve({ forEach() {} }); }, // no orphans
      doc(id) { return { id, update: (data) => { writes.push({ id, data }); return Promise.resolve(); } }; },
    });
    await vm.runInContext('checkForOrphanedSessionOnLoad', sandbox)();
    check('zero writes of any kind when nothing was orphaned', writes.length === 0);
  }

  // ═══════════════════════════════════════════════════════
  // CASE 7: restoreTimerState(), pageWasDiscarded=false, normal resume
  // under MAX_SESSION_HOURS -> session resumes, NO lifecycle tag.
  // ═══════════════════════════════════════════════════════
  console.log('\n=== CASE 7: restoreTimerState(), wasDiscarded=false -> resumes normally, no tag ===');
  {
    const { sandbox, writes } = buildSandbox({ wasDiscarded: false });
    sandbox.localStorage.getItem = () => JSON.stringify({
      running: true, startedAt: Date.now() - 30 * 60 * 1000, pausedMs: 0,
      linkedPlan: { project: 'X' }, sessionLogId: 'resumed1',
    });
    await vm.runInContext('restoreTimerState', sandbox)();
    check('session resumed (timerRunning true)', sandbox.timerRunning === true);
    check('currentSessionLogId set to the saved id', sandbox.currentSessionLogId === 'resumed1');
    check('no lifecycle write happened', lifecycleWritesFor(writes, 'resumed1').length === 0);
  }

  // ═══════════════════════════════════════════════════════
  // CASE 8: same, pageWasDiscarded=true -> resumes IDENTICALLY, PLUS
  // tagged 'discarded'.
  // ═══════════════════════════════════════════════════════
  console.log('\n=== CASE 8: restoreTimerState(), wasDiscarded=true -> resumes identically + tagged "discarded" ===');
  {
    const { sandbox, writes } = buildSandbox({ wasDiscarded: true });
    sandbox.localStorage.getItem = () => JSON.stringify({
      running: true, startedAt: Date.now() - 30 * 60 * 1000, pausedMs: 0,
      linkedPlan: { project: 'X' }, sessionLogId: 'resumed2',
    });
    await vm.runInContext('restoreTimerState', sandbox)();
    await new Promise(r => setTimeout(r, 0));
    check('session resumed (timerRunning true) -- same as wasDiscarded=false', sandbox.timerRunning === true);
    check('currentSessionLogId set to the saved id -- same as wasDiscarded=false', sandbox.currentSessionLogId === 'resumed2');
    const w = lifecycleWritesFor(writes, 'resumed2');
    check('exactly one lifecycle write, tagged "discarded"', w.length === 1 && w[0].data.lifecycleEvent === 'discarded');
  }

  // ═══════════════════════════════════════════════════════
  // CASE 9: recordLifecycleEvent write failure -> doesn't throw, doesn't
  // affect anything else (console.warn only, telemetry-only failure mode).
  // ═══════════════════════════════════════════════════════
  console.log('\n=== CASE 9: lifecycle write fails -> non-fatal, telemetry-only ===');
  {
    const { sandbox, listeners } = buildSandbox({ writeShouldFail: true });
    sandbox.currentSessionLogId = 'sess9';
    let threw = false;
    try {
      listeners.freeze();
      await new Promise(r => setTimeout(r, 0));
    } catch (e) { threw = true; }
    check('a failed lifecycle write does not throw or propagate', !threw);
  }

  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
}

run();
