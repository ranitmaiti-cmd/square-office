// Fixture test for Studio Health -- Log Reliability (v2 layer on Data
// Quality). Per-person Verified%/Contradiction% facts, DELIBERATELY
// not combined into a letter grade or composite score -- the owner's
// explicit "Option B" call, structurally different from the v2 scope's
// original A/B/C proposal.
//
// Extracts the ACTUAL functions from index.html (brace-matched, not
// retyped) and runs them in a vm sandbox, same discipline as every
// other fixture in this repo.
//
// Central claims under test:
//  - computeLogReliabilityFacts() correctly reuses computeConfidence-
//    Breakdown()/detectPhaseTypologyContradictions() filtered to one
//    person -- matches computing those two functions directly against
//    that person's own logs
//  - the minimum-sample floor (SH_LOGREL_MIN_CHECKABLE): below it,
//    insufficientData is true and no percentage is asserted reliable;
//    at/above it, false
//  - NO letter grade (A/B/C/D) and NO composite/combined score anywhere
//    in the rendered card HTML -- only the two named facts + plain text
//  - the framing banner is FIXED text (present regardless of which
//    person is selected or how good/bad their numbers are)
//  - reached one person at a time via a picker -- never a <table> of
//    all people, nothing sortable/rankable in the rendered output
//  - pure-read: no .set/.update/.add/.delete/.batch anywhere in the
//    new code (source-text check, same as Data Quality's own)
//  - renderLogReliability() fetches fresh via source:'server'
//
// Run with: node test/feat-log-reliability-v2.test.js
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
function extractLine(source, startsWith) {
  const idx = source.indexOf(startsWith);
  assert.ok(idx >= 0, `could not find "${startsWith}" in index.html`);
  const end = source.indexOf(';', idx) + 1;
  return source.slice(idx, end);
}

// Dependencies computeLogReliabilityFacts() calls through to -- extract
// verbatim, same as feat-data-integrity-panel.test.js does.
const gradeSrc = extractFunction(fullScript, 'gradeTimeLogConfidence');
const breakdownSrc = extractFunction(fullScript, 'computeConfidenceBreakdown');
const typologyMapSrc = extractConstBlock(fullScript, 'TYPOLOGY_TO_PHASE');
const contradictionSrc = extractFunction(fullScript, 'detectPhaseTypologyContradictions');
// The new v2 code itself.
const minCheckableSrc = extractLine(fullScript, 'const SH_LOGREL_MIN_CHECKABLE');
const factsSrc = extractFunction(fullScript, 'computeLogReliabilityFacts');
const renderLogRelSrc = extractFunction(fullScript, 'renderLogReliability');
const renderLogRelBodySrc = extractFunction(fullScript, 'renderLogReliabilityBody');

let passCount = 0, failCount = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); passCount++; }
  else { console.log(`  FAIL: ${label}`); failCount++; }
}

// ── Sandbox: real functions, fixture logs ──────────────────────────
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(gradeSrc, sandbox);
vm.runInContext(breakdownSrc, sandbox);
vm.runInContext(typologyMapSrc, sandbox);
vm.runInContext(contradictionSrc, sandbox);
vm.runInContext(minCheckableSrc, sandbox);
vm.runInContext(factsSrc, sandbox);
const computeLogReliabilityFacts = vm.runInContext('computeLogReliabilityFacts', sandbox);
const computeConfidenceBreakdown = vm.runInContext('computeConfidenceBreakdown', sandbox);
const detectPhaseTypologyContradictions = vm.runInContext('detectPhaseTypologyContradictions', sandbox);
const SH_LOGREL_MIN_CHECKABLE = vm.runInContext('SH_LOGREL_MIN_CHECKABLE', sandbox);

check('SH_LOGREL_MIN_CHECKABLE is a positive number (a real floor, not 0/disabled)', typeof SH_LOGREL_MIN_CHECKABLE === 'number' && SH_LOGREL_MIN_CHECKABLE > 0);

// ── Fixture: build enough logs for one person to clear the floor ───
function mkLog(over) { return Object.assign({ userId: 'p1', durationMins: 60, desc: '' }, over); }

function buildPersonLogs({ checkableCount, contradictionCount, extraNonCheckable = 0, recoveredCount = 0 }) {
  const logs = [];
  for (let i = 0; i < checkableCount; i++) {
    const isContradiction = i < contradictionCount;
    logs.push(mkLog({
      id: `chk${i}`,
      phase: isContradiction ? 'Site Supervision' : 'Schematic Design',
      typology: 'Schematic Design – Concept Development', // real phase is 'Schematic Design'
    }));
  }
  for (let i = 0; i < extraNonCheckable; i++) {
    logs.push(mkLog({ id: `nc${i}`, phase: '', typology: '', projectName: 'Lunch Break', productive: false }));
  }
  for (let i = 0; i < recoveredCount; i++) {
    logs.push(mkLog({ id: `rec${i}`, phase: 'Final Design', typology: 'Final Design – Detailed Drawings', recovered: true, gapfillSource: 'biometric-close' }));
  }
  return logs;
}

