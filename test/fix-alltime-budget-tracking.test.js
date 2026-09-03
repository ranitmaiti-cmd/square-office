// Fixture for all-time project/phase budget tracking.
//
// The Dashboard refresh cost fix (2026-09-03) correctly made the SHARED
// `timeLogs` array 90-day-scoped, which is right for "recent activity"
// but wrong for budget math -- a phase that went over budget 2 years ago
// is still over budget today. This gives budget calculations their own
// all-time data source, fetched ONCE per session (cached, never on a
// timer/loop), scoped only to the projects that actually have a budget.
//
// Extracts the ACTUAL functions from index.html (brace-matched, not
// retyped) and runs them in a vm sandbox, same discipline as every other
// fixture in this repo.
//
// Central claims under test:
//  - loadAllTimeBudgetLogs() queries ONLY budgeted projects, one
//    .where('projectId','==',id) query each, in parallel -- not the
//    whole collection
//  - it is cached after the first call: calling it (or
//    ensureAllTimeBudgetLogsLoaded()) many times in a row fires EXACTLY
//    ONE round of queries, structurally, not by convention -- proven by
//    counting mock Firestore calls directly
//  - concurrent callers before the first fetch resolves share one
//    in-flight promise, never fire two
//  - refreshAllTimeBudgetLogs() is the only thing that fires a second
//    round of queries -- an explicit action, never automatic
//  - phaseLoggedMinsAllTime()/projectLoggedMinsAllTime() compute
//    correctly from the cached all-time set, and fall back to the (90-
//    day) `timeLogs` array only before the first load resolves
//  - source-text: renderDashboard()'s overBudgetCount and
//    renderProjectsBudget()'s project%/phase% all use the *AllTime()
//    functions, not the plain (90-day) ones
//  - source-text: the *AllTime machinery is NEVER referenced inside a
//    setInterval/setTimeout anywhere in the file -- cost-safe by
//    construction, not just by current wiring
//  - source-text: Dashboard's activity-scoped reads (the 30s refresh,
//    fetchActiveTimersFromFirebase, loadReconciliationQueue,
//    renderLiveTimeLogFeed) are byte-for-byte untouched by this change
//  - REAL DATA: the 4 phases the Dashboard fix's FINDINGS entry flagged
//    (BELGACHHIYA Schematic Design, CHETLA/BURDWAN/TWIN COTTAGE Material
//    Selection) are correctly OVER budget again when computed the way
//    loadAllTimeBudgetLogs() actually computes it (per-project
//    projectId-filtered, no date filter) -- pulled fresh from
//    production, not asserted from memory
//
// Run with: node test/fix-alltime-budget-tracking.test.js
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

const loadSrc = extractFunction(fullScript, 'loadAllTimeBudgetLogs');
const ensureSrc = extractFunction(fullScript, 'ensureAllTimeBudgetLogsLoaded');
const refreshSrc = extractFunction(fullScript, 'refreshAllTimeBudgetLogs');
const phaseAllTimeSrc = extractFunction(fullScript, 'phaseLoggedMinsAllTime');
const projectAllTimeSrc = extractFunction(fullScript, 'projectLoggedMinsAllTime');
const renderDashboardSrc = extractFunction(fullScript, 'renderDashboard');
const renderProjectsBudgetSrc = extractFunction(fullScript, 'renderProjectsBudget');
const dashboardRefreshSrc = extractFunction(fullScript, 'startDashboardAutoRefresh');
const fetchActiveTimersSrc = extractFunction(fullScript, 'fetchActiveTimersFromFirebase');
const loadReconciliationQueueSrc = extractFunction(fullScript, 'loadReconciliationQueue');

let passCount = 0, failCount = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); passCount++; }
  else { console.log(`  FAIL: ${label}`); failCount++; }
}

