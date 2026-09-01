// Fixture test for the self-report SUPERSEDE fix: the orphan-recovery
// modal's Save handler creates a new doc for the honest self-reported
// total, but its happy-path branch never closed the ORIGINAL session doc
// it was replacing -- leaving it inProgress:true (and reconciliationNeeded:
// true, if it had ever been flagged) forever. Real production case: Souvik's
// 28 Aug stub (mtcqxj56j5t0xh) sat open for 3 days; only the ALREADY-
// resolved-by-something-else branch (the Glitch 3 race guard, its own
// fixture in fix-glitch3-race-guard.test.js) ever touched the original doc.
//
// This fix adds a targeted supersede-write to the happy path: when the
// self-report genuinely IS the resolution (not a discard), the original
// doc gets closed too -- inProgress:false, reconciliationNeeded:false,
// durationMins:0 (deliberately zeroed, not carried forward, so it can never
// double-count against the honest total the user just entered), desc
// noting it was superseded.
//
// Extracts the ACTUAL handler source directly from index.html (brace-
// matched, not retyped) and runs it in a vm sandbox -- same discipline as
// every other fixture in this repo, same extraction technique as
// fix-glitch3-race-guard.test.js (which covers the OTHER branch of this
// same handler and is left untouched by this fix).
//
// Run with: node test/fix-selfreport-supersede-original.test.js
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
  const body = source.slice(braceStart, i + 1);
  return `async function __orphanSaveHandler() ${body}`;
}

const saveHandlerSrc = extractSaveHandler(fullScript);

// Confirm the real source actually implements the fix -- not hand-verified.
assert.ok(saveHandlerSrc.includes('supersededBySelfReport'), 'save handler does not write supersededBySelfReport -- fix not wired in as expected');
assert.ok(saveHandlerSrc.includes('durationMins: 0'), 'save handler does not zero durationMins on the superseded doc -- double-count guard not wired in as expected');
assert.ok(/timeLogs\.push\(/.test(saveHandlerSrc), 'save handler no longer pushes the self-report doc -- unrelated behavior changed unexpectedly');

let passCount = 0, failCount = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); passCount++; }
  else { console.log(`  FAIL: ${label}`); failCount++; }
}

function buildSandbox({ localTimeLogs, sessionLogId, omitSessionLogId = false, mins = { h: 5, m: 30 }, supersedeWriteShouldThrow = false }) {
  const pushedLogs = [];
  const removedKeys = [];
  const modalClosed = [];
  const alerts = [];
  const docUpdates = []; // every db.collection('timeLogs').doc(id).update(data) call, whichever source
  const discardTelemetryCalls = []; // recordDuplicateDiscarded() calls -- the OTHER branch's own telemetry, not this fix's concern, tracked separately so it's never confused with a supersede write
  let autoSaveCalled = false;

  const state = {
    startedAt: Date.now() - 15 * 60 * 60 * 1000,
    linkedPlan: { project: 'SALT LAKE RESIDENCE', projectId: 'p1', phase: 'Project Management', typology: 'Project Management – Coordination' },
    ...(omitSessionLogId ? {} : { sessionLogId }),
  };

  const timeLogs = [...localTimeLogs];

  const sandbox = {
    console, Date,
    timeLogs,
    genId: () => 'new-self-report-doc-id',
    currentUser: { id: 'mmllimboc39' },
    fmt: (d) => d.toISOString().slice(0, 10),
    minsToHM: (m) => `${Math.floor(m / 60)}h ${m % 60}m`,
    orphanTimerState: state,
    orphanSnoozeTimeout: null,
    orphanSnoozeCount: 1,
    localStorage: { removeItem: (k) => removedKeys.push(k) },
    closeModal: (id) => modalClosed.push(id),
    alert: (msg) => alerts.push(msg),
    // The OTHER branch's own telemetry (fix-glitch3-race-guard.test.js
    // covers it in full) -- stubbed here only so this handler doesn't throw
    // when that early-return branch fires in the "already resolved" case
    // below; not this fix's concern.
    recordDuplicateDiscarded: (id) => discardTelemetryCalls.push(id),
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
          update: (data) => {
            docUpdates.push({ id, data });
            if (supersedeWriteShouldThrow) return Promise.reject(new Error('simulated network failure'));
            return Promise.resolve();
          },
        }),
      }),
    },
    autoSave: async () => { autoSaveCalled = true; },
    renderTimeLog: () => {},
    renderProjectsBudget: () => {},
    renderDashboard: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(saveHandlerSrc, sandbox);

  return {
    sandbox, timeLogs, removedKeys, modalClosed, alerts, docUpdates, discardTelemetryCalls,
    getPushedCount: () => timeLogs.length - localTimeLogs.length,
    getLastPushed: () => timeLogs[timeLogs.length - 1],
    getAutoSaveCalled: () => autoSaveCalled,
    getLocalOriginal: () => timeLogs.find((l) => l.id === sessionLogId),
  };
}

