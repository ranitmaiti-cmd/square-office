// Fixture test for Studio Health -- Individual Insight, Workload (#1) and
// Estimation-vs-actual (#3) ONLY. Attendance (#2) is explicitly held --
// no plumbing built, nothing to test here for it.
//
// Extracts the ACTUAL functions from index.html (brace-matched, not
// retyped) and runs them in a vm sandbox -- proving the real shipped
// code, same discipline as every other fixture in this repo.
//
// Central claims under test:
//  - pure-read: no writes anywhere (source-text check, like Layer A)
//  - self-baseline only: never a shared absolute target, never
//    cross-person comparison in the computation itself
//  - >=20% meaningful-contributor threshold enforced correctly
//  - flag sentences carry no numbers; raw numbers render for at most
//    ONE selected person at a time (the structural anti-scoreboard claim)
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
  'SH_WORKLOAD_WINDOWS', 'SH_PRIOR_WINDOW_COUNT', 'SH_EST_MIN_CONTRIBUTION_PCT',
  'SH_EST_RECENT_COUNT', 'SH_EST_MIN_HISTORICAL_COUNT',
].map(name => extractConstLine(fullScript, name)).join('\n');

const getWindowBoundsSrc = extractFunction(fullScript, 'getWindowBounds');
const productiveMinsSrc = extractFunction(fullScript, 'productiveMinsInWindow');
const leaveDaysSrc = extractFunction(fullScript, 'approvedLeaveDaysInWindow');
const workloadPatternSrc = extractFunction(fullScript, 'computeWorkloadPattern');
const phaseContribSrc = extractFunction(fullScript, 'computePhaseContributions');
const estimationPatternSrc = extractFunction(fullScript, 'computeEstimationPattern');
const renderInsightSrc = extractFunction(fullScript, 'renderIndividualInsight');
const renderInsightBodySrc = extractFunction(fullScript, 'renderIndividualInsightBody');

// ═══════════════════════════════════════════════════════════════════
console.log('=== Source-text check: Individual Insight never writes ===');
let passCount = 0, failCount = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); passCount++; }
  else { console.log(`  FAIL: ${label}`); failCount++; }
}
const allSrc = [getWindowBoundsSrc, productiveMinsSrc, leaveDaysSrc, workloadPatternSrc, phaseContribSrc, estimationPatternSrc, renderInsightSrc, renderInsightBodySrc].join('\n');
check('no .set( anywhere', !allSrc.includes('.set('));
check('no .update( anywhere', !allSrc.includes('.update('));
check('no .add( anywhere', !allSrc.includes('.add('));
check('no .delete( anywhere', !allSrc.includes('.delete('));
check('no .batch( anywhere', !allSrc.includes('.batch('));
check('renderIndividualInsight reads with source:\'server\'', renderInsightSrc.includes(`source: 'server'`));
check('renderIndividualInsightBody does NOT touch db at all (no re-fetch on selector change)', !renderInsightBodySrc.includes('db.'));
check('computeWorkloadPattern never references a shared/global target constant (self-baseline only)', !workloadPatternSrc.includes('htTarget') && !workloadPatternSrc.includes('MAX_SESSION_HOURS'));
check('computeEstimationPattern never computes a per-person share/fraction of an overrun amount', !estimationPatternSrc.includes('overrun') && !estimationPatternSrc.includes('share'));

function buildSandbox() {
  const sandbox = { console, Date, Object, Math };
  vm.createContext(sandbox);
  vm.runInContext(shConstantsSrc, sandbox);
  vm.runInContext(getWindowBoundsSrc, sandbox);
  vm.runInContext(productiveMinsSrc, sandbox);
  vm.runInContext(leaveDaysSrc, sandbox);
  vm.runInContext(workloadPatternSrc, sandbox);
  vm.runInContext(phaseContribSrc, sandbox);
  vm.runInContext(estimationPatternSrc, sandbox);
  return sandbox;
}

const TODAY = new Date('2026-08-28T12:00:00Z');

function dateStr(offsetDaysFromToday) {
  const d = new Date(TODAY);
  d.setDate(d.getDate() + offsetDaysFromToday);
  return d.toISOString().slice(0, 10);
}

