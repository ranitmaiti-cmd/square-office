// Fixture for V29: "Wins This Quarter" Dashboard recognition card, built
// on top of the stage-completion/at-risk machinery (V27/V28, see
// test/feat-project-stage-status.test.js and
// test/feat-stage-status-layout-flag-undo.test.js).
//
// NOTE: this feature originally shipped alongside a "What's Due" card and
// a project.dueDate field. That half was descoped before merge -- project
// due dates at Square are per-submission and shift, so a single
// project.dueDate field was the wrong shape; What's Due needs a rethink as
// submission-based tracking, tracked as separate future work (see
// FINDINGS-2026-08-10.md). This fixture (renamed from
// feat-dashboard-duedate-recognition.test.js) covers only what shipped:
// Recognition, plus the computeProjectStats() helper it shares with
// Projects & Budget.
//
// Central claims under test:
//  - computeProjectStats(proj): the SAME pct/status/atRiskCount/
//    allPhasesConfirmed computation renderProjectsBudget() has always done
//    per project card, now behind one shared pure function so Recognition
//    and Projects & Budget can never drift apart on "is this on track"
//  - renderProjectsBudget() itself calls computeProjectStats() rather than
//    recomputing the same math inline
//  - computeQuarterWins(): PROJECT-level facts only -- no person names, no
//    ranking/ordering by performance, capped to 4, "this quarter" scoped
//    by endDate falling in the current FY quarter
//  - the Wins This Quarter card's markup exists in the Dashboard page,
//    renderDashboard() actually calls renderQuarterWins(), and it's placed
//    after the operational cards
//  - dueDate/What's Due are fully gone: no orphaned references anywhere in
//    the file, Edit Project form is back to just Start/End Date
//
// Run with: node test/feat-dashboard-recognition.test.js
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

function makeFakeDom(ids) {
  const store = {};
  ids.forEach((id) => { store[id] = { style: {}, textContent: '', innerHTML: '' }; });
  return { document: { getElementById: (id) => store[id] || null }, store };
}

