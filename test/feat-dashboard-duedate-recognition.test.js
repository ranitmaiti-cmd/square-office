// Fixture for V29: two Dashboard cards -- "What's Due" and "Wins This
// Quarter" -- built on top of the stage-completion/at-risk machinery
// (V27/V28, see test/feat-project-stage-status.test.js and
// test/feat-stage-status-layout-flag-undo.test.js).
//
// Central claims under test:
//  - dueDate is a plain field on the Edit Project form's SAME save path as
//    startDate/endDate -- no separate write, no collision-fix needed, and
//    editing an existing project's dueDate never clobbers its phaseStatus
//  - openProjectModal() populates the due-date input when editing
//  - computeWhatsDue(): sorts by days-until-due, pairs each project with
//    the SAME pct/status/atRiskCount computeProjectStats() gives every
//    other view, excludes projects with no dueDate and fully-confirmed
//    projects, and only includes overdue/due-within-14-days
//  - renderWhatsDue(): overdue and due-soon-with-at-risk rows are visually
//    highlighted, a due-soon row with nothing at risk is not
//  - computeQuarterWins(): PROJECT-level facts only -- no person names, no
//    ranking/ordering by performance, capped to 4, "this quarter" scoped
//    by endDate falling in the current FY quarter
//  - both cards' markup exists in the Dashboard page and renderDashboard()
//    actually calls both render functions
//
// Run with: node test/feat-dashboard-duedate-recognition.test.js
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

function makeFakeDom(ids) {
  const store = {};
  ids.forEach((id) => { store[id] = { style: {}, textContent: '', innerHTML: '' }; });
  return { document: { getElementById: (id) => store[id] || null }, store };
}