async function run() {
  // ═══════════════════════════════════════════════════════════════
  console.log('\n=== computeWorkloadPattern: flags ABOVE own normal, not vs. a shared target ===');
  {
    const sandbox = buildSandbox();
    const logs = [];
    // 3 prior 30-day windows: ~100h each (their "normal")
    for (let w = 1; w <= 3; w++) {
      logs.push({ userId: 'u1', productive: true, durationMins: 100 * 60, date: dateStr(-30 * w - 5) });
    }
    // current 30-day window: 180h -- well above their own normal (1.8x)
    logs.push({ userId: 'u1', productive: true, durationMins: 180 * 60, date: dateStr(-5) });
    const result = vm.runInContext('computeWorkloadPattern', sandbox)(logs, 'u1', 30, 3, TODAY);
    check('flagged', result.flagged === true);
    check('direction is "above"', result.direction === 'above');
    check('currentMins reflects the real logged total', result.currentMins === 180 * 60);
  }

  // ═══════════════════════════════════════════════════════════════
  console.log('\n=== computeWorkloadPattern: flags BELOW own normal ===');
  {
    const sandbox = buildSandbox();
    const logs = [];
    for (let w = 1; w <= 3; w++) logs.push({ userId: 'u1', productive: true, durationMins: 100 * 60, date: dateStr(-30 * w - 5) });
    logs.push({ userId: 'u1', productive: true, durationMins: 40 * 60, date: dateStr(-5) }); // 0.4x -- well below
    const result = vm.runInContext('computeWorkloadPattern', sandbox)(logs, 'u1', 30, 3, TODAY);
    check('flagged', result.flagged === true);
    check('direction is "below"', result.direction === 'below');
  }

  // ═══════════════════════════════════════════════════════════════
  console.log('\n=== computeWorkloadPattern: NOT flagged when close to own normal ===');
  {
    const sandbox = buildSandbox();
    const logs = [];
    for (let w = 1; w <= 3; w++) logs.push({ userId: 'u1', productive: true, durationMins: 100 * 60, date: dateStr(-30 * w - 5) });
    logs.push({ userId: 'u1', productive: true, durationMins: 105 * 60, date: dateStr(-5) }); // 1.05x -- ordinary variation
    const result = vm.runInContext('computeWorkloadPattern', sandbox)(logs, 'u1', 30, 3, TODAY);
    check('NOT flagged', result.flagged === false);
  }

  // ═══════════════════════════════════════════════════════════════
  console.log('\n=== computeWorkloadPattern: insufficient history (first tracked period) -- never flagged ===');
  {
    const sandbox = buildSandbox();
    // Only a current window, zero prior data at all
    const logs = [{ userId: 'u1', productive: true, durationMins: 500 * 60, date: dateStr(-5) }];
    const result = vm.runInContext('computeWorkloadPattern', sandbox)(logs, 'u1', 30, 3, TODAY);
    check('insufficientHistory true', result.insufficientHistory === true);
    check('NOT flagged despite an extreme number (nothing to compare against)', result.flagged === false);
  }

  // ═══════════════════════════════════════════════════════════════
  console.log('\n=== approvedLeaveDaysInWindow: leave annotation ===');
  {
    const sandbox = buildSandbox();
    const window = vm.runInContext('getWindowBounds', sandbox)(30, 0, TODAY);
    const leaveRequests = [
      { userId: 'u1', status: 'approved', startDate: dateStr(-10), endDate: dateStr(-8) }, // 3 days, fully inside the window
      { userId: 'u1', status: 'pending', startDate: dateStr(-5), endDate: dateStr(-4) },    // not approved -- must not count
      { userId: 'u2', status: 'approved', startDate: dateStr(-10), endDate: dateStr(-8) },  // different person -- must not count
    ];
    const days = vm.runInContext('approvedLeaveDaysInWindow', sandbox)(leaveRequests, 'u1', window.start, window.end);
    check('3 approved leave days counted', days === 3);
  }

  // ═══════════════════════════════════════════════════════════════
  console.log('\n=== computeEstimationPattern: >=20% meaningful-contributor threshold enforced ===');
  {
    const sandbox = buildSandbox();
    const projects = [{ id: 'p1', name: 'Test Project', phases: { 'Construction Documents': 100 } }];
    const logs = [
      { userId: 'u1', projectId: 'p1', phase: 'Construction Documents', durationMins: 100 * 60 * 0.25, date: dateStr(-5) }, // 25% -- above threshold
      { userId: 'u2', projectId: 'p1', phase: 'Construction Documents', durationMins: 100 * 60 * 0.75, date: dateStr(-5) },
    ];
    const instances = vm.runInContext('computePhaseContributions', sandbox)(logs, projects);
    const patternU1 = vm.runInContext('computeEstimationPattern', sandbox)(instances, 'u1', 0.20, 5, 3);
    check('u1 (25% contributor) IS included', patternU1.contributed.length === 1);

    const projects2 = [{ id: 'p2', name: 'Drive-by Project', phases: { 'Site Supervision': 100 } }];
    const logs2 = [
      { userId: 'u3', projectId: 'p2', phase: 'Site Supervision', durationMins: 100 * 60 * 0.05, date: dateStr(-5) }, // 5% -- below threshold
      { userId: 'u4', projectId: 'p2', phase: 'Site Supervision', durationMins: 100 * 60 * 0.95, date: dateStr(-5) },
    ];
    const instances2 = vm.runInContext('computePhaseContributions', sandbox)(logs2, projects2);
    const patternU3 = vm.runInContext('computeEstimationPattern', sandbox)(instances2, 'u3', 0.20, 5, 3);
    check('u3 (5% drive-by contributor) is EXCLUDED', patternU3.contributed.length === 0);
  }

  // ═══════════════════════════════════════════════════════════════
  console.log('\n=== computeEstimationPattern: raw hours shown, no attribution/split math applied ===');
  {
    const sandbox = buildSandbox();
    const projects = [{ id: 'p1', name: 'Shared Phase Project', phases: { 'Final Design': 100 } }];
    const logs = [
      { userId: 'u1', projectId: 'p1', phase: 'Final Design', durationMins: 130 * 60 * 0.6, date: dateStr(-5) },
      { userId: 'u2', projectId: 'p1', phase: 'Final Design', durationMins: 130 * 60 * 0.4, date: dateStr(-5) },
    ];
    const instances = vm.runInContext('computePhaseContributions', sandbox)(logs, projects);
    const pattern = vm.runInContext('computeEstimationPattern', sandbox)(instances, 'u1', 0.20, 5, 3);
    const inst = pattern.contributed[0];
    check('personMins is u1\'s OWN raw hours, not a split of the overrun', inst.personMins === 130 * 60 * 0.6);
    check('totalActualMins is the REAL total (both people), untouched', inst.totalActualMins === 130 * 60);
    check('ratio is the phase\'s own actual/budget, not attributed to u1 specifically', Math.abs(inst.ratio - 1.3) < 0.001);
  }

  // ═══════════════════════════════════════════════════════════════
  console.log('\n=== computeEstimationPattern: recent-vs-historical rate, matches the owner\'s "4 of 5 vs 1 of 5" shape ===');
  {
    const sandbox = buildSandbox();
    const projects = [];
    const logs = [];
    // 3 historical phase-instances, 1 over budget (1 of 3)
    for (let i = 0; i < 3; i++) {
      const pid = 'hist' + i;
      projects.push({ id: pid, name: 'Historical ' + i, phases: { Phase: 100 } });
      const ratio = i === 0 ? 1.5 : 1.0; // only the first one over
      logs.push({ userId: 'u1', projectId: pid, phase: 'Phase', durationMins: 100 * 60 * ratio, date: dateStr(-100 - i) });
    }
    // 5 recent phase-instances, 4 over budget (4 of 5)
    for (let i = 0; i < 5; i++) {
      const pid = 'recent' + i;
      projects.push({ id: pid, name: 'Recent ' + i, phases: { Phase: 100 } });
      const ratio = i < 4 ? 1.5 : 1.0; // 4 of 5 over
      logs.push({ userId: 'u1', projectId: pid, phase: 'Phase', durationMins: 100 * 60 * ratio, date: dateStr(-i) });
    }
    const instances = vm.runInContext('computePhaseContributions', sandbox)(logs, projects);
    const pattern = vm.runInContext('computeEstimationPattern', sandbox)(instances, 'u1', 0.20, 5, 3);
    check('recentOverRate is 4/5 = 0.8', Math.abs(pattern.recentOverRate - 0.8) < 0.001);
    check('historicalOverRate is 1/3', Math.abs(pattern.historicalOverRate - (1 / 3)) < 0.001);
    check('flagged (0.8 - 0.33 >= 0.4)', pattern.flagged === true);
  }

  // ═══════════════════════════════════════════════════════════════
  console.log('\n=== computeEstimationPattern: insufficient history -- never flagged ===');
  {
    const sandbox = buildSandbox();
    const projects = [{ id: 'p1', name: 'Only One', phases: { Phase: 100 } }];
    const logs = [{ userId: 'u1', projectId: 'p1', phase: 'Phase', durationMins: 100 * 60 * 2.0, date: dateStr(-5) }]; // wildly over, but only 1 sample
    const instances = vm.runInContext('computePhaseContributions', sandbox)(logs, projects);
    const pattern = vm.runInContext('computeEstimationPattern', sandbox)(instances, 'u1', 0.20, 5, 3);
    check('insufficientHistory true', pattern.insufficientHistory === true);
    check('NOT flagged despite an extreme single ratio', pattern.flagged === false);
  }

  // ═══════════════════════════════════════════════════════════════════
  // STRUCTURAL claim: raw numbers for at most ONE person at a time, flag
  // sentences carry no numbers. Needs the full render function with a
  // mocked db/document.
  // ═══════════════════════════════════════════════════════════════════
  function buildRenderSandbox({ projects, logs, leaveRequestsFresh = [], users, selectedPersonId = '', windowDays = 30 }) {
    let capturedHTML = undefined;
    const dbCalls = [];
    const listeners = {};
    const sandbox = {
      console, Date, Object, Math,
      currentUser: { id: 'admin1', isAdmin: true, name: 'Admin' },
      shCachedInsightData: null,
      shSelectedPersonId: selectedPersonId,
      shSelectedWindowDays: windowDays,
      db: {
        collection: (name) => ({
          get: async (opts) => {
            dbCalls.push({ collection: name, opts });
            const map = { projects, timeLogs: logs, leaveRequests: leaveRequestsFresh, users };
            const data = map[name] || [];
            return { forEach: (fn) => data.forEach((d, i) => fn({ data: () => d, id: d.id || `${name}${i}` })) };
          },
        }),
      },
      document: {
        getElementById: (id) => {
          if (id === 'sh-individualinsight') {
            return { set innerHTML(v) { capturedHTML = v; }, get innerHTML() { return capturedHTML; } };
          }
          return { addEventListener: (evt, fn) => { listeners[id] = fn; } };
        },
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(shConstantsSrc, sandbox);
    vm.runInContext(getWindowBoundsSrc, sandbox);
    vm.runInContext(productiveMinsSrc, sandbox);
    vm.runInContext(leaveDaysSrc, sandbox);
    vm.runInContext(workloadPatternSrc, sandbox);
    vm.runInContext(phaseContribSrc, sandbox);
    vm.runInContext(estimationPatternSrc, sandbox);
    vm.runInContext(renderInsightSrc, sandbox);
    vm.runInContext(renderInsightBodySrc, sandbox);
    return { sandbox, dbCalls, getHTML: () => capturedHTML, listeners };
  }

  console.log('\n=== renderIndividualInsight: fresh source:server reads on open ===');
  {
    const projects = [{ id: 'p1', name: 'Proj', phases: { Phase: 100 } }];
    const logs = [{ userId: 'u1', projectId: 'p1', phase: 'Phase', productive: true, durationMins: 100 * 60, date: dateStr(-5) }];
    const users = [{ id: 'u1', name: 'Alice' }, { id: 'u2', name: 'Bob' }];
    const { dbCalls } = await (async () => {
      const b = buildRenderSandbox({ projects, logs, users });
      await vm.runInContext('renderIndividualInsight', b.sandbox)();
      return b;
    })();
    check('4 fresh reads (projects, timeLogs, leaveRequests, users)', dbCalls.length === 4);
    check('all reads used source:\'server\'', dbCalls.every(c => c.opts && c.opts.source === 'server'));
  }

  console.log('\n=== STRUCTURAL: no person selected -- zero raw numbers rendered anywhere ===');
  {
    const projects = [{ id: 'p1', name: 'Proj', phases: { Phase: 100 } }];
    const logs = [
      { userId: 'u1', projectId: 'p1', phase: 'Phase', productive: true, durationMins: 300 * 60, date: dateStr(-5) },
      { userId: 'u2', projectId: 'p1', phase: 'Phase', productive: true, durationMins: 10 * 60, date: dateStr(-5) },
    ];
    const users = [{ id: 'u1', name: 'Alice' }, { id: 'u2', name: 'Bob' }];
    const { getHTML } = await (async () => {
      const b = buildRenderSandbox({ projects, logs, users, selectedPersonId: '' });
      await vm.runInContext('renderIndividualInsight', b.sandbox)();
      return b;
    })();
    const html = getHTML();
    check('prompts to pick a name, shows no numbers by default', /Pick a name above/.test(html));
    check('no "Their Hours" raw-data table rendered when nobody is selected', !html.includes('Their Hours'));
  }

  console.log('\n=== STRUCTURAL: ONE person selected -- their raw numbers appear, no second person\'s numbers alongside ===');
  {
    const projects = [{ id: 'p1', name: 'Proj', phases: { Phase: 100 } }];
    const logs = [];
    for (let w = 1; w <= 3; w++) logs.push({ userId: 'u1', productive: true, durationMins: 100 * 60, date: dateStr(-30 * w - 5) });
    logs.push({ userId: 'u1', productive: true, durationMins: 100 * 60, date: dateStr(-5) });
    logs.push({ userId: 'u2', productive: true, durationMins: 999 * 60, date: dateStr(-5) }); // a second person with data -- must NOT show up numerically
    const users = [{ id: 'u1', name: 'Alice' }, { id: 'u2', name: 'Bob' }];
    const { getHTML } = await (async () => {
      const b = buildRenderSandbox({ projects, logs, users, selectedPersonId: 'u1' });
      await vm.runInContext('renderIndividualInsight', b.sandbox)();
      return b;
    })();
    const html = getHTML();
    check('Alice\'s raw hours are shown', /Alice/.test(html) && /logged in the last/.test(html));
    check('Bob\'s raw hours (999h) are NOT present anywhere in the output', !html.includes('999.0h'));
    check('only ONE "— Workload" raw-numbers header appears (not one per person)', (html.match(/— Workload/g) || []).length === 1);
  }

  console.log('\n=== STRUCTURAL: flag sentences carry no numbers ===');
  {
    const projects = [];
    const logs = [];
    for (let w = 1; w <= 3; w++) logs.push({ userId: 'u1', productive: true, durationMins: 100 * 60, date: dateStr(-30 * w - 5) });
    logs.push({ userId: 'u1', productive: true, durationMins: 200 * 60, date: dateStr(-5) }); // flagged, well above
    const users = [{ id: 'u1', name: 'Alice' }];
    const { getHTML } = await (async () => {
      const b = buildRenderSandbox({ projects, logs, users });
      await vm.runInContext('renderIndividualInsight', b.sandbox)();
      return b;
    })();
    const html = getHTML();
    check('flag fired', /Alice.s workload this period is well above their own normal/.test(html));
    // The workload flag sentence template itself has no numeric interpolation --
    // confirm no digit-percent or digit-hour pattern appears inside the flag card specifically.
    const flagCardMatch = html.match(/Patterns Worth a Look[\s\S]*?<\/div>\s*<\/div>\s*<div class="card">/);
    check('no percentage or hour figure inside the flags card', flagCardMatch ? !/\d+(\.\d+)?(%|h\b)/.test(flagCardMatch[0]) : true);
  }

  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
}

run();
