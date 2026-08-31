// Fixture test for the Glitch 3 RACE fix: restoreTimerState()'s original
// guard (test/fix-orphan-recovery-duplicate-guard.test.js) checks server
// state exactly once, before the self-report modal is shown -- but Bug B
// (checkForOrphanedSessionOnLoad -> tryAutoCloseOrphan) can independently
// close the SAME session in the gap before the user actually clicks Save.
// Right after any crash the doc is ALWAYS still inProgress:true at
// modal-show time (nothing else has touched it yet), so that guard can
// structurally never catch this -- exactly what happened to Taskiya's
// 24 Aug day (Bug B closed the doc at 11:10:04, the modal was submitted
// 29 seconds later at 11:10:33, writing a duplicate on top of it).
//
// THE CRITICAL DIFFERENCE FROM THE ORIGINAL 10 FIXTURES: those all mock a
// server doc whose state is STATIC for the whole test -- which is exactly
// why this race shipped uncaught. The fixtures below model TWO-STEP
// timing: the local `timeLogs` array's state at modal-OPEN differs from
// its state at modal-SUBMIT, with a simulated Bug B write happening in
// between -- the same shape as the real incident.
//
// Extracts the ACTUAL function/handler source directly from index.html
// (brace-matched, not retyped) and runs it in a vm sandbox -- proving the
// real shipped code, same discipline as every other fixture in this repo.
//
// Run with: node test/fix-glitch3-race-guard.test.js
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
  return source.slice(startIdx, i + 1);
}

// The orphanSaveBtn click handler isn't a named function -- extract by
// locating its addEventListener registration and brace-matching the
// arrow function body, same technique, different anchor.
function extractSaveHandler(source) {
  const anchor = `document.getElementById('orphanSaveBtn').addEventListener('click', async () => {`;
  const startIdx = source.indexOf(anchor);
  assert.ok(startIdx >= 0, 'could not find orphanSaveBtn click handler in index.html');
  const braceStart = source.indexOf('{', startIdx + anchor.length - 1);
  let depth = 0, i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  assert.ok(depth === 0, 'brace matching failed for orphanSaveBtn handler');
  // Return as a standalone async function so the sandbox can call it directly.
  const body = source.slice(braceStart, i + 1);
  return `async function __orphanSaveHandler() ${body}`;
}

const recordDuplicateDiscardedSrc = extractFunction(fullScript, 'recordDuplicateDiscarded');
const saveHandlerSrc = extractSaveHandler(fullScript);

// Confirm the real source actually implements the fix -- not hand-verified.
assert.ok(saveHandlerSrc.includes('state.sessionLogId'), 'save handler does not reference state.sessionLogId -- submit-time guard not wired in as expected');
assert.ok(saveHandlerSrc.includes('currentDoc.inProgress === false'), 'save handler does not check currentDoc.inProgress === false -- submit-time guard not wired in as expected');
assert.ok(saveHandlerSrc.includes('recordDuplicateDiscarded'), 'save handler does not call recordDuplicateDiscarded -- telemetry not wired in as expected');
assert.ok(!saveHandlerSrc.includes('.get({') && !saveHandlerSrc.includes('.get()'), 'save handler appears to make a server read -- expected a local timeLogs array check, not a server round-trip');

console.log('--- confirmed: submit-time guard reads local timeLogs array (no server round-trip), checks inProgress === false strictly, calls recordDuplicateDiscarded telemetry ---');

function buildSandbox({ localTimeLogs, sessionLogId, omitSessionLogId = false, mins = { h: 9, m: 15 } }) {
  const pushedLogs = [];
  const removedKeys = [];
  const modalClosed = [];
  const alerts = [];
  const telemetryUpdates = []; // { id, data } for recordDuplicateDiscarded's own write
  let autoSaveCalled = false;

  const state = {
    startedAt: Date.now() - 15 * 60 * 60 * 1000, // ~15h ago, matching the real Taskiya timing
    linkedPlan: { project: 'Kredent office', projectId: 'p1', phase: 'Schematic Design', typology: 'Final Design' },
    ...(omitSessionLogId ? {} : { sessionLogId }),
  };

  // timeLogs is a genuine array with .push/.find, exactly as in index.html --
  // mutated in place by the "Bug B" simulation between open and submit.
  const timeLogs = [...localTimeLogs];

  const sandbox = {
    console,
    timeLogs,
    genId: () => 'new-doc-id',
    currentUser: { id: 'mr21gc49q81zlv' },
    fmt: (d) => d.toISOString().slice(0, 10),
    minsToHM: (m) => `${Math.floor(m / 60)}h ${m % 60}m`,
    orphanTimerState: state,
    orphanSnoozeTimeout: null,
    orphanSnoozeCount: 2,
    localStorage: {
      removeItem: (k) => removedKeys.push(k),
    },
    closeModal: (id) => modalClosed.push(id),
    alert: (msg) => alerts.push(msg),
    document: {
      getElementById: (id) => {
        if (id === 'orphanHours') return { value: String(mins.h) };
        if (id === 'orphanMins') return { value: String(mins.m) };
        return { value: '0' };
      },
    },
    db: {
      collection: () => ({
        doc: (id) => ({
          update: async (data) => { telemetryUpdates.push({ id, data }); },
        }),
      }),
    },
    autoSave: async () => { autoSaveCalled = true; },
    renderTimeLog: () => {},
    renderProjectsBudget: () => {},
    renderDashboard: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(recordDuplicateDiscardedSrc, sandbox);
  vm.runInContext(saveHandlerSrc, sandbox);

  return {
    sandbox, timeLogs, removedKeys, modalClosed, alerts, telemetryUpdates,
    getPushedCount: () => timeLogs.length - localTimeLogs.length,
    getLastPushed: () => timeLogs[timeLogs.length - 1],
    getAutoSaveCalled: () => autoSaveCalled,
  };
}

let passCount = 0, failCount = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); passCount++; }
  else { console.log(`  FAIL: ${label}`); failCount++; }
}