(async () => {
  const computeStatsSrc = extractFunction(fullScript, 'computeProjectStats');
  const atRiskSrc = extractFunction(fullScript, 'isPhaseAtRisk');
  const computeWinsSrc = extractFunction(fullScript, 'computeQuarterWins');
  const renderWinsSrc = extractFunction(fullScript, 'renderQuarterWins');
  const getQuarterSrc = extractFunction(fullScript, 'getQuarter');
  const quarterEndDateSrc = extractFunction(fullScript, 'quarterEndDate');
  const fmtSrc = extractFunction(fullScript, 'fmt');

  // ─────────────────────────────────────────────────────────────
  console.log('=== computeProjectStats(): the shared pct/status/atRiskCount/allPhasesConfirmed helper ===');
  function makeStatsSandbox(PHASES, phaseLoggedMinsAllTime, projectLoggedMinsAllTime) {
    const sandbox = { console, Math, Object };
    vm.createContext(sandbox);
    vm.runInContext(atRiskSrc, sandbox);
    vm.runInContext(computeStatsSrc, sandbox);
    sandbox.PHASES = PHASES;
    sandbox.phaseLoggedMinsAllTime = phaseLoggedMinsAllTime;
    sandbox.projectLoggedMinsAllTime = projectLoggedMinsAllTime;
    return sandbox;
  }
  {
    const PHASES = ['Schematic Design', 'Final Design', 'Construction Documents'];
    const proj = {
      phases: { 'Schematic Design': 40, 'Final Design': 40, 'Construction Documents': 40 },
      phaseStatus: { 'Schematic Design': 'confirmed' },
    };
    // Schematic: 100% used, confirmed -> not at risk. Final: 90% used, no status -> AT RISK. Construction: 50% used, no status -> not at risk.
    function phaseLoggedMinsAllTime(pid, ph) {
      if (ph === 'Schematic Design') return 40 * 60;
      if (ph === 'Final Design') return 36 * 60;
      if (ph === 'Construction Documents') return 20 * 60;
      return 0;
    }
    function projectLoggedMinsAllTime() { return (40 + 36 + 20) * 60; }
    const sandbox = makeStatsSandbox(PHASES, phaseLoggedMinsAllTime, projectLoggedMinsAllTime);
    sandbox.proj = proj;
    const stats = vm.runInContext('computeProjectStats(proj)', sandbox);
    check('totalBudget sums all phase budgets', stats.totalBudget === 120);
    check('pct is the overall logged/budget ratio, rounded', stats.pct === Math.round((96 / 120) * 100));
    check('status reflects the 80/100 thresholds ("near" at 80%)', stats.status === 'near');
    check('atRiskCount counts exactly the one at-risk phase (Final Design)', stats.atRiskCount === 1);
    check('phaseCount counts all budgeted phases', stats.phaseCount === 3);
    check('confirmedCount counts only confirmed phases', stats.confirmedCount === 1);
    check('allPhasesConfirmed is false when not every phase is confirmed', stats.allPhasesConfirmed === false);
  }
  {
    // Every phase confirmed and zero at-risk -> allPhasesConfirmed true.
    const PHASES = ['Design'];
    const proj = { phases: { Design: 40 }, phaseStatus: { Design: 'confirmed' } };
    function phaseLoggedMinsAllTime() { return 40 * 60; }
    function projectLoggedMinsAllTime() { return 40 * 60; }
    const sandbox = makeStatsSandbox(PHASES, phaseLoggedMinsAllTime, projectLoggedMinsAllTime);
    sandbox.proj = proj;
    const stats = vm.runInContext('computeProjectStats(proj)', sandbox);
    check('allPhasesConfirmed is true when every budgeted phase is confirmed', stats.allPhasesConfirmed === true);
    check('atRiskCount is 0 for a fully-confirmed phase regardless of hours used', stats.atRiskCount === 0);
  }

  console.log('\n--- renderProjectsBudget() calls computeProjectStats() rather than recomputing the math inline ---');
  const renderPBSrc = extractFunction(fullScript, 'renderProjectsBudget');
  check('renderProjectsBudget() destructures from computeProjectStats(proj)', /computeProjectStats\(proj\)/.test(renderPBSrc));
  check('renderProjectsBudget() no longer computes atRiskCount with its own inline loop', !/let atRiskCount = 0;/.test(renderPBSrc));

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== computeQuarterWins(): PROJECT-level facts only, never a ranking ===');
  function makeWinsSandbox(projectsData, phaseLoggedMinsAllTime, projectLoggedMinsAllTime, PHASES) {
    const sandbox = { console, Math, Object, Date };
    vm.createContext(sandbox);
    vm.runInContext(atRiskSrc, sandbox);
    vm.runInContext(computeStatsSrc, sandbox);
    vm.runInContext(fmtSrc, sandbox);
    vm.runInContext(getQuarterSrc, sandbox);
    vm.runInContext(quarterEndDateSrc, sandbox);
    vm.runInContext(computeWinsSrc, sandbox);
    sandbox.projectsData = projectsData;
    sandbox.PHASES = PHASES;
    sandbox.phaseLoggedMinsAllTime = phaseLoggedMinsAllTime;
    sandbox.projectLoggedMinsAllTime = projectLoggedMinsAllTime;
    return sandbox;
  }
  {
    // Build an endDate guaranteed inside the CURRENT quarter by asking the
    // real getQuarter()/quarterEndDate() what "today" resolves to, so this
    // fixture never goes stale as the calendar moves on.
    const probeSandbox = { console };
    vm.createContext(probeSandbox);
    vm.runInContext(fmtSrc, probeSandbox);
    vm.runInContext(getQuarterSrc, probeSandbox);
    vm.runInContext(quarterEndDateSrc, probeSandbox);
    const qEndStr = vm.runInContext('fmt(quarterEndDate(getQuarter(0)))', probeSandbox);

    const PHASES = ['Design'];
    const projectsData = [
      { id: 'clean1', name: 'CLEAN_PROJ', endDate: qEndStr, phases: { Design: 40 }, phaseStatus: { Design: 'confirmed' } },
      { id: 'underbudget1', name: 'UNDER_BUDGET_PROJ', endDate: qEndStr, phases: { Design: 40 }, phaseStatus: {} },
      { id: 'overbudget1', name: 'OVER_BUDGET_PROJ', endDate: qEndStr, phases: { Design: 40 }, phaseStatus: {} },
      { id: 'ongoing1', name: 'ONGOING_PROJ', endDate: null, phases: { Design: 40 }, phaseStatus: { Design: 'confirmed' } },
      { id: 'oldqtr1', name: 'LAST_QUARTER_PROJ', endDate: '2020-01-01', phases: { Design: 40 }, phaseStatus: { Design: 'confirmed' } },
    ];
    const loggedByProj = { clean1: 40, underbudget1: 20, overbudget1: 45, ongoing1: 40, oldqtr1: 40 };
    function phaseLoggedMinsAllTime(pid) { return (loggedByProj[pid] || 0) * 60; }
    function projectLoggedMinsAllTime(pid) { return (loggedByProj[pid] || 0) * 60; }

    const sandbox = makeWinsSandbox(projectsData, phaseLoggedMinsAllTime, projectLoggedMinsAllTime, PHASES);
    const wins = vm.runInContext('computeQuarterWins()', sandbox);

    check('clean project surfaced', wins.some((w) => w.includes('CLEAN_PROJ')));
    check('under-budget project surfaced', wins.some((w) => w.includes('UNDER_BUDGET_PROJ')));
    check('over-budget project NOT surfaced as a win', !wins.some((w) => w.includes('OVER_BUDGET_PROJ')));
    check('ongoing project (no endDate) excluded even though fully confirmed', !wins.some((w) => w.includes('ONGOING_PROJ')));
    check('a project completed in a PRIOR quarter is excluded ("this quarter" is real, not just "ever")', !wins.some((w) => w.includes('LAST_QUARTER_PROJ')));
    check('the clean-count summary fact is present', wins.some((w) => /^\d+ projects? completed clean this quarter$/.test(w)));

    console.log('\n--- No person-level data anywhere in the facts ---');
    const allUserNames = ['Admin User', 'Rajesh Kumar', 'Priya Sharma', 'Amit Patel', 'Sonia Verma'];
    check('no user/person name appears in any win fact', !wins.some((w) => allUserNames.some((name) => w.includes(name))));
    check('no fact mentions readyBy/confirmedBy or any person-attribution field', !wins.some((w) => /readyBy|confirmedBy|mentor/i.test(w)));

    console.log('\n--- No ranking / comparison between projects ---');
    check('facts are plain statements, never comparative ("better than", "vs", "#1", "top")', !wins.some((w) => /\b(better|worse|vs\.?|top|#1|rank|fastest|slowest)\b/i.test(w)));
  }
  {
    // Capping: build far more qualifying wins than the cap and confirm the
    // list never exceeds 4.
    const probeSandbox = { console };
    vm.createContext(probeSandbox);
    vm.runInContext(fmtSrc, probeSandbox);
    vm.runInContext(getQuarterSrc, probeSandbox);
    vm.runInContext(quarterEndDateSrc, probeSandbox);
    const qEndStr = vm.runInContext('fmt(quarterEndDate(getQuarter(0)))', probeSandbox);

    const PHASES = ['Design'];
    const projectsData = [];
    const loggedByProj = {};
    for (let i = 0; i < 10; i++) {
      const id = 'clean' + i;
      projectsData.push({ id, name: 'CLEAN_' + i, endDate: qEndStr, phases: { Design: 40 }, phaseStatus: { Design: 'confirmed' } });
      loggedByProj[id] = 40;
    }
    function phaseLoggedMinsAllTime(pid) { return (loggedByProj[pid] || 0) * 60; }
    function projectLoggedMinsAllTime(pid) { return (loggedByProj[pid] || 0) * 60; }
    const sandbox = makeWinsSandbox(projectsData, phaseLoggedMinsAllTime, projectLoggedMinsAllTime, PHASES);
    const wins = vm.runInContext('computeQuarterWins()', sandbox);
    check('capped to at most 4 facts even with 10 qualifying projects', wins.length <= 4);
  }

  console.log('\n--- renderQuarterWins(): renders capped facts, empty state when none ---');
  {
    const { document, store } = makeFakeDom(['quarterWinsCard', 'quarterWinsFeed']);
    const sandbox = makeWinsSandbox([], () => 0, () => 0, ['Design']);
    sandbox.document = document;
    vm.runInContext(renderWinsSrc, sandbox);
    vm.runInContext('renderQuarterWins()', sandbox);
    check('card shown even with zero wins (quiet empty state, not hidden)', store.quarterWinsCard.style.display === 'block');
    check('empty state text present', store.quarterWinsFeed.innerHTML.includes('Nothing to show yet'));
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== Wins This Quarter card exists in the Dashboard page and is actually rendered ===');
  check('#quarterWinsCard markup exists in the Dashboard page', rawSrc.includes('id="quarterWinsCard"'));
  const renderDashboardSrc = extractFunction(fullScript, 'renderDashboard');
  check('renderDashboard() calls renderQuarterWins()', /renderQuarterWins\(\)/.test(renderDashboardSrc));
  {
    // Placement: quarterWinsCard markup must appear AFTER the operational
    // cards (Who's Working Now / Needs Reconciliation / Recent Time Logs)
    // in the page source -- celebratory, not action-needed, per the brief.
    const liveTimerIdx = rawSrc.indexOf('Who\'s Working Now');
    const recentLogsIdx = rawSrc.indexOf('Recent Time Logs');
    const winsIdx = rawSrc.indexOf('id="quarterWinsCard"');
    check('quarterWinsCard appears after the operational cards in the page', winsIdx > liveTimerIdx && winsIdx > recentLogsIdx);
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== dueDate / What\'s Due fully removed -- no orphaned references ===');
  check('no #whatsDueCard markup anywhere', !rawSrc.includes('whatsDueCard'));
  check('no #whatsDueFeed markup anywhere', !rawSrc.includes('whatsDueFeed'));
  check('no #pDueDate input anywhere', !rawSrc.includes('pDueDate'));
  check('no "dueDate" field/reference left in the live code (comment mentioning the descoping in the version banner is fine, actual field/DOM refs are not)', !/\bdueDate\b/.test(fullScript.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')));
  check('no computeWhatsDue()/renderWhatsDue()/daysUntil()/WHATS_DUE_SOON_DAYS left anywhere', !/computeWhatsDue|renderWhatsDue|function daysUntil|WHATS_DUE_SOON_DAYS/.test(fullScript));
  check('Edit Project form has exactly two date inputs (Start/End), not three', (rawSrc.match(/id="pStart"|id="pEnd"|id="pDueDate"/g) || []).length === 2);

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== Isolation: unrelated systems byte-for-byte unchanged from main ===');
  check('saveProject() is byte-for-byte unchanged', extractFunction(fullScript, 'saveProject') === extractFunction(mainFullScript, 'saveProject'));
  check('saveProjectPhaseStatus() is byte-for-byte unchanged', extractFunction(fullScript, 'saveProjectPhaseStatus') === extractFunction(mainFullScript, 'saveProjectPhaseStatus'));
  check('saveTimeLog() is byte-for-byte unchanged', extractFunction(fullScript, 'saveTimeLog') === extractFunction(mainFullScript, 'saveTimeLog'));
  check('renderLeaves() is byte-for-byte unchanged', extractFunction(fullScript, 'renderLeaves') === extractFunction(mainFullScript, 'renderLeaves'));

  console.log('\n=== the inline <script> still parses ===');
  check('new Function(fullScript) does not throw', (() => {
    try { new Function(fullScript); return true; }
    catch (e) { console.log('    parse error:', e.message); return false; }
  })());

  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
})();
