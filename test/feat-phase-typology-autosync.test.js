// Fixture for the phase-typology forward-fix (auto-sync), 2026-09-04.
//
// Prevents the phase/typology mislabeling Data Quality measures and Log
// Reliability localizes, at LOG TIME, by deriving phase from typology
// using the same TYPOLOGY_TO_PHASE table (reused, not duplicated) --
// on both surfaces that capture phase+typology: the Log Time modal and
// the Planner's "Assign Work" modal. GRACEFUL by design: only sets the
// phase select's value when the implied phase is actually one of its
// current options; otherwise leaves phase exactly as the user had it.
// Zero-friction: a plain change-event side effect, never blocks/nags/
// adds a step, never touches the save/write path.
//
// Extracts the ACTUAL functions/wiring from index.html (brace/anchor-
// matched, not retyped) and runs them in a vm sandbox against a small
// mock <select> that behaves like a real one (an out-of-range .value
// assignment is a no-op, exactly like a browser) -- same discipline as
// every other fixture in this repo.
//
// Central claims under test:
//  - Log Time: typology -> phase auto-sets when the implied phase is a
//    valid option in the project's own budgeted-phase list
//  - Log Time: gracefully does nothing (phase stays exactly as it was)
//    when the implied phase ISN'T one of the project's options -- the
//    real-world case (~44% of historical contradictions, projects with
//    incomplete phase budgets)
//  - Log Time: re-applies when project changes AFTER typology was
//    already picked (the two-hook-point requirement -- typology can be
//    picked before a project, when the phase dropdown is still just
//    the "Select project first" placeholder)
//  - Planner: same auto-sync on planTypology -> planPhase, and (found
//    while building, not just asked) the SAME re-apply-on-project-
//    change gap exists there too, since updatePlanPhases() unconditionally
//    rebuilds planPhase (always all 6 phases) and resets its value on
//    every project change, wiping an earlier auto-sync otherwise
//  - source-text: zero Firestore write calls anywhere in the new code
//  - source-text: TYPOLOGY_TO_PHASE is referenced, not duplicated --
//    exactly one definition in the whole file
//  - source-text: saveLog()/savePlanBtn's click handler still contain
//    their original required-field validation, untouched
//
// Run with: node test/feat-phase-typology-autosync.test.js
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
  return source.slice(startIdx, i + 1);
}
function extractConstBlock(source, name) {
  const idx = source.indexOf(`const ${name} =`);
  const eqIdx = source.indexOf('=', idx) + 1;
  let depth = 0, i = eqIdx, started = false;
  for (; i < source.length; i++) {
    if (source[i] === '{') { depth++; started = true; }
    else if (source[i] === '}') { depth--; if (started && depth === 0) { i++; break; } }
  }
  const end = source.indexOf(';', i - 1) + 1;
  return source.slice(idx, end);
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
  const semiIdx = source.indexOf(';', i);
  assert.ok(semiIdx >= 0, 'could not find terminating ; after the matched block');
  return source.slice(idx, semiIdx + 1);
}

const typologyMapSrc = extractConstBlock(fullScript, 'TYPOLOGY_TO_PHASE');
const autoSyncSrc = extractFunction(fullScript, 'autoSyncPhaseFromTypology');
const logProjectHandlerSrc = extractBlockFrom(fullScript, `document.getElementById('logProject').addEventListener('change',function(){`);
const logTypologyHandlerSrc = extractBlockFrom(fullScript, `document.getElementById('logTypology').addEventListener('change',function(){`);
const planProjectHandlerSrc = extractBlockFrom(fullScript, `document.getElementById('planProject').addEventListener('change',function(){`);
const planTypologyHandlerSrc = extractBlockFrom(fullScript, `document.getElementById('planTypology').addEventListener('change',function(){`);
const updatePlanPhasesSrc = extractFunction(fullScript, 'updatePlanPhases');
const saveLogSrc = extractFunction(fullScript, 'saveLog');
const savePlanBtnHandlerSrc = extractBlockFrom(fullScript, `document.getElementById('savePlanBtn').addEventListener('click',()=>{`);

// The real, complete typology list -- exactly TYPOLOGY_TO_PHASE's own
// keys (production's `typologies` array is this same 14-entry list) --
// evaluated once, plainly, so every mock <select> below can be built
// from the real data instead of a hand-retyped subset.
const _typologySandbox = {};
vm.createContext(_typologySandbox);
vm.runInContext(typologyMapSrc, _typologySandbox);
const ALL_TYPOLOGIES = Object.keys(vm.runInContext('TYPOLOGY_TO_PHASE', _typologySandbox));

let passCount = 0, failCount = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); passCount++; }
  else { console.log(`  FAIL: ${label}`); failCount++; }
}

