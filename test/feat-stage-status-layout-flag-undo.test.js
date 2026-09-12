// Fixture for V28: layout fix + flag-work-after-done + reversibility, built
// on top of the already-shipped project stage-completion feature (V27, see
// test/feat-project-stage-status.test.js and FINDINGS-2026-08-10.md).
//
// Central claims under test:
//  - LAYOUT: the phase-status cell renders between phase-name and the bar
//    (left-anchored, not right-anchored with margin-left:auto), and the
//    at-risk chip renders inside the project TITLE block, not the right-
//    side stats block
//  - FLAG-AFTER-DONE: minsLoggedAfterDone() fires (>0) when a timeLog's
//    work date is strictly after the phase's confirmedAt date, and does
//    NOT fire (0) for logs on/before that date -- pure function, real
//    execution against synthetic data
//  - Logging is NEVER blocked: saveTimeLog() and openLogModal() are
//    byte-for-byte unchanged from main
//  - REVERSIBILITY: saveProjectPhaseStatusUndo() executed for real against
//    a dot-path-aware mock Firestore for all three actions and their
//    role-gating/freeze-check rules
//  - Existing at-risk/collision-fix logic (isPhaseAtRisk, saveProjectPhaseStatus,
//    the collision fix) still passes -- re-run here as smoke checks
//
// Run with: node test/feat-stage-status-layout-flag-undo.test.js
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
                const leaf = parts[parts.length - 1];
                if (val && val.__delete__) { delete cur[leaf]; }
                else { cur[leaf] = val; }
              }
            },
          };
        },
      };
    },
  };
  return { db, calls };
}

function makeUndoSandbox(store, user) {
  const { db, calls } = makeDb(store);
  const sandbox = {
    console, Date,
    db, calls,
    staleVersionLockout: false,
    currentUser: user,
    firebase: { firestore: { FieldValue: { delete: () => ({ __delete__: true }) } } },
    projectsData: [{
      id: 'p1',
      phaseStatus: JSON.parse(JSON.stringify((store.projects && store.projects.p1 && store.projects.p1.phaseStatus) || {})),
      phaseStatusMeta: JSON.parse(JSON.stringify((store.projects && store.projects.p1 && store.projects.p1.phaseStatusMeta) || {})),
    }],
    alert: () => {},
  };
  return sandbox;
}

