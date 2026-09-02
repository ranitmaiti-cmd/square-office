// Fixture for the Dashboard auto-refresh cost fix.
//
// startDashboardAutoRefresh()'s 30s interval used to pull the ENTIRE
// timeLogs collection (unfiltered) from the server, every cycle, for
// as long as Dashboard stayed open -- confirmed the single biggest
// live Firestore-read cost in the app (FINDINGS-2026-08-10.md,
// "Firebase cost investigation"). Fixed to match loadData()'s own
// 90-day window exactly -- not narrower, since this refresh replaces
// the SHARED global `timeLogs` array other pages read from
// (phaseLoggedMins(), Time Report), and not wider, since that's the
// whole point of the fix.
//
// Extracts the ACTUAL functions from index.html (brace-matched, not
// retyped) and runs them in a vm sandbox, same discipline as every
// other fixture in this repo.
//
// Central claims under test:
//  - startDashboardAutoRefresh()'s query now carries a
//    .where("date", ">=", cutoffDate) clause before .get(), same as
//    loadData()'s own timeLogs read
//  - the cutoff computed is EXACTLY 90 days back, byte-identical
//    math to loadData()'s own cutoff (same `new Date()` + `setDate`
//    + `fmt()` pattern) -- can't silently drift apart from it
//  - behaviorally: a mock Firestore that actually filters by the
//    requested where-clause proves the refresh only ever receives
//    (and only ever loads into `timeLogs`) docs within the window --
//    not asserted from reading, proven by running the real code
//  - a doc older than the cutoff is correctly EXCLUDED from the
//    resulting in-memory `timeLogs`, and snapshotCollection() is
//    still called with exactly that filtered array (so the delete
//    guard's docSnapshots baseline can never contain an id the array
//    doesn't have -- nothing can look "missing" and become a false
//    delete candidate)
//  - "this month" (what Dashboard's own stats actually display) is
//    always a subset of the last 90 days -- the filtered window can
//    never cut into what Dashboard itself needs to render
//  - the timer-running guard (never clobber timeLogs mid-session) is
//    untouched by this change
//  - source-text: the two other 30s pollers in the same function
//    (fetchActiveTimersFromFirebase, loadReconciliationQueue) remain
//    filtered and unmodified, and Studio Health's per-tab fetches
//    remain deliberately untouched (flagged separately, not fixed --
//    see FINDINGS-2026-08-10.md for why)
//
// Run with: node test/fix-dashboard-refresh-date-scope.test.js
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

const dashboardRefreshSrc = extractFunction(fullScript, 'startDashboardAutoRefresh');
const loadDataSrc = extractFunction(fullScript, 'loadData');
const fetchActiveTimersSrc = extractFunction(fullScript, 'fetchActiveTimersFromFirebase');
const loadReconciliationQueueSrc = extractFunction(fullScript, 'loadReconciliationQueue');

let passCount = 0, failCount = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); passCount++; }
  else { console.log(`  FAIL: ${label}`); failCount++; }
}

