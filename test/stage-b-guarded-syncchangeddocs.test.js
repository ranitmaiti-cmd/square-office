// Fixture test for Stage B: proves the guarded syncChangedDocs() delete
// path (Stage C -- the verify-then-delete guard, extracted to the shared
// verifyAndFilterDeletes() helper and wired into syncChangedDocs(), which
// previously deleted every toDelete candidate unconditionally) removes
// exactly the right docs and only those, across all three collections.
//
// index.html is not a module (plain classic script) so this test extracts
// the ACTUAL function source directly from the real file (brace-matched,
// not retyped/duplicated) and runs it in a vm sandbox with a mocked
// Firestore `db` -- proving the real shipped code, not a reimplementation.
// The diffs fed into syncChangedDocs() are produced by the REAL extracted
// computeCollectionDiffs()/diffCollection(), not hand-assembled, so the
// "doc not in snapshot survives untouched" case is proven through the
// actual production diff-computation path, end to end.
//
// Run with: node test/stage-b-guarded-syncchangeddocs.test.js
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

const HELPER_NAMES = ['stableStringify', 'fnv1aHash', 'computeDocHash', 'diffCollection', 'computeCollectionDiffs', 'computeContentHash', 'verifyAndFilterDeletes'];
const helperSources = HELPER_NAMES.map((name) => extractFunction(fullScript, name));
const syncChangedDocsSrc = extractFunction(fullScript, 'syncChangedDocs');

// Confirm the real production call site actually reuses the shared guard
// now (this is the whole point of Stage C) -- not a hand-verified detail,
// checked directly against the extracted source.
assert.ok(syncChangedDocsSrc.includes('verifyAndFilterDeletes('), 'syncChangedDocs() does not call verifyAndFilterDeletes() -- guard not wired in as expected');
assert.ok(!/toDelete\.forEach\(id => batch\.delete/.test(syncChangedDocsSrc), 'syncChangedDocs() still appears to delete toDelete unconditionally, bypassing the guard');

console.log('--- confirmed: syncChangedDocs() calls verifyAndFilterDeletes() before deleting ---');

function buildSandbox({ serverDocs = {}, failVerifyFor = new Set(), localArrays = {}, snapshotEntries = {}, contentSnapshotEntries = {}, failCommitFor = new Set() }) {
  const deleted = { timeLogs: [], planEntries: [], projects: [] };
  const written = { timeLogs: [], planEntries: [], projects: [] };

  const sandbox = {
    console,
    currentUser: { id: 'u1', name: 'Admin' },
    timeLogs: localArrays.timeLogs || [],
    planEntries: localArrays.planEntries || [],
    projectsData: localArrays.projects || [],
    COLLECTION_FIRESTORE_NAME: { projects: 'projects', timeLogs: 'timeLogs', planEntries: 'planEntries' },
    COLLECTION_BUILD_DOC_DATA: {
      projects: (project, saveTimestamp) => ({ ...project, updatedAt: saveTimestamp, updatedBy: 'Admin' }),
      timeLogs: (log, saveTimestamp) => ({ ...log, updatedAt: saveTimestamp }),
      planEntries: (entry, saveTimestamp) => ({ ...entry, updatedAt: saveTimestamp }),
    },
    // Seeded directly as plain object properties (not via vm.runInContext of
    // the real `let ... = ...;` declarations) -- same reasoning as every
    // prior fixture this engagement: `let`/`const` bindings executed
    // through vm.runInContext live in the script's lexical scope, not as
    // host-readable properties of the contextified object.
    docSnapshots: { timeLogs: new Map(), planEntries: new Map(), projects: new Map() },
    backstopContentSnapshots: { timeLogs: new Map(), planEntries: new Map(), projects: new Map() },
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
      const deleteOps = [];
      const setOps = [];
      let collForThisBatch = null;
      return {
        delete(docRef) { deleteOps.push(docRef.id); },
        set(docRef, data) { setOps.push({ id: docRef.id, data }); },
        commit() {
          // Attribute this batch to a collection by checking which
          // collection's known ids the ops touch -- simpler: the test
          // harness passes failCommitFor as {collectionName} tags on the
          // ids themselves via a prefix convention isn't needed since each
          // test case below only touches one collection per batch call in
          // practice (mirrors real usage: syncChangedDocs() loops one
          // collection at a time). We infer the collection from whichever
          // known serverDocs/localArrays bucket the first op's id belongs
          // to, falling back to scanning failCommitFor by id.
          const allIds = deleteOps.concat(setOps.map(o => o.id));
          const shouldFail = allIds.some(id => failCommitFor.has(id));
          if (shouldFail) return Promise.reject(new Error('simulated commit failure'));
          // Record against whichever collection bucket has these ids -- the
          // test cases below always know which collection they're checking.
          for (const name of ['timeLogs', 'planEntries', 'projects']) {
            const coll = serverDocs[name] || {};
            const localIds = new Set((localArrays[name] || []).map(i => i.id));
            deleteOps.forEach(id => {
              if (Object.prototype.hasOwnProperty.call(coll, id) || localIds.has(id) || (snapshotEntries[name] || []).some(([sid]) => sid === id)) {
                deleted[name].push(id);
              }
            });
            setOps.forEach(({ id, data }) => {
              if (Object.prototype.hasOwnProperty.call(coll, id) || localIds.has(id)) {
                written[name].push({ id, data });
              }
            });
          }
          return Promise.resolve();
        },
      };
    },
  };

  vm.runInContext(syncChangedDocsSrc, sandbox);
  return { sandbox, deleted, written };
}

