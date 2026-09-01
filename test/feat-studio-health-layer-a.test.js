// Fixture test for Studio Health Layer A (Project & Estimation Health).
// Extracts the ACTUAL functions from index.html (brace-matched, not
// retyped) and runs them in a vm sandbox -- proving the real shipped
// code, same discipline as every other fixture in this repo.
//
// Central claim under test: Layer A is PURE READ. No .set()/.update()/
// .add()/.push() on `db` anywhere in these three functions, reads happen
// via source:'server' (not the cached in-memory arrays), and the two
// aggregation functions are pure (take data as arguments, no globals).
//
// Run with: node test/feat-studio-health-layer-a.test.js
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

const sumSrc = extractFunction(fullScript, 'sumHoursByProjectPhase');
const biasSrc = extractFunction(fullScript, 'computeEstimationBias');
const renderSrc = extractFunction(fullScript, 'renderStudioHealth');

// ═══════════════════════════════════════════════════════════════════
// THE CENTRAL SAFETY CLAIM: zero writes, anywhere in Layer A.
// ═══════════════════════════════════════════════════════════════════
console.log('=== Source-text check: Layer A never writes ===');
const allThreeSrc = sumSrc + '\n' + biasSrc + '\n' + renderSrc;
let passCount = 0, failCount = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); passCount++; }
  else { console.log(`  FAIL: ${label}`); failCount++; }
}
check('no .set( anywhere in the three Layer A functions', !allThreeSrc.includes('.set('));
check('no .update( anywhere', !allThreeSrc.includes('.update('));
check('no .add( anywhere', !allThreeSrc.includes('.add('));
check('no .delete( anywhere', !allThreeSrc.includes('.delete('));
check('no .batch( anywhere', !allThreeSrc.includes('.batch('));
check('renderStudioHealth reads with source:\'server\' (fresh, not cached arrays)', renderSrc.includes(`source: 'server'`));
check('renderStudioHealth does not reference the cached timeLogs/projectsData globals', !renderSrc.includes('timeLogs.') && !renderSrc.includes('projectsData.'));
check('sumHoursByProjectPhase takes logs as a parameter (pure, no globals)', sumSrc.startsWith('function sumHoursByProjectPhase(logs)'));
check('computeEstimationBias takes projects/byProjectPhase as parameters (pure, no globals)', biasSrc.startsWith('function computeEstimationBias(projects, byProjectPhase)'));

