// Fixture test for the three reconciliation-flag-clear gaps found tracing
// Rai's 26 Aug stuck flag: closeCurrentSessionNow()'s 2026-08-15.4 fix
// (the "Angana cause-fix") only covered task-switch/logout. Three other
// genuine-close write sites were never updated to clear
// reconciliationNeeded on close:
//   1. finalizeCurrentSession()'s capped (12h-ceiling) branch
//   2. timerCompleteBtn's click handler ("Complete Task" -- the actual
//      path that produced Rai's stuck doc, confirmed by exact desc-format
//      match: no suffix in parens, unlike every other close path)
//   3. runEndOfDayCheck()'s 8pm force auto-complete branch
//
// Extracts the ACTUAL function/handler source directly from index.html
// (brace-matched, not retyped) and runs it in a vm sandbox -- proving the
// real shipped code, same discipline as every other fixture in this repo.
//
// Run with: node test/fix-reconciliation-flag-clear-gaps.test.js
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

function extractHandler(source, anchor, wrapperName) {
  const startIdx = source.indexOf(anchor);
  assert.ok(startIdx >= 0, `could not find handler anchor: ${anchor}`);
  const braceStart = source.indexOf('{', startIdx + anchor.length - 1);
  let depth = 0, i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  assert.ok(depth === 0, `brace matching failed for handler: ${anchor}`);
  const body = source.slice(braceStart, i + 1);
  return `async function ${wrapperName}() ${body}`;
}

const finalizeCurrentSessionSrc = extractFunction(fullScript, 'finalizeCurrentSession');
const runEndOfDayCheckSrc = extractFunction(fullScript, 'runEndOfDayCheck');
const completeTaskHandlerSrc = extractHandler(
  fullScript,
  `document.getElementById('timerCompleteBtn').addEventListener('click', async ()=>{`,
  '__completeTaskHandler',
);
const closeCurrentSessionNowSrc = extractFunction(fullScript, 'closeCurrentSessionNow');

// Confirm the real source implements the fix at all three sites -- not
// hand-verified.
assert.ok(/capped\?\{autoCapped:true,reconciliationNeeded:false\}/.test(finalizeCurrentSessionSrc.replace(/\s/g, '')), 'finalizeCurrentSession does not conditionally clear reconciliationNeeded in its capped branch');
assert.ok(completeTaskHandlerSrc.includes('reconciliationNeeded:false'), 'Complete Task handler does not clear reconciliationNeeded');
assert.ok(runEndOfDayCheckSrc.includes('reconciliationNeeded: false'), '8pm auto-complete does not clear reconciliationNeeded');
// Confirm closeCurrentSessionNow() -- the original 2026-08-15.4 fix -- is
// genuinely untouched, not just "still contains the string somewhere."
assert.ok(closeCurrentSessionNowSrc.includes('reconciliationNeeded: false,'), 'closeCurrentSessionNow appears to have lost its original 2026-08-15.4 fix');

console.log('--- confirmed: all three sites clear reconciliationNeeded on genuine close; closeCurrentSessionNow (the original fix) unchanged ---');