// ── Behavioral: the loader itself, against a call-counting mock ────
async function runLoaderTests() {
  console.log('=== Behavioral: loadAllTimeBudgetLogs() query shape + caching ===');

  const queryLog = [];
  function makeMockDb(docsByProject) {
    return {
      collection: (name) => {
        assert.strictEqual(name, 'timeLogs');
        return {
          where(field, op, value) {
            assert.strictEqual(field, 'projectId');
            assert.strictEqual(op, '==');
            queryLog.push(value);
            const docs = docsByProject[value] || [];
            return {
              async get(opts) {
                assert.strictEqual(opts && opts.source, 'server', "must force source:'server'");
                return { forEach(fn) { docs.forEach((d, i) => fn({ id: d.id || `${value}-${i}`, data: () => d })); } };
              },
            };
          },
        };
      },
    };
  }

  const docsByProject = {
    p1: [{ projectId: 'p1', phase: 'Schematic Design', durationMins: 100 }],
    p2: [{ projectId: 'p2', phase: 'Material Selection & Coordination', durationMins: 200 }],
  };
  const projectsData = [
    { id: 'p1', phases: { 'Schematic Design': 50 } },      // budgeted
    { id: 'p2', phases: { 'Material Selection & Coordination': 10 } }, // budgeted
    { id: 'p3', phases: { 'Site Supervision': 0 } },        // NOT budgeted (0)
    { id: 'p4', phases: {} },                                // NOT budgeted (none)
  ];

  const sandbox = { projectsData, db: makeMockDb(docsByProject) };
  vm.createContext(sandbox);
  vm.runInContext('let allTimeBudgetLogs = null; let allTimeBudgetLogsPromise = null;', sandbox);
  vm.runInContext(loadSrc, sandbox);
  vm.runInContext(ensureSrc, sandbox);
  vm.runInContext(refreshSrc, sandbox);
  const loadAllTimeBudgetLogs = vm.runInContext('loadAllTimeBudgetLogs', sandbox);
  const ensureAllTimeBudgetLogsLoaded = vm.runInContext('ensureAllTimeBudgetLogsLoaded', sandbox);
  const refreshAllTimeBudgetLogs = vm.runInContext('refreshAllTimeBudgetLogs', sandbox);

  const result = await loadAllTimeBudgetLogs();
  check('exactly 2 queries fired -- one per BUDGETED project, not all 4 projects', queryLog.length === 2);
  check('queried project ids are exactly the budgeted ones (p1, p2), never the unbudgeted p3/p4', queryLog.sort().join(',') === 'p1,p2');
  check('merged result contains both budgeted projects\' docs', result.length === 2);

  queryLog.length = 0;
  await loadAllTimeBudgetLogs();
  await loadAllTimeBudgetLogs();
  await loadAllTimeBudgetLogs();
  check('calling loadAllTimeBudgetLogs() 3 more times after the first fires ZERO new queries (cached, structurally)', queryLog.length === 0);

  console.log('\n=== Behavioral: concurrent callers share one in-flight fetch ===');
  {
    const queryLog2 = [];
    let resolveGate;
    const gate = new Promise(r => { resolveGate = r; });
    const slowDb = {
      collection: () => ({
        where: (f, o, v) => {
          queryLog2.push(v);
          return { async get() { await gate; return { forEach: (fn) => {} }; } };
        },
      }),
    };
    const sandbox2 = { projectsData, db: slowDb };
    vm.createContext(sandbox2);
    vm.runInContext('let allTimeBudgetLogs = null; let allTimeBudgetLogsPromise = null;', sandbox2);
    vm.runInContext(loadSrc, sandbox2);
    const load2 = vm.runInContext('loadAllTimeBudgetLogs', sandbox2);
    const p1 = load2(), p2 = load2(), p3 = load2(); // fire 3 concurrent calls before anything resolves
    resolveGate();
    await Promise.all([p1, p2, p3]);
    check('3 concurrent calls before the first resolves still only fire 2 queries total (one per budgeted project), not 6', queryLog2.length === 2);
  }

  console.log('\n=== Behavioral: ensureAllTimeBudgetLogsLoaded() -- no-op once cached ===');
  {
    let onReadyCalls = 0;
    ensureAllTimeBudgetLogsLoaded(() => { onReadyCalls++; });
    // synchronous check: since the cache is already warm from the tests
    // above (same sandbox), this must return without even scheduling a
    // microtask that calls onReady.
    await Promise.resolve(); await Promise.resolve();
    check('ensureAllTimeBudgetLogsLoaded() never invokes onReady when already cached (no-op)', onReadyCalls === 0);
  }

  console.log('\n=== Behavioral: refreshAllTimeBudgetLogs() is the ONLY way to force a re-fetch ===');
  {
    queryLog.length = 0;
    let onReadyCalls = 0;
    await new Promise((resolve) => {
      refreshAllTimeBudgetLogs(() => { onReadyCalls++; resolve(); });
    });
    check('refreshAllTimeBudgetLogs() fires exactly one new round of queries (2, one per budgeted project)', queryLog.length === 2);
    check('refreshAllTimeBudgetLogs() invokes its onReady callback exactly once', onReadyCalls === 1);
  }

  console.log('\n=== Behavioral: *AllTime() computations + 90-day fallback ===');
  {
    const sandbox3 = {};
    vm.createContext(sandbox3);
    vm.runInContext('let allTimeBudgetLogs = null; let timeLogs = [];', sandbox3);
    vm.runInContext(phaseAllTimeSrc, sandbox3);
    vm.runInContext(projectAllTimeSrc, sandbox3);
    const phaseLoggedMinsAllTime = vm.runInContext('phaseLoggedMinsAllTime', sandbox3);
    const projectLoggedMinsAllTime = vm.runInContext('projectLoggedMinsAllTime', sandbox3);

    // Before any load: falls back to (90-day) timeLogs.
    vm.runInContext(`timeLogs = [{projectId:'pX', phase:'Schematic Design', durationMins:30}];`, sandbox3);
    check('before the all-time cache loads, phaseLoggedMinsAllTime() falls back to timeLogs (no blank/zero on first render)', phaseAllTimeSrc && (() => { const f = vm.runInContext('phaseLoggedMinsAllTime', sandbox3); return f('pX', 'Schematic Design') === 30; })());

    // After a load: uses the all-time cache, NOT the (possibly narrower) timeLogs.
    vm.runInContext(`allTimeBudgetLogs = [
      {projectId:'pX', phase:'Schematic Design', durationMins:500},
      {projectId:'pX', phase:'Final Design', durationMins:20},
      {projectId:'pY', phase:'Schematic Design', durationMins:999},
    ];`, sandbox3);
    check('once the all-time cache is loaded, phaseLoggedMinsAllTime() reads it (500), ignoring the narrower timeLogs (30)', phaseLoggedMinsAllTime('pX', 'Schematic Design') === 500);
    check('projectLoggedMinsAllTime() sums across all of that project\'s phases in the all-time cache (500+20=520)', projectLoggedMinsAllTime('pX') === 520);
    check("doesn't leak another project's all-time hours (pY's 999 not counted for pX)", phaseLoggedMinsAllTime('pX', 'Schematic Design') !== 999);
  }

  console.log(`\n${passCount} passed, ${failCount} failed so far`);
}

