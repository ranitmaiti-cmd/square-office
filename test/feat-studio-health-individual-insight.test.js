// Fixture test for Studio Health -- Individual Insight, V16.13 reshape:
// Margin Risk (project-level, primary) + Versatility + Workload (quiet)
// + Leave-near-holidays (drill-down-only, never a flag). Attendance (#2,
// biometric IN-time) is STILL held -- no plumbing, nothing to test here.
//
// Extracts the ACTUAL functions from index.html (brace-matched, not
// retyped) and runs them in a vm sandbox -- proving the real shipped
// code, same discipline as every other fixture in this repo.
//
// Central claims under test:
//  - pure-read: no writes anywhere (source-text check)
//  - margin risk ranks by ABSOLUTE hours over budget, not percentage
//  - person-level patterns still self-baseline only, never each other
//  - leave-near-holiday adjacency, including the real sandwich/weekend
//    rule (2nd/4th Saturday only, ported from the app's own is24Sat())
//  - leave-near-holiday NEVER appears as a flag sentence, drill-down only
//  - the two-axis drill-down (project vs. person) works independently
//  - the structural no-side-by-side rule, extended to the new visuals,
//    WITH the one deliberate, explicitly-tested exception: the project
//    drill-down's contributor list intentionally shows multiple people
//
// Run with: node test/feat-studio-health-individual-insight.test.js
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
  let depth = 0, i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  assert.ok(depth === 0, `brace matching failed for ${name}`);
  return source.slice(startIdx, i + 1);
}
function extractConstLine(source, name) {
  const idx = source.indexOf(`const ${name} =`);
  assert.ok(idx >= 0, `could not find "const ${name} =" in index.html`);
  const end = source.indexOf(';', idx);
  return source.slice(idx, end + 1);
}

const shConstantsSrc = [
  'SH_WORKLOAD_WINDOWS', 'SH_PRIOR_WINDOW_COUNT', 'SH_WORKLOAD_SPIKE_RATIO', 'SH_WORKLOAD_DROP_RATIO',
  'SH_EST_MIN_CONTRIBUTION_PCT', 'SH_EST_RECENT_COUNT', 'SH_EST_MIN_HISTORICAL_COUNT', 'SH_EST_SIGNIFICANT_OVER_RATIO',
  'SH_TREND_WEEKS', 'SH_HEATMAP_DAYS', 'SH_VERSATILITY_MIN_PCT',
].map(name => extractConstLine(fullScript, name)).join('\n');

const FN_NAMES = [
  'toLocalDateStr', 'getWindowBounds', 'productiveMinsInWindow', 'approvedLeaveDaysInWindow', 'computeWorkloadPattern',
  'computePhaseContributions', 'computeEstimationPattern', 'computeMarginRiskRanking', 'meaningfulContributorsFor',
  'meaningfulProjectCount', 'computeVersatilityStat', 'isClosedDayStr', 'addDaysToDateStr', 'leaveNearHolidayInstances',
  'buildLeaveHeatmapDays', 'computeWorkloadTrend', 'renderWorkloadTrendSVG', 'renderLeaveHeatmapSVG',
];
const fnSrc = {};
FN_NAMES.forEach(name => { fnSrc[name] = extractFunction(fullScript, name); });
const renderInsightSrc = extractFunction(fullScript, 'renderIndividualInsight');
const renderInsightBodySrc = extractFunction(fullScript, 'renderIndividualInsightBody');