(async () => {
  const renderPBSrc = extractFunction(fullScript, 'renderProjectsBudget');
  const undoSrc = extractFunction(fullScript, 'saveProjectPhaseStatusUndo');
  const afterDoneSrc = extractFunction(fullScript, 'minsLoggedAfterDone');
  const atRiskSrc = extractFunction(fullScript, 'isPhaseAtRisk');
  const saveStatusSrc = extractFunction(fullScript, 'saveProjectPhaseStatus');

  // ─────────────────────────────────────────────────────────────
  console.log('=== LAYOUT: status cell left of the bar, chip inside the title block ===');
  {
    const nameIdx = renderPBSrc.indexOf('class="phase-name"');
    const statusIdx = renderPBSrc.indexOf('class="phase-status-cell"');
    const barIdx = renderPBSrc.indexOf('class="phase-bar-wrap"');
    check('phase-name appears before phase-status-cell in the row template', nameIdx >= 0 && statusIdx > nameIdx);
    check('phase-status-cell appears before phase-bar-wrap (left-anchored, not after the numbers)', barIdx > statusIdx);
  }
  {
    // The chip must be built INSIDE the same template-literal expression
    // that also emits ${proj.name} -- i.e. it's part of the title block,
    // not the separate text-align:right stats div.
    const titleBlockMatch = renderPBSrc.match(/font-weight:800;font-size:16px[^`]*\$\{proj\.name\}\$\{atRiskChip\}/);
    check('atRiskChip is concatenated directly onto proj.name in the title div', !!titleBlockMatch);
    check('the old right-side stats div no longer embeds atRiskChip', !/font-size:12px;color:#8A7E74;">\$\{hrsToHM\(loggedH\)\} of \$\{totalBudget\}h budget<\/div>\$\{atRiskChip\}/.test(renderPBSrc));
  }
  check('.phase-status-cell CSS no longer right-anchors with margin-left:auto', !/\.phase-status-cell\{[^}]*margin-left:auto/.test(fullScript));

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== FLAG-AFTER-DONE: minsLoggedAfterDone() pure function ===');
  {
    const sandbox = { console };
    vm.createContext(sandbox);
    vm.runInContext(afterDoneSrc, sandbox);
    vm.runInContext(`
      var allTimeBudgetLogs = [
        { projectId: 'p1', phase: 'Final Design', date: '2026-09-01', durationMins: 120 },
        { projectId: 'p1', phase: 'Final Design', date: '2026-09-05', durationMins: 60 },
        { projectId: 'p1', phase: 'Final Design', date: '2026-09-10', durationMins: 90 },
        { projectId: 'p1', phase: 'Schematic Design', date: '2026-09-10', durationMins: 999 },
        { projectId: 'p2', phase: 'Final Design', date: '2026-09-10', durationMins: 999 },
      ];
      var timeLogs = [];
    `, sandbox);
    check('fires (>0) when a log postdates confirmedAt (2026-09-04 confirmed, one log on 09-05 and one on 09-10 = 150m)',
      vm.runInContext("minsLoggedAfterDone('p1', 'Final Design', '2026-09-04T12:00:00.000Z')", sandbox) === 150);
    check('does NOT fire (0) when confirmedAt is AFTER every log date', vm.runInContext("minsLoggedAfterDone('p1', 'Final Design', '2026-09-15T00:00:00.000Z')", sandbox) === 0);
    check('a log on the SAME date as confirmedAt does not count (strictly after)', vm.runInContext("minsLoggedAfterDone('p1', 'Final Design', '2026-09-10T23:00:00.000Z')", sandbox) === 0);
    check('never confirmed (confirmedAt falsy) -> 0, no crash', vm.runInContext("minsLoggedAfterDone('p1', 'Final Design', null)", sandbox) === 0);
    check('other phases/projects are excluded from the sum', vm.runInContext("minsLoggedAfterDone('p1', 'Final Design', '2026-01-01T00:00:00.000Z')", sandbox) === 270);
  }
  check('renderProjectsBudget() only calls minsLoggedAfterDone() for confirmed phases with a confirmedAt', /phStatus === 'confirmed' && phMeta\.confirmedAt/.test(renderPBSrc));
  check('the flag never disables/removes the Log Time button or any log-time affordance', !/data-log="\$\{proj\.id\}"[^`]*disabled/.test(renderPBSrc));

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== Logging is NEVER blocked: saveTimeLog()/openLogModal() byte-for-byte unchanged from main ===');
  check('saveTimeLog() is byte-for-byte unchanged', extractFunction(fullScript, 'saveTimeLog') === extractFunction(mainFullScript, 'saveTimeLog'));
  check('openLogModal() is byte-for-byte unchanged', extractFunction(fullScript, 'openLogModal') === extractFunction(mainFullScript, 'openLogModal'));

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== REVERSIBILITY: saveProjectPhaseStatusUndo() ===');
  const ADMIN = { name: 'PM Priya', isAdmin: true };
  const NON_ADMIN_OWNER = { name: 'Staffer Sam', isAdmin: false };
  const NON_ADMIN_OTHER = { name: 'Someone Else', isAdmin: false };

  console.log('\n--- clear-ready: by the original marker (non-admin) succeeds ---');
  {
    const store = { projects: { p1: { phaseStatus: { 'Final Design': 'ready' }, phaseStatusMeta: { 'Final Design': { readyBy: 'Staffer Sam', readyAt: '2026-09-01T00:00:00.000Z' } } } } };
    const sandbox = makeUndoSandbox(store, NON_ADMIN_OWNER);
    vm.createContext(sandbox);
    vm.runInContext(undoSrc, sandbox);
    const result = await vm.runInContext("saveProjectPhaseStatusUndo('p1', 'Final Design', 'clear-ready')", sandbox);
    check('write succeeds', result.ok === true);
    check('phaseStatus.Final Design is removed from the server doc', !('Final Design' in store.projects.p1.phaseStatus));
    check('readyBy/readyAt metadata removed', !store.projects.p1.phaseStatusMeta['Final Design'] || (!store.projects.p1.phaseStatusMeta['Final Design'].readyBy && !store.projects.p1.phaseStatusMeta['Final Design'].readyAt));
  }

  console.log('\n--- clear-ready: by a non-owner, non-admin is BLOCKED ---');
  {
    const store = { projects: { p1: { phaseStatus: { 'Final Design': 'ready' }, phaseStatusMeta: { 'Final Design': { readyBy: 'Staffer Sam', readyAt: '2026-09-01T00:00:00.000Z' } } } } };
    const sandbox = makeUndoSandbox(store, NON_ADMIN_OTHER);
    vm.createContext(sandbox);
    vm.runInContext(undoSrc, sandbox);
    const result = await vm.runInContext("saveProjectPhaseStatusUndo('p1', 'Final Design', 'clear-ready')", sandbox);
    check('BLOCKED with reason forbidden', result.blocked === true && result.reason === 'forbidden');
    check('ZERO update() calls', sandbox.calls.filter((c) => c.op === 'update').length === 0);
    check('server state untouched', store.projects.p1.phaseStatus['Final Design'] === 'ready');
  }

  console.log('\n--- clear-ready: by admin (not the original marker) succeeds ---');
  {
    const store = { projects: { p1: { phaseStatus: { 'Final Design': 'ready' }, phaseStatusMeta: { 'Final Design': { readyBy: 'Staffer Sam', readyAt: '2026-09-01T00:00:00.000Z' } } } } };
    const sandbox = makeUndoSandbox(store, ADMIN);
    vm.createContext(sandbox);
    vm.runInContext(undoSrc, sandbox);
    const result = await vm.runInContext("saveProjectPhaseStatusUndo('p1', 'Final Design', 'clear-ready')", sandbox);
    check('write succeeds', result.ok === true);
  }

  console.log('\n--- revert-to-ready: non-admin is BLOCKED ---');
  {
    const store = { projects: { p1: { phaseStatus: { 'Final Design': 'confirmed' }, phaseStatusMeta: { 'Final Design': { readyBy: 'Staffer Sam', readyAt: '2026-09-01T00:00:00.000Z', confirmedBy: 'PM Priya', confirmedAt: '2026-09-05T00:00:00.000Z' } } } } };
    const sandbox = makeUndoSandbox(store, NON_ADMIN_OWNER);
    vm.createContext(sandbox);
    vm.runInContext(undoSrc, sandbox);
    const result = await vm.runInContext("saveProjectPhaseStatusUndo('p1', 'Final Design', 'revert-to-ready')", sandbox);
    check('BLOCKED with reason forbidden', result.blocked === true && result.reason === 'forbidden');
    check('server state untouched', store.projects.p1.phaseStatus['Final Design'] === 'confirmed');
  }

  console.log('\n--- revert-to-ready: admin succeeds, clears confirmedBy/At but PRESERVES readyBy/At ---');
  {
    const store = { projects: { p1: { phaseStatus: { 'Final Design': 'confirmed' }, phaseStatusMeta: { 'Final Design': { readyBy: 'Staffer Sam', readyAt: '2026-09-01T00:00:00.000Z', confirmedBy: 'PM Priya', confirmedAt: '2026-09-05T00:00:00.000Z' } } } } };
    const sandbox = makeUndoSandbox(store, ADMIN);
    vm.createContext(sandbox);
    vm.runInContext(undoSrc, sandbox);
    const result = await vm.runInContext("saveProjectPhaseStatusUndo('p1', 'Final Design', 'revert-to-ready')", sandbox);
    check('write succeeds', result.ok === true);
    check('server phaseStatus reverted to ready', store.projects.p1.phaseStatus['Final Design'] === 'ready');
    check('confirmedBy/confirmedAt removed', !store.projects.p1.phaseStatusMeta['Final Design'].confirmedBy && !store.projects.p1.phaseStatusMeta['Final Design'].confirmedAt);
    check('readyBy/readyAt PRESERVED (original ready marker/timestamp survives the revert)', store.projects.p1.phaseStatusMeta['Final Design'].readyBy === 'Staffer Sam' && store.projects.p1.phaseStatusMeta['Final Design'].readyAt === '2026-09-01T00:00:00.000Z');
  }

  console.log('\n--- clear-confirmed: non-admin is BLOCKED ---');
  {
    const store = { projects: { p1: { phaseStatus: { 'Final Design': 'confirmed' }, phaseStatusMeta: { 'Final Design': { confirmedBy: 'PM Priya', confirmedAt: '2026-09-05T00:00:00.000Z' } } } } };
    const sandbox = makeUndoSandbox(store, NON_ADMIN_OTHER);
    vm.createContext(sandbox);
    vm.runInContext(undoSrc, sandbox);
    const result = await vm.runInContext("saveProjectPhaseStatusUndo('p1', 'Final Design', 'clear-confirmed')", sandbox);
    check('BLOCKED with reason forbidden', result.blocked === true && result.reason === 'forbidden');
  }

  console.log('\n--- clear-confirmed: admin succeeds, wipes the phase back to none entirely ---');
  {
    const store = { projects: { p1: { phaseStatus: { 'Final Design': 'confirmed' }, phaseStatusMeta: { 'Final Design': { readyBy: 'Staffer Sam', readyAt: '2026-09-01T00:00:00.000Z', confirmedBy: 'PM Priya', confirmedAt: '2026-09-05T00:00:00.000Z' } } } } };
    const sandbox = makeUndoSandbox(store, ADMIN);
    vm.createContext(sandbox);
    vm.runInContext(undoSrc, sandbox);
    const result = await vm.runInContext("saveProjectPhaseStatusUndo('p1', 'Final Design', 'clear-confirmed')", sandbox);
    check('write succeeds', result.ok === true);
    check('phaseStatus removed entirely', !('Final Design' in store.projects.p1.phaseStatus));
    // Each of the 4 meta leaf fields is deleted via its own dot-path
    // FieldValue.delete() -- Firestore does not collapse the resulting
    // empty map, so the phase key itself remains present as {} server-side.
    // What matters is that none of the 4 fields survive.
    check('ALL phaseStatusMeta leaf fields for this phase removed (ready + confirmed)', Object.keys(store.projects.p1.phaseStatusMeta['Final Design'] || {}).length === 0);
  }

  console.log('\n--- Stale-state: clear-ready when current is actually "confirmed" is BLOCKED (reason: stale) ---');
  {
    const store = { projects: { p1: { phaseStatus: { 'Final Design': 'confirmed' }, phaseStatusMeta: { 'Final Design': { confirmedBy: 'PM Priya', confirmedAt: '2026-09-05T00:00:00.000Z' } } } } };
    const sandbox = makeUndoSandbox(store, ADMIN);
    vm.createContext(sandbox);
    vm.runInContext(undoSrc, sandbox);
    const result = await vm.runInContext("saveProjectPhaseStatusUndo('p1', 'Final Design', 'clear-ready')", sandbox);
    check('BLOCKED with reason stale', result.blocked === true && result.reason === 'stale');
    check('ZERO update() calls', sandbox.calls.filter((c) => c.op === 'update').length === 0);
  }

  console.log('\n--- Stale-state: revert-to-ready when current is already "ready" (nothing to revert) is BLOCKED ---');
  {
    const store = { projects: { p1: { phaseStatus: { 'Final Design': 'ready' }, phaseStatusMeta: { 'Final Design': { readyBy: 'Staffer Sam', readyAt: '2026-09-01T00:00:00.000Z' } } } } };
    const sandbox = makeUndoSandbox(store, ADMIN);
    vm.createContext(sandbox);
    vm.runInContext(undoSrc, sandbox);
    const result = await vm.runInContext("saveProjectPhaseStatusUndo('p1', 'Final Design', 'revert-to-ready')", sandbox);
    check('BLOCKED with reason stale', result.blocked === true && result.reason === 'stale');
  }

  console.log('\n--- Write-safety: dot-path .update() only, freeze-checks server first (mirrors saveProjectPhaseStatus) ---');
  check('uses .update( for the write', undoSrc.includes('.update('));
  check('never uses .set(', !undoSrc.includes('.set('));
  check('re-reads the server (get) BEFORE writing -- the freeze-check', /\.get\(\s*\{\s*source:\s*'server'\s*\}\s*\)/.test(undoSrc));
  check('uses firebase.firestore.FieldValue.delete() to remove stale meta fields', /FieldValue\.delete\(\)/.test(undoSrc));

  console.log('\n--- Undo links are role/ownership-gated in the rendered HTML (structure check) ---');
  check('confirmed badge emits admin-only revert/clear links', /badge-approved[\s\S]{0,20}currentUser\.isAdmin\?`<a[^`]*revert-to-ready/.test(renderPBSrc));
  check('ready badge emits clear link for admin OR the original ready-marker (isReadyOwner)', /\(currentUser\.isAdmin\|\|isReadyOwner\)\?`<a[^`]*clear-ready/.test(renderPBSrc));
  check('undo links are wired to handlePhaseStatusUndo, a function separate from handlePhaseStatusClick', fullScript.includes('handlePhaseStatusUndo') && fullScript.includes("querySelectorAll('.phase-undo-link')"));

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== Smoke-check: existing at-risk / write-safety logic (V27) still holds ===');
  {
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(atRiskSrc, sandbox);
    check('isPhaseAtRisk() unchanged: near/not-confirmed -> at risk', vm.runInContext("isPhaseAtRisk('near', null)", sandbox) === true);
    check('isPhaseAtRisk() unchanged: confirmed clears risk', vm.runInContext("isPhaseAtRisk('over', 'confirmed')", sandbox) === false);
  }
  check('saveProjectPhaseStatus() is byte-for-byte unchanged from main (V28 must not touch it)', saveStatusSrc === extractFunction(mainFullScript, 'saveProjectPhaseStatus'));
  check('saveProject() is byte-for-byte unchanged from main', extractFunction(fullScript, 'saveProject') === extractFunction(mainFullScript, 'saveProject'));
  const saveProjBtnSrc = extractBlockFrom(fullScript, "getElementById('saveProjBtn').addEventListener('click'");
  check('the collision fix (carrying phaseStatus/phaseStatusMeta forward on Edit Project save) is still present', saveProjBtnSrc.includes('phaseStatus:existingProj?.phaseStatus') && saveProjBtnSrc.includes('phaseStatusMeta:existingProj?.phaseStatusMeta'));

  console.log('\n=== the inline <script> still parses ===');
  check('new Function(fullScript) does not throw', (() => {
    try { new Function(fullScript); return true; }
    catch (e) { console.log('    parse error:', e.message); return false; }
  })());

  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
})();