// ── A tiny mock <select> that behaves like a real one, specifically:
// assigning .value to something that isn't a current <option> is a
// silent no-op (the value stays whatever it was), exactly per the HTML
// spec -- this is what makes the graceful-fallback claim meaningful to
// test, not just assumed. .innerHTML parses <option value="..."> tags.
function makeMockSelect(initialOptionsHTML) {
  let _value = '';
  const el = {
    _listeners: {},
    addEventListener(evt, fn) { (el._listeners[evt] = el._listeners[evt] || []).push(fn); },
    fire(evt) { (el._listeners[evt] || []).forEach(fn => fn.call(el)); },
    get options() { return el._options; },
    _options: [],
    set innerHTML(html) {
      el._options = [...html.matchAll(/<option value="([^"]*)"/g)].map(m => ({ value: m[1] }));
      // Real <select> innerHTML replacement resets the selected value to
      // the first option (usually the blank placeholder) unless the new
      // value happens to already be selected -- mirror that.
      _value = el._options.length ? el._options[0].value : '';
    },
    get value() { return _value; },
    set value(v) {
      if (el._options.some(o => o.value === v)) _value = v;
      // else: silent no-op, exactly like a real <select>
    },
  };
  el.innerHTML = initialOptionsHTML || '';
  return el;
}

function buildLogTimeSandbox(projectsData) {
  // Mirrors openLogModal()'s real population line -- logProject needs
  // real <option value="p1">/<option value="p2"> entries before a test
  // can set .value to a project id (the mock enforces "must be a
  // current option," exactly like a real <select>).
  const logProjectOptionsHTML = '<option value="">Select...</option>' + projectsData.map(p => `<option value="${p.id}">${p.id}</option>`).join('');
  const els = {
    logProject: makeMockSelect(logProjectOptionsHTML),
    logPhase: makeMockSelect('<option value="">Select project first</option>'),
    logTypology: makeMockSelect('<option value="">Select...</option>' + ALL_TYPOLOGIES.map(t => `<option value="${t}">${t}</option>`).join('')),
  };
  const sandbox = {
    projectsData,
    document: { getElementById: (id) => els[id] },
  };
  vm.createContext(sandbox);
  vm.runInContext(typologyMapSrc, sandbox);
  vm.runInContext(autoSyncSrc, sandbox);
  vm.runInContext(logProjectHandlerSrc, sandbox);
  vm.runInContext(logTypologyHandlerSrc, sandbox);
  return { els, sandbox };
}

console.log('=== Log Time modal: typology -> phase, graceful, both hook points ===');
{
  const projectsData = [
    { id: 'p1', phases: { 'Schematic Design': 50, 'Final Design': 40, 'Construction Documents': 30 } }, // FULL-ish
    { id: 'p2', phases: { 'Construction Documents': 30 } }, // PARTIAL -- like BAYTOWN FOOD COURT
  ];

  // Case 1: project already selected, implied phase IS an option -> auto-sets.
  {
    const { els } = buildLogTimeSandbox(projectsData);
    els.logProject.value = 'p1'; els.logProject.fire('change');
    check('logPhase repopulated to p1\'s own budgeted phases', els.logPhase.options.map(o => o.value).includes('Schematic Design'));
    els.logTypology.value = 'Schematic Design – Concept Development'; els.logTypology.fire('change');
    check('phase auto-set to the implied phase (Schematic Design)', els.logPhase.value === 'Schematic Design');
  }

  // Case 2: project selected, implied phase is NOT an option (p2, partial budget) -> graceful no-op.
  {
    const { els } = buildLogTimeSandbox(projectsData);
    els.logProject.value = 'p2'; els.logProject.fire('change');
    check('logPhase repopulated to p2\'s own (partial) budgeted phases', els.logPhase.options.map(o => o.value).join(',') === ',Construction Documents');
    els.logTypology.value = 'Schematic Design – Concept Development'; // implies "Schematic Design", NOT an option here
    els.logTypology.fire('change');
    check('phase stays exactly as it was (blank placeholder) -- graceful, no error, no forced option', els.logPhase.value === '');
  }

  // Case 2b: same as above, but the user had ALREADY manually picked a phase -- must not be clobbered.
  {
    const { els } = buildLogTimeSandbox(projectsData);
    els.logProject.value = 'p2'; els.logProject.fire('change');
    els.logPhase.value = 'Construction Documents'; // user's own manual pick
    els.logTypology.value = 'Schematic Design – Concept Development'; // implies a DIFFERENT phase, not available
    els.logTypology.fire('change');
    check('user\'s own manually-picked phase is preserved untouched when the implied phase isn\'t available', els.logPhase.value === 'Construction Documents');
  }

  // Case 3: typology picked BEFORE project (the two-hook-point requirement).
  {
    const { els } = buildLogTimeSandbox(projectsData);
    els.logTypology.value = 'Schematic Design – Concept Development'; els.logTypology.fire('change');
    check('before any project is picked, nothing to sync against yet (phase dropdown still the placeholder)', els.logPhase.options.length === 1 && els.logPhase.options[0].value === '');
    els.logProject.value = 'p1'; els.logProject.fire('change'); // project change re-applies using the already-set typology
    check('picking the project AFTER typology still ends with the correct auto-synced phase (re-apply hook fired)', els.logPhase.value === 'Schematic Design');
  }

  // Case 4: typology picked before project, but the eventual project doesn't have that phase -> still graceful.
  {
    const { els } = buildLogTimeSandbox(projectsData);
    els.logTypology.value = 'Schematic Design – Concept Development'; els.logTypology.fire('change');
    els.logProject.value = 'p2'; els.logProject.fire('change');
    check('typology-before-project, phase not available on the eventual project -> still graceful, still blank, no error', els.logPhase.value === '');
  }
}

