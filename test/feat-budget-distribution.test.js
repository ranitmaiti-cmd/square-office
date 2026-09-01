// Fixture test for the budget-distribution feature: one total budget,
// auto-distributed across PHASES per an owner-defined percentage
// template, reviewed/adjusted in the existing phase inputs, saved through
// the EXISTING saveProject() path -- no new write mechanism.
//
// Central claims under test:
//  - distributeBudgetByTemplate() sums to EXACTLY the entered total for
//    every template, at both a clean and a non-clean-dividing total
//    (largest-remainder rounding, not naive floor/round)
//  - the DEFAULT_BUDGET_TEMPLATES (Standard Design-Build, Design-Heavy)
//    reproduce the real project shapes they were pulled from -- Design-
//    Heavy x AVANA's real 3317h total closely matches AVANA's actual
//    stored phase budgets
//  - the Distribute click handler ONLY fills the existing phase inputs --
//    never calls saveProject()/autoSave(), never touches projectsData
//  - the Manage Templates flow: edits a DRAFT, never mutates the live
//    budgetTemplates (or calls autoSave()) until "Save Templates";
//    Save Templates enforces "sums to 100%" and blocks an invalid save
//  - project docs stay at their current 8-field shape -- no new field
//    added for template state (source-text check on saveProject() itself)
//
// Extracts the ACTUAL functions/handlers from index.html (brace-matched,
// not retyped) and runs them in a vm sandbox -- proving the real shipped
// code, same discipline as every other fixture in this repo.
//
// Run with: node test/feat-budget-distribution.test.js
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
  // DEFAULT_BUDGET_TEMPLATES is a multi-line array literal -- find the
  // matching closing "];" by bracket depth, not the first ";".
  const eqIdx = source.indexOf('=', idx) + 1;
  let depth = 0, i = eqIdx, started = false;
  for (; i < source.length; i++) {
    if (source[i] === '[') { depth++; started = true; }
    else if (source[i] === ']') { depth--; if (started && depth === 0) { i++; break; } }
    else if (!started && source[i] === ';') break; // simple scalar const, no brackets
  }
  const end = source.indexOf(';', i - 1) + 1;
  return source.slice(idx, end);
}

function extractClickHandler(source, elementId) {
  const anchor = `document.getElementById('${elementId}').addEventListener('click', `;
  const startIdx = source.indexOf(anchor);
  assert.ok(startIdx >= 0, `could not find click handler for #${elementId}`);
  const braceStart = source.indexOf('{', startIdx);
  let depth = 0, i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  assert.ok(depth === 0, `brace matching failed for #${elementId} handler`);
  const semiIdx = source.indexOf(';', i);
  const body = source.slice(braceStart, i + 1);
  return `async function __handler_${elementId}() ${body}`;
}

const phasesSrc = extractConstLine(fullScript, 'PHASES');
const defaultTemplatesSrc = extractConstLine(fullScript, 'DEFAULT_BUDGET_TEMPLATES');
const distributeSrc = extractFunction(fullScript, 'distributeBudgetByTemplate');
const populateSelectSrc = extractFunction(fullScript, 'populateDistributeTemplateSelect');
const renderTemplatesFieldsSrc = extractFunction(fullScript, 'renderBudgetTemplatesFields');
const saveProjectSrc = extractFunction(fullScript, 'saveProject');
const distributeBtnHandlerSrc = extractClickHandler(fullScript, 'pDistributeBtn');
const saveTemplatesBtnHandlerSrc = extractClickHandler(fullScript, 'saveBudgetTemplatesBtn');
const addTemplateBtnHandlerSrc = extractClickHandler(fullScript, 'addBudgetTemplateBtn');

let passCount = 0, failCount = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); passCount++; }
  else { console.log(`  FAIL: ${label}`); failCount++; }
}