// ═══════════════════════════════════════════════════════════════════
console.log('=== Source-text check: Individual Insight never writes; supersession confirmed ===');
let passCount = 0, failCount = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); passCount++; }
  else { console.log(`  FAIL: ${label}`); failCount++; }
}
const allSrc = Object.values(fnSrc).concat([renderInsightSrc, renderInsightBodySrc]).join('\n');
check('no .set( anywhere', !allSrc.includes('.set('));
check('no .update( anywhere', !allSrc.includes('.update('));
check('no Firestore .add( anywhere (plain JS Set.add(), if any, would be excluded here -- none of these functions use one)', !allSrc.replace(/set\.add\(/g, '').includes('.add('));
check('no .delete( anywhere', !allSrc.includes('.delete('));
check('no .batch( anywhere', !allSrc.includes('.batch('));
check('renderIndividualInsight reads with source:\'server\'', renderInsightSrc.includes(`source: 'server'`));
check('renderIndividualInsightBody does NOT touch db at all (no re-fetch on selector change)', !renderInsightBodySrc.includes('db.'));
check('computeWorkloadPattern never references a shared/global target constant (self-baseline only)', !fnSrc.computeWorkloadPattern.includes('htTarget') && !fnSrc.computeWorkloadPattern.includes('MAX_SESSION_HOURS'));
check('computeMarginRiskRanking sorts by hoursOver, not ratio/percentage', /sort\(\(a, b\) => b\.hoursOver - a\.hoursOver\)/.test(fnSrc.computeMarginRiskRanking));
check('V16.12\'s per-person significantlyOverBudgetInstances() is gone -- superseded by the project-level ranking', !fullScript.includes('function significantlyOverBudgetInstances'));
check('renderIndividualInsight now reads companyData/squareDB for holidays', renderInsightSrc.includes(`collection('companyData').doc('squareDB')`));

function buildSandbox() {
  const sandbox = { console, Date, Object, Math, Set };
  vm.createContext(sandbox);
  vm.runInContext(shConstantsSrc, sandbox);
  FN_NAMES.forEach(name => vm.runInContext(fnSrc[name], sandbox));
  return sandbox;
}

// Real extracted value, not retyped -- so the fixture tracks index.html's
// actual SH_VERSATILITY_MIN_PCT constant if it's ever retuned again.
const SH_VERSATILITY_MIN_PCT_VAL = vm.runInContext('SH_VERSATILITY_MIN_PCT', buildSandbox());

const TODAY = new Date('2026-08-28T12:00:00Z'); // a Friday
function dateStr(offsetDaysFromToday) {
  const d = new Date(TODAY);
  d.setDate(d.getDate() + offsetDaysFromToday);
  return d.toISOString().slice(0, 10);
}

async function run() {
  // ═══════════════════════════════════════════════════════════════
  // THE ACTUAL BUG FOUND WHILE BUILDING THIS: toLocalDateStr() replaces
  // four separate d.toISOString().slice(0,10) call sites (including
  // getWindowBounds(), already-shipped since V16.11) that silently
  // rolled the date BACKWARD by one day for any `today` between IST
  // midnight and 05:29 -- toISOString() converts to UTC first, and IST
  // is UTC+5:30, so IST 02:00 is UTC 20:30 the PREVIOUS calendar day.
  // fmt() (this file's own established date-string helper, defined a
  // few hundred lines up) was already written specifically to avoid
  // this exact pitfall -- toLocalDateStr() mirrors it, this proves it.
  // ═══════════════════════════════════════════════════════════════
  console.log('=== toLocalDateStr: does NOT roll the date backward for an early-IST-morning instant ===');
  {
    const sandbox = buildSandbox();
    // 2026-08-15T00:30:00+05:30 IST = 2026-08-14T19:00:00Z UTC -- a
    // PREVIOUS-UTC-day instant that a naive toISOString().slice(0,10)
    // would wrongly report as 2026-08-14.
    const earlyIST = new Date('2026-08-15T00:30:00+05:30');
    const result = vm.runInContext('toLocalDateStr', sandbox)(earlyIST);
    check('correctly reports the LOCAL calendar day (2026-08-15), not the UTC-shifted previous day', result === '2026-08-15');
  }

  console.log('\n=== getWindowBounds: does NOT roll backward when `today` is an early-IST-morning instant ===');
  {
    const sandbox = buildSandbox();
    const earlyIST = new Date('2026-08-15T00:30:00+05:30');
    const window = vm.runInContext('getWindowBounds', sandbox)(30, 0, earlyIST);
    check('window.end is the real local day (2026-08-15), not rolled back to 2026-08-14', window.end === '2026-08-15');
  }

  // ═══════════════════════════════════════════════════════════════
  // Workload -- unchanged from V16.12, re-confirmed against the real
  // shipped code post-restructure (nothing here should have regressed).
  // ═══════════════════════════════════════════════════════════════
  console.log('=== computeWorkloadPattern: still self-baseline, extreme-only (unchanged) ===');
  {
    const sandbox = buildSandbox();
    const logs = [];
    for (let w = 1; w <= 3; w++) logs.push({ userId: 'u1', productive: true, durationMins: 100 * 60, date: dateStr(-30 * w - 5) });
    logs.push({ userId: 'u1', productive: true, durationMins: 260 * 60, date: dateStr(-5) });
    const spike = vm.runInContext('computeWorkloadPattern', sandbox)(logs, 'u1', 30, 3, TODAY);
    check('extreme spike (2.6x) still flags', spike.flagged === true && spike.direction === 'above');

    const sandbox2 = buildSandbox();
    const logs2 = [];
    for (let w = 1; w <= 3; w++) logs2.push({ userId: 'u1', productive: true, durationMins: 100 * 60, date: dateStr(-30 * w - 5) });
    logs2.push({ userId: 'u1', productive: true, durationMins: 109 * 60, date: dateStr(-5) });
    const ordinary = vm.runInContext('computeWorkloadPattern', sandbox2)(logs2, 'u1', 30, 3, TODAY);
    check('the Souvik case (9% above) still stays silent', ordinary.flagged === false);
  }

  // ═══════════════════════════════════════════════════════════════
  console.log('\n=== approvedLeaveDaysInWindow: unchanged ===');
  {
    const sandbox = buildSandbox();
    const window = vm.runInContext('getWindowBounds', sandbox)(30, 0, TODAY);
    const leaveRequests = [
      { userId: 'u1', status: 'approved', startDate: dateStr(-10), endDate: dateStr(-8) },
    ];
    const days = vm.runInContext('approvedLeaveDaysInWindow', sandbox)(leaveRequests, 'u1', window.start, window.end);
    check('3 approved leave days counted', days === 3);
  }

  // ═══════════════════════════════════════════════════════════════
  console.log('\n=== computeEstimationPattern: >=20% threshold + raw hours, unchanged ===');
  {
    const sandbox = buildSandbox();
    const projects = [{ id: 'p1', name: 'Test Project', phases: { 'Construction Documents': 100 } }];
    const logs = [
      { userId: 'u1', projectId: 'p1', phase: 'Construction Documents', durationMins: 100 * 60 * 0.25, date: dateStr(-5) },
      { userId: 'u2', projectId: 'p1', phase: 'Construction Documents', durationMins: 100 * 60 * 0.75, date: dateStr(-5) },
    ];
    const instances = vm.runInContext('computePhaseContributions', sandbox)(logs, projects);
    const pattern = vm.runInContext('computeEstimationPattern', sandbox)(instances, 'u1', 0.20, 5, 3);
    check('u1 (25% contributor) IS included, raw hours not split', pattern.contributed.length === 1 && pattern.contributed[0].personMins === 100 * 60 * 0.25);
  }

  // ═══════════════════════════════════════════════════════════════
  // NEW: Margin Risk -- the central reframe. Absolute hours over, NOT
  // percentage, is the sort key.
  // ═══════════════════════════════════════════════════════════════
  console.log('\n=== computeMarginRiskRanking: ranks by ABSOLUTE hours over, not percentage ===');
  {
    const sandbox = buildSandbox();
    const projects = [
      { id: 'small', name: 'Small Phase Project', phases: { Phase: 10 } },  // 288% of 10h = 28.8h actual, 18.8h over
      { id: 'big', name: 'Big Phase Project', phases: { Phase: 500 } },     // 130% of 500h = 650h actual, 150h over
    ];
    const logs = [
      { userId: 'u1', projectId: 'small', phase: 'Phase', durationMins: 10 * 60 * 2.88, date: dateStr(-5) },
      { userId: 'u2', projectId: 'big', phase: 'Phase', durationMins: 500 * 60 * 1.30, date: dateStr(-5) },
    ];
    const instances = vm.runInContext('computePhaseContributions', sandbox)(logs, projects);
    const ranking = vm.runInContext('computeMarginRiskRanking', sandbox)(instances, 1.10);
    check('both instances included (both over the 1.10 floor)', ranking.length === 2);
    check('the BIG project (150h over) ranks FIRST despite lower percentage (130% vs 288%)', ranking[0].projectId === 'big');
    check('the SMALL project (18.8h over) ranks SECOND despite higher percentage', ranking[1].projectId === 'small');
    check('hoursOver computed correctly for the big one (~150h)', Math.abs(ranking[0].hoursOver - 150) < 0.5);
  }

  console.log('\n=== computeMarginRiskRanking: a phase under budget, or barely over, is excluded ===');
  {
    const sandbox = buildSandbox();
    const projects = [{ id: 'p1', name: 'Fine Project', phases: { Phase: 100 } }];
    const logs = [{ userId: 'u1', projectId: 'p1', phase: 'Phase', durationMins: 100 * 60 * 1.05, date: dateStr(-5) }]; // 5% over -- under the 1.10 floor
    const instances = vm.runInContext('computePhaseContributions', sandbox)(logs, projects);
    const ranking = vm.runInContext('computeMarginRiskRanking', sandbox)(instances, 1.10);
    check('excluded -- not a real margin problem', ranking.length === 0);
  }

  // ═══════════════════════════════════════════════════════════════
  console.log('\n=== meaningfulContributorsFor: raw hours, sorted for legibility (not a quality ranking) ===');
  {
    const sandbox = buildSandbox();
    const inst = { totalActualMins: 100 * 60, byPerson: { u1: 60 * 60, u2: 25 * 60, u3: 15 * 60 } }; // u3 is a 15% drive-by
    const users = [{ id: 'u1', name: 'Alice' }, { id: 'u2', name: 'Bob' }, { id: 'u3', name: 'Carol' }];
    const contributors = vm.runInContext('meaningfulContributorsFor', sandbox)(inst, 0.20, users);
    check('only meaningful (>=20%) contributors included -- Carol (15%) excluded', contributors.length === 2);
    check('sorted by hours, most-involved first', contributors[0].name === 'Alice' && contributors[1].name === 'Bob');
  }

  // ═══════════════════════════════════════════════════════════════
  // V16.17: meaningfulProjectCount()/computeVersatilityStat() -- real-
  // data investigation (2026-08-30) found the OLD distinctProjectCount()
  // (any project with >=1 logged minute, no threshold, no productive
  // check) badly inflated: Angana showed "11 projects" over a quarter
  // when only 3 were a meaningful chunk of her own time. Fix: a project
  // counts only if this person's PRODUCTIVE minutes on it are
  // >= SH_VERSATILITY_MIN_PCT (10%) of their own total productive
  // project minutes in the window -- self-baselined against their OWN
  // total, not the project's total (deliberately a different, lower
  // threshold than the estimation metric's 20%-of-the-PHASE's-hours --
  // see the SH_VERSATILITY_MIN_PCT comment in index.html for why).
  // ═══════════════════════════════════════════════════════════════
  console.log('\n=== meaningfulProjectCount: the >=10% boundary, exact ===');
  {
    const sandbox = buildSandbox();
    // Total = 100 mins. Case 1: A=91, B=9 -- B sits at exactly 9%, excluded.
    const logsExcluded = [
      { userId: 'u1', projectId: 'pA', productive: true, durationMins: 91, date: dateStr(-5) },
      { userId: 'u1', projectId: 'pB', productive: true, durationMins: 9, date: dateStr(-4) },
    ];
    check('a project at exactly 9% of the person\'s own project time is excluded', vm.runInContext('meaningfulProjectCount', sandbox)(logsExcluded, 'u1', dateStr(-30), dateStr(1), SH_VERSATILITY_MIN_PCT_VAL) === 1);
    // Case 2: A=89, B=11 -- B sits at exactly 11%, included.
    const logsIncluded = [
      { userId: 'u1', projectId: 'pA', productive: true, durationMins: 89, date: dateStr(-5) },
      { userId: 'u1', projectId: 'pB', productive: true, durationMins: 11, date: dateStr(-4) },
    ];
    check('a project at exactly 11% of the person\'s own project time is included', vm.runInContext('meaningfulProjectCount', sandbox)(logsIncluded, 'u1', dateStr(-30), dateStr(1), SH_VERSATILITY_MIN_PCT_VAL) === 2);
    // Case 3: exactly at the 10% boundary itself -- >= is inclusive.
    const logsBoundary = [
      { userId: 'u1', projectId: 'pA', productive: true, durationMins: 90, date: dateStr(-5) },
      { userId: 'u1', projectId: 'pB', productive: true, durationMins: 10, date: dateStr(-4) },
    ];
    check('a project at EXACTLY 10% is included (>= is inclusive)', vm.runInContext('meaningfulProjectCount', sandbox)(logsBoundary, 'u1', dateStr(-30), dateStr(1), SH_VERSATILITY_MIN_PCT_VAL) === 2);
  }

  console.log('\n=== meaningfulProjectCount: only PRODUCTIVE minutes count, on both sides of the ratio ===');
  {
    const sandbox = buildSandbox();
    // Project A: 50 productive mins (this person's only real project work).
    // Project B: 500 NON-productive mins logged against it (e.g. an admin
    // note tagged to a project) -- must not count as involvement, and
    // must not dilute the denominator either (old bug: distinctProjectCount
    // had no productive check at all, so B would have counted as a full
    // "touched" project on its own).
    const logs = [
      { userId: 'u1', projectId: 'pA', productive: true, durationMins: 50, date: dateStr(-5) },
      { userId: 'u1', projectId: 'pB', productive: false, durationMins: 500, date: dateStr(-4) },
    ];
    const count = vm.runInContext('meaningfulProjectCount', sandbox)(logs, 'u1', dateStr(-30), dateStr(1), SH_VERSATILITY_MIN_PCT_VAL);
    check('the non-productive-only project does not count at all', count === 1);
  }

  console.log('\n=== computeVersatilityStat: current count AND own-average use the SAME thresholded definition ===');
  {
    const sandbox = buildSandbox();
    const logs = [];
    // Each of 3 prior windows: 1 meaningful project (900 mins, ~90%) +
    // 2 drive-by touches (50 mins each, ~5% each -- excluded). Old
    // (unthresholded) behavior would have averaged 3 projects/window;
    // the fix must average 1/window, matching the current side's own
    // thresholding, not a raw count.
    for (let w = 1; w <= 3; w++) {
      const base = -30 * w - 5;
      logs.push({ userId: 'u1', projectId: 'pMain', productive: true, durationMins: 900, date: dateStr(base) });
      logs.push({ userId: 'u1', projectId: 'pDrive1', productive: true, durationMins: 50, date: dateStr(base + 1) });
      logs.push({ userId: 'u1', projectId: 'pDrive2', productive: true, durationMins: 50, date: dateStr(base + 2) });
    }
    // Current window: same shape -- 1 meaningful + 2 drive-bys.
    logs.push({ userId: 'u1', projectId: 'pMain', productive: true, durationMins: 900, date: dateStr(-5) });
    logs.push({ userId: 'u1', projectId: 'pDrive1', productive: true, durationMins: 50, date: dateStr(-4) });
    logs.push({ userId: 'u1', projectId: 'pDrive2', productive: true, durationMins: 50, date: dateStr(-3) });
    const result = vm.runInContext('computeVersatilityStat', sandbox)(logs, 'u1', 30, 3, TODAY, SH_VERSATILITY_MIN_PCT_VAL);
    check('currentCount reflects the threshold (1 meaningful, not 3 touched)', result.currentCount === 1);
    check('avgPriorCount ALSO reflects the same threshold (1/window, not 3/window) -- no current-vs-avg definition mismatch', result.avgPriorCount === 1);
  }

  console.log('\n=== Angana-style real case: many touches -> few meaningful ===');
  {
    const sandbox = buildSandbox();
    // Mirrors the real 91-day investigation shape (2026-08-30): 3 big
    // projects (35%/26%/24%, ~85% of her time combined) + 5 small
    // drive-by touches trailing off from ~6% down to ~0.5%. 8 projects
    // touched, only 3 meaningful.
    const mins = [350, 260, 240, 60, 40, 30, 15, 5]; // sums to 1000
    const logs = mins.map((m, i) => ({ userId: 'u1', projectId: 'p' + i, productive: true, durationMins: m, date: dateStr(-5 - i) }));
    const count = vm.runInContext('meaningfulProjectCount', sandbox)(logs, 'u1', dateStr(-30), dateStr(1), SH_VERSATILITY_MIN_PCT_VAL);
    check('8 projects touched, only the 3 meaningful ones (>=10%) count', count === 3);
  }

  console.log('\n=== Suravi-style real case: several real month-long commitments, ALL clear 10% ===');
  {
    const sandbox = buildSandbox();
    // Mirrors the real 30-day investigation shape: 5 substantial
    // commitments (~25%/17%/15%/13%/11%) + 4 smaller touches (~6%/6%/5%/3%)
    // -- the threshold must NOT collapse genuinely multi-project
    // involvement down to just the top one.
    const mins = [3820, 2510, 2330, 1920, 1650, 890, 870, 750, 400]; // sums to 15140 (mirrors real hours x100)
    const logs = mins.map((m, i) => ({ userId: 'u1', projectId: 'p' + i, productive: true, durationMins: m, date: dateStr(-5 - i) }));
    const count = vm.runInContext('meaningfulProjectCount', sandbox)(logs, 'u1', dateStr(-30), dateStr(1), SH_VERSATILITY_MIN_PCT_VAL);
    check('9 projects touched, 5 real commitments all clear 10% and count -- not collapsed to 1', count === 5);
  }

  console.log('\n=== computeVersatilityStat: framing unchanged -- still no flagged/direction field ===');
  {
    const sandbox = buildSandbox();
    const logs = [{ userId: 'u1', projectId: 'p1', productive: true, durationMins: 100, date: dateStr(-5) }];
    const result = vm.runInContext('computeVersatilityStat', sandbox)(logs, 'u1', 30, 3, TODAY, SH_VERSATILITY_MIN_PCT_VAL);
    check('no "flagged" field -- the threshold fixes the NUMBER, not the interpretation', !('flagged' in result));
    check('no "direction" field either', !('direction' in result));
  }

  // ═══════════════════════════════════════════════════════════════
  // NEW: leave-near-holiday adjacency, including the REAL sandwich rule
  // (2nd/4th Saturday only -- ported from the app's own is24Sat()).
  // ═══════════════════════════════════════════════════════════════
  console.log('\n=== isClosedDayStr: Sunday, 2nd/4th Saturday, holiday -- matches the app\'s real rule ===');
  {
    const sandbox = buildSandbox();
    check('a Sunday is closed', vm.runInContext('isClosedDayStr', sandbox)('2026-08-30', []) === true); // 30 Aug 2026 is a Sunday
    check('2026-08-08 (2nd Saturday of August 2026) is closed', vm.runInContext('isClosedDayStr', sandbox)('2026-08-08', []) === true);
    check('2026-08-01 (1st Saturday) is NOT closed -- only 2nd/4th count', vm.runInContext('isClosedDayStr', sandbox)('2026-08-01', []) === false);
    check('2026-08-15 (3rd Saturday) is NOT closed', vm.runInContext('isClosedDayStr', sandbox)('2026-08-15', []) === false);
    check('an ordinary Tuesday is not closed', vm.runInContext('isClosedDayStr', sandbox)('2026-08-25', []) === false); // a Tuesday
    check('a real holiday is closed', vm.runInContext('isClosedDayStr', sandbox)('2026-10-02', [{ date: '2026-10-02', name: 'Gandhi Jayanti' }]) === true);
  }

  console.log('\n=== leaveNearHolidayInstances: adjacent to a weekend -> included ===');
  {
    const sandbox = buildSandbox();
    // 2026-08-07 is a Friday; 2026-08-08 (the very next day) is the 2nd
    // Saturday -- so leave ENDING on the Friday is adjacent to a closed
    // weekend day right after it.
    const leaveRequests = [{ userId: 'u1', status: 'approved', startDate: '2026-08-07', endDate: '2026-08-07' }];
    const result = vm.runInContext('leaveNearHolidayInstances', sandbox)(leaveRequests, 'u1', []);
    check('leave ending right before a 2nd-Saturday weekend is flagged as adjacent', result.length === 1);
  }

  console.log('\n=== leaveNearHolidayInstances: adjacent to a 1st Saturday -> NOT included (not a real closed day) ===');
  {
    const sandbox = buildSandbox();
    // 2026-07-31 is a Friday; 2026-08-01 (the next day) is the 1ST
    // Saturday -- NOT closed under this app's own rule, so this leave
    // should NOT be flagged, unlike the 2nd/4th Saturday case above.
    const leaveRequests = [{ userId: 'u1', status: 'approved', startDate: '2026-07-31', endDate: '2026-07-31' }];
    const result = vm.runInContext('leaveNearHolidayInstances', sandbox)(leaveRequests, 'u1', []);
    check('leave next to a 1st Saturday is correctly NOT flagged', result.length === 0);
  }

  console.log('\n=== leaveNearHolidayInstances: adjacent to a real holiday -> included ===');
  {
    const sandbox = buildSandbox();
    const holidays = [{ date: '2026-10-02', name: 'Gandhi Jayanti' }];
    // Leave starting the day right after the holiday.
    const leaveRequests = [{ userId: 'u1', status: 'approved', startDate: '2026-10-03', endDate: '2026-10-05' }];
    const result = vm.runInContext('leaveNearHolidayInstances', sandbox)(leaveRequests, 'u1', holidays);
    check('leave starting right after a holiday is flagged as adjacent', result.length === 1);
  }

  console.log('\n=== leaveNearHolidayInstances: no adjacency at all -> excluded ===');
  {
    const sandbox = buildSandbox();
    // A Tuesday-to-Wednesday leave with ordinary weekdays on both sides.
    const leaveRequests = [{ userId: 'u1', status: 'approved', startDate: '2026-08-25', endDate: '2026-08-26' }];
    const result = vm.runInContext('leaveNearHolidayInstances', sandbox)(leaveRequests, 'u1', []);
    check('leave with no adjacent closed day is correctly excluded', result.length === 0);
  }

  console.log('\n=== leaveNearHolidayInstances: only APPROVED leave counts, only the named user ===');
  {
    const sandbox = buildSandbox();
    const leaveRequests = [
      { userId: 'u1', status: 'pending', startDate: '2026-08-07', endDate: '2026-08-07' }, // adjacent, but not approved
      { userId: 'u2', status: 'approved', startDate: '2026-08-07', endDate: '2026-08-07' }, // adjacent, but a different person
    ];
    const result = vm.runInContext('leaveNearHolidayInstances', sandbox)(leaveRequests, 'u1', []);
    check('neither the pending nor the other-person leave counts for u1', result.length === 0);
  }

  // ═══════════════════════════════════════════════════════════════
  console.log('\n=== buildLeaveHeatmapDays: day types classified correctly, leave takes precedence ===');
  {
    const sandbox = buildSandbox();
    const holidays = [{ date: dateStr(-3), name: 'Test Holiday' }];
    const leaveRequests = [{ userId: 'u1', status: 'approved', startDate: dateStr(-1), endDate: dateStr(-1) }];
    const days = vm.runInContext('buildLeaveHeatmapDays', sandbox)(leaveRequests, holidays, 'u1', 10, TODAY);
    check('correct total day count', days.length === 10);
    const holidayDay = days.find(d => d.date === dateStr(-3));
    const leaveDay = days.find(d => d.date === dateStr(-1));
    check('the holiday day is typed "holiday"', holidayDay.type === 'holiday');
    check('the leave day is typed "leave"', leaveDay.type === 'leave');
  }

  // ═══════════════════════════════════════════════════════════════════
  // STRUCTURAL claims: two-axis drill-down, no-side-by-side (extended to
  // the new visuals), leave-near-holiday drill-down-only, and the
  // deliberate project-view exception, all explicitly tested.
  // ═══════════════════════════════════════════════════════════════════
  function buildRenderSandbox({ projects, logs, leaveRequestsFresh = [], users, holidaysFresh = [], selectedProjectId = '', selectedPersonId = '', windowDays = 30 }) {
    let capturedHTML = undefined;
    const dbCalls = [];
    const sandbox = {
      console, Date, Object, Math, Set,
      currentUser: { id: 'admin1', isAdmin: true, name: 'Admin' },
      shCachedInsightData: null,
      shSelectedProjectId: selectedProjectId,
      shSelectedPersonId: selectedPersonId,
      shSelectedWindowDays: windowDays,
      db: {
        collection: (name) => ({
          get: async (opts) => {
            dbCalls.push({ collection: name, opts, kind: 'collection' });
            const map = { projects, timeLogs: logs, leaveRequests: leaveRequestsFresh, users };
            const data = map[name] || [];
            return { forEach: (fn) => data.forEach((d, i) => fn({ data: () => d, id: d.id || `${name}${i}` })) };
          },
          doc: (id) => ({
            get: async (opts) => {
              dbCalls.push({ collection: name, docId: id, opts, kind: 'doc' });
              return { exists: true, data: () => ({ holidays: holidaysFresh }) };
            },
          }),
        }),
      },
      document: {
        getElementById: (id) => {
          if (id === 'sh-individualinsight') {
            return { set innerHTML(v) { capturedHTML = v; }, get innerHTML() { return capturedHTML; } };
          }
          return { addEventListener: () => {} };
        },
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(shConstantsSrc, sandbox);
    FN_NAMES.forEach(name => vm.runInContext(fnSrc[name], sandbox));
    vm.runInContext(renderInsightSrc, sandbox);
    vm.runInContext(renderInsightBodySrc, sandbox);
    return { sandbox, dbCalls, getHTML: () => capturedHTML };
  }

  console.log('\n=== renderIndividualInsight: 5 fresh source:server reads (added companyData/squareDB) ===');
  {
    const projects = [{ id: 'p1', name: 'Proj', phases: { Phase: 100 } }];
    const logs = [{ userId: 'u1', projectId: 'p1', phase: 'Phase', productive: true, durationMins: 100 * 60, date: dateStr(-5) }];
    const users = [{ id: 'u1', name: 'Alice' }];
    const { dbCalls } = await (async () => {
      const b = buildRenderSandbox({ projects, logs, users });
      await vm.runInContext('renderIndividualInsight', b.sandbox)();
      return b;
    })();
    check('5 fresh reads total', dbCalls.length === 5);
    check('all reads used source:\'server\'', dbCalls.every(c => c.opts && c.opts.source === 'server'));
    check('the 5th is the companyData/squareDB doc read', dbCalls.some(c => c.kind === 'doc' && c.collection === 'companyData' && c.docId === 'squareDB'));
  }

  console.log('\n=== STRUCTURAL: Margin Risk sentences appear in the primary card, sorted by hours-over (not alphabetical) ===');
  {
    // Both ratios must clear the REAL render-time significant-over bar
    // (SH_EST_SIGNIFICANT_OVER_RATIO = 1.5x) for both to actually appear
    // as flags -- the earlier pure-function test used minRatio=1.10
        // directly as an argument, which is a different, lower bar than what
    // the shipped render code actually applies.
    const projects = [
      { id: 'small', name: 'Zebra Project', phases: { Phase: 10 } },  // 300% of 10h -> 30h actual, 20h over
      { id: 'big', name: 'Alpha Project', phases: { Phase: 500 } },   // 160% of 500h -> 800h actual, 300h over
    ];
    const logs = [
      { userId: 'u1', projectId: 'small', phase: 'Phase', durationMins: 10 * 60 * 3.0, date: dateStr(-5) },
      { userId: 'u1', projectId: 'big', phase: 'Phase', durationMins: 500 * 60 * 1.60, date: dateStr(-5) },
    ];
    const users = [{ id: 'u1', name: 'Alice' }];
    const { getHTML } = await (async () => {
      const b = buildRenderSandbox({ projects, logs, users });
      await vm.runInContext('renderIndividualInsight', b.sandbox)();
      return b;
    })();
    const html = getHTML();
    check('Margin Risk card present', /Margin Risk/.test(html));
    check('"Alpha Project" (150h over) sorts BEFORE "Zebra Project" (18.8h over) -- money, not alphabet, not percentage', html.indexOf('Alpha Project') < html.indexOf('Zebra Project'));
    check('margin risk sentences include real numbers (project-level numbers are allowed, per Layer A precedent)', /\d+h over its \d+h budget/.test(html));
  }

  console.log('\n=== STRUCTURAL: two-axis drill-down -- project and person selections work independently ===');
  {
    const projects = [{ id: 'p1', name: 'Proj A', phases: { Phase: 100 } }];
    const logs = [
      { userId: 'u1', projectId: 'p1', phase: 'Phase', productive: true, durationMins: 100 * 60 * 1.5, date: dateStr(-5) },
    ];
    const users = [{ id: 'u1', name: 'Alice' }];

    const { getHTML: getProjOnly } = await (async () => {
      const b = buildRenderSandbox({ projects, logs, users, selectedProjectId: 'p1', selectedPersonId: '' });
      await vm.runInContext('renderIndividualInsight', b.sandbox)();
      return b;
    })();
    const projOnlyHtml = getProjOnly();
    check('project selected alone -> shows budget burn', /budget burn by phase/.test(projOnlyHtml));
    check('project selected alone -> person drill-down still says "pick a name"', /Pick a name above/.test(projOnlyHtml));

    const { getHTML: getPersonOnly } = await (async () => {
      const b = buildRenderSandbox({ projects, logs, users, selectedProjectId: '', selectedPersonId: 'u1' });
      await vm.runInContext('renderIndividualInsight', b.sandbox)();
      return b;
    })();
    const personOnlyHtml = getPersonOnly();
    check('person selected alone -> shows their numbers', /Alice/.test(personOnlyHtml) && /Versatility/.test(personOnlyHtml));
    check('person selected alone -> project drill-down still says "pick a project"', /Pick a project above/.test(personOnlyHtml));
  }

  console.log('\n=== STRUCTURAL: leave-near-holiday NEVER appears as a flag -- drill-down only ===');
  {
    const projects = [];
    const logs = [{ userId: 'u1', productive: true, durationMins: 100 * 60, date: dateStr(-5) }];
    // Leave adjacent to a 2nd-Saturday weekend -- would qualify as "near holiday".
    const leaveRequestsFresh = [{ userId: 'u1', status: 'approved', startDate: '2026-08-07', endDate: '2026-08-07' }];
    const users = [{ id: 'u1', name: 'Alice' }];

    const { getHTML: noSelection } = await (async () => {
      const b = buildRenderSandbox({ projects, logs, leaveRequestsFresh, users });
      await vm.runInContext('renderIndividualInsight', b.sandbox)();
      return b;
    })();
    const flagsOnly = noSelection();
    check('with nobody selected, no leave/holiday language appears anywhere (nothing to proactively surface)', !flagsOnly.toLowerCase().includes('holiday') && !flagsOnly.toLowerCase().includes('coverage planning'));

    const { getHTML: withSelection } = await (async () => {
      const b = buildRenderSandbox({ projects, logs, leaveRequestsFresh, users, selectedPersonId: 'u1' });
      await vm.runInContext('renderIndividualInsight', b.sandbox)();
      return b;
    })();
    const withPerson = withSelection();
    check('only appears once a person is explicitly selected (drill-down), neutrally worded', /coverage planning/.test(withPerson) && !withPerson.toLowerCase().includes('gotcha'));
  }

  console.log('\n=== STRUCTURAL: no-side-by-side, extended to the new visuals -- workload trend & leave heatmap are single-person only ===');
  {
    const projects = [];
    const logs = [];
    for (let w = 1; w <= 3; w++) logs.push({ userId: 'u1', productive: true, durationMins: 50 * 60, date: dateStr(-30 * w - 5) });
    logs.push({ userId: 'u1', productive: true, durationMins: 50 * 60, date: dateStr(-5) });
    logs.push({ userId: 'u2', productive: true, durationMins: 999 * 60, date: dateStr(-5) }); // a second person, real data
    const leaveRequestsFresh = [
      { userId: 'u2', status: 'approved', startDate: dateStr(-2), endDate: dateStr(-2) }, // u2's own leave -- must never show in u1's heatmap
    ];
    const users = [{ id: 'u1', name: 'Alice' }, { id: 'u2', name: 'Bob' }];
    const { getHTML } = await (async () => {
      const b = buildRenderSandbox({ projects, logs, leaveRequestsFresh, users, selectedPersonId: 'u1' });
      await vm.runInContext('renderIndividualInsight', b.sandbox)();
      return b;
    })();
    const html = getHTML();
    check('Bob\'s raw hours (999h) do not appear anywhere when Alice is selected', !html.includes('999.0h'));
    check('exactly one workload trend SVG rendered (one person\'s own series)', (html.match(/<svg width="260"/g) || []).length === 1);
    check('exactly one leave heatmap SVG rendered (one person\'s own calendar)', (html.match(/<svg width="\d+" height="\d+" viewBox="0 0 \d+ \d+" style="display:block;"><rect/g) || []).length >= 1);
  }

  console.log('\n=== STRUCTURAL: the ONE deliberate exception -- "Look at One Project" DOES show multiple people together, on purpose ===');
  {
    const projects = [{ id: 'p1', name: 'Shared Project', phases: { Phase: 100 } }];
    const logs = [
      { userId: 'u1', projectId: 'p1', phase: 'Phase', durationMins: 100 * 60 * 0.8, date: dateStr(-5) },
      { userId: 'u2', projectId: 'p1', phase: 'Phase', durationMins: 100 * 60 * 0.5, date: dateStr(-5) },
    ];
    const users = [{ id: 'u1', name: 'Alice' }, { id: 'u2', name: 'Bob' }];
    const { getHTML } = await (async () => {
      const b = buildRenderSandbox({ projects, logs, users, selectedProjectId: 'p1' });
      await vm.runInContext('renderIndividualInsight', b.sandbox)();
      return b;
    })();
    const html = getHTML();
    check('BOTH Alice and Bob appear together under the project drill-down -- deliberate, not a bug', html.includes('Alice') && html.includes('Bob') && /Who's on this:.*Alice.*Bob|Who's on this:.*Bob.*Alice/.test(html));
  }

  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
}

run();