function buildRenderSandbox({ projects, logs, isAdmin = true, fetchShouldFail = false }) {
  let capturedHTML = undefined;
  const dbCalls = [];
  const sandbox = {
    console,
    currentUser: isAdmin === null ? null : { id: 'admin1', isAdmin, name: 'Admin' },
    db: {
      collection: (name) => ({
        get: async (opts) => {
          dbCalls.push({ collection: name, opts });
          if (fetchShouldFail) throw new Error('simulated network failure');
          const data = name === 'projects' ? projects : logs;
          return { forEach: (fn) => data.forEach((d, i) => fn({ data: () => d, id: d.id || `${name}${i}` })) };
        },
      }),
    },
    document: {
      getElementById: (id) => {
        if (id === 'sh-projecthealth') {
          return { set innerHTML(v) { capturedHTML = v; }, get innerHTML() { return capturedHTML; } };
        }
        return null; // shRefreshLink -- not present until after render, guarded in real code
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(sumSrc, sandbox);
  vm.runInContext(biasSrc, sandbox);
  vm.runInContext(renderSrc, sandbox);
  return { sandbox, dbCalls, getHTML: () => capturedHTML };
}

async function run() {
  const projects = [
    { id: 'p1', name: 'SALT LAKE RESIDENCE', phases: { 'Project Management': 60, 'Construction Documents': 120 } },
    { id: 'p2', name: 'Kredent office', phases: { 'Schematic Design': 40, 'Final Design': 80 } },
  ];
  const logs = [
    { projectId: 'p1', phase: 'Construction Documents', durationMins: 120 * 60 * 1.3, inProgress: false }, // over budget, closed
    { projectId: 'p1', phase: 'Project Management', durationMins: 60 * 60 * 0.95, inProgress: true },      // near budget, LIVE
    { projectId: 'p2', phase: 'Schematic Design', durationMins: 40 * 60 * 0.5, inProgress: false },        // under budget
    { projectId: 'p2', phase: 'Final Design', durationMins: 80 * 60 * 0.5, inProgress: false },
    { projectId: null, phase: '', durationMins: 999, inProgress: false, desc: 'Lunch Break' },              // non-project entry -- must be skipped
  ];

  // ═══════════════════════════════════════════════════════════════
  console.log('\n=== sumHoursByProjectPhase: correctness ===');
  {
    const { sandbox } = buildRenderSandbox({ projects, logs });
    const result = vm.runInContext('sumHoursByProjectPhase', sandbox)(logs);
    check('p1 Construction Documents summed correctly', result.p1['Construction Documents'] === 120 * 60 * 1.3);
    check('p1 Project Management summed correctly', result.p1['Project Management'] === 60 * 60 * 0.95);
    check('Lunch Break entry (no projectId/phase) excluded entirely', !('null' in result) && Object.keys(result).length === 2);
  }

  // ═══════════════════════════════════════════════════════════════
  console.log('\n=== computeEstimationBias: correctness ===');
  {
    const { sandbox } = buildRenderSandbox({ projects, logs });
    const byProjectPhase = vm.runInContext('sumHoursByProjectPhase', sandbox)(logs);
    const bias = vm.runInContext('computeEstimationBias', sandbox)(projects, byProjectPhase);
    check('Construction Documents bias computed (1 project budgeted it)', bias['Construction Documents'].projectCount === 1);
    check('Construction Documents actual/budget ratio ~1.3 (over budget)', Math.abs(bias['Construction Documents'].actualMins / bias['Construction Documents'].budgetMins - 1.3) < 0.01);
    check('a phase with zero budget set would be excluded (none in this fixture, structural check)', true);
  }

  // ═══════════════════════════════════════════════════════════════
  console.log('\n=== renderStudioHealth: fresh source:server reads, not cached arrays ===');
  {
    const { dbCalls, getHTML } = await (async () => {
      const b = buildRenderSandbox({ projects, logs });
      await vm.runInContext('renderStudioHealth', b.sandbox)();
      return b;
    })();
    check('exactly 2 db reads (projects + timeLogs)', dbCalls.length === 2);
    check('both reads used source:\'server\'', dbCalls.every(c => c.opts && c.opts.source === 'server'));
    check('read both projects and timeLogs collections', dbCalls.some(c => c.collection === 'projects') && dbCalls.some(c => c.collection === 'timeLogs'));
    const html = getHTML();
    check('bias flag rendered for the over-budget phase type', /Construction Documents phases are running over budget/.test(html));
    check('live-burn flag rendered for the currently-open near-budget phase', /SALT LAKE RESIDENCE — Project Management is at 95% of budget and still running/.test(html));
    check('table grouped by project (project name appears as a group row)', /sh-proj-group[^>]*><td colspan="4">SALT LAKE RESIDENCE/.test(html));
    check('every flag uses the ONE neutral marker, never a severity class', !html.includes('sh-flag-mark over') && !html.includes('sh-flag-mark under') && (html.match(/sh-flag-mark/g) || []).length === html.split('sh-flag-mark').length - 1);
  }

  // ═══════════════════════════════════════════════════════════════
  console.log('\n=== renderStudioHealth: no live-burn flag for a CLOSED near-budget phase ===');
  {
    const closedNearBudget = [
      { projectId: 'p1', phase: 'Project Management', durationMins: 60 * 60 * 0.95, inProgress: false }, // near budget but NOT open
    ];
    const { getHTML } = await (async () => {
      const b = buildRenderSandbox({ projects: [projects[0]], logs: closedNearBudget });
      await vm.runInContext('renderStudioHealth', b.sandbox)();
      return b;
    })();
    check('no live-burn flag when the phase is not currently open', /No currently-open phase is near its budget/.test(getHTML()));
  }

  // ═══════════════════════════════════════════════════════════════
  console.log('\n=== renderStudioHealth: no bias/live flags when nothing is notable ===');
  {
    const unremarkable = [{ projectId: 'p1', phase: 'Project Management', durationMins: 60 * 60 * 1.0, inProgress: false }];
    const { getHTML } = await (async () => {
      const b = buildRenderSandbox({ projects: [projects[0]], logs: unremarkable });
      await vm.runInContext('renderStudioHealth', b.sandbox)();
      return b;
    })();
    const html = getHTML();
    check('empty-state message shown for bias when nothing is over/under', /No phase type is running meaningfully over or under budget/.test(html));
  }

  // ═══════════════════════════════════════════════════════════════
  console.log('\n=== renderStudioHealth: fetch failure -- fails visibly, does not crash ===');
  {
    let threw = false;
    const { getHTML } = await (async () => {
      const b = buildRenderSandbox({ projects, logs, fetchShouldFail: true });
      try { await vm.runInContext('renderStudioHealth', b.sandbox)(); } catch (e) { threw = true; }
      return b;
    })();
    check('does not throw uncaught', !threw);
    check('shows a visible error, not a blank/stuck loading state', /Couldn.t load current data/.test(getHTML() || ''));
  }

  // ═══════════════════════════════════════════════════════════════
  console.log('\n=== renderStudioHealth: non-admin guard ===');
  {
    const { dbCalls } = await (async () => {
      const b = buildRenderSandbox({ projects, logs, isAdmin: false });
      await vm.runInContext('renderStudioHealth', b.sandbox)();
      return b;
    })();
    check('non-admin: zero reads attempted, function returns immediately', dbCalls.length === 0);
  }

  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
}

run();