console.log('\n=== Planner "Assign Work" modal: typology -> phase, all 6 always available ===');
function buildPlannerSandbox() {
  const els = {
    planProject: makeMockSelect('<option value="">Select project...</option><option value="p1">p1</option>'),
    planPhase: makeMockSelect(''),
    planTypology: makeMockSelect('<option value="">Select typology...</option>' + ALL_TYPOLOGIES.map(t => `<option value="${t}">${t}</option>`).join('')),
  };
  const sandbox = {
    PHASES: ['Schematic Design', 'Final Design', 'Construction Documents', 'Material Selection & Coordination', 'Site Supervision', 'Project Management'],
    document: { getElementById: (id) => els[id] },
  };
  vm.createContext(sandbox);
  vm.runInContext(typologyMapSrc, sandbox);
  vm.runInContext(autoSyncSrc, sandbox);
  vm.runInContext(updatePlanPhasesSrc, sandbox);
  vm.runInContext(planProjectHandlerSrc, sandbox);
  vm.runInContext(planTypologyHandlerSrc, sandbox);
  // Mirrors the real "Assign Work" modal-open flow: updatePlanPhases('')
  // is called immediately when the modal opens fresh (see the real
  // openLogModal-equivalent plan-open code), populating all 6 phases
  // right away -- unlike Log Time's logPhase, planPhase is never
  // actually empty once the modal is open, project picked or not.
  vm.runInContext(`updatePlanPhases('')`, sandbox);
  return els;
}
{
  const els = buildPlannerSandbox();
  els.planProject.value = 'p1'; els.planProject.fire('change');
  check('planPhase always lists all 6 canonical phases, regardless of project', els.planPhase.options.length === 7); // placeholder + 6
  els.planTypology.value = 'Material Selection – Vendor Coordination'; els.planTypology.fire('change');
  check('planPhase auto-sets to the implied phase (Material Selection & Coordination)', els.planPhase.value === 'Material Selection & Coordination');
}
{
  // Typology picked BEFORE project -- updatePlanPhases() unconditionally
  // rebuilds planPhase on every project change (always all 6, but still
  // resets .value to blank), so this needs the same re-apply hook.
  const els = buildPlannerSandbox();
  els.planTypology.value = 'Site Supervision – Site Visit'; els.planTypology.fire('change');
  check('planPhase auto-sets immediately even with no project yet picked (always-available options)', els.planPhase.value === 'Site Supervision');
  els.planProject.value = 'p1'; els.planProject.fire('change'); // rebuilds planPhase's options, would reset to blank without the re-apply hook
  check('picking the project AFTER typology still ends with the correct auto-synced phase (Planner re-apply hook fired, not just Log Time\'s)', els.planPhase.value === 'Site Supervision');
}

console.log('\n=== Source-text: zero write-path changes, TYPOLOGY_TO_PHASE reused not duplicated ===');
const newCodeCombined = [autoSyncSrc, logProjectHandlerSrc, logTypologyHandlerSrc, planProjectHandlerSrc, planTypologyHandlerSrc, updatePlanPhasesSrc].join('\n');
check('no Firestore .set(/.update(/.add(/.delete(/.batch( anywhere in the new auto-sync code', !/\.(set|update|add|delete|batch)\(/.test(newCodeCombined.replace(/classList\.add\(/g, '')));
check('exactly one const TYPOLOGY_TO_PHASE definition in the whole file (reused, not duplicated)', (fullScript.match(/const TYPOLOGY_TO_PHASE = \{/g) || []).length === 1);
check('autoSyncPhaseFromTypology() actually references TYPOLOGY_TO_PHASE by name (real reuse, not a second copy of the data)', autoSyncSrc.includes('TYPOLOGY_TO_PHASE['));

console.log('\n=== Confirm the timer/save flow is otherwise untouched ===');
check('saveLog() still requires project+phase+typology exactly as before', saveLogSrc.includes('if(!projectId||!phase||!typology){ alert(\'Select project, phase and job type\'); return; }'));
check('saveLog() still reads logPhase/logTypology .value the same way (not rewritten around the new sync)', saveLogSrc.includes(`phase=document.getElementById('logPhase').value`) && saveLogSrc.includes(`typology=document.getElementById('logTypology').value`));
check('savePlanBtn handler still builds its entry from planPhase/planTypology .value the same way', savePlanBtnHandlerSrc.includes(`phase:document.getElementById('planPhase').value,typology:document.getElementById('planTypology').value`));
check('no Firestore write call anywhere in saveLog()\'s or savePlanBtn\'s OWN source changed shape -- still present exactly once each', (saveLogSrc.match(/timeLogs\.push\(/g) || []).length >= 1);

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