async function run() {
  // ═══════════════════════════════════════════════════════════════════
  // *** THE CENTRAL FIXTURE ***: the real Souvik shape -- original doc
  // still genuinely open (inProgress:true, reconciliationNeeded:true) at
  // submit time, self-report saved normally. Original must now ALSO close.
  // ═══════════════════════════════════════════════════════════════════
  console.log('=== CENTRAL: self-report fires -> new doc created AND original doc closed/superseded ===');
  {
    const { timeLogs, sandbox, docUpdates, getPushedCount, getLastPushed, getAutoSaveCalled, getLocalOriginal } = buildSandbox({
      localTimeLogs: [{ id: 'mtcqxj56j5t0xh', userId: 'mmllimboc39', inProgress: true, reconciliationNeeded: true, durationMins: 63, desc: 'Project Management – Coordination (in progress)' }],
      sessionLogId: 'mtcqxj56j5t0xh',
      mins: { h: 5, m: 30 },
    });
    await vm.runInContext('__orphanSaveHandler', sandbox)();

    check('exactly one new self-report doc pushed', getPushedCount() === 1);
    check('self-report has the correct duration (330 min)', getLastPushed().durationMins === 330);
    check('self-report desc unchanged from before this fix', /Self-reported \(timer left running/.test(getLastPushed().desc));

    const supersedeUpdate = docUpdates.find((u) => u.id === 'mtcqxj56j5t0xh');
    check('exactly one server write targets the ORIGINAL doc id', docUpdates.filter((u) => u.id === 'mtcqxj56j5t0xh').length === 1);
    check('original doc write sets inProgress:false', supersedeUpdate.data.inProgress === false);
    check('original doc write sets reconciliationNeeded:false', supersedeUpdate.data.reconciliationNeeded === false);
    check('original doc write ZEROES durationMins (no double-count against the self-report total)', supersedeUpdate.data.durationMins === 0);
    check('original doc write notes it was superseded', /[Ss]uperseded/.test(supersedeUpdate.data.desc));
    check('original doc write tags supersededBySelfReport:true', supersedeUpdate.data.supersededBySelfReport === true);
    check('original doc write includes a recoveredAt timestamp', typeof supersedeUpdate.data.recoveredAt === 'string');

    const localOriginal = getLocalOriginal();
    check('LOCAL timeLogs array mirror also shows the original doc closed', localOriginal.inProgress === false && localOriginal.reconciliationNeeded === false && localOriginal.durationMins === 0);
    check('autoSave() was called (self-report path unaffected)', getAutoSaveCalled());
  }

  // ═══════════════════════════════════════════════════════════════════
  // CASE: original doc was NEVER flagged (reconciliationNeeded was never
  // true) -- the supersede write must still fire; a doc doesn't need to
  // have been flagged to need closing.
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== CASE: original doc never flagged -- still gets superseded/closed ===');
  {
    const { docUpdates, sandbox } = buildSandbox({
      localTimeLogs: [{ id: 'never-flagged-doc', userId: 'mmllimboc39', inProgress: true, durationMins: 12 }],
      sessionLogId: 'never-flagged-doc',
    });
    await vm.runInContext('__orphanSaveHandler', sandbox)();
    const update = docUpdates.find((u) => u.id === 'never-flagged-doc');
    check('superseded even though it was never flagged', !!update && update.data.inProgress === false);
  }

  // ═══════════════════════════════════════════════════════════════════
  // CASE: the Glitch 3 duplicate-discard branch fires instead (original
  // already resolved by something else) -- the NEW supersede write must
  // NOT also fire; that branch returns early, before the new code.
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== CASE: duplicate-discard branch (already resolved elsewhere) -- supersede write does NOT double-fire ===');
  {
    const { timeLogs, sandbox, docUpdates, discardTelemetryCalls, getPushedCount } = buildSandbox({
      localTimeLogs: [{ id: 'already-closed-doc', userId: 'mmllimboc39', inProgress: false, durationMins: 400 }],
      sessionLogId: 'already-closed-doc',
    });
    await vm.runInContext('__orphanSaveHandler', sandbox)();
    check('no new self-report doc pushed (discarded as a duplicate)', getPushedCount() === 0);
    check('the OTHER branch\'s own discard telemetry fired once (unrelated to this fix)', discardTelemetryCalls.length === 1 && discardTelemetryCalls[0] === 'already-closed-doc');
    // docUpdates only ever receives writes from THIS fix's new supersede
    // code (recordDuplicateDiscarded is stubbed separately above, not
    // routed through db.collection().doc().update() in this sandbox) --
    // so zero entries here proves the early return genuinely skips it.
    check('no server write at all from the new supersede code (early return before it)', docUpdates.length === 0);
  }

  // ═══════════════════════════════════════════════════════════════════
  // CASE: original doc write fails (network error) -- must not crash or
  // block the self-report write, which already succeeded by that point.
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== CASE: supersede write fails -- self-report itself still saved, no crash ===');
  {
    const { sandbox, getPushedCount, getAutoSaveCalled } = buildSandbox({
      localTimeLogs: [{ id: 'flaky-doc', userId: 'mmllimboc39', inProgress: true, durationMins: 5 }],
      sessionLogId: 'flaky-doc',
      supersedeWriteShouldThrow: true,
    });
    let threw = false;
    try { await vm.runInContext('__orphanSaveHandler', sandbox)(); }
    catch (e) { threw = true; console.error('  unexpected throw:', e.message); }
    check('did NOT crash even though the supersede write rejected', !threw);
    check('self-report doc was still pushed', getPushedCount() === 1);
    check('autoSave() still ran normally', getAutoSaveCalled());
  }

  // ═══════════════════════════════════════════════════════════════════
  // CASE: no sessionLogId at all (legacy localStorage) -- no supersede
  // write attempted (nothing to supersede), self-report still writes.
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== CASE: no sessionLogId at all -- no supersede write attempted, self-report unaffected ===');
  {
    const { sandbox, docUpdates, getPushedCount } = buildSandbox({
      localTimeLogs: [{ id: 'irrelevant', inProgress: true }],
      omitSessionLogId: true,
    });
    let threw = false;
    try { await vm.runInContext('__orphanSaveHandler', sandbox)(); }
    catch (e) { threw = true; console.error('  unexpected throw:', e.message); }
    check('did NOT crash', !threw);
    check('no server write attempted (no id to supersede)', docUpdates.length === 0);
    check('self-report still written normally', getPushedCount() === 1);
  }

  // ═══════════════════════════════════════════════════════════════════
  // CASE: sessionLogId not found in the local timeLogs array -- server
  // write still attempted (it's a targeted write by id, not dependent on
  // local presence), but the local-mirror step is skipped without crashing.
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== CASE: original doc not in local array -- server write still fires, no crash on local mirror ===');
  {
    const { sandbox, docUpdates, getPushedCount } = buildSandbox({
      localTimeLogs: [], // sessionLogId not present locally at all
      sessionLogId: 'not-loaded-locally',
    });
    let threw = false;
    try { await vm.runInContext('__orphanSaveHandler', sandbox)(); }
    catch (e) { threw = true; console.error('  unexpected throw:', e.message); }
    check('did NOT crash', !threw);
    check('server write still targets the original doc id', docUpdates.some((u) => u.id === 'not-loaded-locally'));
    check('self-report still written normally', getPushedCount() === 1);
  }

  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
}

run();