async function runCycle(sandbox) {
  const diffs = vm.runInContext('computeCollectionDiffs()', sandbox);
  await vm.runInContext('syncChangedDocs', sandbox)(diffs);
  return diffs;
}

let passCount = 0, failCount = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); passCount++; }
  else { console.log(`  FAIL: ${label}`); failCount++; }
}

async function run() {
  // ═══════════════════════════════════════════════════════════════════
  // CASE 1: hash-match candidate, one per collection -- confirms the
  // guard's positive path works identically across timeLogs, planEntries,
  // and projects, not just the one collection Stage 0 originally proved.
  // ═══════════════════════════════════════════════════════════════════
  console.log('=== CASE 1: hash-match delete candidate, all three collections ===');
  for (const name of ['timeLogs', 'planEntries', 'projects']) {
    const docId = `${name}-safe-delete`;
    const localItem = { id: docId, x: 1, updatedAt: 'old' };
    const serverData = { ...localItem, updatedAt: 'fresh-server-updatedAt' }; // differs on purpose -- content hash strips updatedAt
    const { sandbox, deleted } = buildSandbox({
      serverDocs: { [name]: { [docId]: serverData } },
      localArrays: { [name]: [] }, // genuinely removed locally
      snapshotEntries: { [name]: [[docId, 'unused-shared-hash']] },
    });
    const contentHash = vm.runInContext(`computeContentHash(${JSON.stringify(localItem)})`, sandbox);
    sandbox.backstopContentSnapshots[name].set(docId, contentHash);
    await runCycle(sandbox);
    check(`${name}: hash-match candidate deleted`, deleted[name].includes(docId));
  }

  // ═══════════════════════════════════════════════════════════════════
  // CASE 2: hash-mismatch candidate -- server content changed since this
  // tab's last known state -- must survive, not be deleted.
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== CASE 2: hash-mismatch candidate -- must survive ===');
  for (const name of ['timeLogs', 'planEntries']) {
    const docId = `${name}-changed-elsewhere`;
    const lastKnown = { id: docId, x: 1, updatedAt: 'old' };
    const serverNow = { id: docId, x: 999, updatedAt: 'new' }; // genuinely different content
    const { sandbox, deleted } = buildSandbox({
      serverDocs: { [name]: { [docId]: serverNow } },
      localArrays: { [name]: [] },
      snapshotEntries: { [name]: [[docId, 'unused-shared-hash']] },
    });
    sandbox.backstopContentSnapshots[name].set(docId, vm.runInContext(`computeContentHash(${JSON.stringify(lastKnown)})`, sandbox));
    await runCycle(sandbox);
    check(`${name}: hash-mismatch candidate NOT deleted`, !deleted[name].includes(docId));
  }

  // ═══════════════════════════════════════════════════════════════════
  // CASE 3: verify-fetch itself fails -- fail closed, whole cycle's
  // delete candidates for that collection are skipped.
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== CASE 3: verify fetch fails -- fail-closed ===');
  {
    const docId = 'projects-verify-fails';
    const { sandbox, deleted } = buildSandbox({
      serverDocs: { projects: {} },
      failVerifyFor: new Set(['projects']),
      localArrays: { projects: [] },
      snapshotEntries: { projects: [[docId, 'unused-shared-hash']] },
      contentSnapshotEntries: { projects: [[docId, 'some-hash']] },
    });
    await runCycle(sandbox);
    check('candidate NOT deleted when verify fetch fails', !deleted.projects.includes(docId));
  }

  // ═══════════════════════════════════════════════════════════════════
  // CASE 4 (the required case): a doc that exists on the server but was
  // NEVER part of docSnapshots (this tab never knew about it -- e.g.
  // created by another user after this tab's last full snapshot). It
  // must never even become a delete candidate, let alone survive a
  // guard check -- diffCollection() only flags ids present in the
  // snapshot map as toDelete, so an unknown id is structurally excluded
  // before the guard ever runs. Proven here through the REAL extracted
  // diffCollection()/computeCollectionDiffs(), not asserted by inspection.
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== CASE 4: doc not in snapshot at all -- survives untouched, never even a candidate ===');
  {
    const knownId = 'timelogs-known-and-deleted';
    const unknownId = 'timelogs-never-snapshotted';
    const knownLocal = { id: knownId, x: 1, updatedAt: 'old' };
    const { sandbox, deleted } = buildSandbox({
      serverDocs: {
        timeLogs: {
          [knownId]: { ...knownLocal, updatedAt: 'server-ts' },
          [unknownId]: { id: unknownId, x: 42, updatedAt: 'server-ts' }, // exists server-side, this tab just never loaded/snapshotted it
        },
      },
      localArrays: { timeLogs: [] }, // neither doc in the local array
      snapshotEntries: { timeLogs: [[knownId, 'unused-shared-hash']] }, // ONLY knownId is in the snapshot -- unknownId is not
    });
    sandbox.backstopContentSnapshots.timeLogs.set(knownId, vm.runInContext(`computeContentHash(${JSON.stringify(knownLocal)})`, sandbox));
    const diffs = await runCycle(sandbox);
    check('diffCollection only flagged the known id as a delete candidate', diffs.timeLogs.toDelete.length === 1 && diffs.timeLogs.toDelete[0] === knownId);
    check('known id (in snapshot, hash matches) was deleted', deleted.timeLogs.includes(knownId));
    check('unknown id (never in snapshot) was NEVER touched -- not in toDelete, not deleted', !diffs.timeLogs.toDelete.includes(unknownId) && !deleted.timeLogs.includes(unknownId));
  }

  // ═══════════════════════════════════════════════════════════════════
  // CASE 5: mixed cycle -- writes proceed normally even while some
  // deletes in the same cycle are guarded/skipped. Confirms the guard
  // change didn't couple the write path to the delete path.
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== CASE 5: writes unaffected by delete-guard skips in the same cycle ===');
  {
    const newDocId = 'planentries-new-or-edited';
    const skippedId = 'planentries-changed-elsewhere';
    const lastKnown = { id: skippedId, x: 1, updatedAt: 'old' };
    const serverNow = { id: skippedId, x: 999, updatedAt: 'new' };
    const { sandbox, deleted, written } = buildSandbox({
      serverDocs: { planEntries: { [skippedId]: serverNow } },
      localArrays: { planEntries: [{ id: newDocId, desc: 'new item', updatedAt: 'irrelevant' }] },
      snapshotEntries: { planEntries: [[skippedId, 'unused-shared-hash']] }, // newDocId not in snapshot -> toWrite; skippedId missing from array -> toDelete candidate
    });
    sandbox.backstopContentSnapshots.planEntries.set(skippedId, vm.runInContext(`computeContentHash(${JSON.stringify(lastKnown)})`, sandbox));
    await runCycle(sandbox);
    check('new/changed doc still written despite an unrelated skipped delete in the same cycle', written.planEntries.some(w => w.id === newDocId));
    check('changed-elsewhere doc still correctly skipped, not deleted', !deleted.planEntries.includes(skippedId));
  }

  // ═══════════════════════════════════════════════════════════════════
  // CASE 6: server doc already gone (another tab's cycle beat us to it)
  // -- no-op, not an error, not double-deleted.
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== CASE 6: server doc already gone -- no-op, no error ===');
  {
    const docId = 'projects-already-gone';
    const { sandbox, deleted } = buildSandbox({
      serverDocs: { projects: {} }, // does not exist
      localArrays: { projects: [] },
      snapshotEntries: { projects: [[docId, 'unused-shared-hash']] },
      contentSnapshotEntries: { projects: [[docId, 'whatever']] },
    });
    let threw = false;
    try { await runCycle(sandbox); } catch (e) { threw = true; }
    check('cycle completes without throwing when the candidate is already gone server-side', !threw);
    check('already-gone doc not re-recorded as deleted (nothing to delete)', !deleted.projects.includes(docId));
  }

  // ═══════════════════════════════════════════════════════════════════
  // CASE 7: guard is strictly more conservative than the pre-Stage-C
  // unconditional delete -- the actual delete set is always a subset of
  // what the old "delete everything in toDelete" code would have done.
  // This is the specific regression this call site (previously
  // unguarded) needed proven, not just Stage 0's original call site.
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== CASE 7: guard strictly more conservative than old unconditional delete ===');
  {
    const safeId = 'timelogs-safe';
    const changedId = 'timelogs-changed';
    const safeLocal = { id: safeId, x: 1, updatedAt: 't0' };
    const changedLocal = { id: changedId, x: 1, updatedAt: 't0' };
    const { sandbox, deleted } = buildSandbox({
      serverDocs: {
        timeLogs: {
          [safeId]: { ...safeLocal, updatedAt: 't5' },
          [changedId]: { id: changedId, x: 999, updatedAt: 't1' },
        },
      },
      localArrays: { timeLogs: [] },
      snapshotEntries: { timeLogs: [[safeId, 'x'], [changedId, 'x']] },
    });
    sandbox.backstopContentSnapshots.timeLogs.set(safeId, vm.runInContext(`computeContentHash(${JSON.stringify(safeLocal)})`, sandbox));
    sandbox.backstopContentSnapshots.timeLogs.set(changedId, vm.runInContext(`computeContentHash(${JSON.stringify(changedLocal)})`, sandbox));

    const oldCodeWouldDelete = new Set([safeId, changedId]); // pre-Stage-C: both in toDelete, both would've been deleted unconditionally
    const diffs = await runCycle(sandbox);
    check('both candidates present in toDelete (pre-guard set)', diffs.timeLogs.toDelete.length === 2);
    const actuallyDeleted = new Set(deleted.timeLogs);
    check('safe candidate deleted', actuallyDeleted.has(safeId));
    check('changed candidate NOT deleted', !actuallyDeleted.has(changedId));
    let isSubset = true;
    actuallyDeleted.forEach(id => { if (!oldCodeWouldDelete.has(id)) isSubset = false; });
    check('actual delete set is a subset of the old unconditional behavior (never a superset)', isSubset);
    check('actual delete set is a STRICT subset (guard suppressed at least one)', actuallyDeleted.size < oldCodeWouldDelete.size);
  }

  // ═══════════════════════════════════════════════════════════════════
  // CASE 8: delete-commit failure -- retry-by-omission still holds. The
  // guard confirms it's safe to delete, but the batch commit itself
  // fails; the id must stay in docSnapshots so the NEXT cycle's diff
  // finds it missing again and retries automatically.
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== CASE 8: delete-commit failure -- retried next cycle, not lost ===');
  {
    const docId = 'planentries-commit-fails-once';
    const localItem = { id: docId, x: 1, updatedAt: 'old' };
    const { sandbox, deleted } = buildSandbox({
      serverDocs: { planEntries: { [docId]: { ...localItem, updatedAt: 'server-ts' } } },
      localArrays: { planEntries: [] },
      snapshotEntries: { planEntries: [[docId, 'unused-shared-hash']] },
      failCommitFor: new Set([docId]),
    });
    sandbox.backstopContentSnapshots.planEntries.set(docId, vm.runInContext(`computeContentHash(${JSON.stringify(localItem)})`, sandbox));
    let threw = false;
    try { await runCycle(sandbox); } catch (e) { threw = true; }
    check('a failed commit does not throw out of syncChangedDocs (caught, logged, retried)', !threw);
    check('id still present in docSnapshots after a failed commit (will retry next cycle)', sandbox.docSnapshots.planEntries.has(docId));
    check('not recorded as deleted since the commit failed', !deleted.planEntries.includes(docId));
  }

  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
}

run();
