// Fixture test for Studio Health -- Data Quality: confidence grade
// (Feature A) and phase/typology contradiction detection (Feature B).
// Both pure-read: derived entirely from existing timeLogs fields,
// no new field, no write path, changes nothing.
//
// Extracts the ACTUAL functions from index.html (brace-matched, not
// retyped) and runs them in a vm sandbox -- proving the real shipped
// code, same discipline as every other fixture in this repo.
//
// Central claims under test:
//  - gradeTimeLogConfidence() implements the exact A/B/C/D rules,
//    including the self-report desc-match and the biometric-B vs
//    reconstructed-C distinction
//  - computeConfidenceBreakdown() aggregates correctly and the
//    verified% (A+B) is computed right
//  - TYPOLOGY_TO_PHASE covers all 14 real typology values
//  - detectPhaseTypologyContradictions() uses the EXPLICIT lookup, not
//    a naive prefix match -- proven directly: a Material Selection
//    entry that WOULD false-flag under a prefix check does NOT flag
//    here
//  - contradictions group correctly by (person, phase, typology)
//    pattern, matching real data's shape (few patterns, most of the
//    hours)
//  - pure-read: no .set/.update/.add/.delete/.batch anywhere in either
//    feature's code or in renderDataQuality() (source-text check)
//  - renderDataQuality() reads fresh via source:'server', same as
//    every other Studio Health panel
//
// Run with: node test/feat-data-integrity-panel.test.js
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
function extractConstBlock(source, name) {
  const idx = source.indexOf(`const ${name} =`);
  assert.ok(idx >= 0, `could not find "const ${name} =" in index.html`);
  const eqIdx = source.indexOf('=', idx) + 1;
  let depth = 0, i = eqIdx, started = false;
  for (; i < source.length; i++) {
    if (source[i] === '{') { depth++; started = true; }
    else if (source[i] === '}') { depth--; if (started && depth === 0) { i++; break; } }
  }
  const end = source.indexOf(';', i - 1) + 1;
  return source.slice(idx, end);
}

const gradeSrc = extractFunction(fullScript, 'gradeTimeLogConfidence');
const breakdownSrc = extractFunction(fullScript, 'computeConfidenceBreakdown');
const typologyMapSrc = extractConstBlock(fullScript, 'TYPOLOGY_TO_PHASE');
const contradictionSrc = extractFunction(fullScript, 'detectPhaseTypologyContradictions');
const renderDataQualitySrc = extractFunction(fullScript, 'renderDataQuality');

let passCount = 0, failCount = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); passCount++; }
  else { console.log(`  FAIL: ${label}`); failCount++; }
}

