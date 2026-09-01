// Fixture test for Studio Health -- Estimation Reliability's count-
// threshold fix. Real-data investigation (2026-08-31) found the old 5
// recent + 3 historical (8 total qualifying phase-instances) threshold
// left 8 of 9 people showing "not enough history" -- the metric almost
// never fired. Swept several count combinations against real production
// data with the 20% contribution filter held fixed (confirmed NOT the
// bottleneck -- identical insufficient-count at 20%/15%/10%): 4+2 (6
// total) dropped it to 5/9, 3+2 (5 total) to 4/9, and 2+2 (4 total)
// rescued nobody further than 3+2 -- confirming 3+2 as the real floor,
// not an arbitrary relaxation.
//
// Extracts the ACTUAL functions from index.html (brace-matched, not
// retyped) and runs them in a vm sandbox -- proving the real shipped
// code, same discipline as every other fixture in this repo.
//
// Central claims under test:
//  - SH_EST_RECENT_COUNT/SH_EST_MIN_HISTORICAL_COUNT are 3/2, not 5/3
//  - SH_EST_MIN_CONTRIBUTION_PCT stays 0.20 (unchanged, deliberately --
//    confirmed not the bottleneck, unlike Versatility's 20%->10%)
//  - the real team-shaped 8/9 -> 4/9 transition, reproduced from
//    synthetic data shaped to match the real per-person qualifying
//    counts found in the investigation (not live Firestore -- fixtures
//    stay deterministic/offline)
//  - the "natural floor" claim: 2+2 rescues nobody beyond what 3+2
//    already rescues, in the same team-shaped data
//  - recent/historical are sliced from ONE filtered+sorted list, so
//    they can never disagree about which phases qualified
//  - both Individual Insight and Employee Review reference the SAME
//    shared constants (source-text check) -- one change fixes both
//  - framing unchanged: still no flagged/verdict language beyond the
//    existing neutral over/under-rate numbers
//
// Run with: node test/feat-studio-health-estimation-threshold.test.js
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

const shConstantsSrc = ['SH_EST_MIN_CONTRIBUTION_PCT', 'SH_EST_RECENT_COUNT', 'SH_EST_MIN_HISTORICAL_COUNT']
  .map(name => extractConstLine(fullScript, name)).join('\n');
const computePhaseContributionsSrc = extractFunction(fullScript, 'computePhaseContributions');
const computeEstimationPatternSrc = extractFunction(fullScript, 'computeEstimationPattern');
const computeObjectivePanelFactsSrc = extractFunction(fullScript, 'computeObjectivePanelFacts');
const renderIndividualInsightBodySrc = extractFunction(fullScript, 'renderIndividualInsightBody');

let passCount = 0, failCount = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); passCount++; }
  else { console.log(`  FAIL: ${label}`); failCount++; }
}

console.log('=== V16.21: the shipped constants ===');
{
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(shConstantsSrc, sandbox);
  check('SH_EST_RECENT_COUNT is 3 (was 5)', vm.runInContext('SH_EST_RECENT_COUNT', sandbox) === 3);
  check('SH_EST_MIN_HISTORICAL_COUNT is 2 (was 3)', vm.runInContext('SH_EST_MIN_HISTORICAL_COUNT', sandbox) === 2);
  check('SH_EST_MIN_CONTRIBUTION_PCT is UNCHANGED at 0.20 -- confirmed not the bottleneck, deliberately kept', vm.runInContext('SH_EST_MIN_CONTRIBUTION_PCT', sandbox) === 0.20);
}

function buildSandbox() {
  const sandbox = { console, Object, Math };
  vm.createContext(sandbox);
  vm.runInContext(shConstantsSrc, sandbox);
  vm.runInContext(computePhaseContributionsSrc, sandbox);
  vm.runInContext(computeEstimationPatternSrc, sandbox);
  return sandbox;
}