// ── Test 1: matches computing the two underlying functions directly ─
{
  const logs = buildPersonLogs({ checkableCount: 20, contradictionCount: 6, extraNonCheckable: 3, recoveredCount: 4 });
  const otherPersonLogs = buildPersonLogs({ checkableCount: 20, contradictionCount: 20 }).map(l => ({ ...l, userId: 'someone-else', id: 'other-' + l.id }));
  const allLogs = logs.concat(otherPersonLogs);

  const facts = computeLogReliabilityFacts(allLogs, 'p1');
  const directBreakdown = computeConfidenceBreakdown(logs); // p1's own logs only
  const directContradictions = detectPhaseTypologyContradictions(logs);

  check('computeLogReliabilityFacts filters to the requested person only (matches direct computeConfidenceBreakdown on their logs)',
    facts.totalMins === directBreakdown.totalMins && facts.verifiedMins === directBreakdown.verifiedMins && facts.verifiedPct === directBreakdown.verifiedPct);
  check('computeLogReliabilityFacts filters to the requested person only (matches direct detectPhaseTypologyContradictions on their logs)',
    facts.checkableCount === directContradictions.checkableCount && facts.contradictionCount === directContradictions.contradictions.length);
  // recoveredCount logs are also checkable (real phase+typology set,
  // no mismatch) -- so p1's true checkable count is 20 + 4 = 24, not
  // just the 20 from the checkable/contradiction loop. Derive the
  // expected % from the same direct computation rather than
  // hand-hardcoding it, so this test can't drift from the fixture.
  check('contradictionPct = contradictions / checkable * 100, exactly',
    Math.abs(facts.contradictionPct - (directContradictions.contradictions.length / directContradictions.checkableCount) * 100) < 1e-9);
  check("does NOT leak the other person's data into this person's facts (other person alone would contribute 20 checkable, all contradictions)",
    facts.checkableCount === directContradictions.checkableCount && facts.checkableCount < 40);
}

// ── Test 2: minimum-sample floor ────────────────────────────────────
{
  const below = buildPersonLogs({ checkableCount: SH_LOGREL_MIN_CHECKABLE - 1, contradictionCount: 0 });
  const atFloor = buildPersonLogs({ checkableCount: SH_LOGREL_MIN_CHECKABLE, contradictionCount: 0 });
  const factsBelow = computeLogReliabilityFacts(below, 'p1');
  const factsAt = computeLogReliabilityFacts(atFloor, 'p1');
  check(`below the floor (${SH_LOGREL_MIN_CHECKABLE - 1} checkable) -> insufficientData: true`, factsBelow.insufficientData === true);
  check(`at the floor (${SH_LOGREL_MIN_CHECKABLE} checkable) -> insufficientData: false`, factsAt.insufficientData === false);

  const zero = computeLogReliabilityFacts([], 'p1');
  check('zero logs at all -> insufficientData: true, no crash, no NaN leaking as a truthy number', zero.insufficientData === true && zero.checkableCount === 0);
}

// ── Test 3: render output -- no letter grade, no composite score ───
const renderSandbox = {
  currentUser: { id: 'admin1', isAdmin: true, name: 'Admin' },
  document: {
    getElementById: (id) => ({ innerHTML: '', addEventListener: () => {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} } }),
  },
};
vm.createContext(renderSandbox);
[gradeSrc, breakdownSrc, typologyMapSrc, contradictionSrc, minCheckableSrc, factsSrc].forEach(s => vm.runInContext(s, renderSandbox));
vm.runInContext(`let shCachedLogRelData = null; let shLogRelSelectedPersonId = '';`, renderSandbox);
vm.runInContext(renderLogRelBodySrc, renderSandbox);
const renderLogReliabilityBody = vm.runInContext('renderLogReliabilityBody', renderSandbox);

function renderForPerson(logs, allUsers, selectedId) {
  const captured = { html: '' };
  const container = { set innerHTML(v) { captured.html = v; }, get innerHTML() { return captured.html; } };
  const els = {};
  renderSandbox.document.getElementById = (id) => {
    if (id === 'sh-logreliability') return container;
    if (!els[id]) els[id] = { value: '', addEventListener: () => {} };
    return els[id];
  };
  vm.runInContext(`shCachedLogRelData = ${JSON.stringify({ logs, allUsers })}; shLogRelSelectedPersonId = ${JSON.stringify(selectedId)};`, renderSandbox);
  renderLogReliabilityBody();
  return captured.html;
}