async function run() {
  // ═══════════════════════════════════════════════════════════════════
  // *** THE CRITICAL FIXTURE ***: models the actual race. At modal-OPEN
  // time the local array has this doc as inProgress:true (matching what
  // restoreTimerState()'s own guard saw). Bug B then mutates the SAME
  // array entry to inProgress:false BEFORE the user clicks Save --
  // exactly the 29-second gap from the real incident. The submit-time
  // guard must read that post-mutation state, not a stale snapshot.
  // ═══════════════════════════════════════════════════════════════════
  console.log('=== CRITICAL: race fixture -- Bug B closes the doc between modal-open and modal-submit ===');
  {
    const { sandbox, timeLogs, removedKeys, modalClosed, alerts, telemetryUpdates, getPushedCount, getAutoSaveCalled } = buildSandbox({
      localTimeLogs: [{ id: 'mt7ccb47bmjujh', userId: 'mr21gc49q81zlv', inProgress: true, durationMins: 1 }],
      sessionLogId: 'mt7ccb47bmjujh',
    });

    // Modal is now open, showing this doc as inProgress:true (matches
    // reality). Simulate Bug B's own synchronous local-array mutation --
    // its exact code shape: `timeLogs[idx] = { ...timeLogs[idx], ...updates }`.
    const idx = timeLogs.findIndex((l) => l.id === 'mt7ccb47bmjujh');
    timeLogs[idx] = { ...timeLogs[idx], inProgress: false, recovered: true, endTime: '20:08' };

    // NOW the user clicks Save (29 "seconds" later, in the real incident).
    await vm.runInContext('__orphanSaveHandler', sandbox)();

    check('NO duplicate written to timeLogs', getPushedCount() === 0);
    check('localStorage.timerState was cleared', removedKeys.includes('timerState'));
    check('modal was closed', modalClosed.includes('orphanTimerModal'));
    check('user was informed, not left wondering', alerts.some(a => /already closed automatically/.test(a)));
    check('telemetry recorded exactly once, on the resolved doc', telemetryUpdates.length === 1 && telemetryUpdates[0].id === 'mt7ccb47bmjujh');
    check('telemetry marks orphanDuplicateDiscarded:true with a timestamp', telemetryUpdates[0].data.orphanDuplicateDiscarded === true && typeof telemetryUpdates[0].data.orphanDuplicateDiscardedAt === 'string');
    check('autoSave() was NOT called (nothing new to save)', !getAutoSaveCalled());
  }

  // ═══════════════════════════════════════════════════════════════════
  // CASE: doc is LEGITIMATELY still open at submit time (Bug B never
  // touched it -- a real, still-unresolved miss-punch). The self-report
  // IS real and must write normally, completely unaffected by the new guard.
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== CASE: still genuinely open at submit -- writes normally, unaffected ===');
  {
    const { timeLogs, sandbox, removedKeys, modalClosed, alerts, telemetryUpdates, getPushedCount, getLastPushed, getAutoSaveCalled } = buildSandbox({
      localTimeLogs: [{ id: 'still-open-doc', userId: 'mr21gc49q81zlv', inProgress: true, durationMins: 1 }],
      sessionLogId: 'still-open-doc',
      mins: { h: 2, m: 30 },
    });
    // No mutation here -- Bug B never touched it, still inProgress:true.
    await vm.runInContext('__orphanSaveHandler', sandbox)();

    check('exactly one duplicate-free self-report written', getPushedCount() === 1);
    check('written entry has the correct self-reported duration (150 min)', getLastPushed().durationMins === 150);
    check('written entry has the expected self-report desc', /Self-reported \(timer left running/.test(getLastPushed().desc));
    check('localStorage.timerState was cleared (normal completion)', removedKeys.includes('timerState'));
    check('user got the normal thank-you alert, not the discard alert', alerts.some(a => /Thank you for self-reporting/.test(a)) && !alerts.some(a => /already closed automatically/.test(a)));
    // V16.19 (self-report supersede fix, separate from this file's own
    // race guard): this genuinely-open happy path now ALSO writes to the
    // original doc -- closing it as superseded by the self-report just
    // written, so it's never left orphaned. That write lands in this same
    // mock's telemetryUpdates array (same db.doc().update() shape as
    // recordDuplicateDiscarded's own write) -- distinguish by content, not
    // by absence: no DISCARD-shaped write (this wasn't a duplicate), but
    // exactly one SUPERSEDE-shaped write. See
    // test/fix-selfreport-supersede-original.test.js for that fix's own
    // full coverage; this assertion just confirms the two fixes don't
    // contradict each other on this shared code path.
    check('NO discard-telemetry write (this was a real report, not a duplicate)', !telemetryUpdates.some(u => u.data.orphanDuplicateDiscarded === true));
    check('exactly one supersede write, closing the original doc this self-report replaces', telemetryUpdates.filter(u => u.data.supersededBySelfReport === true).length === 1);
    check('autoSave() WAS called', getAutoSaveCalled());
  }

  // ═══════════════════════════════════════════════════════════════════
  // CASE: sessionLogId not found in the local timeLogs array at all (aged
  // out of the local cache, or never loaded) -- can't positively confirm
  // resolution, so fail-closed: writes normally, same as the original
  // guard's missing-doc case.
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== CASE: sessionLogId not found locally -- fail-closed, writes normally ===');
  {
    const { sandbox, getPushedCount, telemetryUpdates } = buildSandbox({
      localTimeLogs: [], // empty -- the doc simply isn't in the local array
      sessionLogId: 'not-in-local-array',
    });
    await vm.runInContext('__orphanSaveHandler', sandbox)();
    check('writes normally (cannot confirm resolution, so does not guess)', getPushedCount() === 1);
    // V16.19: the supersede write is attempted server-side regardless of
    // local-array presence (it's a targeted write by id, not dependent on
    // the doc being loaded locally) -- see fix-selfreport-supersede-
    // original.test.js's own "not in local array" case for full coverage.
    // What this fixture is actually proving is unchanged: no DISCARD write.
    check('no discard telemetry (nothing was discarded)', !telemetryUpdates.some(u => u.data.orphanDuplicateDiscarded === true));
  }

  // ═══════════════════════════════════════════════════════════════════
  // CASE: no sessionLogId on the local state at all (legacy localStorage
  // predating that field) -- falls through to write, no crash.
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== CASE: no sessionLogId at all (legacy state) -- falls through, no crash ===');
  {
    const { sandbox, getPushedCount } = buildSandbox({
      localTimeLogs: [{ id: 'irrelevant', inProgress: false }],
      omitSessionLogId: true,
    });
    let threw = false;
    try { await vm.runInContext('__orphanSaveHandler', sandbox)(); }
    catch (e) { threw = true; console.error('  unexpected throw:', e.message); }
    check('did NOT crash', !threw);
    check('falls through to writing (no id to check against)', getPushedCount() === 1);
  }

  // ═══════════════════════════════════════════════════════════════════
  // CASE: local doc found but inProgress is undefined (not strictly
  // false) -- same strict-equality discipline as the original
  // restoreTimerState() guard. Must NOT be treated as resolved.
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== CASE: local doc found but inProgress is undefined (not strictly false) -- writes normally ===');
  {
    const { sandbox, getPushedCount, telemetryUpdates } = buildSandbox({
      localTimeLogs: [{ id: 'undefined-inprogress-doc' }], // no inProgress field at all
      sessionLogId: 'undefined-inprogress-doc',
    });
    await vm.runInContext('__orphanSaveHandler', sandbox)();
    check('writes normally (inProgress undefined !== strictly false)', getPushedCount() === 1);
    // V16.19: same reasoning as the two cases above -- the supersede write
    // is expected here (state.sessionLogId is truthy), so absence-of-any-
    // write is no longer the right check; absence of a DISCARD write is.
    check('no discard telemetry', !telemetryUpdates.some(u => u.data.orphanDuplicateDiscarded === true));
  }

  // ═══════════════════════════════════════════════════════════════════
  // CASE: mins <= 0 still short-circuits before the new guard even runs --
  // confirms the new code was inserted after, not interfering with, the
  // pre-existing validation.
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== CASE: mins <= 0 -- pre-existing validation still fires first, unaffected by the new guard ===');
  {
    const { sandbox, getPushedCount, alerts } = buildSandbox({
      localTimeLogs: [{ id: 'doc-x', inProgress: true }],
      sessionLogId: 'doc-x',
      mins: { h: 0, m: 0 },
    });
    await vm.runInContext('__orphanSaveHandler', sandbox)();
    check('no write attempted', getPushedCount() === 0);
    check('the original validation alert fired', alerts.some(a => /enter how long you actually worked/.test(a)));
  }

  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
}

run();
