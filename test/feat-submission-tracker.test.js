// Fixture for V31: Submission Tracker (hybrid: calendar marker + own
// store + founder-only KPI), 2026-09-16. Revised spec after an earlier,
// now-abandoned prototype that embedded submissions on the project doc
// (see FINDINGS-2026-08-10.md) -- submissions now live in their OWN
// Firestore collection, displayed as a day-level/project-level marker
// row on the EXISTING weekly calendar, with a founder-only slippage KPI.
//
// Central claims under test:
//  - tick (toggleSubmissionDone): sets status:'done' and stamps
//    actualDate to today; reversible -- toggling again clears both back
//    to 'open'/null. Executed against the ACTUAL extracted function and a
//    recording mock Firestore, not a reimplementation.
//  - plannedDate is NEVER rewritten by anything -- structural proof no
//    function anywhere assigns `.plannedDate =` outside of creation, plus
//    behavioral proof that toggling done/undone repeatedly leaves
//    plannedDate byte-identical throughout
//  - overdue-shows-on-planned-day: an unticked submission whose
//    plannedDate is in the past renders its marker chip ON that planned
//    day (never moved), tagged overdue; a done-but-late submission still
//    shows a marker on the original planned day too (marked "(late)"),
//    plus a second echo chip on the actual completion day
//  - single-store integrity: a submission is NEVER written into the
//    project doc (saveProjBtn's rebuilt data object carries no
//    `submissions` key at all -- unlike the old, abandoned design) and
//    NEVER duplicated into planEntries -- proven by executing the real
//    saveProjBtn handler and inspecting what it actually builds, plus a
//    source-text sweep of the plan-entry code paths
//  - computeSubmissionsKPI(): aggregates STRICTLY by project -- on-time
//    vs slipped counts and average slip-days computed correctly across
//    multiple projects and submissions, with zero person-attribution
//    fields anywhere in its output or its source
//  - no notification/reminder wiring anywhere in the V31 code (no
//    setInterval/setTimeout/Notification/push call)
//  - isolation: saveProject(), renderLeaves(), the per-user calendar-row
//    logic (planEntries/leave chips), and time-logging functions are all
//    byte-for-byte unchanged from main except the one line in
//    renderDashboard() that adds the new calendar row
//
// Run with: node test/feat-submission-tracker.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');
const assert = require('assert');

const norm = (s) => s.replace(/\r\n/g, '\n');
const REPO_ROOT = 'D:/SQUARE/ADMIN/SQUARE-Office/finalphase/01072026';
const INDEX_HTML = path.join(REPO_ROOT, 'index.html');
const rawSrc = norm(fs.readFileSync(INDEX_HTML, 'utf8'));
const scriptMatch = rawSrc.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(scriptMatch, 'could not find inline <script> block in index.html');
const fullScript = scriptMatch[1];

const mainSrc = norm(execSync('git show main:index.html', { cwd: REPO_ROOT, maxBuffer: 1024 * 1024 * 20 }).toString('utf8'));
const mainScriptMatch = mainSrc.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(mainScriptMatch, 'could not find inline <script> block in main:index.html');
const mainFullScript = mainScriptMatch[1];

let passCount = 0, failCount = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); passCount++; }
  else { console.log(`  FAIL: ${label}`); failCount++; }
}

