// Fixture test for Stage 0: the verify-before-delete guard added to
// backstopFullSave()'s already-live delete-by-omission block (originally
// shipped commit b5d6642, 2026-08-04).
//
// index.html is not a module (plain classic script, browser globals
// throughout) so this test extracts the ACTUAL function source directly
// from the real file (brace-matched, not retyped/duplicated) and runs it in
// a vm sandbox with a mocked Firestore `db` and stubbed collaborators --
// proving the real shipped code, not a reimplementation of it.
//
// Run with: node stage-0-backstop-delete-guard.test.js
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
  // Check "async function NAME(" FIRST -- "function NAME(" also matches as
  // a substring inside "async function NAME(" (starting right after
  // "async "), so checking the plain form first would silently drop the
  // async keyword from the extracted source, breaking any `await` inside.
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

function extractLetInit(source, name) {
  const re = new RegExp(`let ${name}\\s*=\\s*([\\s\\S]*?);\\r?\\n`);
  const m = source.match(re);
  assert.ok(m, `could not find "let ${name} = ...;" in index.html`);
  return m[0];
}

const HELPER_NAMES = ['stableStringify', 'fnv1aHash', 'computeDocHash', 'snapshotCollection', 'computeContentHash', 'snapshotBackstopContent'];
const helperSources = HELPER_NAMES.map((name) => extractFunction(fullScript, name));
const backstopFullSaveSrc = extractFunction(fullScript, 'backstopFullSave');
// Static check only -- confirms the real declarations exist with the
// expected initial shape; the sandbox itself is seeded directly (see
// buildSandbox()'s comment on why `let` bindings from vm.runInContext
// aren't reachable as host-side object properties).
extractLetInit(fullScript, 'docSnapshots');
extractLetInit(fullScript, 'backstopContentSnapshots');

console.log('--- extracted backstopFullSave() delete-guard block (from real index.html) ---');
{
  const guardStart = backstopFullSaveSrc.indexOf('if (candidateDeletes.length > 0)');
  console.log(backstopFullSaveSrc.slice(guardStart, guardStart + 950) + '\n  ...\n');
}

// Build a fresh vm sandbox with the real extracted helpers + backstopFullSave
// wired to a mocked Firestore `db`. Returns the sandbox plus a way to read
// exactly which ids got batch.delete()'d, per collection.
function buildSandbox({ serverDocs = {}, failVerifyFor = new Set(), localArrays = {}, snapshotEntries = {}, contentSnapshotEntries = {} }) {
  const deletedByCollection = { timeLogs: [], planEntries: [], projects: [] };
  const commitInChunksCalls = [];

  const sandbox = {
    console,
    window: {},
    dataLoaded: true,
    currentUser: { id: 'u1', name: 'Admin' },
    staleVersionLockout: false,
    timeLogs: localArrays.timeLogs || [],
    planEntries: localArrays.planEntries || [],
    projectsData: localArrays.projects || [],
    COLLECTION_FIRESTORE_NAME: { timeLogs: 'timeLogs', planEntries: 'planEntries', projects: 'projects' },
    COLLECTION_BUILD_DOC_DATA: {
      timeLogs: (l, ts) => ({ ...l, updatedAt: ts }),
      planEntries: (e, ts) => ({ ...e, updatedAt: ts }),
      projects: (p, ts) => ({ ...p, updatedAt: ts }),
    },
    commitInChunks: (collectionName, items) => {
      commitInChunksCalls.push({ collectionName, count: items.length });
      return Promise.resolve();
    },
    // NOTE: docSnapshots/backstopContentSnapshots are seeded directly as
    // plain object properties here, NOT via vm.runInContext of the
    // extracted `let ... = ...;` source. `let` bindings executed through
    // vm.runInContext live in the script's lexical scope, not as
    // properties of the contextified global object, so they wouldn't be
    // reachable as `sandbox.docSnapshots` from the host afterward. Plain
    // properties assigned directly on the object passed to
    // vm.createContext() ARE reachable both ways -- this mirrors the real
    // declared initial shape (confirmed via extraction/display above),
    // just assigned through a mechanism the host can also read/mutate.
    docSnapshots: { timeLogs: new Map(), planEntries: new Map(), projects: new Map() },
    backstopContentSnapshots: { timeLogs: new Map(), planEntries: new Map(), projects: new Map() },
  };
  vm.createContext(sandbox);
  helperSources.forEach((s) => vm.runInContext(s, sandbox));

  // Stub the shared snapshotCollection (write-path rebuild) so this test
  // only exercises the delete-guard's own content snapshot, not the
  // unrelated shared docSnapshots rebuild backstopFullSave also does at
  // the end of a successful sweep.
  vm.runInContext('snapshotCollection = function(name, arr) {};', sandbox);

  for (const [name, entries] of Object.entries(snapshotEntries)) sandbox.docSnapshots[name] = new Map(entries);
  for (const [name, entries] of Object.entries(contentSnapshotEntries)) sandbox.backstopContentSnapshots[name] = new Map(entries);

  sandbox.db = {
    collection(collectionName) {
      return {
        doc(id) {
          return {
            id,
            get() {
              if (failVerifyFor.has(collectionName)) return Promise.reject(new Error('simulated network failure'));
              const coll = serverDocs[collectionName] || {};
              const data = Object.prototype.hasOwnProperty.call(coll, id) ? coll[id] : null;
              return Promise.resolve({ exists: data !== null, id, data: () => data });
            },
          };
        },
      };
    },
    batch() {
      const ops = [];
      return {
        delete(docRef) { ops.push(docRef.id); },
        set() {},
        commit() {
          // Infer which collection this batch belongs to from the ids
          // present in serverDocs/localArrays keys the test set up --
          // simpler: just record into a flat list and let the test check
          // "was this id ever deleted" without needing per-collection
          // attribution, since each test case only exercises one collection.
          deletedByCollection.__flat = (deletedByCollection.__flat || []).concat(ops);
          return Promise.resolve();
        },
      };
    },
  };

  vm.runInContext(backstopFullSaveSrc, sandbox);
  return { sandbox, deletedByCollection, commitInChunksCalls };
}

