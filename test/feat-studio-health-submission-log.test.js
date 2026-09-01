// Fixture test for Studio Health -- Submission Log (Layer B), the
// delivery-tracking log: committed vs. actual dates, revision chains.
// KPI computations (on-time rate, slippage, rework rate, delivery
// rhythm, hours-per-submission) are a DELIBERATE second pass, not built
// here -- this file tests the log + entry UI only.
//
// Extracts the ACTUAL functions from index.html (brace-matched, not
// retyped) and runs them in a vm sandbox -- same discipline as every
// other fixture in this repo.
//
// Central claims under test:
//  - saveSubmission() is the ONLY write anywhere in this feature
//    (source-text check across every extracted function)
//  - the write mirrors saveReview()/saveLeaveRequest()'s shape: targeted
//    doc, {merge:true}, source:'server' verify immediately after, throws
//    on a failed verify
//  - "Revise" creates a NEW linked doc: revisionNumber = max-in-chain+1,
//    parentSubmissionId always points at the chain's ORIGINAL (not the
//    immediately-prior revision) -- proven by reviving from a MIDDLE
//    revision of a 3-deep chain, not just rev1->rev2
//  - submissions collection NOT registered in computeCollectionDiffs()
//  - the list view groups correctly by project then by chain, revisions
//    shown in ascending order
//
// Run with: node test/feat-studio-health-submission-log.test.js
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

const FN_NAMES = ['groupSubmissionsByProject', 'computeNextRevision', 'saveSubmission'];
const fnSrc = {};
FN_NAMES.forEach(name => { fnSrc[name] = extractFunction(fullScript, name); });
const renderLogSrc = extractFunction(fullScript, 'renderSubmissionLog');
const renderLogBodySrc = extractFunction(fullScript, 'renderSubmissionLogBody');
const genIdSrc = extractFunction(fullScript, 'genId');