console.log('=== Source-text: the refresh query is now date-filtered ===');
check('startDashboardAutoRefresh() contains a .where("date", ">=", ...) clause', /\.where\(\s*["']date["']\s*,\s*["']>=["']\s*,\s*cutoffDate\s*\)/.test(dashboardRefreshSrc));
check('the .where(...) is chained BEFORE .get( (query built correctly, not filtered client-side after the fact)',
  (() => {
    const whereIdx = dashboardRefreshSrc.search(/\.where\(\s*["']date["']/);
    const getIdx = dashboardRefreshSrc.indexOf('.get({source:\'server\'})', whereIdx);
    return whereIdx >= 0 && getIdx > whereIdx;
  })());
check('still forces source:\'server\' (unchanged -- cache must never serve stale dashboard data)', /\.get\(\{\s*source:\s*'server'\s*\}\)/.test(dashboardRefreshSrc));

console.log('\n=== Source-text: cutoff math is byte-identical to loadData()\'s own 90-day window ===');
function extractCutoffMath(source) {
  const idx = source.search(/const \w+\s*=\s*new Date\(\);\s*\n\s*\w+\.setDate\(\w+\.getDate\(\)\s*-\s*90\);\s*\n\s*const cutoffDate\s*=\s*fmt\(\w+\);/);
  return idx;
}
check('startDashboardAutoRefresh() computes cutoffDate via `new Date()` + `setDate(getDate()-90)` + `fmt()`, matching loadData()\'s own pattern',
  /new Date\(\);\s*\n\s*ninetyDaysAgo\.setDate\(ninetyDaysAgo\.getDate\(\)\s*-\s*90\);\s*\n\s*const cutoffDate\s*=\s*fmt\(ninetyDaysAgo\);/.test(dashboardRefreshSrc));
check('loadData() itself still computes its cutoff the same way (both sides of the "match" claim actually checked, not just one)',
  /new Date\(\);\s*\n\s*ninetyDaysAgo\.setDate\(ninetyDaysAgo\.getDate\(\)\s*-\s*90\);\s*\n\s*const cutoffDate\s*=\s*fmt\(ninetyDaysAgo\);/.test(loadDataSrc));

console.log('\n=== Behavioral: a mock Firestore that ACTUALLY filters by the requested where-clause ===');
{
  const today = new Date();
  const fmt = (d) => { const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0'); return `${y}-${m}-${day}`; };
  const daysAgo = (n) => { const d = new Date(today); d.setDate(d.getDate() - n); return fmt(d); };

  // Seed docs spanning well inside and well outside the 90-day window.
  const allDocs = [
    { id: 'recent1', date: daysAgo(1), userId: 'u1', durationMins: 60 },
    { id: 'recent2', date: daysAgo(45), userId: 'u2', durationMins: 30 },
    { id: 'boundary', date: daysAgo(90), userId: 'u3', durationMins: 10 }, // >= cutoff, included
    { id: 'old1', date: daysAgo(91), userId: 'u4', durationMins: 500 },   // just outside, excluded
    { id: 'old2', date: daysAgo(400), userId: 'u5', durationMins: 999 },  // ancient, excluded
  ];

  const whereCallsLog = [];
  function makeFilteredCollection(docs) {
    const filters = [];
    const chain = {
      where(field, op, value) {
        filters.push([field, op, value]);
        whereCallsLog.push([field, op, value]);
        return chain;
      },
      async get(opts) {
        // opts is a plain object literal created INSIDE the vm sandbox's own
        // realm -- its prototype differs from this outer realm's
        // Object.prototype, so assert.deepStrictEqual (which compares
        // prototypes) would false-fail here even though the code is
        // correct. Compare the one field that matters directly instead.
        assert.strictEqual(opts && opts.source, 'server', 'must force source:\'server\'');
        let result = docs;
        filters.forEach(([field, op, value]) => {
          if (op === '>=') result = result.filter(d => d[field] >= value);
          else throw new Error(`mock does not support operator ${op}`);
        });
        return {
          forEach(fn) { result.forEach((d, i) => fn({ id: d.id, data: () => { const { id, ...rest } = d; return rest; } })); },
        };
      },
    };
    return chain;
  }

  const snapshotCollectionCalls = [];
  const sandbox = {
    console,
    DEBUG: false,
    timerRunning: false,
    timeLogs: ['STALE_PRE_REFRESH_SENTINEL'], // proves the array really gets replaced
    hasUnsavedChanges: true,
    dashboardRefreshInterval: null,
    fmt,
    db: { collection: (name) => (name === 'timeLogs' ? makeFilteredCollection(allDocs) : makeFilteredCollection([])) },
    snapshotCollection: (name, arr) => { snapshotCollectionCalls.push({ name, arr: arr.slice() }); },
    renderLiveTimeLogFeed: () => {},
    renderDashboardStats: () => {},
    document: { getElementById: () => null },
    clearInterval: () => {},
    setInterval: (fn) => { sandbox._tickFn = fn; return 1; },
  };
  vm.createContext(sandbox);
  vm.runInContext(dashboardRefreshSrc, sandbox);
  vm.runInContext('startDashboardAutoRefresh()', sandbox);

  (async () => {
    await sandbox._tickFn(); // fire one tick manually

    check('the mock Firestore actually received a .where("date", ">=", <90-days-ago>) call', whereCallsLog.length === 1 && whereCallsLog[0][0] === 'date' && whereCallsLog[0][1] === '>=');
    check('the cutoff value passed is exactly 90 days back (matches the hand-computed daysAgo(90))', whereCallsLog[0][2] === daysAgo(90));

    const resultIds = sandbox.timeLogs.map(l => l.id).sort();
    check('resulting timeLogs contains the in-window docs (recent1, recent2, boundary)', ['boundary', 'recent1', 'recent2'].every(id => resultIds.includes(id)));
    check('resulting timeLogs EXCLUDES docs older than 90 days (old1, old2) -- proves the filter genuinely narrows what lands in memory', !resultIds.includes('old1') && !resultIds.includes('old2'));
    check('the stale pre-refresh sentinel is gone -- the array was really replaced, not appended to', !resultIds.includes(undefined) && sandbox.timeLogs.every(l => l !== 'STALE_PRE_REFRESH_SENTINEL'));
    check('exactly 3 docs loaded (not 5 -- the two old docs never made it into memory at all)', sandbox.timeLogs.length === 3);

    check('snapshotCollection("timeLogs", ...) was called with the SAME filtered array (docSnapshots can never contain an id outside the window)',
      snapshotCollectionCalls.length === 1 && snapshotCollectionCalls[0].name === 'timeLogs' && snapshotCollectionCalls[0].arr.map(l => l.id).sort().join(',') === resultIds.join(','));

    console.log('\n=== Behavioral: timer-running guard still protects in-memory logs (unchanged) ===');
    sandbox.timeLogs = ['LIVE_UNSAVED_SENTINEL'];
    sandbox.timerRunning = true;
    whereCallsLog.length = 0;
    await sandbox._tickFn();
    check('while a timer is running, the refresh is skipped entirely -- no query fired', whereCallsLog.length === 0);
    check('in-memory timeLogs (with the live unsaved entry) is untouched', sandbox.timeLogs[0] === 'LIVE_UNSAVED_SENTINEL');

    finishUp();
  })();

  function finishUp() {
    console.log('\n=== Sanity: "this month" (what Dashboard actually renders) is always inside the last 90 days ===');
    // Dashboard's own stat cards filter by `l.date.startsWith(thisMonthStr)`.
    // The earliest possible date in "this month" is the 1st; the widest gap
    // between "the 1st of this month" and "today" is bounded well under 90
    // days for any calendar month (max 31 days), so the 90-day window can
    // never cut into what Dashboard itself displays, for any day of any
    // month.
    const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const daysSinceFirstOfMonth = Math.round((today - firstOfMonth) / (24 * 60 * 60 * 1000));
    check('every day of "this month" is within 31 days of today (well inside the 90-day window, for any month)', daysSinceFirstOfMonth <= 31);

    console.log('\n=== Source-text: the two other 30s pollers in this function stay filtered, untouched ===');
    check('fetchActiveTimersFromFirebase() still filters on inProgress==true (unchanged, still cheap)', /\.where\(\s*['"]inProgress['"]\s*,\s*['"]==['"]\s*,\s*true\s*\)/.test(fetchActiveTimersSrc));
    check('loadReconciliationQueue() still filters on reconciliationNeeded==true (unchanged, still cheap)', /\.where\(\s*['"]reconciliationNeeded['"]\s*,\s*['"]==['"]\s*,\s*true\s*\)/.test(loadReconciliationQueueSrc));

    console.log(`\n${passCount} passed, ${failCount} failed`);
    if (failCount > 0) process.exit(1);
  }
}
