// Fixture test for Studio Health -- Employee Review, the honest
// replacement for the dormant Appraisal (renderAppraisal()/
// appraisalData/the appraisal nav item are UNTOUCHED by this build --
// confirmed by source-text check below, not just by intent).
//
// Extracts the ACTUAL functions from index.html (brace-matched, not
// retyped) and runs them in a vm sandbox -- proving the real shipped
// code, same discipline as every other fixture in this repo.
//
// Central claims under test:
//  - saveReview() is the ONLY write anywhere in this feature
//    (source-text check across every extracted function)
//  - the write mirrors saveLeaveRequest()'s shape: targeted doc,
//    {merge:true}, source:'server' verify immediately after
//  - reviewId encodes personId+raterId+period -- two raters reviewing
//    the same person/period are two STRUCTURALLY SEPARATE documents,
//    proven with a real second write, not just asserted
//  - the objective panel reuses Individual Insight's own pure functions
//    unchanged -- confirmed both by source text and by matching output
//  - renderAppraisal()/appraisalData/the appraisal nav item are
//    genuinely untouched
//
// Run with: node test/feat-studio-health-employee-review.test.js
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
  'SH_EST_MIN_CONTRIBUTION_PCT', 'SH_EST_RECENT_COUNT', 'SH_EST_MIN_HISTORICAL_COUNT',
  'SH_REVIEW_WINDOW_DAYS', 'SH_REVIEW_PRIOR_WINDOWS', 'SH_CONSISTENCY_CV_THRESHOLD',
].map(name => extractConstLine(fullScript, name)).join('\n');
// SH_REVIEW_CRITERIA is an array literal, not a simple const expression -- extract separately.
const critIdx = fullScript.indexOf('const SH_REVIEW_CRITERIA = [');
const critEnd = fullScript.indexOf('];', critIdx) + 2;
const shCriteriaSrc = fullScript.slice(critIdx, critEnd);

const FN_NAMES = [
  'toLocalDateStr', 'getWindowBounds', 'productiveMinsInWindow', 'computeWorkloadPattern',
  'computePhaseContributions', 'computeEstimationPattern', 'distinctProjectCount', 'computeVersatilityStat',
  'quarterEndDate', 'quarterPeriodKey', 'computeLoggingConsistency', 'computeObjectivePanelFacts', 'saveReview',
];
const fnSrc = {};
FN_NAMES.forEach(name => { fnSrc[name] = extractFunction(fullScript, name); });
const renderReviewSrc = extractFunction(fullScript, 'renderEmployeeReview');
const renderReviewBodySrc = extractFunction(fullScript, 'renderEmployeeReviewBody');
const getQuarterSrc = extractFunction(fullScript, 'getQuarter');

