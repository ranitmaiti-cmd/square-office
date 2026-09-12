// Fixture for project stage-completion / progress-tracking (2026-09-13).
//
// Central claims under test:
//  - isPhaseAtRisk(): pure, both conditions required (hours-status !== 'ok'
//    AND not confirmed)
//  - saveProjectPhaseStatus(): targeted dot-path .update() only, NEVER a
//    full .set() -- proven by inspecting the actual Firestore calls made
//  - write-safety: freeze-checks the CURRENT SERVER value before writing --
//    a stale "mark ready" click on an already-confirmed phase is BLOCKED
//    (no .update() call at all), and re-confirming an already-confirmed
//    phase is a no-op that does NOT overwrite the original confirmedBy/At
//  - the REQUIRED collision fix: editing a project's budget and saving
//    through the real saveProjBtn handler logic preserves the existing
//    phaseStatus/phaseStatusMeta -- proven against the ACTUAL handler
//    source, not a reimplementation
//  - role-gating: the Confirm Done button is emitted ONLY for
//    currentUser.isAdmin; Mark Ready is emitted for everyone
//  - the "N phases at risk" project-card summary chip count is correct,
//    computed with the SAME numbers the phase rows themselves render
//  - accountability metadata (readyBy/readyAt/confirmedBy/confirmedAt) is
//    written, but NEVER aggregated anywhere in the file -- source-text
//    proof there is no per-person completion-speed/ranking function
//  - isolation: saveProject() itself, renderLeaves()/submitLeaveBtn/
//    cancelLeave()/renderApprovals() are all byte-for-byte unchanged
//
// Run with: node test/feat-project-stage-status.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');
const assert = require('assert');

const norm = (s) => s.replace(/\r\n/g, '\n');
const REPO_ROOT = 'D:/SQUARE/ADMIN/SQUARE-Office/finalphase/01072026';
const INDEX_HTML = path.join(REPO_ROOT, 'index.html');
const src = norm(fs.readFileSync(INDEX_HTML, 'utf8'));
const scriptMatch = src.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(scriptMatch, 'could not find inline <script> block in index.html');
const fullScript = scriptMatch[1];

const mainSrc = norm(execSync('git show main:index.html', { cwd: REPO_ROOT, maxBuffer: 1024 * 1024 * 20 }).toString('utf8'));
const mainScriptMatch = mainSrc.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(mainScriptMatch, 'could not find inline <script> block in main:index.html');
const mainFullScript = mainScriptMatch[1];

let passCount = 0, failCount = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); passCount++; }
  else { console.log(`  FAIL: ${label}`); failCount++; }
}

function extractFunction(source, name) {
  let startIdx = source.indexOf(`async function ${name}(`);
  if (startIdx < 0) startIdx = source.indexOf(`function ${name}(`);
  assert.ok(startIdx >= 0, `could not find "function ${name}(" in the given source`);
  const parenStart = source.indexOf('(', startIdx);
  let pdepth = 0, j = parenStart;
  for (; j < source.length; j++) {
    if (source[j] === '(') pdepth++;
    else if (source[j] === ')') { pdepth--; if (pdepth === 0) break; }
  }
  const braceStart = source.indexOf('{', j);
  let depth = 0, i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  return source.slice(startIdx, i + 1);
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
  return source.slice(idx, i + 1);
}