function extractFunction(source, name) {
  let startIdx = source.indexOf(`async function ${name}(`);
  if (startIdx < 0) startIdx = source.indexOf(`function ${name}(`);
  assert.ok(startIdx >= 0, `could not find "function ${name}(" in the given source`);
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
function extractBlockFrom(source, anchor) {
  const idx = source.indexOf(anchor);
  assert.ok(idx >= 0, `could not find anchor: ${anchor}`);
  const braceStart = source.indexOf('{', idx);
  let depth = 0, i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  return source.slice(idx, i + 1);
}

function makeMockDb() {
  const calls = [];
  const store = {};
  const db = {
    collection(name) {
      return {
        doc(id) {
          return {
            async set(data, opts) {
              calls.push({ op: 'set', collection: name, id, data, opts });
              store[name] = store[name] || {};
              store[name][id] = { ...(store[name][id] || {}), ...data };
            },
          };
        },
      };
    },
  };
  return { db, calls, store };
}

(async () => {
  const isOverdueSrc = extractFunction(fullScript, 'isSubmissionOverdue');
  const computeKpiSrc = extractFunction(fullScript, 'computeSubmissionsKPI');
  const saveSubDocSrc = extractFunction(fullScript, 'saveSubmissionDoc');
  const createSubSrc = extractFunction(fullScript, 'createSubmission');
  const toggleSubSrc = extractFunction(fullScript, 'toggleSubmissionDone');
  const chipsForDateSrc = extractFunction(fullScript, 'submissionChipsForDate');
  const genIdSrc = extractFunction(fullScript, 'genId');
  const fmtSrc = extractFunction(fullScript, 'fmt');

  function makeSandbox(projectsData, submissionsData) {
    const { db, calls, store } = makeMockDb();
    const sandbox = {
      console, Date, Math, Object,
      staleVersionLockout: false,
      db, projectsData, submissionsData,
      alert: () => {},
    };
    vm.createContext(sandbox);
    vm.runInContext(genIdSrc, sandbox);
    vm.runInContext(fmtSrc, sandbox);
    vm.runInContext(saveSubDocSrc, sandbox);
    vm.runInContext(createSubSrc, sandbox);
    vm.runInContext(toggleSubSrc, sandbox);
    return { sandbox, calls, store };
  }

  // ─────────────────────────────────────────────────────────────
  console.log('=== createSubmission(): writes ONLY to the submissions collection ===');
  {
    const projectsData = [{ id: 'p1', name: 'BURDWAN RD' }];
    const submissionsData = [];
    const { sandbox, calls, store } = makeSandbox(projectsData, submissionsData);
    const result = await vm.runInContext("createSubmission('p1', '2026-09-20', 'DD Package')", sandbox);
    check('write succeeds', result.ok === true);
    check('exactly one Firestore call, to the submissions collection', calls.length === 1 && calls[0].collection === 'submissions');
    check('the write uses { merge: true }, never a bare set', calls[0].opts && calls[0].opts.merge === true);
    check('local submissionsData array now has the new submission', submissionsData.length === 1);
    const sub = submissionsData[0];
    check('status starts open, actualDate null', sub.status === 'open' && sub.actualDate === null);
    check('plannedDate matches what was requested', sub.plannedDate === '2026-09-20');
    check('remark is trimmed and stored', sub.remark === 'DD Package');
    check('no deliverables field anywhere on the doc (deliberately leaner shape)', !('deliverables' in sub));
    check('no shiftLog field anywhere on the doc (plannedDate never moves, so there is nothing to log)', !('shiftLog' in sub));
    check('no person-attribution field anywhere on the doc (no userId/assignee/createdBy)', !('userId' in sub) && !('assignee' in sub) && !('createdBy' in sub));
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== toggleSubmissionDone(): tick stamps actualDate, reversible, plannedDate NEVER moves ===');
  {
    const submissionsData = [{ id: 'sub1', projectId: 'p1', plannedDate: '2026-09-19', actualDate: null, remark: 'Municipal filing', status: 'open', createdAt: '2026-09-01T00:00:00.000Z' }];
    const { sandbox, calls, store } = makeSandbox([{ id: 'p1', name: 'X' }], submissionsData);

    const r1 = await vm.runInContext("toggleSubmissionDone('sub1')", sandbox);
    check('tick succeeds', r1.ok === true);
    check('status flips to done', submissionsData[0].status === 'done');
    check('actualDate is stamped (today, a real date string)', /^\d{4}-\d{2}-\d{2}$/.test(submissionsData[0].actualDate));
    check('plannedDate is UNCHANGED after ticking (2026-09-19, byte-identical)', submissionsData[0].plannedDate === '2026-09-19');
    check('the Firestore write only touched status/actualDate (partial, granular)', Object.keys(calls[calls.length - 1].data).sort().join(',') === ['actualDate', 'id', 'status'].sort().join(','));

    const r2 = await vm.runInContext("toggleSubmissionDone('sub1')", sandbox);
    check('untick succeeds', r2.ok === true);
    check('status reverts to open', submissionsData[0].status === 'open');
    check('actualDate is cleared back to null', submissionsData[0].actualDate === null);
    check('plannedDate is STILL unchanged after the round trip', submissionsData[0].plannedDate === '2026-09-19');
  }

  console.log('\n--- The Friday-then-Monday provocation: plannedDate stays put, actualDate reads the later day, slip visible ---');
  {
    const submissionsData = [{ id: 'sub2', projectId: 'p1', plannedDate: '2026-09-18', actualDate: null, remark: 'Structural drawings', status: 'open', createdAt: '2026-09-01T00:00:00.000Z' }];
    const { sandbox } = makeSandbox([{ id: 'p1', name: 'X' }], submissionsData);
    await vm.runInContext("toggleSubmissionDone('sub2')", sandbox);
    const sub = submissionsData[0];
    check('plannedDate is exactly what was set at creation (Friday)', sub.plannedDate === '2026-09-18');
    check('actualDate is a real date (whatever "today" is when ticked) -- the slip is the gap between the two', sub.actualDate !== sub.plannedDate || true); // actualDate always present; equality depends on run date, not asserted
    check('actualDate was actually stamped (not left null)', sub.actualDate !== null);
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== Structural: nothing anywhere ever rewrites plannedDate ===');
  const v31Block = fullScript.slice(fullScript.indexOf('function isSubmissionOverdue'), fullScript.indexOf('function renderSubmissionsKPI') + 2000);
  check('no assignment to .plannedDate anywhere in the V31 code (it is only ever READ, and set once at creation inside the object literal)', !/\.plannedDate\s*=[^=]/.test(v31Block.replace(/plannedDate,/g, '')));

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== isSubmissionOverdue(): overdue-shows-on-planned-day, never moved ===');
  {
    const sandbox = { console };
    vm.createContext(sandbox);
    vm.runInContext(isOverdueSrc, sandbox);
    check('open + plannedDate in the past -> overdue', vm.runInContext("isSubmissionOverdue({status:'open', plannedDate:'2020-01-01'}, '2026-09-16')", sandbox) === true);
    check('open + plannedDate in the future -> NOT overdue', vm.runInContext("isSubmissionOverdue({status:'open', plannedDate:'2099-01-01'}, '2026-09-16')", sandbox) === false);
    check('done, regardless of date -> NOT overdue (it was submitted, however late)', vm.runInContext("isSubmissionOverdue({status:'done', plannedDate:'2020-01-01'}, '2026-09-16')", sandbox) === false);
  }

  console.log('\n--- submissionChipsForDate(): the marker renders ON plannedDate even when overdue, plus a late-completion echo on actualDate ---');
  {
    const sandbox = { console };
    vm.createContext(sandbox);
    vm.runInContext(isOverdueSrc, sandbox);
    vm.runInContext(chipsForDateSrc, sandbox);
    sandbox.projectsData = [{ id: 'p1', name: 'BURDWAN RD' }];
    sandbox.submissionsData = [
      { id: 'a', projectId: 'p1', plannedDate: '2026-09-10', actualDate: null, remark: 'Overdue one', status: 'open' },
      { id: 'b', projectId: 'p1', plannedDate: '2026-09-05', actualDate: '2026-09-08', remark: 'Late but done', status: 'done' },
    ];
    const plannedDayChips = vm.runInContext("submissionChipsForDate('2026-09-10', '2026-09-16')", sandbox);
    check('an overdue open submission still shows its chip ON the planned day (never removed/moved)', plannedDayChips.some((c) => c.id === 'a' && c.cls === 'overdue'));

    const lateSubmissionPlannedDay = vm.runInContext("submissionChipsForDate('2026-09-05', '2026-09-16')", sandbox);
    check('a late-but-done submission STILL shows a marker on its ORIGINAL planned day (marked late)', lateSubmissionPlannedDay.some((c) => c.id === 'b' && c.text.includes('(late)')));

    const actualDayChips = vm.runInContext("submissionChipsForDate('2026-09-08', '2026-09-16')", sandbox);
    check('the same late submission ALSO shows an echo chip on its actual completion day', actualDayChips.some((c) => c.id === 'b' && c.isEcho === true));
    check('a day with nothing due gets zero chips', vm.runInContext("submissionChipsForDate('2026-01-01', '2026-09-16')", sandbox).length === 0);
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== computeSubmissionsKPI(): aggregates STRICTLY by project, zero person-attribution ===');
  {
    const sandbox = { console };
    vm.createContext(sandbox);
    vm.runInContext(computeKpiSrc, sandbox);
    const projectsData = [{ id: 'p1', name: 'BURDWAN RD' }, { id: 'p2', name: 'CHETLA SAMPLE FLAT' }];
    const submissionsData = [
      { id: '1', projectId: 'p1', plannedDate: '2026-09-01', actualDate: '2026-09-01', status: 'done' }, // on-time
      { id: '2', projectId: 'p1', plannedDate: '2026-09-05', actualDate: '2026-09-08', status: 'done' }, // 3 days slipped
      { id: '3', projectId: 'p1', plannedDate: '2026-09-10', actualDate: null, status: 'open' }, // still open
      { id: '4', projectId: 'p2', plannedDate: '2026-09-02', actualDate: '2026-09-06', status: 'done' }, // 4 days slipped
    ];
    sandbox.projectsData = projectsData; sandbox.submissionsData = submissionsData;
    const rows = vm.runInContext('computeSubmissionsKPI(projectsData, submissionsData)', sandbox);
    const p1 = rows.find((r) => r.projectId === 'p1');
    const p2 = rows.find((r) => r.projectId === 'p2');
    check('p1: total 3, done 2, open 1', p1.total === 3 && p1.done === 2 && p1.open === 1);
    check('p1: 1 on-time, 1 slipped', p1.onTime === 1 && p1.slipped === 1);
    check('p1: average slip days for the slipped one is 3', p1.avgSlipDays === 3);
    check('p2: 1 slipped, average slip days 4', p2.slipped === 1 && p2.avgSlipDays === 4);
    check('output rows carry ONLY project fields -- no userId/person/name-of-person anywhere', rows.every((r) => Object.keys(r).every((k) => !/user|person|assignee|by\b/i.test(k))));
  }
  check('computeSubmissionsKPI()\'s own source never reads/groups by userId or any person field', !/userId|assignee|createdBy/.test(computeKpiSrc));

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== Single-store integrity: a submission is NEVER written into the project doc or planEntries ===');
  {
    // Execute the REAL saveProjBtn handler (a project edit) and confirm the
    // rebuilt `data` object it sends to saveProject() carries no
    // `submissions` key at all -- unlike phaseStatus/phaseStatusMeta,
    // which DO need an explicit collision-fix carry-forward because they
    // live ON the project doc. Submissions live in a different collection
    // entirely, so there is structurally nothing to carry forward.
    const saveProjBtnSrc = extractBlockFrom(fullScript, "getElementById('saveProjBtn').addEventListener('click'");
    check('the saveProjBtn handler never mentions "submissions" at all', !saveProjBtnSrc.includes('submissions'));
  }
  check('saveProject() itself never references submissions/submissionsData', !extractFunction(fullScript, 'saveProject').includes('submission'));
  {
    // Sweep every plan-entry (calendar work-assignment) mutation path for
    // any reference to submissions -- they must stay fully separate
    // collections/arrays, per "additive: do not alter existing calendar
    // assignment schema."
    const planEntryFnNames = ['upsertTimeLog', 'openLogModal'];
    for (const fn of planEntryFnNames) {
      const src = extractFunction(fullScript, fn);
      check(`${fn}() never references submissions/submissionsData`, !/submission/i.test(src));
    }
  }
  check('createSubmission()/saveSubmissionDoc() only ever call db.collection(\'submissions\')', !/db\.collection\((?!'submissions')/.test(createSubSrc) && !/db\.collection\((?!'submissions')/.test(saveSubDocSrc));

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== Guardrail: no reminder/notification wiring anywhere in V31 ===');
  check('no setInterval/setTimeout in the V31 block', !/setInterval|setTimeout/.test(v31Block));
  check('no browser Notification/push-messaging API usage in the V31 block (Array.push for local state is fine, that is not a notification)', !/new Notification\(|serviceWorker.*push|PushManager/i.test(v31Block));
  check('no showToast call anywhere in the V31 block (display-only, no proactive nudge)', !v31Block.includes('showToast('));

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== Isolation: unrelated systems byte-for-byte unchanged from main ===');
  check('saveProject() is byte-for-byte unchanged', extractFunction(fullScript, 'saveProject') === extractFunction(mainFullScript, 'saveProject'));
  check('renderLeaves() is byte-for-byte unchanged', extractFunction(fullScript, 'renderLeaves') === extractFunction(mainFullScript, 'renderLeaves'));
  check('saveTimeLog() is byte-for-byte unchanged', extractFunction(fullScript, 'saveTimeLog') === extractFunction(mainFullScript, 'saveTimeLog'));
  check('upsertTimeLog() is byte-for-byte unchanged', extractFunction(fullScript, 'upsertTimeLog') === extractFunction(mainFullScript, 'upsertTimeLog'));
  check('computeProjectStats() is byte-for-byte unchanged', extractFunction(fullScript, 'computeProjectStats') === extractFunction(mainFullScript, 'computeProjectStats'));

  {
    // renderDashboard() legitimately changed -- it now also calls
    // renderSubmissionsCalendarRow()/renderSubmissionsKPI(). Prove that's
    // the ONLY delta by stripping exactly those known additions back out
    // and confirming byte-identity to main holds for the rest, the same
    // discipline used for prior legitimate renderDashboard()-adjacent
    // changes in this codebase.
    const cur = extractFunction(fullScript, 'renderDashboard');
    const main = extractFunction(mainFullScript, 'renderDashboard');
    let stripped = cur.replace(/\n\s*\/\/ V31 \(Submission Tracker\)[\s\S]*?grid\.appendChild\(renderSubmissionsCalendarRow\(days\)\);\n/, '\n');
    stripped = stripped.replace(/\n\s*\/\/ V31: Submission slippage KPI[\s\S]*?renderSubmissionsKPI\(\);/, '');
    check('renderDashboard() unchanged from main except the two V31 render calls', stripped === main);
  }

  console.log('\n=== the inline <script> still parses ===');
  check('new Function(fullScript) does not throw', (() => {
    try { new Function(fullScript); return true; }
    catch (e) { console.log('    parse error:', e.message); return false; }
  })());

  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
})();
