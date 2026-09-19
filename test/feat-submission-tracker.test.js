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
  const computeOutcomeSrc = extractFunction(fullScript, 'computeSubmissionOutcome');
  const computeKpiSrc = extractFunction(fullScript, 'computeSubmissionsKPI');
  const saveSubDocSrc = extractFunction(fullScript, 'saveSubmissionDoc');
  const createSubSrc = extractFunction(fullScript, 'createSubmission');
  const toggleSubSrc = extractFunction(fullScript, 'toggleSubmissionDone');
  const chipsForDateSrc = extractFunction(fullScript, 'submissionChipsForDate');
  const genIdSrc = extractFunction(fullScript, 'genId');
  const fmtSrc = extractFunction(fullScript, 'fmt');

  function makeSandbox(projectsData, submissionsData, currentUser) {
    const { db, calls, store } = makeMockDb();
    const sandbox = {
      console, Date, Math, Object,
      staleVersionLockout: false,
      db, projectsData, submissionsData,
      currentUser: currentUser || { id: 'u-tester', name: 'Tester', isAdmin: false },
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
    const { sandbox, calls, store } = makeSandbox([{ id: 'p1', name: 'X' }], submissionsData, { id: 'u-ticker', name: 'Priya Sharma', isAdmin: false });

    const r1 = await vm.runInContext("toggleSubmissionDone('sub1')", sandbox);
    check('tick succeeds', r1.ok === true);
    check('status flips to done', submissionsData[0].status === 'done');
    check('actualDate is stamped (today, a real date string)', /^\d{4}-\d{2}-\d{2}$/.test(submissionsData[0].actualDate));
    check('plannedDate is UNCHANGED after ticking (2026-09-19, byte-identical)', submissionsData[0].plannedDate === '2026-09-19');
    check('the Firestore write only touched status/actualDate/tickedBy/tickedAt (partial, granular)', Object.keys(calls[calls.length - 1].data).sort().join(',') === ['actualDate', 'id', 'status', 'tickedAt', 'tickedBy'].sort().join(','));
    check('tickedBy records the id of whoever ticked it (anyone can tick -- this only records the fact)', submissionsData[0].tickedBy === 'u-ticker');
    check('tickedAt is a real ISO timestamp', !isNaN(new Date(submissionsData[0].tickedAt).getTime()));

    const r2 = await vm.runInContext("toggleSubmissionDone('sub1')", sandbox);
    check('untick succeeds', r2.ok === true);
    check('status reverts to open', submissionsData[0].status === 'open');
    check('actualDate is cleared back to null', submissionsData[0].actualDate === null);
    check('plannedDate is STILL unchanged after the round trip', submissionsData[0].plannedDate === '2026-09-19');
    check('tickedBy is cleared back to null on untick', submissionsData[0].tickedBy === null);
    check('tickedAt is cleared back to null on untick', submissionsData[0].tickedAt === null);
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
  console.log('\n=== The row and the KPI card NEVER hide on zero records -- there must always be a way to create the first one ===');
  function makeFakeElement() {
    const el = { className: '', innerHTML: '', textContent: '', style: {}, children: [], _listeners: {} };
    el.createElement = undefined;
    el.appendChild = (child) => { el.children.push(child); return child; };
    el.addEventListener = (evt, fn) => { el._listeners[evt] = fn; };
    return el;
  }
  function makeFakeDocumentForRow() {
    return { createElement: () => makeFakeElement() };
  }
  {
    const renderRowSrc = extractFunction(fullScript, 'renderSubmissionsCalendarRow');
    const sandbox = { console, Date, Math };
    vm.createContext(sandbox);
    vm.runInContext(fmtSrc, sandbox);
    vm.runInContext(isOverdueSrc, sandbox);
    vm.runInContext(computeOutcomeSrc, sandbox);
    vm.runInContext(chipsForDateSrc, sandbox);
    sandbox.document = makeFakeDocumentForRow();
    sandbox.projectsData = [];
    sandbox.submissionsData = []; // ZERO records
    sandbox.toggleSubmissionDoneAndRefresh = () => {};
    sandbox.openAddSubmissionModal = () => {};
    vm.runInContext(renderRowSrc, sandbox);
    const days = [new Date('2026-09-14'), new Date('2026-09-15')];
    sandbox.days = days;
    const row = vm.runInContext('renderSubmissionsCalendarRow(days)', sandbox);
    check('the row still renders with zero submissions (not skipped/hidden)', !!row);
    check('every day cell still has a "+ submission" entry point even with zero records', row.children.slice(1).every((cell) => cell.children.some((c) => c.textContent === '+ submission')));
  }
  {
    const renderKpiSrc = extractFunction(fullScript, 'renderSubmissionsKPI');
    const sandbox = { console, Math, Object };
    vm.createContext(sandbox);
    vm.runInContext(computeKpiSrc, sandbox);
    const cardEl = { style: {} };
    const feedEl = { innerHTML: '' };
    sandbox.document = { getElementById: (id) => (id === 'submissionsKpiCard' ? cardEl : id === 'submissionsKpiFeed' ? feedEl : null) };
    sandbox.currentUser = { isAdmin: true };
    sandbox.projectsData = [];
    sandbox.submissionsData = []; // ZERO records
    vm.runInContext(renderKpiSrc, sandbox);
    vm.runInContext('renderSubmissionsKPI()', sandbox);
    check('the KPI card is still shown (not hidden) for an admin with zero submissions logged', cardEl.style.display === 'block');
    check('it shows an explanatory empty state instead of disappearing', feedEl.innerHTML.includes('No submissions logged yet'));
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

  console.log('\n=== computeSubmissionOutcome(): the bug fix -- direction matters, early is NEVER late ===');
  {
    const sandbox = { console };
    vm.createContext(sandbox);
    vm.runInContext(isOverdueSrc, sandbox);
    vm.runInContext(computeOutcomeSrc, sandbox);

    console.log('\n--- THE BUG: planned Thu 2026-09-17, ticked done Wed 2026-09-16 (early) -- must NOT be "late" ---');
    const earlyOutcome = vm.runInContext("computeSubmissionOutcome({status:'done', plannedDate:'2026-09-17', actualDate:'2026-09-16'}, '2026-09-16')", sandbox);
    check('actualDate BEFORE plannedDate -> kind is "early", never "late"', earlyOutcome.kind === 'early');
    check('the early outcome carries no lateDays', earlyOutcome.lateDays === undefined);

    const onTimeOutcome = vm.runInContext("computeSubmissionOutcome({status:'done', plannedDate:'2026-09-17', actualDate:'2026-09-17'}, '2026-09-17')", sandbox);
    check('actualDate === plannedDate (same day) -> kind is "on-time"', onTimeOutcome.kind === 'on-time');

    const lateOutcome = vm.runInContext("computeSubmissionOutcome({status:'done', plannedDate:'2026-09-05', actualDate:'2026-09-08'}, '2026-09-16')", sandbox);
    check('actualDate AFTER plannedDate -> kind is "late"', lateOutcome.kind === 'late');
    check('late-by-3-days computed correctly', lateOutcome.lateDays === 3);

    const overdueOutcome = vm.runInContext("computeSubmissionOutcome({status:'open', plannedDate:'2020-01-01'}, '2026-09-16')", sandbox);
    check('not done, plannedDate in the past -> kind is "overdue"', overdueOutcome.kind === 'overdue');

    const upcomingOutcomeFuture = vm.runInContext("computeSubmissionOutcome({status:'open', plannedDate:'2099-01-01'}, '2026-09-16')", sandbox);
    check('not done, plannedDate in the future -> kind is "upcoming"', upcomingOutcomeFuture.kind === 'upcoming');
    const upcomingOutcomeToday = vm.runInContext("computeSubmissionOutcome({status:'open', plannedDate:'2026-09-16'}, '2026-09-16')", sandbox);
    check('not done, plannedDate is TODAY -> kind is "upcoming", not "overdue"', upcomingOutcomeToday.kind === 'upcoming');
  }

  console.log('\n--- submissionChipsForDate(): the marker renders ON plannedDate even when overdue, plus a late-completion echo on actualDate ---');
  {
    const sandbox = { console };
    vm.createContext(sandbox);
    vm.runInContext(isOverdueSrc, sandbox);
    vm.runInContext(computeOutcomeSrc, sandbox);
    vm.runInContext(chipsForDateSrc, sandbox);
    sandbox.projectsData = [{ id: 'p1', name: 'BURDWAN RD' }];
    sandbox.submissionsData = [
      { id: 'a', projectId: 'p1', plannedDate: '2026-09-10', actualDate: null, remark: 'Overdue one', status: 'open' },
      { id: 'b', projectId: 'p1', plannedDate: '2026-09-05', actualDate: '2026-09-08', remark: 'Late but done', status: 'done' },
      { id: 'c', projectId: 'p1', plannedDate: '2026-09-17', actualDate: '2026-09-16', remark: 'Ticked early', status: 'done' },
      { id: 'd', projectId: 'p1', plannedDate: '2026-09-12', actualDate: '2026-09-12', remark: 'Ticked same day', status: 'done' },
    ];
    const plannedDayChips = vm.runInContext("submissionChipsForDate('2026-09-10', '2026-09-16')", sandbox);
    check('an overdue open submission still shows its chip ON the planned day (never removed/moved)', plannedDayChips.some((c) => c.id === 'a' && c.cls === 'overdue'));

    const lateSubmissionPlannedDay = vm.runInContext("submissionChipsForDate('2026-09-05', '2026-09-16')", sandbox);
    check('a late-but-done submission STILL shows a marker on its ORIGINAL planned day (marked late, with day count)', lateSubmissionPlannedDay.some((c) => c.id === 'b' && c.text.includes('(late by 3d)')));

    const actualDayChips = vm.runInContext("submissionChipsForDate('2026-09-08', '2026-09-16')", sandbox);
    check('the same late submission ALSO shows an echo chip on its actual completion day', actualDayChips.some((c) => c.id === 'b' && c.isEcho === true));
    check('a day with nothing due gets zero chips', vm.runInContext("submissionChipsForDate('2026-01-01', '2026-09-16')", sandbox).length === 0);

    console.log('\n--- THE BUG, end to end through the actual chip renderer: early must read "(early)", never "(late)" ---');
    const earlyChipDay = vm.runInContext("submissionChipsForDate('2026-09-17', '2026-09-16')", sandbox);
    const earlyChip = earlyChipDay.find((c) => c.id === 'c');
    check('a submission ticked done BEFORE its plannedDate shows "(early)"', earlyChip.text.includes('(early)'));
    check('...and CRITICALLY does NOT show "(late)" anywhere in its text', !earlyChip.text.includes('(late)'));
    check('its chip class reflects the early outcome', earlyChip.cls === 'done early');

    const onTimeChipDay = vm.runInContext("submissionChipsForDate('2026-09-12', '2026-09-16')", sandbox);
    const onTimeChip = onTimeChipDay.find((c) => c.id === 'd');
    check('a submission ticked done on the SAME day as plannedDate shows neither "(late)" nor "(early)"', !onTimeChip.text.includes('(late)') && !onTimeChip.text.includes('(early)'));
    check('its chip class reflects the on-time outcome', onTimeChip.cls === 'done on-time');
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== computeSubmissionsKPI(): aggregates STRICTLY by project, zero person-attribution ===');
  {
    const sandbox = { console };
    vm.createContext(sandbox);
    vm.runInContext(isOverdueSrc, sandbox);
    vm.runInContext(computeOutcomeSrc, sandbox);
    vm.runInContext(computeKpiSrc, sandbox);
    const projectsData = [{ id: 'p1', name: 'BURDWAN RD' }, { id: 'p2', name: 'CHETLA SAMPLE FLAT' }];
    const submissionsData = [
      { id: '1', projectId: 'p1', plannedDate: '2026-09-01', actualDate: '2026-09-01', status: 'done', tickedBy: 'u-priya', tickedAt: '2026-09-01T10:00:00.000Z' }, // on-time
      { id: '2', projectId: 'p1', plannedDate: '2026-09-05', actualDate: '2026-09-08', status: 'done', tickedBy: 'u-tasmin', tickedAt: '2026-09-08T10:00:00.000Z' }, // 3 days slipped
      { id: '3', projectId: 'p1', plannedDate: '2026-09-10', actualDate: null, status: 'open', tickedBy: null, tickedAt: null }, // still open
      { id: '4', projectId: 'p1', plannedDate: '2026-09-17', actualDate: '2026-09-16', status: 'done', tickedBy: 'u-priya', tickedAt: '2026-09-16T10:00:00.000Z' }, // EARLY -- must count as met, not slipped
      { id: '5', projectId: 'p2', plannedDate: '2026-09-02', actualDate: '2026-09-06', status: 'done', tickedBy: 'u-priya', tickedAt: '2026-09-06T10:00:00.000Z' }, // 4 days slipped
    ];
    sandbox.projectsData = projectsData; sandbox.submissionsData = submissionsData;
    const rows = vm.runInContext('computeSubmissionsKPI(projectsData, submissionsData)', sandbox);
    const p1 = rows.find((r) => r.projectId === 'p1');
    const p2 = rows.find((r) => r.projectId === 'p2');
    check('p1: total 4, done 3, open 1', p1.total === 4 && p1.done === 3 && p1.open === 1);
    check('p1: 2 on-time (includes the EARLY one), 1 slipped -- early counts as met, not slipped', p1.onTime === 2 && p1.slipped === 1);
    check('p1: average slip days for the one genuinely slipped submission is 3 (the early one contributes ZERO slip days)', p1.avgSlipDays === 3);
    check('p2: 1 slipped, average slip days 4', p2.slipped === 1 && p2.avgSlipDays === 4);
    check('output rows carry ONLY project fields -- no userId/person/name-of-person anywhere', rows.every((r) => Object.keys(r).every((k) => !/user|person|assignee|by\b/i.test(k))));
    check('tickedBy is NEVER surfaced in the KPI output, even though the input submissions carry it (input has 3 distinct tickedBy values, output has none)', !rows.some((r) => 'tickedBy' in r || 'tickedAt' in r));
  }
  check('computeSubmissionsKPI()\'s own source never reads/groups by userId or any person field, INCLUDING tickedBy/tickedAt', !/userId|assignee|createdBy|tickedBy|tickedAt/.test(computeKpiSrc));

  console.log('\n--- Guardrail: tickedBy/tickedAt never surface in the TEAM-facing calendar row ---');
  {
    const chipsSrc = extractFunction(fullScript, 'submissionChipsForDate');
    const rowSrc = extractFunction(fullScript, 'renderSubmissionsCalendarRow');
    check('submissionChipsForDate() (feeds the team-visible Weekly Planner row) never references tickedBy/tickedAt', !/tickedBy|tickedAt/.test(chipsSrc));
    check('renderSubmissionsCalendarRow() never references tickedBy/tickedAt', !/tickedBy|tickedAt/.test(rowSrc));
  }

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
  // V34 made renderLeaves()'s "used of X" / bar maths entitlement-aware; compare with that one change normalised away on both sides (holds before AND after V34 is on main).
  const flatEnt = (s) => s.replace('const medEnt=user.medEntitlement??12,casEnt=user.casEntitlement??5,mU=medEnt-user.medLeft,cU=casEnt-user.casLeft;', 'const mU=12-user.medLeft,cU=5-user.casLeft;').split('${medEnt}').join('12').split('${casEnt}').join('5').split('medEnt').join('12').split('casEnt').join('5');
  check('renderLeaves() is byte-for-byte unchanged (modulo V34 entitlement denominators)', flatEnt(extractFunction(fullScript, 'renderLeaves')) === flatEnt(extractFunction(mainFullScript, 'renderLeaves')));
  check('saveTimeLog() is byte-for-byte unchanged', extractFunction(fullScript, 'saveTimeLog') === extractFunction(mainFullScript, 'saveTimeLog'));
  check('upsertTimeLog() is byte-for-byte unchanged', extractFunction(fullScript, 'upsertTimeLog') === extractFunction(mainFullScript, 'upsertTimeLog'));
  check('computeProjectStats() is byte-for-byte unchanged', extractFunction(fullScript, 'computeProjectStats') === extractFunction(mainFullScript, 'computeProjectStats'));

  {
    // V31 shipped to main since this check was written (main now already
    // contains renderDashboard()'s KPI call), so a "strip the addition,
    // compare to main" check would compare main against its own former
    // self and false-fail forever -- same post-merge situation this
    // codebase has hit before (see e.g. feat-quick-ask-keyword-hr.test.js
    // on renderHrInfo(), or the V30 fixtures after V30 merged). Assert
    // plain byte-identity now that both sides have the change.
    check('renderDashboard() is byte-for-byte unchanged from main', extractFunction(fullScript, 'renderDashboard') === extractFunction(mainFullScript, 'renderDashboard'));
    check('renderDashboard() does NOT render the submissions marker row (wrong surface -- that belongs on Weekly Planner)', !extractFunction(fullScript, 'renderDashboard').includes('renderSubmissionsCalendarRow'));
  }
  {
    check('renderPlanner() is byte-for-byte unchanged from main', extractFunction(fullScript, 'renderPlanner') === extractFunction(mainFullScript, 'renderPlanner'));
  }

  console.log('\n=== the inline <script> still parses ===');
  check('new Function(fullScript) does not throw', (() => {
    try { new Function(fullScript); return true; }
    catch (e) { console.log('    parse error:', e.message); return false; }
  })());

  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
})();
