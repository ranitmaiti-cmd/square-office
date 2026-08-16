// Replaces test/stage-0-backstop-delete-guard.test.js (removed in the same
// change). That file tested Stage 0's verify-before-delete guard as it
// existed INLINE inside backstopFullSave(). Stage C (2026-08-16) extracted
// that exact algorithm out to the shared verifyAndFilterDeletes() helper --
// already thoroughly covered, across all three collections plus every edge
// case, by test/stage-b-guarded-syncchangeddocs.test.js (which exercises it
// via syncChangedDocs(), the OTHER caller). backstopFullSave() itself no
// longer contains that logic at all; post-C it's a thin wrapper: guard
// clauses, then computeCollectionDiffs() + syncChangedDocs(), on its own
// 5-minute cadence. This file tests THAT -- the wrapper's own guard clauses
// and correct delegation -- plus one true end-to-end case proving the
// delegation actually reaches the real guarded delete path, not just that
// the right function names get called.
//
// index.html is not a module (plain classic script) so this test extracts
// the ACTUAL function source directly from the real file (brace-matched,
// not retyped/duplicated) and runs it in a vm sandbox -- proving the real
// shipped code, not a reimplementation.
//
// Run with: node test/stage-cd-backstop-diff-wrapper.test.js
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
  assert.ok(braceStart >= 0, `could not find opening brace for ${name}`);
  let depth = 0;
  let i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  assert.ok(depth === 0, `brace matching failed for ${name}`);
  return source.slice(startIdx, i + 1);
}

const backstopFullSaveSrc = extractFunction(fullScript, 'backstopFullSave');

// Static checks -- confirm the shape actually matches what this test
// assumes before exercising it, so a future refactor that breaks these
// assumptions fails loudly here rather than passing for the wrong reason.
assert.ok(backstopFullSaveSrc.includes('computeCollectionDiffs()'), 'backstopFullSave() no longer calls computeCollectionDiffs() -- Stage C wrapper shape changed');
assert.ok(backstopFullSaveSrc.includes('syncChangedDocs(diffs)'), 'backstopFullSave() no longer calls syncChangedDocs(diffs) -- Stage C wrapper shape changed');
assert.ok(!backstopFullSaveSrc.includes('commitInChunks('), 'backstopFullSave() still calls commitInChunks() -- the unconditional full-rewrite should be gone post-Stage-C');
console.log('--- confirmed: backstopFullSave() is now a thin computeCollectionDiffs()+syncChangedDocs() wrapper, no unconditional rewrite ---');

const HELPER_NAMES = ['stableStringify', 'fnv1aHash', 'computeDocHash', 'diffCollection', 'computeCollectionDiffs', 'computeContentHash', 'verifyAndFilterDeletes', 'syncChangedDocs'];
const helperSources = HELPER_NAMES.map((name) => extractFunction(fullScript, name));

function buildSandbox({ serverDocs = {}, localArrays = {}, snapshotEntries = {}, contentSnapshotEntries = {}, extraSandboxProps = {} }) {
  const deleted = { timeLogs: [], planEntries: [], projects: [] };
  const written = { timeLogs: [], planEntries: [], projects: [] };

  const sandbox = {
    console,
    window: {},
    dataLoaded: true,
    currentUser: { id: 'u1', name: 'Admin' },
    staleVersionLockout: false,
    timeLogs: localArrays.timeLogs || [],
    planEntries: localArrays.planEntries || [],
    projectsData: localArrays.projects || [],
    COLLECTION_FIRESTORE_NAME: { projects: 'projects', timeLogs: 'timeLogs', planEntries: 'planEntries' },
    COLLECTION_BUILD_DOC_DATA: {
      projects: (project, saveTimestamp) => ({ ...project, updatedAt: saveTimestamp }),
      timeLogs: (log, saveTimestamp) => ({ ...log, updatedAt: saveTimestamp }),
      planEntries: (entry, saveTimestamp) => ({ ...entry, updatedAt: saveTimestamp }),
    },
    docSnapshots: { timeLogs: new Map(), planEntries: new Map(), projects: new Map() },
    backstopContentSnapshots: { timeLogs: new Map(), planEntries: new Map(), projects: new Map() },
    ...extraSandboxProps,
  };
  vm.createContext(sandbox);
  helperSources.forEach((s) => vm.runInContext(s, sandbox));

  for (const [name, entries] of Object.entries(snapshotEntries)) sandbox.docSnapshots[name] = new Map(entries);
  for (const [name, entries] of Object.entries(contentSnapshotEntries)) sandbox.backstopContentSnapshots[name] = new Map(entries);

  sandbox.db = {
    collection(collectionName) {
      return {
        doc(id) {
          return {
            id,
            get() {
              const coll = serverDocs[collectionName] || {};
              const data = Object.prototype.hasOwnProperty.call(coll, id) ? coll[id] : null;
              return Promise.resolve({ exists: data !== null, id, data: () => data });
            },
          };
        },
      };
    },
    batch() {
      const deleteOps = [];
      const setOps = [];
      return {
        delete(docRef) { deleteOps.push(docRef.id); },
        set(docRef, data) { setOps.push({ id: docRef.id, data }); },
        commit() {
          for (const name of ['timeLogs', 'planEntries', 'projects']) {
            const coll = serverDocs[name] || {};
            deleteOps.forEach(id => { if (Object.prototype.hasOwnProperty.call(coll, id) || (snapshotEntries[name] || []).some(([sid]) => sid === id)) deleted[name].push(id); });
            setOps.forEach(({ id, data }) => { written[name].push({ id, data }); });
          }
          return Promise.resolve();
        },
      };
    },
  };

  vm.runInContext(backstopFullSaveSrc, sandbox);
  return { sandbox, deleted, written };
}