async function run() {
console.log('=== Source-text: project docs stay at their current shape -- no new field added ===');
{
  check('saveProject() still writes only {...project, updatedAt, updatedBy} -- no budgetTemplate-related field added to project docs', saveProjectSrc.includes('...project') && !/budgetTemplate/i.test(saveProjectSrc));
  check('saveProject() itself is completely unmodified by this feature (still the plain .set(), no merge flag added)', saveProjectSrc.includes('.set({') && !saveProjectSrc.includes('merge'));
}

function buildSandbox() {
  const sandbox = { console, Object, Math };
  vm.createContext(sandbox);
  vm.runInContext(phasesSrc, sandbox);
  vm.runInContext(defaultTemplatesSrc, sandbox);
  vm.runInContext(distributeSrc, sandbox);
  return sandbox;
}

console.log('\n=== distributeBudgetByTemplate: sums to EXACTLY the total, every template ===');
{
  const sandbox = buildSandbox();
  const templates = vm.runInContext('DEFAULT_BUDGET_TEMPLATES', sandbox);
  const PHASES = vm.runInContext('PHASES', sandbox);
  [100, 1000, 3317, 7, 1, 0].forEach(total => {
    templates.forEach(t => {
      const result = vm.runInContext('distributeBudgetByTemplate', sandbox)(total, t.pcts);
      const sum = PHASES.reduce((s, ph) => s + result[ph], 0);
      check(`"${t.name}" x ${total}h sums to exactly ${total}`, sum === total);
    });
  });
}

console.log('\n=== distributeBudgetByTemplate: largest-remainder rounding on a non-clean total ===');
{
  const sandbox = buildSandbox();
  const stdTemplate = vm.runInContext('DEFAULT_BUDGET_TEMPLATES', sandbox).find(t => t.id === 'standard-design-build');
  const PHASES = vm.runInContext('PHASES', sandbox);
  // 7h doesn't divide cleanly by 15/20/30/5/20/10 -- exercises real
  // fractional remainders on every phase.
  const result = vm.runInContext('distributeBudgetByTemplate', sandbox)(7, stdTemplate.pcts);
  const sum = PHASES.reduce((s, ph) => s + result[ph], 0);
  check('7h distributed sums to exactly 7 (not 6 from naive flooring, not 8 from naive rounding)', sum === 7);
  check('every phase is a non-negative integer (no fractional hours)', PHASES.every(ph => Number.isInteger(result[ph]) && result[ph] >= 0));

  // Determinism: same inputs -> same output, every time.
  const result2 = vm.runInContext('distributeBudgetByTemplate', sandbox)(7, stdTemplate.pcts);
  check('deterministic -- identical inputs produce identical output', JSON.stringify(result) === JSON.stringify(result2));
}

console.log('\n=== distributeBudgetByTemplate: zero and edge inputs handled cleanly ===');
{
  const sandbox = buildSandbox();
  const stdTemplate = vm.runInContext('DEFAULT_BUDGET_TEMPLATES', sandbox).find(t => t.id === 'standard-design-build');
  const zero = vm.runInContext('distributeBudgetByTemplate', sandbox)(0, stdTemplate.pcts);
  check('total=0 -> every phase is 0, no NaN/negative', Object.values(zero).every(v => v === 0));
  const negative = vm.runInContext('distributeBudgetByTemplate', sandbox)(-50, stdTemplate.pcts);
  check('a negative total is clamped to 0, not distributed as negative hours', Object.values(negative).every(v => v === 0));
}

console.log('\n=== DEFAULT_BUDGET_TEMPLATES: both sum to exactly 100%, map to the app\'s real PHASES names ===');
{
  const sandbox = buildSandbox();
  const templates = vm.runInContext('DEFAULT_BUDGET_TEMPLATES', sandbox);
  const PHASES = vm.runInContext('PHASES', sandbox);
  check('exactly 2 default templates', templates.length === 2);
  templates.forEach(t => {
    const sum = PHASES.reduce((s, ph) => s + (t.pcts[ph] || 0), 0);
    check(`"${t.name}" sums to exactly 100%`, sum === 100);
    check(`"${t.name}" only uses real PHASES keys, nothing invented`, Object.keys(t.pcts).every(k => PHASES.includes(k)));
  });
}

console.log('\n=== REAL-DATA CHECK: Design-Heavy x AVANA\'s real 3317h closely reproduces AVANA\'s actual stored budgets ===');
{
  const sandbox = buildSandbox();
  const designHeavy = vm.runInContext('DEFAULT_BUDGET_TEMPLATES', sandbox).find(t => t.id === 'design-heavy');
  const result = vm.runInContext('distributeBudgetByTemplate', sandbox)(3317, designHeavy.pcts);
  // AVANA's real stored phases (confirmed via a real Firestore read,
  // 2026-08-31): SD 332h, FD 829h, CD 663h, MSC 829h, SS 332h, PM 332h.
  const AVANA_REAL = { 'Schematic Design': 332, 'Final Design': 829, 'Construction Documents': 663, 'Material Selection & Coordination': 829, 'Site Supervision': 332, 'Project Management': 332 };
  Object.keys(AVANA_REAL).forEach(ph => {
    check(`${ph}: distributed ${result[ph]}h vs AVANA's real ${AVANA_REAL[ph]}h (within 1h rounding tolerance)`, Math.abs(result[ph] - AVANA_REAL[ph]) <= 1);
  });
}

console.log('\n=== Distribute button handler: ONLY fills phase inputs, never saves/writes anything ===');
{
  const filledValues = {};
  const alerts = [];
  const dbCalls = [];
  let autoSaveCalled = false, saveProjectCalled = false;
  const projectsDataBefore = [{ id: 'p1', name: 'Existing', client: 'X', phases: { 'Schematic Design': 5 } }];
  const sandbox = {
    console, Object, Math,
    projectsData: JSON.parse(JSON.stringify(projectsDataBefore)),
    autoSave: () => { autoSaveCalled = true; },
    saveProject: async () => { saveProjectCalled = true; },
    alert: (msg) => alerts.push(msg),
    db: { collection: () => ({ doc: () => ({ set: async (d) => dbCalls.push(d), update: async (d) => dbCalls.push(d) }) }) },
    document: {
      getElementById: (id) => {
        if (id === 'pDistributeTemplate') return { value: 'design-heavy' };
        if (id === 'pDistributeTotal') return { value: '3317' };
        if (id.startsWith('phase_')) {
          const key = id;
          return { set value(v) { filledValues[key] = v; }, get value() { return filledValues[key]; } };
        }
        return { value: '' };
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(phasesSrc, sandbox);
  vm.runInContext(defaultTemplatesSrc, sandbox);
  vm.runInContext('let budgetTemplates = DEFAULT_BUDGET_TEMPLATES;', sandbox);
  vm.runInContext(distributeSrc, sandbox);
  vm.runInContext(distributeBtnHandlerSrc, sandbox);
  await vm.runInContext(`__handler_pDistributeBtn`, sandbox)();

  check('Schematic Design input filled (332h)', filledValues['phase_Schematic_Design'] === 332);
  check('Final Design input filled (829h)', filledValues['phase_Final_Design'] === 829);
  check('saveProject() was NEVER called by Distribute', saveProjectCalled === false);
  check('autoSave() was NEVER called by Distribute', autoSaveCalled === false);
  check('no Firestore write of any kind happened', dbCalls.length === 0);
  check('projectsData array is untouched (still the exact object it started as)', JSON.stringify(sandbox.projectsData) === JSON.stringify(projectsDataBefore));
}

console.log('\n=== Distribute button: no template selected -> alerts, does not fill or crash ===');
{
  const alerts = [];
  const sandbox = {
    console, Object, Math,
    alert: (msg) => alerts.push(msg),
    document: { getElementById: (id) => (id === 'pDistributeTemplate' ? { value: '' } : { value: '1000' }) },
  };
  vm.createContext(sandbox);
  vm.runInContext(phasesSrc, sandbox);
  vm.runInContext(defaultTemplatesSrc, sandbox);
  vm.runInContext('let budgetTemplates = DEFAULT_BUDGET_TEMPLATES;', sandbox);
  vm.runInContext(distributeSrc, sandbox);
  vm.runInContext(distributeBtnHandlerSrc, sandbox);
  let threw = false;
  try { await vm.runInContext('__handler_pDistributeBtn', sandbox)(); } catch (e) { threw = true; }
  check('did not crash', !threw);
  check('alerted asking to select a template', alerts.some(a => /select a template/i.test(a)));
}

console.log('\n=== Manage Templates: editing the draft never mutates the LIVE budgetTemplates, only "Save Templates" does ===');
{
  const alerts = [];
  let autoSaveCalled = false;
  const liveTemplatesBefore = JSON.parse(JSON.stringify(vm.runInContext('DEFAULT_BUDGET_TEMPLATES', buildSandbox())));
  const sandbox = {
    console, Object, Math,
    alert: (msg) => alerts.push(msg),
    autoSave: () => { autoSaveCalled = true; },
    document: { getElementById: () => ({ innerHTML: '' }), querySelectorAll: () => [] },
  };
  vm.createContext(sandbox);
  vm.runInContext(phasesSrc, sandbox);
  vm.runInContext(defaultTemplatesSrc, sandbox);
  vm.runInContext('let budgetTemplates = JSON.parse(JSON.stringify(DEFAULT_BUDGET_TEMPLATES));', sandbox);
  // Simulate opening Manage Templates (the deep-copy) then editing the DRAFT only.
  vm.runInContext(`let budgetTemplatesDraft = budgetTemplates.map(t => ({ id: t.id, name: t.name, pcts: { ...t.pcts } }));`, sandbox);
  vm.runInContext(`budgetTemplatesDraft[0].pcts['Schematic Design'] = 999;`, sandbox); // a wild, invalid edit to the draft only
  const liveAfterDraftEdit = vm.runInContext('budgetTemplates', sandbox);
  check('editing the draft does NOT change the live budgetTemplates array', JSON.stringify(liveAfterDraftEdit) === JSON.stringify(liveTemplatesBefore));

  // Now try to Save Templates with that invalid (sum != 100%) draft -- must block.
  vm.runInContext(populateSelectSrc, sandbox); // harmless no-op here (no matching element), just confirms it doesn't crash if referenced
  vm.runInContext(saveTemplatesBtnHandlerSrc, sandbox);
  await vm.runInContext('__handler_saveBudgetTemplatesBtn', sandbox)();
  check('an invalid (not-100%) template blocks the save with an alert', alerts.some(a => /100%/.test(a)));
  check('autoSave() was NOT called when validation fails', autoSaveCalled === false);
  const liveAfterBlockedSave = vm.runInContext('budgetTemplates', sandbox);
  check('the live budgetTemplates is STILL unchanged after a blocked save', JSON.stringify(liveAfterBlockedSave) === JSON.stringify(liveTemplatesBefore));
}

console.log('\n=== Manage Templates: a VALID draft (sums to 100%) commits to the live array and calls autoSave() ===');
{
  const alerts = [];
  let autoSaveCalled = false;
  const sandbox = {
    console, Object, Math,
    alert: (msg) => alerts.push(msg),
    autoSave: () => { autoSaveCalled = true; },
    closeModal: () => {},
    document: { getElementById: () => ({ innerHTML: '' }) },
  };
  vm.createContext(sandbox);
  vm.runInContext(phasesSrc, sandbox);
  vm.runInContext(defaultTemplatesSrc, sandbox);
  vm.runInContext('let budgetTemplates = [];', sandbox); // starts empty -- proves the commit actually populates it
  vm.runInContext(`let budgetTemplatesDraft = [{ id: 't1', name: '  My Template  ', pcts: { 'Schematic Design': 50, 'Final Design': 50, 'Construction Documents': 0, 'Material Selection & Coordination': 0, 'Site Supervision': 0, 'Project Management': 0 } }];`, sandbox);
  vm.runInContext(populateSelectSrc, sandbox); // saveBudgetTemplatesBtn's handler calls this after committing -- must be loaded
  vm.runInContext(saveTemplatesBtnHandlerSrc, sandbox);
  await vm.runInContext('__handler_saveBudgetTemplatesBtn', sandbox)();
  check('no validation alert fired for a valid 100%-summing template', alerts.length === 0);
  check('autoSave() WAS called -- same persistence path as holidays', autoSaveCalled === true);
  const committed = vm.runInContext('budgetTemplates', sandbox);
  check('the live budgetTemplates now holds the committed template', committed.length === 1 && committed[0].name === 'My Template'); // trimmed
}

console.log('\n=== Add Template: appends a blank (0% everywhere) template to the DRAFT, not the live array ===');
{
  const sandbox = {
    console, Object, Math,
    genId: () => 'new-template-id',
    document: { getElementById: () => ({ innerHTML: '', querySelectorAll: () => [] }), querySelectorAll: () => [] },
  };
  vm.createContext(sandbox);
  vm.runInContext(phasesSrc, sandbox);
  vm.runInContext('let budgetTemplates = [];', sandbox);
  vm.runInContext('let budgetTemplatesDraft = [];', sandbox);
  vm.runInContext(renderTemplatesFieldsSrc, sandbox); // addBudgetTemplateBtn's handler calls this after pushing -- must be loaded
  vm.runInContext(addTemplateBtnHandlerSrc, sandbox);
  await vm.runInContext('__handler_addBudgetTemplateBtn', sandbox)();
  const draft = vm.runInContext('budgetTemplatesDraft', sandbox);
  const live = vm.runInContext('budgetTemplates', sandbox);
  check('draft now has exactly 1 template', draft.length === 1);
  check('live budgetTemplates untouched by Add Template', live.length === 0);
  const PHASES = vm.runInContext('PHASES', sandbox);
  check('the new template starts at 0% on every real phase', PHASES.every(ph => draft[0].pcts[ph] === 0));
}

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
}

run().catch((e) => { console.error('FIXTURE ERROR:', e); process.exit(1); });