(async () => {
  const computeStatsSrc = extractFunction(fullScript, 'computeProjectStats');
  const atRiskSrc = extractFunction(fullScript, 'isPhaseAtRisk');
  const daysUntilSrc = extractFunction(fullScript, 'daysUntil');
  const computeWhatsDueSrc = extractFunction(fullScript, 'computeWhatsDue');
  const renderWhatsDueSrc = extractFunction(fullScript, 'renderWhatsDue');
  const computeWinsSrc = extractFunction(fullScript, 'computeQuarterWins');
  const renderWinsSrc = extractFunction(fullScript, 'renderQuarterWins');
  const getQuarterSrc = extractFunction(fullScript, 'getQuarter');
  const quarterEndDateSrc = extractFunction(fullScript, 'quarterEndDate');
  const fmtSrc = extractFunction(fullScript, 'fmt');
  const dueSoonConstMatch = fullScript.match(/const WHATS_DUE_SOON_DAYS = \d+;/);
  assert.ok(dueSoonConstMatch, 'could not find WHATS_DUE_SOON_DAYS constant');

  // ─────────────────────────────────────────────────────────────
  console.log('=== dueDate: plain field on the Edit Project form, same save path as startDate/endDate ===');
  const saveProjBtnSrc = extractBlockFrom(fullScript, "getElementById('saveProjBtn').addEventListener('click'");
  check('the save handler reads pDueDate from the form', saveProjBtnSrc.includes("getElementById('pDueDate')"));
  check('dueDate is a plain key in the rebuilt data object, not carried from existingProj (unlike phaseStatus)', /dueDate:document\.getElementById\('pDueDate'\)\.value\|\|null/.test(saveProjBtnSrc));
  {
    const EXISTING_STATUS = { 'Schematic Design': 'confirmed' };
    const EXISTING_META = { 'Schematic Design': { confirmedBy: 'PM Priya', confirmedAt: '2026-08-01T00:00:00.000Z' } };
    const formValues = {
      pName: 'Renamed Project', pClientSelect: 'Acme', pStart: '2026-01-01', pEnd: '2026-12-31', pDueDate: '2026-10-15',
      phase_Schematic_Design: '50', phase_Final_Design: '0', phase_Construction_Documents: '0',
      'phase_Material_Selection_&_Coordination': '0', phase_Site_Supervision: '0', phase_Project_Management: '0',
    };
    let savedData = null;
    const elements = { getElementById: (id) => ({ value: formValues[id] !== undefined ? formValues[id] : '0', textContent: '' }) };
    const sandbox = {
      console, parseInt,
      document: elements,
      PHASES: ['Schematic Design', 'Final Design', 'Construction Documents', 'Material Selection & Coordination', 'Site Supervision', 'Project Management'],
      clients: ['Acme'],
      projectsData: [{ id: 'proj-1', name: 'Original Name', client: 'Acme', startDate: '2026-01-01', endDate: '2026-12-31', dueDate: null, phases: { 'Schematic Design': 40 }, phaseStatus: EXISTING_STATUS, phaseStatusMeta: EXISTING_META }],
      genId: () => 'new-id',
      skipNextConflictCheck: false,
      saveProject: async (data) => { savedData = data; },
      autoSave: () => {},
      closeModal: () => {},
      renderProjectsBudget: () => {},
      alert: () => {},
      this: { _editId: 'proj-1' },
    };
    vm.createContext(sandbox);
    const fn = `(async function(){ ${saveProjBtnSrc.slice(saveProjBtnSrc.indexOf('{') + 1, saveProjBtnSrc.lastIndexOf('}'))} }).call({ _editId: 'proj-1' })`;
    await vm.runInContext(fn, sandbox);
    check('saveProject() was called', savedData !== null);
    check('the new dueDate is saved', savedData.dueDate === '2026-10-15');
    check('phaseStatus/phaseStatusMeta are STILL carried forward unclobbered (dueDate is additive, not a replacement mechanism)', JSON.stringify(savedData.phaseStatus) === JSON.stringify(EXISTING_STATUS) && JSON.stringify(savedData.phaseStatusMeta) === JSON.stringify(EXISTING_META));
  }
  {
    // Leaving the due-date field blank saves null, not an empty string or crash.
    const formValues = { pName: 'X', pClientSelect: 'Acme', pStart: '2026-01-01', pEnd: '2026-12-31', pDueDate: '', phase_Schematic_Design: '10', phase_Final_Design: '0', phase_Construction_Documents: '0', 'phase_Material_Selection_&_Coordination': '0', phase_Site_Supervision: '0', phase_Project_Management: '0' };
    let savedData = null;
    const sandbox = {
      console, parseInt,
      document: { getElementById: (id) => ({ value: formValues[id] !== undefined ? formValues[id] : '0' }) },
      PHASES: ['Schematic Design', 'Final Design', 'Construction Documents', 'Material Selection & Coordination', 'Site Supervision', 'Project Management'],
      clients: ['Acme'],
      projectsData: [],
      genId: () => 'new-id',
      skipNextConflictCheck: false,
      saveProject: async (data) => { savedData = data; },
      autoSave: () => {}, closeModal: () => {}, renderProjectsBudget: () => {}, alert: () => {},
    };
    vm.createContext(sandbox);
    const fn = `(async function(){ ${saveProjBtnSrc.slice(saveProjBtnSrc.indexOf('{') + 1, saveProjBtnSrc.lastIndexOf('}'))} }).call({ _editId: null })`;
    await vm.runInContext(fn, sandbox);
    check('a blank due-date field saves null, not "" or undefined', savedData.dueDate === null);
  }
  console.log('\n--- openProjectModal() populates the due-date input when editing ---');
  const openProjectModalSrc = extractFunction(fullScript, 'openProjectModal');
  check("openProjectModal() sets pDueDate.value from proj.dueDate", /getElementById\('pDueDate'\)\.value=proj\?\.dueDate\|\|''/.test(openProjectModalSrc));

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== computeWhatsDue(): sort + pair with on-track signals ===');
  function makeWhatsDueSandbox(projectsData, phaseLoggedMinsAllTime, projectLoggedMinsAllTime, PHASES) {
    const sandbox = { console, Math, Object };
    vm.createContext(sandbox);
    vm.runInContext(atRiskSrc, sandbox);
    vm.runInContext(computeStatsSrc, sandbox);
    vm.runInContext(daysUntilSrc, sandbox);
    vm.runInContext(dueSoonConstMatch[0], sandbox);
    vm.runInContext(computeWhatsDueSrc, sandbox);
    sandbox.projectsData = projectsData;
    sandbox.PHASES = PHASES;
    sandbox.phaseLoggedMinsAllTime = phaseLoggedMinsAllTime;
    sandbox.projectLoggedMinsAllTime = projectLoggedMinsAllTime;
    return sandbox;
  }
  {
    // Today is treated as "now" -- build due dates relative to it so the
    // fixture never goes stale.
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const plusDays = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
    const PHASES = ['Design'];
    const projectsData = [
      { id: 'overdue1', name: 'OVERDUE_PROJ', dueDate: plusDays(-3), phases: { Design: 40 }, phaseStatus: {} },
      { id: 'soon-risk', name: 'SOON_AT_RISK', dueDate: plusDays(5), phases: { Design: 40 }, phaseStatus: {} },
      { id: 'soon-ok', name: 'SOON_ON_TRACK', dueDate: plusDays(10), phases: { Design: 40 }, phaseStatus: {} },
      { id: 'far', name: 'FAR_OUT', dueDate: plusDays(30), phases: { Design: 40 }, phaseStatus: {} },
      { id: 'none', name: 'NO_DUE_DATE', dueDate: null, phases: { Design: 40 }, phaseStatus: {} },
      { id: 'done', name: 'ALL_CONFIRMED_OVERDUE', dueDate: plusDays(-10), phases: { Design: 40 }, phaseStatus: { Design: 'confirmed' } },
    ];
    // 90% used for at-risk cases, 50% for the on-track one, 100%+confirmed for the done one.
    const loggedByProj = { overdue1: 36, 'soon-risk': 36, 'soon-ok': 20, far: 20, none: 40, done: 40 };
    function phaseLoggedMinsAllTime(pid) { return (loggedByProj[pid] || 0) * 60; }
    function projectLoggedMinsAllTime(pid) { return (loggedByProj[pid] || 0) * 60; }

    const sandbox = makeWhatsDueSandbox(projectsData, phaseLoggedMinsAllTime, projectLoggedMinsAllTime, PHASES);
    const items = vm.runInContext('computeWhatsDue()', sandbox);
    const names = items.map((x) => x.proj.name);
    check('overdue project included', names.includes('OVERDUE_PROJ'));
    check('due-soon-at-risk project included', names.includes('SOON_AT_RISK'));
    check('due-soon-on-track project included (still within 14 days)', names.includes('SOON_ON_TRACK'));
    check('project due >14 days out is EXCLUDED', !names.includes('FAR_OUT'));
    check('project with no dueDate is EXCLUDED', !names.includes('NO_DUE_DATE'));
    check('a fully-confirmed project is EXCLUDED even though overdue (nothing left to catch up on)', !names.includes('ALL_CONFIRMED_OVERDUE'));
    check('sorted most-overdue/soonest first', names[0] === 'OVERDUE_PROJ' && names[1] === 'SOON_AT_RISK' && names[2] === 'SOON_ON_TRACK');
    const soonAtRisk = items.find((x) => x.proj.name === 'SOON_AT_RISK');
    check('each item pairs the due date with the SAME computeProjectStats() numbers (pct/atRiskCount)', soonAtRisk.stats.pct === 90 && soonAtRisk.stats.atRiskCount === 1);
  }

  console.log('\n--- renderWhatsDue(): overdue and due-soon-with-at-risk are highlighted, plain due-soon is not ---');
  {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const plusDays = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
    const PHASES = ['Design'];
    const projectsData = [
      { id: 'p-overdue', name: 'OVERDUE_X', dueDate: plusDays(-2), phases: { Design: 40 }, phaseStatus: {} },
      { id: 'p-risk', name: 'RISK_X', dueDate: plusDays(3), phases: { Design: 40 }, phaseStatus: {} },
      { id: 'p-clean', name: 'CLEAN_X', dueDate: plusDays(3), phases: { Design: 40 }, phaseStatus: {} },
    ];
    const loggedByProj = { 'p-overdue': 20, 'p-risk': 36, 'p-clean': 10 }; // clean: 25% used, not at risk
    function phaseLoggedMinsAllTime(pid) { return (loggedByProj[pid] || 0) * 60; }
    function projectLoggedMinsAllTime(pid) { return (loggedByProj[pid] || 0) * 60; }

    const { document, store } = makeFakeDom(['whatsDueCard', 'whatsDueFeed', 'whatsDueCount']);
    const sandbox = makeWhatsDueSandbox(projectsData, phaseLoggedMinsAllTime, projectLoggedMinsAllTime, PHASES);
    sandbox.document = document;
    vm.runInContext(renderWhatsDueSrc, sandbox);
    vm.runInContext('renderWhatsDue()', sandbox);

    const html = store.whatsDueFeed.innerHTML;
    check('card is shown (display set)', store.whatsDueCard.style.display === 'block');
    check('count reflects 3 upcoming items', store.whatsDueCount.textContent === '3 upcoming');
    // The highlight background is a style attribute BEFORE the project name
    // in each row's markup -- extract the whole enclosing <div> per row
    // rather than a fixed-width slice after the name, or a highlight set
    // earlier in the div would be missed.
    function extractRow(marker) {
      const nameIdx = html.indexOf(marker);
      const rowStart = html.lastIndexOf('<div style="padding:8px 10px', nameIdx);
      const rowEnd = html.indexOf('</div>', nameIdx) + 6;
      return html.slice(rowStart, rowEnd);
    }
    const overdueRow = extractRow('OVERDUE_X');
    const riskRow = extractRow('RISK_X');
    const cleanRow = extractRow('CLEAN_X');
    check('overdue row is highlighted (red background)', overdueRow.includes('#FBF0EE'));
    check('due-soon-with-at-risk row is highlighted', riskRow.includes('#FBF0EE'));
    check('due-soon-with-nothing-at-risk row is NOT highlighted', !cleanRow.includes('#FBF0EE'));
    check('overdue row shows "overdue" language', overdueRow.includes('overdue'));
  }

  console.log('\n--- renderWhatsDue(): empty state when nothing is due soon ---');
  {
    const { document, store } = makeFakeDom(['whatsDueCard', 'whatsDueFeed', 'whatsDueCount']);
    const sandbox = makeWhatsDueSandbox([], () => 0, () => 0, ['Design']);
    sandbox.document = document;
    vm.runInContext(renderWhatsDueSrc, sandbox);
    vm.runInContext('renderWhatsDue()', sandbox);
    check('empty state text shown', store.whatsDueFeed.innerHTML.includes('Nothing due soon'));
    check('count reads 0 upcoming', store.whatsDueCount.textContent === '0 upcoming');
  }

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
    // Build an endDate that's guaranteed inside the CURRENT quarter by
    // asking the real getQuarter()/quarterEndDate() what "today" resolves
    // to, so this fixture never goes stale as the calendar moves on.
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
  console.log('\n=== Both cards exist in the Dashboard page and are actually rendered ===');
  check('#whatsDueCard markup exists in the Dashboard page', rawSrc.includes('id="whatsDueCard"'));
  check('#quarterWinsCard markup exists in the Dashboard page', rawSrc.includes('id="quarterWinsCard"'));
  const renderDashboardSrc = extractFunction(fullScript, 'renderDashboard');
  check('renderDashboard() calls renderWhatsDue()', /renderWhatsDue\(\)/.test(renderDashboardSrc));
  check('renderDashboard() calls renderQuarterWins()', /renderQuarterWins\(\)/.test(renderDashboardSrc));
  {
    // Placement: quarterWinsCard markup must appear AFTER the operational
    // cards (Who's Working Now / Needs Reconciliation / Recent Time Logs)
    // in the page source -- celebratory, not action-needed, per the brief.
    const liveTimerIdx = rawSrc.indexOf('Who\'s Working Now');
    const recentLogsIdx = rawSrc.indexOf('Recent Time Logs');
    const winsIdx = rawSrc.indexOf('id="quarterWinsCard"');
    const dueIdx = rawSrc.indexOf('id="whatsDueCard"');
    check('quarterWinsCard appears after the operational cards in the page', winsIdx > liveTimerIdx && winsIdx > recentLogsIdx);
    check('whatsDueCard appears before/among the operational cards, not after wins', dueIdx < winsIdx);
  }

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