{
  // A person with a real, elevated contradiction% -- if a letter grade
  // or composite score were rendered anywhere, it would show here.
  const logs = buildPersonLogs({ checkableCount: 30, contradictionCount: 25 }); // 83.3%, well past every threshold
  const allUsers = [{ id: 'p1', name: 'Tasmin', isAdmin: false }];
  const html = renderForPerson(logs, allUsers, 'p1');

  check('renders the person\'s name', html.includes('Tasmin'));
  check('renders a Verified% figure', /Verified/.test(html) && /%/.test(html));
  check('renders a Contradiction% figure', /Contradiction/.test(html));
  check('NO bare letter grade token (Grade A/B/C/D) rendered anywhere', !/Grade\s*[ABCD]\b/.test(html));
  check('NO "Log Reliability Grade" / composite-score wording anywhere', !/composite|overall grade|reliability grade|reliability score/i.test(html));
  check('the framing banner is present and unmissable', html.includes('NOT job performance') && html.includes('DATA quality'));
}

{
  // A person with excellent numbers -- banner text must be IDENTICAL,
  // proving it's fixed, not conditional on how good/bad the facts are.
  const goodLogs = buildPersonLogs({ checkableCount: 30, contradictionCount: 0 });
  const badLogs = buildPersonLogs({ checkableCount: 30, contradictionCount: 25 });
  const allUsers = [{ id: 'p1', name: 'Sarbani', isAdmin: false }];
  const goodHTML = renderForPerson(goodLogs, allUsers, 'p1');
  const badHTML = renderForPerson(badLogs, allUsers, 'p1');
  const extractBanner = (h) => (h.match(/sh-framing-banner">([\s\S]*?)<\/div>/) || [, ''])[1];
  check('framing banner text is byte-identical regardless of the selected person\'s numbers (fixed, not conditional)',
    extractBanner(goodHTML) === extractBanner(badHTML) && extractBanner(goodHTML).length > 0);
}

{
  // Insufficient-data person -- must say so, not guess a percentage.
  const logs = buildPersonLogs({ checkableCount: 3, contradictionCount: 1 });
  const allUsers = [{ id: 'p1', name: 'NewHire', isAdmin: false }];
  const html = renderForPerson(logs, allUsers, 'p1');
  check('insufficient-data person: says "insufficient data" (case-insensitive)', /insufficient data/i.test(html));
  check('insufficient-data person: does NOT render a Verified%/Contradiction% figure for them', !/Verified%<\/div>/.test(html));
}

{
  // No one selected -- picker + banner only, no table of everyone.
  const allUsers = [{ id: 'p1', name: 'A', isAdmin: false }, { id: 'p2', name: 'B', isAdmin: false }];
  const html = renderForPerson([], allUsers, '');
  check('nobody selected: prompts to pick a name, shows no data', /pick a name/i.test(html));
  check('nobody selected: no <table> in the output at all (never a full-team list)', !/<table/i.test(html));
  check('the picker is a <select>, not a table/list of people (structural anti-ranking)', /<select[^>]*id="shlogrelPersonPicker"/.test(html));
}

// ── Test 4: never a sortable/rankable structure, anywhere in source ─
{
  const bodySrc = renderLogRelBodySrc;
  check('renderLogReliabilityBody() never builds a <table> (nothing tabular/sortable to rank people by)', !/<table/i.test(bodySrc));
  check('renderLogReliabilityBody() never calls .sort() across people (only sorts picker options alphabetically by name, not by any fact)', (bodySrc.match(/\.sort\(/g) || []).length === 1 && bodySrc.includes("a.name.localeCompare(b.name)"));
}

// ── Test 5: pure-read source-text check ─────────────────────────────
{
  const allNewSrc = [minCheckableSrc, factsSrc, renderLogRelSrc, renderLogRelBodySrc].join('\n');
  check('no .set( anywhere in the new v2 code', !allNewSrc.includes('.set('));
  check('no .update( anywhere in the new v2 code', !allNewSrc.includes('.update('));
  check('no Firestore .add( anywhere (plain JS Set.add(), if any, excluded)', !allNewSrc.replace(/set\.add\(/g, '').includes('.add('));
  check('no .delete( anywhere in the new v2 code', !allNewSrc.includes('.delete('));
  check('no .batch( anywhere in the new v2 code', !allNewSrc.includes('.batch('));
  check("renderLogReliability() fetches fresh via source:'server'", (renderLogRelSrc.match(/source:\s*'server'/g) || []).length === 2);
  check("renderLogReliability() reads only timeLogs + users (same two collections Data Quality already reads)", renderLogRelSrc.includes(`collection('timeLogs')`) && renderLogRelSrc.includes(`collection('users')`) && !/collection\('(?!timeLogs|users)/.test(renderLogRelSrc));
}

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