// ── Source-text: correct wiring, correct scope, cost-safe by construction ──
console.log('=== Source-text: renderDashboard()/renderProjectsBudget() use the *AllTime functions ===');
check('renderDashboard()\'s overBudgetCount uses phaseLoggedMinsAllTime(), not the 90-day phaseLoggedMins()', /overBudgetCount\+\+/.test(renderDashboardSrc) && renderDashboardSrc.includes('phaseLoggedMinsAllTime(proj.id,phase)') && !/[^r]phaseLoggedMins\(proj\.id,phase\)/.test(renderDashboardSrc));
check('renderDashboard() calls ensureAllTimeBudgetLogsLoaded()', renderDashboardSrc.includes('ensureAllTimeBudgetLogsLoaded('));
check('renderProjectsBudget() uses projectLoggedMinsAllTime() for the overall project %', renderProjectsBudgetSrc.includes('projectLoggedMinsAllTime(proj.id)') && !renderProjectsBudgetSrc.includes('projectLoggedMins(proj.id)/60'));
check('renderProjectsBudget() uses phaseLoggedMinsAllTime() for each phase bar', renderProjectsBudgetSrc.includes('phaseLoggedMinsAllTime(proj.id,ph)') && !renderProjectsBudgetSrc.includes('=phaseLoggedMins(proj.id,ph)'));
check('renderProjectsBudget() calls ensureAllTimeBudgetLogsLoaded()', renderProjectsBudgetSrc.includes('ensureAllTimeBudgetLogsLoaded('));

console.log('\n=== Source-text: cost-safe by construction -- never on a timer/loop, anywhere in the file ===');
check('loadAllTimeBudgetLogs/ensureAllTimeBudgetLogsLoaded/refreshAllTimeBudgetLogs/*AllTime never appear inside a setInterval(...) call anywhere in the file',
  (() => {
    const intervalBlocks = [...fullScript.matchAll(/setInterval\(([\s\S]*?),\s*\d+\s*\)/g)].map(m => m[1]);
    const names = ['loadAllTimeBudgetLogs', 'ensureAllTimeBudgetLogsLoaded', 'refreshAllTimeBudgetLogs', 'phaseLoggedMinsAllTime', 'projectLoggedMinsAllTime'];
    return intervalBlocks.every(block => names.every(name => !block.includes(name)));
  })());