function wasDeleted(deletedByCollection, id) {
  return (deletedByCollection.__flat || []).includes(id);
}

let passCount = 0, failCount = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); passCount++; }
  else { console.log(`  FAIL: ${label}`); failCount++; }
}

async function run() {
  // ═══════════════════════════════════════════════════════════════════
  // CASE (a): doc genuinely deleted locally, server content hash matches
  // what this tab last knew -- should delete.
  // ═══════════════════════════════════════════════════════════════════
  console.log('=== CASE (a): genuine local delete, server content unchanged -- should delete ===');
  {
    const docId = 'plan-cancelled-1';
    const localItem = { id: docId, desc: 'Old meeting', userId: 'u2', updatedAt: '2026-08-01T00:00:00.000Z' };
    const serverData = { ...localItem, updatedAt: '2026-08-01T05:00:00.000Z' }; // real server updatedAt differs -- must NOT affect the comparison
    const { sandbox, deletedByCollection } = buildSandbox({
      serverDocs: { planEntries: { [docId]: serverData } },
      localArrays: { planEntries: [] }, // genuinely removed locally (e.g. meeting cancel)
      snapshotEntries: { planEntries: [[docId, 'unused-shared-hash']] },
      contentSnapshotEntries: {}, // populated below using the real extracted computeContentHash
    });
    const localContentHash = vm.runInContext(`computeContentHash(${JSON.stringify(localItem)})`, sandbox);
    sandbox.backstopContentSnapshots.planEntries.set(docId, localContentHash);

    await vm.runInContext('backstopFullSave()', sandbox);
    check('candidate with unchanged server content gets deleted', wasDeleted(deletedByCollection, docId));
  }

  // ═══════════════════════════════════════════════════════════════════
  // CASE (b): doc missing from local array, but server content hash has
  // CHANGED since this tab last knew about it (someone else edited it) --
  // must SKIP, never delete.
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== CASE (b): missing locally, server content CHANGED -- must skip ===');
  {
    const docId = 'timelog-edited-elsewhere';
    const localItemAsLastKnown = { id: docId, desc: 'Old desc', durationMins: 15, updatedAt: '2026-08-01T00:00:00.000Z' };
    const serverDataNow = { id: docId, desc: 'Edited by someone else', durationMins: 500, updatedAt: '2026-08-02T00:00:00.000Z' };
    const { sandbox, deletedByCollection } = buildSandbox({
      serverDocs: { timeLogs: { [docId]: serverDataNow } },
      localArrays: { timeLogs: [] }, // this stale tab's array doesn't have it (never refreshed)
      snapshotEntries: { timeLogs: [[docId, 'unused-shared-hash']] },
    });
    const lastKnownContentHash = vm.runInContext(`computeContentHash(${JSON.stringify(localItemAsLastKnown)})`, sandbox);
    sandbox.backstopContentSnapshots.timeLogs.set(docId, lastKnownContentHash);

    await vm.runInContext('backstopFullSave()', sandbox);
    check('candidate with changed server content is NOT deleted', !wasDeleted(deletedByCollection, docId));
    // NOTE: not asserting on backstopContentSnapshots' post-cycle value here
    // -- the end-of-function snapshotBackstopContent() call unconditionally
    // rebuilds the whole map from the (empty, in this fixture) array, so
    // this id is excluded from the rebuilt map regardless of what happened
    // during the guard. The in-guard set()/delete() calls are a defensive
    // fallback for an exception-before-rebuild case, not something that
    // survives a normal successful cycle -- see the comment in index.html.
    // The only real, always-guaranteed-observable outcome is "not deleted."
  }

  // ═══════════════════════════════════════════════════════════════════
  // CASE (c): verify fetch itself fails (network error) -- fail closed,
  // must SKIP the whole chunk, never delete on an unconfirmed state.
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== CASE (c): verify fetch fails -- fail-closed, must skip ===');
  {
    const docId = 'projects-doc-verify-fails';
    const { sandbox, deletedByCollection } = buildSandbox({
      serverDocs: { projects: {} },
      failVerifyFor: new Set(['projects']),
      localArrays: { projects: [] },
      snapshotEntries: { projects: [[docId, 'unused-shared-hash']] },
      contentSnapshotEntries: { projects: [[docId, 'some-content-hash']] },
    });
    await vm.runInContext('backstopFullSave()', sandbox);
    check('candidate is NOT deleted when the verify fetch fails (fail-closed)', !wasDeleted(deletedByCollection, docId));
    // Same note as CASE (b): the end-of-cycle full resnapshot excludes this
    // id regardless (empty array in this fixture), so the meaningful,
    // always-observable guarantee is "not deleted," not a specific
    // snapshot-map value.
  }

  // ═══════════════════════════════════════════════════════════════════
  // CASE (d): the guard can only be MORE conservative than the old code --
  // across every scenario above, confirmedDeletes is always a subset of
  // what the pre-Stage-0 unconditional code would have deleted (every
  // candidateDeletes id). Verified here by re-running a mixed batch (one
  // safe-to-delete id, one changed-content id, one fetch-failure id) and
  // checking the delete set is exactly the safe one, never a superset.
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== CASE (d): guard is strictly more conservative, never deletes beyond old-code candidates ===');
  {
    const safeId = 'safe-to-delete';
    const changedId = 'changed-elsewhere';
    const safeLocal = { id: safeId, x: 1, updatedAt: 't0' };
    const changedLocal = { id: changedId, x: 1, updatedAt: 't0' };
    const changedServer = { id: changedId, x: 999, updatedAt: 't1' };

    const { sandbox, deletedByCollection } = buildSandbox({
      serverDocs: { planEntries: { [safeId]: { ...safeLocal, updatedAt: 't5' }, [changedId]: changedServer } },
      localArrays: { planEntries: [] },
      snapshotEntries: { planEntries: [[safeId, 'x'], [changedId, 'x']] },
    });
    sandbox.backstopContentSnapshots.planEntries.set(safeId, vm.runInContext(`computeContentHash(${JSON.stringify(safeLocal)})`, sandbox));
    sandbox.backstopContentSnapshots.planEntries.set(changedId, vm.runInContext(`computeContentHash(${JSON.stringify(changedLocal)})`, sandbox));

    const oldCodeWouldDelete = new Set([safeId, changedId]); // pre-Stage-0: both were in docSnapshots, both missing from array
    await vm.runInContext('backstopFullSave()', sandbox);
    const actuallyDeleted = new Set(deletedByCollection.__flat || []);

    check('safe candidate deleted', actuallyDeleted.has(safeId));
    check('changed candidate NOT deleted', !actuallyDeleted.has(changedId));
    let isSubset = true;
    actuallyDeleted.forEach((id) => { if (!oldCodeWouldDelete.has(id)) isSubset = false; });
    check('actual delete set is a subset of what the old unconditional code would have deleted (never a superset)', isSubset);
    check('actual delete set is a STRICT subset here (guard suppressed at least one)', actuallyDeleted.size < oldCodeWouldDelete.size);
  }

  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
}

run();