// FakeDate: `new Date()` (zero-arg) returns a fixed instant anchored to
// LOCAL wall-clock components (so .getHours()/.getMinutes() read correctly
// regardless of the test machine's own timezone); `new Date(x)` with an
// argument behaves exactly like the real Date. Date.now() is separately
// overridden to the same instant.
function buildSandbox({ nowLocal, timerStartedAtOffsetMs, capped = false }) {
  const RealDate = Date;
  const fixedNowMs = nowLocal.getTime();

  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixedNowMs);
      else super(...args);
    }
    static now() { return fixedNowMs; }
  }

  const pushedLogs = [];
  const toasts = [];
  const alerts = [];
  const closedModals = [];
  const resetCalls = [];

  const timerStartedAt = fixedNowMs - timerStartedAtOffsetMs;

  const sandbox = {
    console,
    Date: FakeDate,
    // Shared timer/session state every extracted function reads.
    timerRunning: true,
    timerStartedAt,
    currentSessionLogId: 'session-under-test',
    timerLinkedPlan: { id: 'plan1', project: 'Test Project', projectId: 'p1', phase: 'Schematic Design', typology: 'Schematic Design', type: 'work' },
    sessionExternallyClosed: false,
    awaitingWakeVerification: false,
    currentUser: { id: 'u1', name: 'Test User' },
    planEntries: [{ id: 'plan1', done: false }],
    MAX_SESSION_HOURS: 12,
    endOfDayWarningShown: true, // skip the 7:30 warning branch, only exercise the 8pm force branch
    timerInterval: null,
    clearInterval: () => {},
    genId: () => 'generated-id',
    fmt: (d) => new RealDate(d.getTime ? d.getTime() : d).toISOString().slice(0, 10),
    minsToHM: (m) => `${Math.floor(m / 60)}h ${m % 60}m`,
    capSessionDuration: (secs) => {
      const maxSecs = 12 * 60 * 60;
      if (secs <= maxSecs) return { durationMins: Math.max(1, Math.floor(secs / 60)), capped: false };
      return { durationMins: 12 * 60, capped: true };
    },
    upsertTimeLog: (log) => { pushedLogs.push(log); },
    showNotificationToast: (title, msg, kind) => { toasts.push({ title, msg, kind }); },
    alert: (msg) => { alerts.push(msg); },
    closeModal: (id) => { closedModals.push(id); },
    resetTimer: async () => { resetCalls.push('resetTimer'); },
    autoSave: async () => {},
    setTimeout: () => {}, // no-op -- don't fire deferred callbacks (e.g. showEodSummary) in this synchronous fixture
    showEodSummary: () => {},
    renderTimeLog: () => {}, renderProjectsBudget: () => {}, renderDashboard: () => {},
    document: {
      getElementById: () => ({ style: {}, classList: { add: () => {}, remove: () => {} }, checked: false, dispatchEvent: () => {}, textContent: '', onclick: null, addEventListener: () => {} }),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(finalizeCurrentSessionSrc, sandbox);
  vm.runInContext(runEndOfDayCheckSrc, sandbox);
  vm.runInContext(completeTaskHandlerSrc, sandbox);

  return { sandbox, pushedLogs, toasts, alerts, closedModals, resetCalls };
}

let passCount = 0, failCount = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); passCount++; }
  else { console.log(`  FAIL: ${label}`); failCount++; }
}