(async () => {
  // ─────────────────────────────────────────────────────────────
  console.log('=== Isolation: unrelated systems byte-for-byte unchanged from main ===');
  check('saveProject() itself is byte-for-byte unchanged (only its CALL SITE changed)',
    extractFunction(fullScript, 'saveProject') === extractFunction(mainFullScript, 'saveProject'));
  check('renderLeaves() is byte-for-byte unchanged', extractFunction(fullScript, 'renderLeaves') === extractFunction(mainFullScript, 'renderLeaves'));
  check('the submitLeaveBtn handler is byte-for-byte unchanged',
    extractBlockFrom(fullScript, "getElementById('submitLeaveBtn').addEventListener('click'") ===
    extractBlockFrom(mainFullScript, "getElementById('submitLeaveBtn').addEventListener('click'"));
  check('cancelLeave() is byte-for-byte unchanged',
    extractBlockFrom(fullScript, 'window.cancelLeave = function') === extractBlockFrom(mainFullScript, 'window.cancelLeave = function'));
  check('renderApprovals() is byte-for-byte unchanged', extractFunction(fullScript, 'renderApprovals') === extractFunction(mainFullScript, 'renderApprovals'));

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== isPhaseAtRisk(): pure, both conditions required ===');
  const atRiskSrc = extractFunction(fullScript, 'isPhaseAtRisk');
  {
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(atRiskSrc, sandbox);
    check('near/not-confirmed -> at risk', vm.runInContext("isPhaseAtRisk('near', null)", sandbox) === true);
    check('over/ready-not-confirmed -> at risk', vm.runInContext("isPhaseAtRisk('over', 'ready')", sandbox) === true);
    check('near/confirmed -> NOT at risk (confirmed clears it even at high hours)', vm.runInContext("isPhaseAtRisk('near', 'confirmed')", sandbox) === false);
    check('ok/not-confirmed -> NOT at risk (low hours, no urgency yet)', vm.runInContext("isPhaseAtRisk('ok', null)", sandbox) === false);
    check('over/confirmed -> NOT at risk', vm.runInContext("isPhaseAtRisk('over', 'confirmed')", sandbox) === false);
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== saveProjectPhaseStatus(): targeted dot-path .update() only, with freeze-check ===');
  const saveStatusSrc = extractFunction(fullScript, 'saveProjectPhaseStatus');
  check('uses .update( for the write', saveStatusSrc.includes('.update('));
  check('never uses .set( (that would be the collision this feature must avoid)', !saveStatusSrc.includes('.set('));
  check('the update key is a dot-path template (`phaseStatus.${phase}`), not a nested object literal', /\[`phaseStatus\.\$\{phase\}`\]/.test(saveStatusSrc));
  check('re-reads the server (get) BEFORE writing -- the freeze-check', /\.get\(\s*\{\s*source:\s*'server'\s*\}\s*\)/.test(saveStatusSrc));

  function makeDb(store) {
    const calls = [];
    const db = {
      collection(coll) {
        return {
          doc(id) {
            return {
              async get() {
                calls.push({ op: 'get', coll, id });
                const data = store[coll] && store[coll][id];
                return { exists: data !== undefined, data: () => JSON.parse(JSON.stringify(data)) };
              },
              async update(fields) {
                calls.push({ op: 'update', coll, id, fields });
                const doc = (store[coll] = store[coll] || {}, store[coll][id] = store[coll][id] || {});
                for (const [pathStr, val] of Object.entries(fields)) {
                  const parts = pathStr.split('.');
                  let cur = doc;
                  for (let i = 0; i < parts.length - 1; i++) { cur[parts[i]] = cur[parts[i]] || {}; cur = cur[parts[i]]; }
                  cur[parts[parts.length - 1]] = val;
                }
              },
            };
          },
        };
      },
    };
    return { db, calls };
  }

  function makeStatusSandbox(store, adminName) {
    const { db, calls } = makeDb(store);
    const sandbox = {
      console, Date,
      db, calls,
      staleVersionLockout: false,
      currentUser: { name: adminName || 'PM Priya', isAdmin: true },
      projectsData: [{ id: 'p1', phaseStatus: JSON.parse(JSON.stringify((store.projects && store.projects.p1 && store.projects.p1.phaseStatus) || {})) }],
      alert: () => {},
    };
    return sandbox;
  }

  console.log('\n--- Fresh phase (no status yet): marking ready succeeds ---');
  {
    const store = { projects: { p1: { id: 'p1', name: 'Test', phases: { 'Construction Documents': 60 } } } };
    const sandbox = makeStatusSandbox(store);
    vm.createContext(sandbox);
    vm.runInContext(saveStatusSrc, sandbox);
    const result = await vm.runInContext("saveProjectPhaseStatus('p1', 'Construction Documents', 'ready')", sandbox);
    check('write succeeds', result.ok === true && result.status === 'ready');
    check('exactly one update() call', sandbox.calls.filter((c) => c.op === 'update').length === 1);
    check('server doc now has phaseStatus.Construction Documents = ready', store.projects.p1.phaseStatus['Construction Documents'] === 'ready');
    check('readyBy/readyAt metadata written', store.projects.p1.phaseStatusMeta['Construction Documents'].readyBy && store.projects.p1.phaseStatusMeta['Construction Documents'].readyAt);
    check('sibling fields (name, phases) on the server doc are untouched', store.projects.p1.name === 'Test' && store.projects.p1.phases['Construction Documents'] === 60);
  }

  console.log('\n--- Write-safety: a stale "mark ready" on an ALREADY-CONFIRMED phase is BLOCKED ---');
  {
    const store = { projects: { p1: { id: 'p1', phaseStatus: { 'Construction Documents': 'confirmed' }, phaseStatusMeta: { 'Construction Documents': { confirmedBy: 'PM Priya', confirmedAt: '2026-09-01T00:00:00.000Z' } } } } };
    const sandbox = makeStatusSandbox(store);
    vm.createContext(sandbox);
    vm.runInContext(saveStatusSrc, sandbox);
    const result = await vm.runInContext("saveProjectPhaseStatus('p1', 'Construction Documents', 'ready')", sandbox);
    check('the write is BLOCKED', result.blocked === true && result.status === 'confirmed');
    check('ZERO update() calls -- confirmed is never regressed to ready', sandbox.calls.filter((c) => c.op === 'update').length === 0);
    check('the server value is genuinely still confirmed', store.projects.p1.phaseStatus['Construction Documents'] === 'confirmed');
  }

  console.log('\n--- Write-safety: re-confirming an already-confirmed phase is a no-op (preserves original confirmedBy/At) ---');
  {
    const ORIGINAL_META = { confirmedBy: 'PM Priya', confirmedAt: '2026-09-01T00:00:00.000Z' };
    const store = { projects: { p1: { id: 'p1', phaseStatus: { 'Construction Documents': 'confirmed' }, phaseStatusMeta: { 'Construction Documents': { ...ORIGINAL_META } } } } };
    const sandbox = makeStatusSandbox(store, 'A Different Admin');
    vm.createContext(sandbox);
    vm.runInContext(saveStatusSrc, sandbox);
    const result = await vm.runInContext("saveProjectPhaseStatus('p1', 'Construction Documents', 'confirmed')", sandbox);
    check('reported as a no-op', result.ok === true && result.noop === true);
    check('ZERO update() calls', sandbox.calls.filter((c) => c.op === 'update').length === 0);
    check('the ORIGINAL confirmedBy/confirmedAt are preserved, not overwritten by the re-click', JSON.stringify(store.projects.p1.phaseStatusMeta['Construction Documents']) === JSON.stringify(ORIGINAL_META));
  }

  console.log('\n--- Confirming a genuinely-ready phase succeeds normally ---');
  {
    const store = { projects: { p1: { id: 'p1', phaseStatus: { 'Construction Documents': 'ready' }, phaseStatusMeta: { 'Construction Documents': { readyBy: 'Staffer', readyAt: '2026-09-10T00:00:00.000Z' } } } } };
    const sandbox = makeStatusSandbox(store);
    vm.createContext(sandbox);
    vm.runInContext(saveStatusSrc, sandbox);
    const result = await vm.runInContext("saveProjectPhaseStatus('p1', 'Construction Documents', 'confirmed')", sandbox);
    check('write succeeds', result.ok === true && result.status === 'confirmed' && !result.noop);
    check('confirmedBy/confirmedAt written, readyBy/readyAt from before still present (not clobbered)',
      store.projects.p1.phaseStatusMeta['Construction Documents'].confirmedBy &&
      store.projects.p1.phaseStatusMeta['Construction Documents'].readyBy === 'Staffer');
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== REQUIRED collision fix: editing a project preserves phaseStatus/phaseStatusMeta ===');
  // Executes the ACTUAL saveProjBtn handler source (not a reimplementation)
  // against a fake form + an existing project that already has phase
  // status, and inspects the `data` object it builds for saveProject().
  const saveProjBtnSrc = extractBlockFrom(fullScript, "getElementById('saveProjBtn').addEventListener('click'");
  check('the handler reads existingProj.phaseStatus/phaseStatusMeta forward into data', saveProjBtnSrc.includes('phaseStatus:existingProj?.phaseStatus') && saveProjBtnSrc.includes('phaseStatusMeta:existingProj?.phaseStatusMeta'));
  {
    const EXISTING_STATUS = { 'Schematic Design': 'confirmed', 'Final Design': 'ready' };
    const EXISTING_META = { 'Schematic Design': { confirmedBy: 'PM Priya', confirmedAt: '2026-08-01T00:00:00.000Z' } };
    const formValues = {
      pName: 'Renamed Project', pClientSelect: 'Acme', pStart: '2026-01-01', pEnd: '2026-12-31',
      phase_Schematic_Design: '50', phase_Final_Design: '0', phase_Construction_Documents: '0',
      'phase_Material_Selection_&_Coordination': '0', phase_Site_Supervision: '0', phase_Project_Management: '0',
    };
    let savedData = null;
    const elements = { getElementById: (id) => ({ value: formValues[id] !== undefined ? formValues[id] : '0', textContent: '' }) };
    const sandbox = {
      console, parseInt,
      document: elements,
      PHASES: ['Schematic Design', 'Final Design', 'Construction Documents', 'Material Selection & Coordination', 'Site Supervision', 'Project Management'],
      clients: ['Acme'],
      projectsData: [{ id: 'proj-1', name: 'Original Name', client: 'Acme', startDate: '2026-01-01', endDate: '2026-12-31', phases: { 'Schematic Design': 40 }, phaseStatus: EXISTING_STATUS, phaseStatusMeta: EXISTING_META }],
      genId: () => 'new-id',
      skipNextConflictCheck: false,
      saveProject: async (data) => { savedData = data; },
      autoSave: () => {},
      closeModal: () => {},
      renderProjectsBudget: () => {},
      alert: () => {},
      this: { _editId: 'proj-1' },
    };
    vm.createContext(sandbox);
    // Bind `this._editId` the same way the real click handler does (a
    // property stashed on the button by openProjectModal()) by invoking
    // the extracted function body with `this` bound explicitly.
    const fn = `(async function(){ ${saveProjBtnSrc.slice(saveProjBtnSrc.indexOf('{') + 1, saveProjBtnSrc.lastIndexOf('}'))} }).call({ _editId: 'proj-1' })`;
    await vm.runInContext(fn, sandbox);
    check('saveProject() was called', savedData !== null);
    check('the rebuilt data carries the EXISTING phaseStatus forward, byte-for-byte', JSON.stringify(savedData.phaseStatus) === JSON.stringify(EXISTING_STATUS));
    check('the rebuilt data carries the EXISTING phaseStatusMeta forward, byte-for-byte', JSON.stringify(savedData.phaseStatusMeta) === JSON.stringify(EXISTING_META));
    check('the edited fields (name) DID change -- this is a real edit, not a no-op', savedData.name === 'Renamed Project');
  }

  console.log('\n--- Same collision-fix path for a genuinely NEW project (no existing phaseStatus) ---');
  {
    const formValues = { pName: 'Brand New', pClientSelect: 'Acme', pStart: '2026-01-01', pEnd: '2026-12-31', phase_Schematic_Design: '10', phase_Final_Design: '0', phase_Construction_Documents: '0', 'phase_Material_Selection_&_Coordination': '0', phase_Site_Supervision: '0', phase_Project_Management: '0' };
    let savedData = null;
    const sandbox = {
      console, parseInt,
      document: { getElementById: (id) => ({ value: formValues[id] !== undefined ? formValues[id] : '0' }) },
      PHASES: ['Schematic Design', 'Final Design', 'Construction Documents', 'Material Selection & Coordination', 'Site Supervision', 'Project Management'],
      clients: ['Acme'],
      projectsData: [],
      genId: () => 'new-id',
      skipNextConflictCheck: false,
      saveProject: async (data) => { savedData = data; },
      autoSave: () => {}, closeModal: () => {}, renderProjectsBudget: () => {}, alert: () => {},
    };
    vm.createContext(sandbox);
    const fn = `(async function(){ ${saveProjBtnSrc.slice(saveProjBtnSrc.indexOf('{') + 1, saveProjBtnSrc.lastIndexOf('}'))} }).call({ _editId: null })`;
    await vm.runInContext(fn, sandbox);
    check('a new project gets an empty phaseStatus/phaseStatusMeta, not undefined (safe default)', JSON.stringify(savedData.phaseStatus) === '{}' && JSON.stringify(savedData.phaseStatusMeta) === '{}');
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== Role-gating: Confirm Done only for admins, Mark Ready for everyone ===');
  const renderPBSrc = extractFunction(fullScript, 'renderProjectsBudget');
  check('the phase-row template only emits the confirm button when currentUser.isAdmin', /currentUser\.isAdmin\?`<button class="btn btn-ghost btn-sm phase-confirm-btn"/.test(renderPBSrc));
  {
    // The "Mark Ready" button is the unconditional final `:` branch of the
    // phStatus ternary (confirmed -> ready -> else/Mark Ready) -- confirm
    // that branch's template literal contains phase-ready-btn with NO
    // currentUser.isAdmin check anywhere in front of it.
    const markReadyBranch = renderPBSrc.slice(renderPBSrc.lastIndexOf(': `<button class="btn btn-ghost btn-sm phase-ready-btn"'));
    check('the Mark Ready button branch exists and contains phase-ready-btn', markReadyBranch.includes('phase-ready-btn'));
    check('the Mark Ready button branch has no admin gate in front of it', !markReadyBranch.slice(0, markReadyBranch.indexOf('phase-ready-btn')).includes('isAdmin'));
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== "N phases at risk" project-card summary chip ===');
  {
    const isRiskSrc = atRiskSrc;
    const sandbox = { console, Math, Object };
    vm.createContext(sandbox);
    // Recreate the exact chip-building logic renderProjectsBudget() uses,
    // sourced from the real function body via a targeted slice, so the
    // count logic under test is the real code, not a re-description of it.
    const chipLogicMatch = renderPBSrc.match(/let atRiskCount = 0;[\s\S]*?const atRiskChip = atRiskCount>0[\s\S]*?: '';/);
    assert.ok(chipLogicMatch, 'could not find the at-risk chip logic inside renderProjectsBudget()');
    vm.runInContext(isRiskSrc, sandbox);
    vm.runInContext(`
      var proj = {
        phases: { 'Schematic Design': 40, 'Final Design': 40, 'Construction Documents': 40 },
        phaseStatus: { 'Schematic Design': 'confirmed' },
      };
      var PHASES = ['Schematic Design', 'Final Design', 'Construction Documents'];
      // Schematic: 100% used, confirmed -> NOT at risk. Final: 90% used, no status -> AT RISK. Construction: 50% used, no status -> not at risk (below 80%).
      function phaseLoggedMinsAllTime(pid, ph) {
        if (ph === 'Schematic Design') return 40 * 60;
        if (ph === 'Final Design') return 36 * 60;
        if (ph === 'Construction Documents') return 20 * 60;
        return 0;
      }
      ${chipLogicMatch[0]}
    `, sandbox);
    const atRiskCount = vm.runInContext('atRiskCount', sandbox);
    const atRiskChip = vm.runInContext('atRiskChip', sandbox);
    check('exactly 1 phase counted at risk (Final Design: 90%, unconfirmed)', atRiskCount === 1);
    check('the chip text reads "1 phase at risk" (singular)', atRiskChip.includes('1 phase at risk'));
  }
  {
    // Zero at-risk -> no chip rendered at all.
    const sandbox = { console, Math, Object };
    vm.createContext(sandbox);
    vm.runInContext(atRiskSrc, sandbox);
    const chipLogicMatch = renderPBSrc.match(/let atRiskCount = 0;[\s\S]*?const atRiskChip = atRiskCount>0[\s\S]*?: '';/);
    vm.runInContext(`
      var proj = { phases: { 'Schematic Design': 40 }, phaseStatus: { 'Schematic Design': 'confirmed' } };
      var PHASES = ['Schematic Design'];
      function phaseLoggedMinsAllTime() { return 40 * 60; }
      ${chipLogicMatch[0]}
    `, sandbox);
    check('zero at-risk phases -> empty chip (nothing rendered)', vm.runInContext('atRiskChip', sandbox) === '');
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== Accountability metadata stored, but NEVER aggregated (source-text proof) ===');
  // Strip // line comments and /* */ blocks (preserving string literals)
  // before counting -- documentation mentioning these field names (the
  // version-bump line, this function's own header comment) is not the
  // same claim as "live code reads/aggregates this field elsewhere."
  function stripComments(text) {
    let out = '', i = 0;
    const n = text.length;
    while (i < n) {
      const two = text.slice(i, i + 2);
      if (two === '//') { const e = text.indexOf('\n', i); i = e < 0 ? n : e; continue; }
      if (two === '/*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
      if (text[i] === "'" || text[i] === '"' || text[i] === '`') {
        const q = text[i]; out += text[i++];
        while (i < n && text[i] !== q) {
          if (text[i] === '\\') { out += text[i++]; if (i < n) out += text[i++]; continue; }
          out += text[i++];
        }
        if (i < n) out += text[i++];
        continue;
      }
      out += text[i++];
    }
    return out;
  }
  const codeOnlyFullScript = stripComments(fullScript);
  const codeOnlySaveStatusSrc = stripComments(saveStatusSrc);
  const metaFieldNames = ['readyBy', 'readyAt', 'confirmedBy', 'confirmedAt'];
  for (const field of metaFieldNames) {
    const occurrences = (codeOnlyFullScript.match(new RegExp(field, 'g')) || []).length;
    // Every LIVE-CODE occurrence must be inside saveProjectPhaseStatus()
    // (write-only) -- if it appears more times than inside that one
    // function, some OTHER code is reading/aggregating it, which must
    // never exist.
    const countInSaveFn = (codeOnlySaveStatusSrc.match(new RegExp(field, 'g')) || []).length;
    check(`"${field}" appears ONLY inside saveProjectPhaseStatus() as live code (write-only, never read/aggregated elsewhere)`, occurrences === countInSaveFn && occurrences > 0);
  }
  check('no function name anywhere suggests per-person completion speed/ranking (e.g. "PhaseSpeed", "CompletionRate", "PersonProgress")',
    !/function\s+\w*(PhaseSpeed|CompletionRate|PersonProgress|ReadySpeed|ConfirmSpeed)\w*/i.test(fullScript));
  check('phaseStatus/phaseStatusMeta are never grouped/reduced BY PERSON anywhere (no groupBy-style reduce keyed on readyBy/confirmedBy)',
    !/reduce\([^)]*\)[\s\S]{0,40}(readyBy|confirmedBy)/.test(fullScript));

  console.log('\n=== the inline <script> still parses ===');
  check('new Function(fullScript) does not throw', (() => {
    try { new Function(fullScript); return true; }
    catch (e) { console.log('    parse error:', e.message); return false; }
  })());

  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
})();