// ═══════════════════════════════════════════════════════════════════
console.log('=== Source-text check: saveSubmission() is the ONLY write ===');
let passCount = 0, failCount = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); passCount++; }
  else { console.log(`  FAIL: ${label}`); failCount++; }
}
const nonWriteFnNames = FN_NAMES.filter(n => n !== 'saveSubmission');
const nonWriteSrc = nonWriteFnNames.map(n => fnSrc[n]).concat([renderLogSrc, renderLogBodySrc]).join('\n');
check(
  'no Firestore .set(/.update(/.add(/.delete(/.batch( anywhere OUTSIDE saveSubmission() (Set.add()/classList.add()/data-*.add()-style DOM calls are plain JS/DOM, not writes, and are excluded)',
  !/\.(set|update|add|delete|batch)\(/.test(
    nonWriteSrc
      .replace(/\.classList\.add\(/g, '')
      .replace(/\bset\.add\(/g, '')
      .replace(/document\.querySelectorAll\('\[data-edit\]'\)\.forEach/g, '')
      .replace(/document\.querySelectorAll\('\[data-revise\]'\)\.forEach/g, '')
  )
);
check('saveSubmission() itself uses {merge:true}', fnSrc.saveSubmission.includes('{ merge: true }'));
check('saveSubmission() verifies source:\'server\' immediately after the write', fnSrc.saveSubmission.includes(`get({ source: 'server' })`));
check('saveSubmission() throws if the server verify comes back missing (fail loud, not silent)', fnSrc.saveSubmission.includes('throw new Error'));
check('submissions collection NOT registered in computeCollectionDiffs() -- still hardcoded to exactly 3 collections', (() => {
  const ccdSrc = extractFunction(fullScript, 'computeCollectionDiffs');
  return ccdSrc.includes('timeLogs') && ccdSrc.includes('planEntries') && ccdSrc.includes('projects') && !ccdSrc.includes('submissions');
})());

function buildSandbox() {
  const sandbox = { console, Date, Object, Math, Set, String };
  vm.createContext(sandbox);
  vm.runInContext(genIdSrc, sandbox);
  FN_NAMES.forEach(name => { if (name !== 'saveSubmission') vm.runInContext(fnSrc[name], sandbox); });
  return sandbox;
}

async function run() {
  // ═══════════════════════════════════════════════════════════════
  console.log('\n=== computeNextRevision: parentSubmissionId always points at the ORIGINAL, not the immediately-prior revision ===');
  {
    const sandbox = buildSandbox();
    const rev1 = { id: 'sub-a', projectId: 'p1', projectName: 'Proj A', packageName: 'DD Package', revisionNumber: 1, parentSubmissionId: null };
    const rev2 = { id: 'sub-b', projectId: 'p1', projectName: 'Proj A', packageName: 'DD Package', revisionNumber: 2, parentSubmissionId: 'sub-a' };
    const rev3 = { id: 'sub-c', projectId: 'p1', projectName: 'Proj A', packageName: 'DD Package', revisionNumber: 3, parentSubmissionId: 'sub-a' };
    const all = [rev1, rev2, rev3];

    const fromLatest = vm.runInContext('computeNextRevision', sandbox)(all, 'sub-c');
    check('reviving from rev3 -> next revisionNumber is 4', fromLatest.nextRevisionNumber === 4);
    check('reviving from rev3 -> parentSubmissionId points at the ORIGINAL (sub-a), not sub-c itself', fromLatest.originalId === 'sub-a');

    const fromOriginal = vm.runInContext('computeNextRevision', sandbox)(all, 'sub-a');
    check('reviving from the ORIGINAL (sub-a) directly -> still finds the true max across the whole chain (4), not just 1+1', fromOriginal.nextRevisionNumber === 4);
    check('reviving from the original -> originalId is itself', fromOriginal.originalId === 'sub-a');

    // The critical case: reviving from a MIDDLE revision (rev2) of a
    // 3-deep chain must still link to the ORIGINAL (sub-a), never to
    // rev2 -- proving parentSubmissionId is not "immediately-prior".
    const fromMiddle = vm.runInContext('computeNextRevision', sandbox)(all, 'sub-b');
    check('reviving from a MIDDLE revision (rev2) -> parentSubmissionId still points at the ORIGINAL (sub-a), not sub-b', fromMiddle.originalId === 'sub-a');
    check('reviving from a MIDDLE revision -> next revisionNumber is still the true chain max + 1 (4), not rev2+1', fromMiddle.nextRevisionNumber === 4);
    check('carries forward projectId/projectName/packageName from the doc being revised', fromMiddle.projectId === 'p1' && fromMiddle.packageName === 'DD Package');

    const missing = vm.runInContext('computeNextRevision', sandbox)(all, 'sub-nonexistent');
    check('reviving a nonexistent id returns null rather than throwing', missing === null);
  }

  // ═══════════════════════════════════════════════════════════════
  console.log('\n=== groupSubmissionsByProject: groups by project, then by chain, revisions in ascending order ===');
  {
    const sandbox = buildSandbox();
    const subs = [
      { id: 's1', projectId: 'p1', projectName: 'Proj A', packageName: 'DD', revisionNumber: 1, parentSubmissionId: null },
      { id: 's3', projectId: 'p1', projectName: 'Proj A', packageName: 'DD', revisionNumber: 3, parentSubmissionId: 's1' },
      { id: 's2', projectId: 'p1', projectName: 'Proj A', packageName: 'DD', revisionNumber: 2, parentSubmissionId: 's1' },
      { id: 's4', projectId: 'p1', projectName: 'Proj A', packageName: 'CD', revisionNumber: 1, parentSubmissionId: null },
      { id: 's5', projectId: 'p2', projectName: 'Proj B', packageName: 'SD', revisionNumber: 1, parentSubmissionId: null },
    ];
    const grouped = vm.runInContext('groupSubmissionsByProject', sandbox)(subs);
    check('two projects present', Object.keys(grouped).length === 2);
    check('project p1 has two chains (DD and CD)', Object.keys(grouped.p1.chains).length === 2);
    check('the DD chain (rooted at s1) is sorted ascending by revisionNumber despite input order being 1,3,2', grouped.p1.chains.s1.map(s => s.revisionNumber).join(',') === '1,2,3');
    check('project name carried through', grouped.p1.projectName === 'Proj A' && grouped.p2.projectName === 'Proj B');
  }

  // ═══════════════════════════════════════════════════════════════
  console.log('\n=== saveSubmission: writes with {merge:true}, verifies source:server, returns the verified data ===');
  {
    let store = {};
    const writes = [];
    const mockSandbox = {
      console,
      db: {
        collection: () => ({
          doc: (id) => ({
            set: async (data, opts) => { writes.push({ id, data, opts }); store[id] = { ...(store[id] || {}), ...data }; },
            get: async () => ({ exists: !!store[id], data: () => store[id] }),
          }),
        }),
      },
    };
    vm.createContext(mockSandbox);
    vm.runInContext(fnSrc.saveSubmission, mockSandbox);
    const result = await vm.runInContext('saveSubmission', mockSandbox)('sub-x', { id: 'sub-x', projectId: 'p1', packageName: 'DD', revisionNumber: 1, parentSubmissionId: null, status: 'pending' });
    check('exactly one write', writes.length === 1);
    check('write used {merge:true}', writes[0].opts && writes[0].opts.merge === true);
    check('returned data matches what was verified from the mock "server"', result.packageName === 'DD');
  }

  console.log('\n=== saveSubmission: throws if the server verify comes back missing (does not silently succeed) ===');
  {
    const mockSandbox = {
      console,
      db: { collection: () => ({ doc: () => ({ set: async () => {}, get: async () => ({ exists: false, data: () => undefined }) }) }) },
    };
    vm.createContext(mockSandbox);
    vm.runInContext(fnSrc.saveSubmission, mockSandbox);
    let threw = false;
    try { await vm.runInContext('saveSubmission', mockSandbox)('sub-y', {}); } catch (e) { threw = true; }
    check('throws rather than reporting success on a failed verify', threw);
  }

  console.log('\n=== STRUCTURAL: revise-creates-linked-doc, real second write against a real mock db ===');
  {
    // Simulate the actual UI flow: log an original, then "Revise" it
    // twice in a row (second revive is FROM the just-created rev2, not
    // from the original), proving the chain-max logic and the
    // always-points-at-original rule against real sequential writes.
    const store = {};
    const writes = [];
    const mockSandbox = {
      console,
      db: {
        collection: () => ({
          doc: (id) => ({
            set: async (data, opts) => { writes.push({ id, data, opts }); store[id] = { ...(store[id] || {}), ...data }; },
            get: async () => ({ exists: !!store[id], data: () => store[id] }),
          }),
        }),
      },
    };
    vm.createContext(mockSandbox);
    vm.runInContext(fnSrc.saveSubmission, mockSandbox);
    const revSandbox = buildSandbox();

    await vm.runInContext('saveSubmission', mockSandbox)('sub-orig', { id: 'sub-orig', projectId: 'p1', projectName: 'Proj A', packageName: 'DD', revisionNumber: 1, parentSubmissionId: null, committedDate: '2026-09-01', actualDate: '2026-09-01', status: 'submitted' });

    let allSubs = Object.values(store);
    const next1 = vm.runInContext('computeNextRevision', revSandbox)(allSubs, 'sub-orig');
    check('first revise: next revisionNumber is 2', next1.nextRevisionNumber === 2);
    await vm.runInContext('saveSubmission', mockSandbox)('sub-rev2', { id: 'sub-rev2', projectId: next1.projectId, projectName: next1.projectName, packageName: next1.packageName, revisionNumber: next1.nextRevisionNumber, parentSubmissionId: next1.originalId, committedDate: '2026-09-15', actualDate: null, status: 'pending' });

    allSubs = Object.values(store);
    check('rev2 links to the original, not to itself', store['sub-rev2'].parentSubmissionId === 'sub-orig');

    // Revive FROM rev2 this time -- must still land on sub-orig, and rev 3.
    const next2 = vm.runInContext('computeNextRevision', revSandbox)(allSubs, 'sub-rev2');
    check('second revise (from rev2): next revisionNumber is 3', next2.nextRevisionNumber === 3);
    check('second revise (from rev2): parentSubmissionId still points at the ORIGINAL (sub-orig), not sub-rev2', next2.originalId === 'sub-orig');
    await vm.runInContext('saveSubmission', mockSandbox)('sub-rev3', { id: 'sub-rev3', projectId: next2.projectId, projectName: next2.projectName, packageName: next2.packageName, revisionNumber: next2.nextRevisionNumber, parentSubmissionId: next2.originalId, committedDate: '2026-09-30', actualDate: null, status: 'pending' });

    check('exactly 3 documents exist -- one per delivery event, none overwritten', Object.keys(store).length === 3);
    check('rev3 also links directly to the original', store['sub-rev3'].parentSubmissionId === 'sub-orig');
    check('the original doc itself is untouched by later revisions', store['sub-orig'].status === 'submitted' && store['sub-orig'].actualDate === '2026-09-01');
  }

  // ═══════════════════════════════════════════════════════════════
  // renderSubmissionLog / renderSubmissionLogBody -- need a mocked db/document.
  // ═══════════════════════════════════════════════════════════════
  function buildRenderSandbox({ projects = [], submissions = [] }) {
    let capturedHTML = undefined;
    const dbCalls = [];
    const elements = {};
    const store = {};
    submissions.forEach(s => { store[s.id] = s; });

    const sandbox = {
      console, Date, Object, Math, Set, String,
      currentUser: { id: 'admin1', isAdmin: true, name: 'Ranit' },
      shCachedSubmissionData: null,
      shSubFormMode: 'new',
      shSubFormTargetId: '',
      db: {
        collection: (name) => ({
          get: async (opts) => {
            dbCalls.push({ collection: name, opts, kind: 'collection' });
            const map = { projects, submissions: Object.values(store) };
            const data = map[name] || [];
            return { forEach: (fn) => data.forEach((d, i) => fn({ data: () => d, id: d.id || `${name}${i}` })) };
          },
          doc: (id) => ({
            set: async (data, opts) => { store[id] = { ...(store[id] || {}), ...data, id }; },
            get: async () => ({ exists: !!store[id], data: () => store[id] }),
          }),
        }),
      },
      document: {
        querySelectorAll: () => [],
        getElementById: (id) => {
          if (id === 'sh-submissionlog') {
            return { set innerHTML(v) { capturedHTML = v; }, get innerHTML() { return capturedHTML; } };
          }
          if (!elements[id]) elements[id] = { value: '', textContent: '', classList: { add: () => {}, toggle: () => {} }, disabled: false, addEventListener: () => {} };
          return elements[id];
        },
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(genIdSrc, sandbox);
    FN_NAMES.forEach(name => vm.runInContext(fnSrc[name], sandbox));
    vm.runInContext(renderLogSrc, sandbox);
    vm.runInContext(renderLogBodySrc, sandbox);
    return { sandbox, dbCalls, store, getHTML: () => capturedHTML };
  }

  console.log('\n=== renderSubmissionLog: fresh source:server reads on open ===');
  {
    const projects = [{ id: 'p1', name: 'Proj A' }];
    const { dbCalls } = await (async () => {
      const b = buildRenderSandbox({ projects });
      await vm.runInContext('renderSubmissionLog', b.sandbox)();
      return b;
    })();
    check('2 fresh reads (projects, submissions)', dbCalls.filter(c => c.kind === 'collection').length === 2);
    check('all reads used source:\'server\'', dbCalls.every(c => c.opts && c.opts.source === 'server'));
  }

  console.log('\n=== STRUCTURAL: renderSubmissionLogBody -- entry form + list view with a chain, revision numbers shown ===');
  {
    const projects = [{ id: 'p1', name: 'BURDWAN RD' }];
    const submissions = [
      { id: 'sub-1', projectId: 'p1', projectName: 'BURDWAN RD', packageName: 'DD Package', revisionNumber: 1, parentSubmissionId: null, committedDate: '2026-08-01', actualDate: '2026-08-03', status: 'submitted', notes: '' },
      { id: 'sub-2', projectId: 'p1', projectName: 'BURDWAN RD', packageName: 'DD Package', revisionNumber: 2, parentSubmissionId: 'sub-1', committedDate: '2026-08-20', actualDate: null, status: 'pending', notes: 'Client requested revisions.' },
    ];
    const { getHTML } = await (async () => {
      const b = buildRenderSandbox({ projects, submissions });
      await vm.runInContext('renderSubmissionLog', b.sandbox)();
      return b;
    })();
    const html = getHTML();
    check('entry form present (project picker + package + dates + status)', /Log a Submission/.test(html) && /shsubProject/.test(html) && /shsubPackage/.test(html) && /shsubCommitted/.test(html) && /shsubActual/.test(html) && /shsubStatus/.test(html));
    check('the project picker is populated from the real project (BURDWAN RD)', /BURDWAN RD/.test(html));
    check('Submission Log card present', /Submission Log/.test(html));
    check('both revisions of the chain appear', (html.match(/DD Package/g) || []).length >= 2);
    check('revision numbers 1 and 2 both shown', />1<\/td>/.test(html) && />2<\/td>/.test(html));
    check('a Revise button is offered on the latest revision', /data-revise="sub-2"/.test(html));
    check('no Revise button on the superseded revision (only the chain tip)', !/data-revise="sub-1"/.test(html));
    check('pending vs submitted status both render as plain text, no fabricated on-time/late verdict', /submitted/.test(html) && /pending/.test(html) && !/\b(on.time|late|overdue)\b/i.test(html));
  }

  console.log('\n=== STRUCTURAL: empty state -- no submissions logged yet ===');
  {
    const projects = [{ id: 'p1', name: 'Proj A' }];
    const { getHTML } = await (async () => {
      const b = buildRenderSandbox({ projects, submissions: [] });
      await vm.runInContext('renderSubmissionLog', b.sandbox)();
      return b;
    })();
    check('empty-state message shown when no submissions exist yet', /No submissions logged yet/.test(getHTML()));
  }

  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
}

run();