console.log('=== Source-text: pure-read, zero writes anywhere in either feature ===');
{
  const allSrc = [gradeSrc, breakdownSrc, typologyMapSrc, contradictionSrc, renderDataQualitySrc].join('\n');
  check('no .set( anywhere', !allSrc.includes('.set('));
  check('no .update( anywhere', !allSrc.includes('.update('));
  check('no Firestore .add( anywhere (plain JS Set.add(), if any, excluded)', !allSrc.replace(/set\.add\(/g, '').includes('.add('));
  check('no .delete( anywhere', !allSrc.includes('.delete('));
  check('no .batch( anywhere', !allSrc.includes('.batch('));
  check('renderDataQuality() reads with source:\'server\'', renderDataQualitySrc.includes(`source: 'server'`));
  check('renderDataQuality() gates on currentUser.isAdmin (admin-only, matches every other Studio Health panel)', renderDataQualitySrc.includes('currentUser?.isAdmin'));
}

function buildSandbox() {
  const sandbox = { console, Object, Math };
  vm.createContext(sandbox);
  vm.runInContext(typologyMapSrc, sandbox);
  vm.runInContext(gradeSrc, sandbox);
  vm.runInContext(breakdownSrc, sandbox);
  vm.runInContext(contradictionSrc, sandbox);
  return sandbox;
}

console.log('\n=== Feature A: gradeTimeLogConfidence -- each rule, exactly ===');
{
  const sandbox = buildSandbox();
  const grade = (log) => vm.runInContext('gradeTimeLogConfidence', sandbox)(log);

  check('D: supersededBySelfReport:true', grade({ supersededBySelfReport: true, desc: 'anything' }) === 'D');
  check('D: desc matches the self-report marker, no boolean needed', grade({ desc: 'Self-reported (timer left running — 5h 30m logged by user)' }) === 'D');
  check('D takes priority even if recovered:true is also set (a superseded doc may carry stale recovered from before)', grade({ supersededBySelfReport: true, recovered: true, desc: '' }) === 'D');

  check('B: recovered:true + gapfillSource starting "biometric-"', grade({ recovered: true, gapfillSource: 'biometric-2026-08-28', desc: '' }) === 'B');
  check('B: recovered:true + desc contains "capped at biometric OUT"', grade({ recovered: true, desc: 'Work on project (closed end-of-day — capped at biometric OUT 18:30)' }) === 'B');
  check('B: gapfill:true alone (not itself "recovered")', grade({ gapfill: true, desc: '' }) === 'B');

  check('C: recovered:true, autoCapped, no biometric evidence', grade({ recovered: true, autoCapped: true, desc: '(auto-closed on load — capped at last heartbeat 11:19)' }) === 'C');
  check('C: recovered:true, estimatedClose+ceilingClamped (the Rai-correction shape), no biometric', grade({ recovered: true, estimatedClose: true, ceilingClamped: true, desc: '(closed end-of-day — no biometric data, capped at 20:30 ceiling...)' }) === 'C');
  check('C: bare recovered:true, heartbeat-stale, no other tag', grade({ recovered: true, desc: '(recovered — heartbeat stale for 190m)' }) === 'C');

  check('A: no repair tag of any kind -- a normal switchTaskTo/logout close', grade({ desc: 'Schematic Design – Concept Development (switched to Lunch Break)' }) === 'A');
  check('A: a plain manually-entered log with no desc at all', grade({}) === 'A');
}

console.log('\n=== Feature A: computeConfidenceBreakdown -- aggregation and verified% ===');
{
  const sandbox = buildSandbox();
  const logs = [
    { durationMins: 100, desc: 'switched to X' }, // A
    { durationMins: 50, desc: 'switched to Y' }, // A
    { durationMins: 200, recovered: true, gapfillSource: 'biometric-2026-08-01', desc: '' }, // B
    { durationMins: 80, recovered: true, autoCapped: true, desc: '' }, // C
    { durationMins: 40, desc: 'Self-reported (timer left running — 0h 40m logged by user)' }, // D
  ];
  const b = vm.runInContext('computeConfidenceBreakdown', sandbox)(logs);
  check('grade A: 2 entries, 150 mins', b.grades.A.count === 2 && b.grades.A.mins === 150);
  check('grade B: 1 entry, 200 mins', b.grades.B.count === 1 && b.grades.B.mins === 200);
  check('grade C: 1 entry, 80 mins', b.grades.C.count === 1 && b.grades.C.mins === 80);
  check('grade D: 1 entry, 40 mins', b.grades.D.count === 1 && b.grades.D.mins === 40);
  check('totalMins is the sum of all 5', b.totalMins === 470);
  check('verifiedMins is A+B only (350), not A+B+C', b.verifiedMins === 350);
  check('verifiedPct computed correctly (350/470)', Math.abs(b.verifiedPct - (350 / 470) * 100) < 0.001);

  const empty = vm.runInContext('computeConfidenceBreakdown', sandbox)([]);
  check('empty input -> verifiedPct is null, not NaN or a crash', empty.verifiedPct === null && empty.totalMins === 0);
}

console.log('\n=== Feature B: TYPOLOGY_TO_PHASE covers all 14 real typology values ===');
{
  const sandbox = buildSandbox();
  const map = vm.runInContext('TYPOLOGY_TO_PHASE', sandbox);
  const REAL_TYPOLOGIES = [
    'Schematic Design – Concept Development', 'Schematic Design – Client Presentation',
    'Final Design – Detailed Drawings', 'Final Design – 3D Visualisation',
    'Construction Documents – Floor Plans', 'Construction Documents – Sections & Elevations', 'Construction Documents – Details',
    'Material Selection – Research', 'Material Selection – Vendor Coordination',
    'Site Supervision – Site Visit', 'Site Supervision – Progress Report',
    'Project Management – Coordination', 'Project Management – Client Meeting', 'Project Management – Internal Review',
  ];
  check('exactly 14 entries in the map', Object.keys(map).length === 14);
  check('every real typology from index.html\'s own `typologies` array is covered', REAL_TYPOLOGIES.every(t => t in map));
  check('the two Material Selection typologies map to the REAL phase name "Material Selection & Coordination" (not a prefix match)', map['Material Selection – Research'] === 'Material Selection & Coordination' && map['Material Selection – Vendor Coordination'] === 'Material Selection & Coordination');
}

console.log('\n=== Feature B: the Material Selection non-false-flag case, proven directly ===');
{
  const sandbox = buildSandbox();
  // This is EXACTLY the case a naive `typology.startsWith(phase)` check
  // would misfire on: phase is "Material Selection & Coordination",
  // typology is "Material Selection – Research" -- they don't share a
  // string prefix, but they ARE the correct, consistent pair.
  const logs = [{ id: 'x1', userId: 'u1', phase: 'Material Selection & Coordination', typology: 'Material Selection – Research', durationMins: 60 }];
  const result = vm.runInContext('detectPhaseTypologyContradictions', sandbox)(logs);
  check('the real Material Selection pair is NOT flagged as a contradiction', result.contradictions.length === 0);
  check('it IS counted as checkable (both phase and typology present, typology known)', result.checkableCount === 1);
}

console.log('\n=== Feature B: a genuine contradiction IS caught ===');
{
  const sandbox = buildSandbox();
  const logs = [{ id: 'x2', userId: 'u1', phase: 'Schematic Design', typology: 'Construction Documents – Details', durationMins: 90 }];
  const result = vm.runInContext('detectPhaseTypologyContradictions', sandbox)(logs);
  check('a real mismatch (SD phase, CD typology) IS flagged', result.contradictions.length === 1);
  check('contradictionMins matches the flagged entry\'s duration', result.contradictionMins === 90);
}

console.log('\n=== Feature B: non-checkable entries excluded, not false-flagged ===');
{
  const sandbox = buildSandbox();
  const logs = [
    { id: 'a', userId: 'u1', phase: '', typology: 'Site Supervision – Site Visit', durationMins: 30 }, // no phase (e.g. Lunch Break) -- not checkable
    { id: 'b', userId: 'u1', phase: 'Site Supervision', typology: '', durationMins: 30 }, // no typology -- not checkable
    { id: 'c', userId: 'u1', phase: 'Site Supervision', typology: 'Some Free Text Typology', durationMins: 30 }, // unknown typology -- not checkable, not a contradiction
  ];
  const result = vm.runInContext('detectPhaseTypologyContradictions', sandbox)(logs);
  check('none of these count as checkable', result.checkableCount === 0);
  check('none of these are flagged as contradictions (a data gap is not a contradiction)', result.contradictions.length === 0);
}

console.log('\n=== Feature B: grouping by (person, phase, typology) pattern -- matches real data\'s shape ===');
{
  const sandbox = buildSandbox();
  // Mirrors the real finding: a handful of repeating patterns account
  // for most of the contradiction hours, not scattered one-off entries.
  const logs = [
    { id: '1', userId: 'tasmin', phase: 'Schematic Design', typology: 'Final Design – 3D Visualisation', durationMins: 100 },
    { id: '2', userId: 'tasmin', phase: 'Schematic Design', typology: 'Final Design – 3D Visualisation', durationMins: 200 },
    { id: '3', userId: 'tasmin', phase: 'Schematic Design', typology: 'Final Design – 3D Visualisation', durationMins: 50 },
    { id: '4', userId: 'taskiya', phase: 'Schematic Design', typology: 'Construction Documents – Details', durationMins: 60 },
  ];
  const result = vm.runInContext('detectPhaseTypologyContradictions', sandbox)(logs);
  check('4 contradiction entries collapse into 2 distinct patterns', result.patterns.length === 2);
  const tasminPattern = result.patterns.find(p => p.userId === 'tasmin');
  check('the repeated tasmin pattern aggregates count (3) and minutes (350) correctly', tasminPattern.count === 3 && tasminPattern.mins === 350);
  check('patterns are sorted by minutes descending (the biggest pattern first, matching "show patterns not rows")', result.patterns[0].mins >= result.patterns[1].mins);
  check('each pattern carries the expected phase for context', tasminPattern.expectedPhase === 'Final Design');
}

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