// Builds `count` distinct budgeted phase-instances where `userId` is the
// SOLE contributor (trivially clears any reasonable contribution-%), each
// with its own distinct date so recent/historical sorting is deterministic.
// `overRatios` (optional) assigns actual/budget ratios in date order (most
// recent first) so a specific over/under pattern can be constructed.
function buildLogsForPerson(userId, count, overRatios) {
  const projects = [];
  const logs = [];
  for (let i = 0; i < count; i++) {
    const pid = `${userId}-proj-${i}`;
    const budgetHours = 100;
    const ratio = (overRatios && overRatios[i] != null) ? overRatios[i] : 1.0;
    projects.push({ id: pid, name: `Project ${pid}`, phases: { Phase: budgetHours } });
    logs.push({
      userId, projectId: pid, phase: 'Phase',
      durationMins: budgetHours * 60 * ratio,
      date: `2026-${String(8 - Math.floor(i / 28)).padStart(2, '0')}-${String(28 - (i % 28)).padStart(2, '0')}`, // distinct, descending-ish dates
    });
  }
  return { projects, logs };
}

console.log('\n=== computeEstimationPattern: the 3+2 boundary, exact ===');
{
  const sandbox = buildSandbox();
  // Exactly 5 qualifying phases (3 recent + 2 historical) -- sufficient.
  const five = buildLogsForPerson('u1', 5);
  const instances5 = vm.runInContext('computePhaseContributions', sandbox)(five.logs, five.projects);
  const r5 = vm.runInContext('computeEstimationPattern', sandbox)(instances5, 'u1', vm.runInContext('SH_EST_MIN_CONTRIBUTION_PCT', sandbox), vm.runInContext('SH_EST_RECENT_COUNT', sandbox), vm.runInContext('SH_EST_MIN_HISTORICAL_COUNT', sandbox));
  check('exactly 5 qualifying phases -> sufficient (3 recent + 2 historical)', r5.insufficientHistory === false && r5.recent.length === 3 && r5.historical.length === 2);

  // Exactly 4 -- one short -- insufficient.
  const four = buildLogsForPerson('u2', 4);
  const instances4 = vm.runInContext('computePhaseContributions', sandbox)(four.logs, four.projects);
  const r4 = vm.runInContext('computeEstimationPattern', sandbox)(instances4, 'u2', vm.runInContext('SH_EST_MIN_CONTRIBUTION_PCT', sandbox), vm.runInContext('SH_EST_RECENT_COUNT', sandbox), vm.runInContext('SH_EST_MIN_HISTORICAL_COUNT', sandbox));
  check('exactly 4 qualifying phases -> still insufficient (one short of 5)', r4.insufficientHistory === true);
}

console.log('\n=== computeEstimationPattern: recent + historical are sliced from ONE filtered+sorted list -- can never disagree ===');
{
  const sandbox = buildSandbox();
  const { projects, logs } = buildLogsForPerson('u1', 6);
  const instances = vm.runInContext('computePhaseContributions', sandbox)(logs, projects);
  const r = vm.runInContext('computeEstimationPattern', sandbox)(instances, 'u1', 0.20, 3, 2);
  const recentIds = new Set(r.recent.map(x => x.projectId));
  const historicalIds = new Set(r.historical.map(x => x.projectId));
  check('recent and historical never overlap', [...recentIds].every(id => !historicalIds.has(id)));
  check('recent + historical together account for every qualifying phase', recentIds.size + historicalIds.size === r.contributed.length);
}

console.log('\n=== REAL-DATA-SHAPED: team-wide 8/9 -> 4/9 transition, natural floor confirmed ===');
{
  // Qualifying-phase counts per person, exactly as found against real
  // production data on 2026-08-31 (see the SH_EST_RECENT_COUNT comment in
  // index.html for the full investigation): Angana:1, Ridhi:6, Souvik:1,
  // Suravi:10, Tasmin:5, Sarbani:6, Rai:6, Neha:3, Taskiya:1.
  const teamShape = { Angana: 1, Ridhi: 6, Souvik: 1, Suravi: 10, Tasmin: 5, Sarbani: 6, Rai: 6, Neha: 3, Taskiya: 1 };
  const sandbox = buildSandbox();
  const allProjects = [], allLogs = [];
  Object.entries(teamShape).forEach(([name, count]) => {
    const { projects, logs } = buildLogsForPerson(name, count);
    allProjects.push(...projects); allLogs.push(...logs);
  });
  const instances = vm.runInContext('computePhaseContributions', sandbox)(allLogs, allProjects);

  function countInsufficient(recentN, histN) {
    let insuff = 0;
    Object.keys(teamShape).forEach(name => {
      const r = vm.runInContext('computeEstimationPattern', sandbox)(instances, name, 0.20, recentN, histN);
      if (r.insufficientHistory) insuff++;
    });
    return insuff;
  }

  check('OLD threshold (5+3, 8 total): 8/9 insufficient, matching the real investigation', countInsufficient(5, 3) === 8);
  check('NEW threshold (3+2, 5 total): 4/9 insufficient, matching the real investigation', countInsufficient(3, 2) === 4);
  check('going lower still (2+2, 4 total) rescues NOBODY further -- confirms 3+2 is the real floor, not arbitrary', countInsufficient(2, 2) === 4);
}