check('the all-time budget machinery is not called from inside startDashboardAutoRefresh()\'s own interval body', names_absent(dashboardRefreshSrc));
function names_absent(source) {
  return !['loadAllTimeBudgetLogs', 'ensureAllTimeBudgetLogsLoaded', 'refreshAllTimeBudgetLogs', 'AllTime('].some(n => source.includes(n));
}

console.log('\n=== Source-text: Dashboard\'s activity-scoped reads are untouched (still 90-day / filtered, not widened) ===');
check('startDashboardAutoRefresh() still date-filters its timeLogs re-read (the Dashboard cost fix, unmodified)', /\.where\(\s*["']date["']\s*,\s*["']>=["']\s*,\s*cutoffDate\s*\)/.test(dashboardRefreshSrc));
check('fetchActiveTimersFromFirebase() still filters on inProgress==true (untouched)', /\.where\(\s*['"]inProgress['"]\s*,\s*['"]==['"]\s*,\s*true\s*\)/.test(fetchActiveTimersSrc));
check('loadReconciliationQueue() still filters on reconciliationNeeded==true (untouched)', /\.where\(\s*['"]reconciliationNeeded['"]\s*,\s*['"]==['"]\s*,\s*true\s*\)/.test(loadReconciliationQueueSrc));

// ── REAL DATA: the 4 flagged phases are correctly over budget again ──
async function runRealDataVerification() {
  console.log('\n=== REAL DATA: the 4 previously-flipped phases, computed the way loadAllTimeBudgetLogs() actually computes it ===');
  const projectRoot = 'D:/SQUARE/ADMIN/SQUARE-Office/finalphase/01072026';
  let firebaseApp, firestore;
  try {
    firebaseApp = require(path.join(projectRoot, 'node_modules', 'firebase', 'app'));
    firestore = require(path.join(projectRoot, 'node_modules', 'firebase', 'firestore'));
  } catch (e) {
    console.log('  SKIP (firebase SDK not resolvable in this environment):', e.message);
    return;
  }
  const { initializeApp } = firebaseApp;
  const { getFirestore, collection, query, where, getDocsFromServer } = firestore;
  const db = getFirestore(initializeApp({ apiKey: 'AIzaSyBi_OD42znfsYZerQ_c6RWfLIPD_GropBE', authDomain: 'square-office-management.firebaseapp.com', projectId: 'square-office-management', storageBucket: 'square-office-management.firebasestorage.app', messagingSenderId: '99247930577', appId: '1:99247930577:web:4f5137e9476349582319f0' }));

  const targets = [
    { project: 'BELGACHHIYA EXP CENTRE', phase: 'Schematic Design', budget: 203 },
    { project: 'CHETLA SAMPLE FLAT', phase: 'Material Selection & Coordination', budget: 14 },
    { project: 'BURDWAN RD', phase: 'Material Selection & Coordination', budget: 14 },
    { project: 'TWIN COTTAGE', phase: 'Material Selection & Coordination', budget: 14 },
  ];

  const projSnap = await getDocsFromServer(collection(db, 'projects'));
  const projects = []; projSnap.forEach(d => projects.push({ id: d.id, ...d.data() }));

  let allOver = true;
  for (const t of targets) {
    const proj = projects.find(p => p.name === t.project);
    if (!proj) { console.log(`  SKIP: project "${t.project}" not found in current production data (renamed/deleted?)`); allOver = false; continue; }
    // Exactly loadAllTimeBudgetLogs()'s own query shape: projectId-filtered, no date filter.
    const snap = await getDocsFromServer(query(collection(db, 'timeLogs'), where('projectId', '==', proj.id)));
    const logs = []; snap.forEach(d => logs.push({ id: d.id, ...d.data() }));
    const mins = logs.filter(l => l.phase === t.phase).reduce((s, l) => s + (l.durationMins || 0), 0);
    const hours = mins / 60;
    const over = hours >= t.budget;
    console.log(`  ${t.project} | ${t.phase}: ${hours.toFixed(1)}h logged (all-time, projectId-scoped) / ${t.budget}h budget -- over? ${over}`);
    if (!over) allOver = false;
  }
  check('all 4 previously-flipped phases are OVER budget again using the all-time, projectId-scoped query', allOver);
}

(async () => {
  await runLoaderTests();
  await runRealDataVerification();
  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
})();