let passCount = 0, failCount = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); passCount++; }
  else { console.log(`  FAIL: ${label}`); failCount++; }
}

async function run() {
  // ═══════════════════════════════════════════════════════════════════
  // Guard clauses: each should return immediately, doing nothing.
  // ═══════════════════════════════════════════════════════════════════
  console.log('=== Guard clauses ===');
  {
    const { sandbox, deleted, written } = buildSandbox({
      serverDocs: { timeLogs: {} },
      localArrays: { timeLogs: [] },
      snapshotEntries: { timeLogs: [['some-id', 'x']] },
      extraSandboxProps: { staleVersionLockout: true },
    });
    await vm.runInContext('backstopFullSave()', sandbox);
    check('staleVersionLockout:true -- no writes/deletes attempted', deleted.timeLogs.length === 0 && written.timeLogs.length === 0);
  }
  {
    const { sandbox, deleted, written } = buildSandbox({
      serverDocs: { timeLogs: {} },
      localArrays: { timeLogs: [] },
      snapshotEntries: { timeLogs: [['some-id', 'x']] },
      extraSandboxProps: { dataLoaded: false },
    });
    await vm.runInContext('backstopFullSave()', sandbox);
    check('dataLoaded:false -- no writes/deletes attempted', deleted.timeLogs.length === 0 && written.timeLogs.length === 0);
  }
  {
    const { sandbox, deleted, written } = buildSandbox({
      serverDocs: { timeLogs: {} },
      localArrays: { timeLogs: [] },
      snapshotEntries: { timeLogs: [['some-id', 'x']] },
      extraSandboxProps: { currentUser: null },
    });
    await vm.runInContext('backstopFullSave()', sandbox);
    check('currentUser:null -- no writes/deletes attempted', deleted.timeLogs.length === 0 && written.timeLogs.length === 0);
  }
  {
    const { sandbox, deleted, written } = buildSandbox({
      serverDocs: { timeLogs: {} },
      localArrays: { timeLogs: [] },
      snapshotEntries: { timeLogs: [['some-id', 'x']] },
      extraSandboxProps: { window: { _saveInProgress: true } },
    });
    await vm.runInContext('backstopFullSave()', sandbox);
    check("window._saveInProgress:true -- doesn't race a concurrent cycle, no writes/deletes attempted", deleted.timeLogs.length === 0 && written.timeLogs.length === 0);
  }

  // ═══════════════════════════════════════════════════════════════════
  // _saveInProgress lifecycle: set true during the cycle, reset to false
  // in `finally` -- both on success and on a thrown exception, so a
  // failure never permanently locks out future cycles.
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== _saveInProgress lifecycle ===');
  {
    const { sandbox } = buildSandbox({ serverDocs: { timeLogs: {} }, localArrays: { timeLogs: [] } });
    await vm.runInContext('backstopFullSave()', sandbox);
    check('_saveInProgress reset to false after a normal successful cycle', sandbox.window._saveInProgress === false);
  }
  {
    const { sandbox } = buildSandbox({
      serverDocs: { timeLogs: {} },
      localArrays: { timeLogs: [] },
      extraSandboxProps: {
        // Force computeCollectionDiffs() to throw by making docSnapshots.timeLogs
        // something that breaks diffCollection()'s .forEach usage.
      },
    });
    vm.runInContext('computeCollectionDiffs = function() { throw new Error("simulated diff failure"); };', sandbox);
    let threw = false;
    try { await vm.runInContext('backstopFullSave()', sandbox); } catch (e) { threw = true; }
    check('a thrown exception inside the cycle does not escape backstopFullSave() (caught, logged)', !threw);
    check('_saveInProgress still reset to false after an exception (finally runs)', sandbox.window._saveInProgress === false);
  }

  // ═══════════════════════════════════════════════════════════════════
  // End-to-end: confirms the wrapper actually reaches the real guarded
  // delete path, not just that the right function names appear in source.
  // Same shape as Stage 0's original case (a): a genuine local delete
  // whose server content hash still matches this tab's last-known state.
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== End-to-end: reaches the real guarded delete path ===');
  {
    const docId = 'timelogs-safe-delete';
    const localItem = { id: docId, x: 1, updatedAt: 'old' };
    const { sandbox, deleted } = buildSandbox({
      serverDocs: { timeLogs: { [docId]: { ...localItem, updatedAt: 'server-ts' } } },
      localArrays: { timeLogs: [] },
      snapshotEntries: { timeLogs: [[docId, 'unused-shared-hash']] },
    });
    sandbox.backstopContentSnapshots.timeLogs.set(docId, vm.runInContext(`computeContentHash(${JSON.stringify(localItem)})`, sandbox));
    await vm.runInContext('backstopFullSave()', sandbox);
    check('a genuine, guard-confirmed local delete is actually deleted via the wrapper', deleted.timeLogs.includes(docId));
  }
  {
    const docId = 'timelogs-changed-elsewhere';
    const lastKnown = { id: docId, x: 1, updatedAt: 'old' };
    const serverNow = { id: docId, x: 999, updatedAt: 'new' };
    const { sandbox, deleted } = buildSandbox({
      serverDocs: { timeLogs: { [docId]: serverNow } },
      localArrays: { timeLogs: [] },
      snapshotEntries: { timeLogs: [[docId, 'unused-shared-hash']] },
    });
    sandbox.backstopContentSnapshots.timeLogs.set(docId, vm.runInContext(`computeContentHash(${JSON.stringify(lastKnown)})`, sandbox));
    await vm.runInContext('backstopFullSave()', sandbox);
    check('a candidate whose server content changed elsewhere is correctly skipped via the wrapper too', !deleted.timeLogs.includes(docId));
  }

  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
}

run();