console.log('\n=== REAL-DATA-SHAPED: the 5 newly-qualifying people show SANE patterns, not noise ===');
{
  const sandbox = buildSandbox();
  // Tasmin: real recent overruns of 243%/112%/120%, clean historical --
  // must produce a genuine 100%/0% split and flag (matches the real
  // investigation's central "not noise" proof point).
  const { projects, logs } = buildLogsForPerson('tasmin', 5, [2.43, 1.12, 1.20, 0.95, 0.90]); // most-recent-first: 3 overruns, then 2 clean historical
  const instances = vm.runInContext('computePhaseContributions', sandbox)(logs, projects);
  const r = vm.runInContext('computeEstimationPattern', sandbox)(instances, 'tasmin', 0.20, 3, 2);
  check('sufficient history now (was insufficient at the old 8-total bar for someone with only 5 phases)', r.insufficientHistory === false);
  check('recent over-rate is 100% (all 3 recent phases genuinely over 1.10)', r.recentOverRate === 1);
  check('historical over-rate is 0% (both historical phases genuinely clean)', r.historicalOverRate === 0);
  check('flagged -- a real, non-noise pattern (>=0.4 swing from a real 100-point gap)', r.flagged === true);
}

console.log('\n=== Shared function, shared constants -- one change fixes BOTH Individual Insight and Employee Review ===');
{
  check('computeObjectivePanelFacts() (Employee Review) calls computeEstimationPattern() with the shared constants by NAME, not hardcoded numbers', computeObjectivePanelFactsSrc.includes('computeEstimationPattern(phaseInstances, userId, SH_EST_MIN_CONTRIBUTION_PCT, SH_EST_RECENT_COUNT, SH_EST_MIN_HISTORICAL_COUNT)'));
  check('renderIndividualInsightBody() calls computeEstimationPattern() with the shared constants by NAME, not hardcoded numbers', renderIndividualInsightBodySrc.includes('computeEstimationPattern(phaseInstances, u.id, SH_EST_MIN_CONTRIBUTION_PCT, SH_EST_RECENT_COUNT, SH_EST_MIN_HISTORICAL_COUNT)'));
  check('neither call site hardcodes a literal 5 or 3 in place of the constants', !/computeEstimationPattern\([^)]*,\s*5\s*,\s*3\s*\)/.test(computeObjectivePanelFactsSrc) && !/computeEstimationPattern\([^)]*,\s*5\s*,\s*3\s*\)/.test(renderIndividualInsightBodySrc));
}

console.log('\n=== Framing unchanged: no verdict/grade language, still just neutral over-rate numbers ===');
{
  const sandbox = buildSandbox();
  const { projects, logs } = buildLogsForPerson('u1', 5, [2.0, 2.0, 2.0, 0.5, 0.5]);
  const instances = vm.runInContext('computePhaseContributions', sandbox)(logs, projects);
  const r = vm.runInContext('computeEstimationPattern', sandbox)(instances, 'u1', 0.20, 3, 2);
  check('result carries only flagged (boolean) + numeric rates -- no grade/label field added by this fix', Object.keys(r).sort().join(',') === 'contributed,flagged,historical,historicalOverRate,insufficientHistory,recent,recentOverRate');
  check('flagged is a plain boolean, not a color/severity string', typeof r.flagged === 'boolean');
}

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