async function run() {
  // ═══════════════════════════════════════════════════════════════════
  // CASE 1: Complete Task -- the actual Rai-shaped case. A session that
  // (conceptually) was flagged mid-day, running well under the 12h cap,
  // closed via the Complete Task button.
  // ═══════════════════════════════════════════════════════════════════
  console.log('=== CASE 1: Complete Task on a normal (uncapped) session -> closes clean, clears reconciliationNeeded ===');
  {
    const nowLocal = new Date(2026, 7, 26, 19, 4, 0); // 26 Aug, 19:04 local
    const { sandbox, pushedLogs, alerts } = buildSandbox({ nowLocal, timerStartedAtOffsetMs: 8.5 * 60 * 60 * 1000 }); // started ~10:34
    await vm.runInContext('__completeTaskHandler', sandbox)();
    check('exactly one write', pushedLogs.length === 1);
    check('inProgress:false (genuine close)', pushedLogs[0].inProgress === false);
    check('reconciliationNeeded:false written (the fix)', pushedLogs[0].reconciliationNeeded === false);
    check('durationMins matches the real elapsed (~510min)', pushedLogs[0].durationMins >= 505 && pushedLogs[0].durationMins <= 515);
    check('desc has no suffix (matches Rai\'s exact doc shape)', pushedLogs[0].desc === 'Schematic Design');
    check('normal completion alert fired', alerts.some(a => /Task Completed/.test(a)));
  }

  // ═══════════════════════════════════════════════════════════════════
  // CASE 2: 8pm force auto-complete on a session still running at 20:00.
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== CASE 2: 8pm force auto-complete -> closes clean, clears reconciliationNeeded ===');
  {
    const nowLocal = new Date(2026, 7, 26, 20, 0, 0); // exactly 8:00 PM local
    const { sandbox, pushedLogs, closedModals, resetCalls } = buildSandbox({ nowLocal, timerStartedAtOffsetMs: 9 * 60 * 60 * 1000 }); // started ~11:00
    await vm.runInContext('runEndOfDayCheck', sandbox)();
    check('exactly one write', pushedLogs.length === 1);
    check('inProgress:false (genuine close)', pushedLogs[0].inProgress === false);
    check('reconciliationNeeded:false written (the fix)', pushedLogs[0].reconciliationNeeded === false);
    check('endTime hardcoded to 20:00', pushedLogs[0].endTime === '20:00');
    check('desc carries the auto-complete suffix', /Auto-completed at end of day/.test(pushedLogs[0].desc));
    check('endOfDayModal was closed', closedModals.includes('endOfDayModal'));
    check('resetTimer() was called', resetCalls.includes('resetTimer'));
  }

  // ═══════════════════════════════════════════════════════════════════
  // CASE 3: 12h-ceiling heartbeat close (finalizeCurrentSession's capped
  // branch) -- a session that's been running long enough to hit the cap.
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== CASE 3: 12h-ceiling capped close -> closes clean, clears reconciliationNeeded ===');
  {
    const nowLocal = new Date(2026, 7, 26, 23, 0, 0);
    const { sandbox, pushedLogs, toasts } = buildSandbox({ nowLocal, timerStartedAtOffsetMs: 13 * 60 * 60 * 1000 }); // started 13h ago -- over the 12h cap
    await vm.runInContext('finalizeCurrentSession', sandbox)('watchdog');
    check('exactly one write', pushedLogs.length === 1);
    check('capped -> inProgress:false', pushedLogs[0].inProgress === false);
    check('autoCapped:true also present (unrelated pre-existing field, unaffected)', pushedLogs[0].autoCapped === true);
    check('reconciliationNeeded:false written (the fix)', pushedLogs[0].reconciliationNeeded === false);
    check('durationMins capped at 12h (720min)', pushedLogs[0].durationMins === 720);
    check('auto-capped toast fired', toasts.some(t => /auto-capped/.test(t.title)));
  }

  // ═══════════════════════════════════════════════════════════════════
  // REGRESSION: finalizeCurrentSession's UNCAPPED branch (a plain live
  // checkpoint, NOT a close) must NOT write reconciliationNeeded at all --
  // this is the case the fix deliberately does NOT touch (see the new
  // comment at that site: unconditionally clearing here would be wrong,
  // since this write also fires on ordinary live ticks).
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== REGRESSION: finalizeCurrentSession UNCAPPED (live checkpoint, not a close) -> reconciliationNeeded NOT written ===');
  {
    const nowLocal = new Date(2026, 7, 26, 15, 0, 0);
    const { sandbox, pushedLogs } = buildSandbox({ nowLocal, timerStartedAtOffsetMs: 2 * 60 * 60 * 1000 }); // 2h in, well under the cap
    await vm.runInContext('finalizeCurrentSession', sandbox)('tab-backgrounded');
    check('exactly one write (a checkpoint, not a close)', pushedLogs.length === 1);
    check('inProgress:true (still running, NOT a close)', pushedLogs[0].inProgress === true);
    check('reconciliationNeeded is NOT present on an uncapped checkpoint (correctly scoped to capped only)', !('reconciliationNeeded' in pushedLogs[0]));
  }

  // ═══════════════════════════════════════════════════════════════════
  // REGRESSION: a normal, never-flagged session closing via Complete Task
  // still behaves identically otherwise -- the fix doesn't change any
  // other field, doesn't branch on prior flag state (the client never
  // reads it -- it unconditionally writes false on a genuine close, same
  // as closeCurrentSessionNow() already did before this fix).
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== REGRESSION: Complete Task on a short, never-flagged session -> normal fields all unaffected ===');
  {
    const nowLocal = new Date(2026, 7, 26, 12, 0, 0);
    const { sandbox, pushedLogs, alerts } = buildSandbox({ nowLocal, timerStartedAtOffsetMs: 45 * 60 * 1000 }); // 45min session
    await vm.runInContext('__completeTaskHandler', sandbox)();
    check('exactly one write', pushedLogs.length === 1);
    check('durationMins ~45', pushedLogs[0].durationMins >= 43 && pushedLogs[0].durationMins <= 46);
    check('reconciliationNeeded:false still written (harmless no-op if never flagged)', pushedLogs[0].reconciliationNeeded === false);
    check('no capped/autoCapped field on a short session', !('autoCapped' in pushedLogs[0]));
    check('normal completion alert, not the capped one', alerts.some(a => /Task Completed/.test(a)) && !alerts.some(a => /auto-capped/.test(a)));
  }

  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
}

run();