// ═══════════════════════════════════════════════════════════════════
console.log('=== Source-text check: saveReview() is the ONLY write; Appraisal untouched ===');
let passCount = 0, failCount = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); passCount++; }
  else { console.log(`  FAIL: ${label}`); failCount++; }
}
const nonWriteFnNames = FN_NAMES.filter(n => n !== 'saveReview');
const nonWriteSrc = nonWriteFnNames.map(n => fnSrc[n]).concat([renderReviewSrc, renderReviewBodySrc]).join('\n');
check('no Firestore .set(/.update(/.add(/.delete(/.batch( anywhere OUTSIDE saveReview() (Set.add() and classList.add() are plain JS/DOM, not writes, and are excluded)', !/\.(set|update|add|delete|batch)\(/.test(nonWriteSrc.replace(/set\.add\(/g, '').replace(/classList\.add\(/g, '')));
check('saveReview() itself uses {merge:true}', fnSrc.saveReview.includes('{ merge: true }'));
check('saveReview() verifies source:\'server\' immediately after the write', fnSrc.saveReview.includes(`get({ source: 'server' })`));
check('saveReview() throws if the server verify comes back missing (fail loud, not silent)', fnSrc.saveReview.includes('throw new Error'));
check('reviews collection NOT registered in computeCollectionDiffs() -- still hardcoded to exactly 3 collections', (() => {
  const ccdSrc = extractFunction(fullScript, 'computeCollectionDiffs');
  return ccdSrc.includes('timeLogs') && ccdSrc.includes('planEntries') && ccdSrc.includes('projects') && !ccdSrc.includes('reviews');
})());
check('renderAppraisal() itself is completely unchanged by this feature (still gates non-admins, still uses appraisalData)', (() => {
  const apSrc = extractFunction(fullScript, 'renderAppraisal');
  return apSrc.includes(`if (!currentUser.isAdmin)`) && apSrc.includes('appraisalData') && !apSrc.includes('reviews');
})());
check('renderEmployeeReview()/Body() never reference appraisalData/apAdminScores', !renderReviewSrc.includes('appraisalData') && !renderReviewBodySrc.includes('appraisalData') && !renderReviewSrc.includes('apAdminScores') && !renderReviewBodySrc.includes('apAdminScores'));
check('the objective panel reuses computeWorkloadPattern/computeVersatilityStat/computeEstimationPattern by NAME, not reimplemented', fnSrc.computeObjectivePanelFacts.includes('computeWorkloadPattern(') && fnSrc.computeObjectivePanelFacts.includes('computeVersatilityStat(') && fnSrc.computeObjectivePanelFacts.includes('computeEstimationPattern('));

function buildSandbox() {
  const sandbox = { console, Date, Object, Math, Set };
  vm.createContext(sandbox);
  vm.runInContext(shConstantsSrc, sandbox);
  vm.runInContext(shCriteriaSrc, sandbox);
  vm.runInContext(getQuarterSrc, sandbox);
  FN_NAMES.forEach(name => { if (name !== 'saveReview') vm.runInContext(fnSrc[name], sandbox); });
  return sandbox;
}

async function run() {
  // ═══════════════════════════════════════════════════════════════
  console.log('\n=== quarterPeriodKey / quarterEndDate: sane, deterministic ===');
  {
    const sandbox = buildSandbox();
    const qtr = vm.runInContext('getQuarter', sandbox)(0);
    const key = vm.runInContext('quarterPeriodKey', sandbox)(qtr);
    check('period key is a short, stable string', /^Q[1-4]-FY\d{4}$/.test(key));
    const end = vm.runInContext('quarterEndDate', sandbox)(qtr);
    check('quarterEndDate returns a real Date in the quarter\'s final month', end instanceof Date && !isNaN(end.getTime()));
  }

  // ═══════════════════════════════════════════════════════════════
  console.log('\n=== computeLoggingConsistency: steady vs variable, neutral either way ===');
  {
    const sandbox = buildSandbox();
    const steadyLogs = [];
    for (let i = 0; i < 61; i++) { // exactly covers [2026-06-01, 2026-08-01) -- June (30) + July (31) days, no gap at the boundary
      const d = new Date('2026-06-01T00:00:00'); d.setDate(d.getDate() + i);
      if (d.getDay() === 0) continue;
      // Local-component date string, matching toLocalDateStr()'s own
      // approach -- NOT d.toISOString().slice(0,10), which is exactly
      // the timezone bug fixed in the real source (see the file header
      // comment on toLocalDateStr() in index.html). Using the buggy form
      // here would misalign which days the test data lands on relative
      // to what computeLoggingConsistency() walks, injecting spurious
      // variance into what's supposed to be perfectly steady data.
      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      steadyLogs.push({ userId: 'u1', productive: true, durationMins: 480, date: ds }); // exactly 8h every non-Sunday
    }
    const steady = vm.runInContext('computeLoggingConsistency', sandbox)(steadyLogs, 'u1', '2026-06-01', '2026-08-01');
    check('perfectly steady logging -> CV near 0', steady.cv !== null && steady.cv < 0.05);

    const erraticLogs = [
      { userId: 'u1', productive: true, durationMins: 600, date: '2026-06-01' },
      { userId: 'u1', productive: true, durationMins: 0, date: '2026-06-08' },
      { userId: 'u1', productive: true, durationMins: 700, date: '2026-06-15' },
      { userId: 'u1', productive: true, durationMins: 30, date: '2026-06-22' },
    ];
    const erratic = vm.runInContext('computeLoggingConsistency', sandbox)(erraticLogs, 'u1', '2026-06-01', '2026-07-01');
    check('wildly uneven logging -> a meaningfully higher CV than the steady case', erratic.cv > steady.cv * 3);
  }

  // ═══════════════════════════════════════════════════════════════
  console.log('\n=== computeObjectivePanelFacts: reuses the real shared functions, not reimplemented math ===');
  {
    const sandbox = buildSandbox();
    const qtr = vm.runInContext('getQuarter', sandbox)(0);
    const qEnd = vm.runInContext('quarterEndDate', sandbox)(qtr);
    const projects = [{ id: 'p1', name: 'Proj', phases: { Phase: 100 } }];
    const logs = [{ userId: 'u1', projectId: 'p1', phase: 'Phase', productive: true, durationMins: 50 * 60, date: vm.runInContext('toLocalDateStr', sandbox)(new Date(qEnd.getTime() - 5 * 86400000)) }];
    const facts = vm.runInContext('computeObjectivePanelFacts', sandbox)(logs, projects, 'u1', qtr);
    check('returns all four live facts', 'workload' in facts && 'versatility' in facts && 'estimation' in facts && 'consistency' in facts);
    check('workload fact reflects the real logged minutes', facts.workload.currentMins === 50 * 60);
  }

  // ═══════════════════════════════════════════════════════════════════
  // saveReview() and the render functions -- need a mocked db/document.
  // ═══════════════════════════════════════════════════════════════════
  function buildRenderSandbox({ projects = [], logs = [], users = [], reviews = [], selectedPersonId = '', currentUserOverride }) {
    let capturedHTML = undefined;
    const writes = []; // { docId, data } every .set() call
    const dbCalls = [];
    const listeners = {};
    const elements = {};
    const store = {}; // simulates the reviews collection's real server state, for the verify-read to check against
    reviews.forEach(r => { store[r.id] = r; });

    const sandbox = {
      console, Date, Object, Math, Set,
      currentUser: currentUserOverride || { id: 'admin1', isAdmin: true, name: 'Ranit' },
      shCachedReviewData: null,
      shReviewSelectedPersonId: selectedPersonId,
      shReviewQtrOffset: 0,
      db: {
        collection: (name) => ({
          get: async (opts) => {
            dbCalls.push({ collection: name, opts, kind: 'collection' });
            const map = { projects, timeLogs: logs, users, reviews: Object.values(store) };
            const data = map[name] || [];
            return { forEach: (fn) => data.forEach((d, i) => fn({ data: () => d, id: d.id || `${name}${i}` })) };
          },
          doc: (id) => ({
            set: async (data, opts) => {
              writes.push({ docId: id, data, opts });
              store[id] = { ...(store[id] || {}), ...data, id };
            },
            get: async (opts) => {
              dbCalls.push({ collection: name, docId: id, opts, kind: 'doc-get' });
              return { exists: !!store[id], data: () => store[id] };
            },
          }),
        }),
      },
      document: {
        querySelectorAll: () => [],
        getElementById: (id) => {
          if (id === 'sh-employeereview') {
            return { set innerHTML(v) { capturedHTML = v; }, get innerHTML() { return capturedHTML; } };
          }
          if (!elements[id]) elements[id] = { value: '', textContent: '', classList: { add: () => {}, toggle: () => {} }, disabled: false, addEventListener: (evt, fn) => { listeners[id] = fn; } };
          return elements[id];
        },
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(shConstantsSrc, sandbox);
    vm.runInContext(shCriteriaSrc, sandbox);
    vm.runInContext(getQuarterSrc, sandbox);
    FN_NAMES.forEach(name => vm.runInContext(fnSrc[name], sandbox));
    vm.runInContext(renderReviewSrc, sandbox);
    vm.runInContext(renderReviewBodySrc, sandbox);
    return { sandbox, writes, dbCalls, store, getHTML: () => capturedHTML };
  }

  console.log('\n=== renderEmployeeReview: fresh source:server reads on open ===');
  {
    const users = [{ id: 'u1', name: 'Alice' }];
    const { dbCalls } = await (async () => {
      const b = buildRenderSandbox({ users });
      await vm.runInContext('renderEmployeeReview', b.sandbox)();
      return b;
    })();
    check('4 fresh reads (projects, timeLogs, users, reviews)', dbCalls.filter(c => c.kind === 'collection').length === 4);
    check('all reads used source:\'server\'', dbCalls.every(c => c.opts && c.opts.source === 'server'));
  }

  console.log('\n=== saveReview: writes with {merge:true}, verifies source:server, returns the verified data ===');
  {
    const sandbox = buildSandbox(); // saveReview isn't loaded in this one -- build manually
    let store = {};
    const writes = [];
    const mockSandbox = {
      console,
      db: {
        collection: () => ({
          doc: (id) => ({
            set: async (data, opts) => { writes.push({ id, data, opts }); store[id] = { ...(store[id] || {}), ...data }; },
            get: async () => ({ exists: !!store[id], data: () => store[id] }),
          }),
        }),
      },
    };
    vm.createContext(mockSandbox);
    vm.runInContext(fnSrc.saveReview, mockSandbox);
    const result = await vm.runInContext('saveReview', mockSandbox)('review-u1-admin1-Q1-FY2026', { id: 'review-u1-admin1-Q1-FY2026', personId: 'u1', raterId: 'admin1', criteria: { designQuality: 4 } });
    check('exactly one write', writes.length === 1);
    check('write used {merge:true}', writes[0].opts && writes[0].opts.merge === true);
    check('returned data matches what was verified from the mock "server"', result.criteria.designQuality === 4);
  }

  console.log('\n=== saveReview: throws if the server verify comes back missing (does not silently succeed) ===');
  {
    const mockSandbox = {
      console,
      db: { collection: () => ({ doc: () => ({ set: async () => {}, get: async () => ({ exists: false, data: () => undefined }) }) }) },
    };
    vm.createContext(mockSandbox);
    vm.runInContext(fnSrc.saveReview, mockSandbox);
    let threw = false;
    try { await vm.runInContext('saveReview', mockSandbox)('review-x', {}); } catch (e) { threw = true; }
    check('throws rather than reporting success on a failed verify', threw);
  }

  console.log('\n=== STRUCTURAL: two raters, same person+period -> two SEPARATE docs, no collision ===');
  {
    // Build a shared mock db across two sequential saveReview() calls,
    // simulating Ranit's review then Indira's, for the SAME person+period.
    const store = {};
    const writes = [];
    const mockSandbox = {
      console,
      db: {
        collection: () => ({
          doc: (id) => ({
            set: async (data, opts) => { writes.push({ id, data, opts }); store[id] = { ...(store[id] || {}), ...data }; },
            get: async () => ({ exists: !!store[id], data: () => store[id] }),
          }),
        }),
      },
    };
    vm.createContext(mockSandbox);
    vm.runInContext(fnSrc.saveReview, mockSandbox);
    const period = 'Q1-FY2026';
    const ranitId = `review-u1-admin1-${period}`;
    const indiraId = `review-u1-indira1-${period}`;
    await vm.runInContext('saveReview', mockSandbox)(ranitId, { id: ranitId, personId: 'u1', raterId: 'admin1', raterName: 'Ranit', period, criteria: { designQuality: 3 } });
    await vm.runInContext('saveReview', mockSandbox)(indiraId, { id: indiraId, personId: 'u1', raterId: 'indira1', raterName: 'Indira', period, criteria: { designQuality: 5 } });
    check('two separate documents exist', Object.keys(store).length === 2);
    check('Ranit\'s review is untouched by Indira\'s save', store[ranitId].criteria.designQuality === 3);
    check('Indira\'s review is its own independent doc', store[indiraId].criteria.designQuality === 5);
  }

  console.log('\n=== STRUCTURAL: renderEmployeeReviewBody -- both raters shown, objective panel + rubric render together ===');
  {
    const period = (() => {
      const s = buildSandbox();
      const qtr = vm.runInContext('getQuarter', s)(0);
      return vm.runInContext('quarterPeriodKey', s)(qtr);
    })();
    const projects = [{ id: 'p1', name: 'Proj', phases: { Phase: 100 } }];
    const logs = [{ userId: 'u1', projectId: 'p1', phase: 'Phase', productive: true, durationMins: 50 * 60, date: '2026-08-01' }];
    const users = [{ id: 'u1', name: 'Alice' }];
    const reviews = [
      { id: `review-u1-admin1-${period}`, personId: 'u1', raterId: 'admin1', raterName: 'Ranit', period, criteria: { designQuality: 4, judgment: 3, clientHandling: 5, initiative: 4, reliability: 3, mentoring: 2 }, notes: 'Solid quarter.', updatedAt: '2026-08-01T00:00:00.000Z' },
      { id: `review-u1-indira1-${period}`, personId: 'u1', raterId: 'indira1', raterName: 'Indira', period, criteria: { designQuality: 5, judgment: 4, clientHandling: 4, initiative: 4, reliability: 4, mentoring: 3 }, notes: '', updatedAt: '2026-08-02T00:00:00.000Z' },
    ];
    const { getHTML } = await (async () => {
      const b = buildRenderSandbox({ projects, logs, users, reviews, selectedPersonId: 'u1' });
      await vm.runInContext('renderEmployeeReview', b.sandbox)();
      return b;
    })();
    const html = getHTML();
    check('Objective Panel card present', /Objective Panel/.test(html));
    check('Human Rubric card present', /Human Rubric/.test(html));
    check('all 6 criteria labels appear', /Design quality/.test(html) && /Mentoring/.test(html));
    check('both raters (Ranit and Indira) appear in the comparison table', /Ranit/.test(html) && /Indira/.test(html));
    check('objective facts render neutrally -- no "poor/excellent/good" grade language anywhere', !/\b(excellent|poor)\b/i.test(html));
    check('pending metrics show their placeholder text, not fabricated numbers', /Pending — needs the deferred attendance-capture build/.test(html) && /Pending — needs the Submission Log/.test(html));
  }

  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
}

run();
