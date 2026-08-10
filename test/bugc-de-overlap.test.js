// Fixture test for the Bug C de-overlap fix in
// api/biometric-sync.js's closeReconciliationNeededSessions().
//
// Bug C (found live on 2026-08-10): the function used to process every
// reconciliationNeeded:true doc independently and close each one at the
// user's biometric OUT. Fine for one flagged doc/day. Broken for 2+ --
// every flagged doc for that user that day got stretched to the SAME OUT
// time, producing overlapping ranges and double-counted totals. See
// FINDINGS-2026-08-10.md, "Bug C," for the real-world incident this
// reproduces.
//
// This file:
//   1. Mocks firebase/app + firebase/firestore + global.fetch so the real
//      exported closeReconciliationNeededSessions() can run against an
//      in-memory doc store instead of live Firestore/eTimeOffice.
//   2. Keeps a frozen, verbatim-behavior copy of the PRE-FIX per-doc-
//      independent closing logic (closeReconciliationNeededSessions_PREFIX)
//      so the same fixture data can be run against both, proving (a) the
//      fixture reproduces the real bug on old logic, and (b) the new code
//      actually fixes it.
//   3. Two fixture shapes: "Neha" (orphan + real final, same pattern as
//      the actual 2026-08-10 incident) and "Souvik" (triple-overlap: two
//      stretched orphans plus a normal, never-flagged doc that's the true
//      final segment).
//
// Run with: node test/bugc-de-overlap.test.js
'use strict';

const assert = require('assert');
const path = require('path');

const projectRoot = path.join(__dirname, '..');

// ── Fake firebase/app + firebase/firestore ─────────────────────────────
// currentStore is reassigned per fixture case (see runCase below); every
// mock function below reads/writes it live, so no module reload is needed
// between cases.
let currentStore = new Map(); // id -> plain data object

function collection(_db, name) { return { name }; }
function where(field, op, value) { return { field, op, value }; }
function query(collRef, ...conditions) { return { collRef, conditions }; }
function matches(data, cond) {
  const v = data[cond.field];
  if (cond.op === '==') return v === cond.value;
  if (cond.op === '>=') return v >= cond.value;
  if (cond.op === '<=') return v <= cond.value;
  throw new Error(`mock getDocs: unsupported operator ${cond.op}`);
}
async function getDocs(q) {
  const docs = [];
  for (const [id, data] of currentStore) {
    if (q.conditions.every((c) => matches(data, c))) {
      docs.push({ id, data: () => ({ ...data }) });
    }
  }
  return { size: docs.length, docs, forEach(cb) { docs.forEach(cb); } };
}
function docRef(_db, _collName, id) { return { id }; }
async function updateDoc(ref, updates) {
  const existing = currentStore.get(ref.id);
  if (!existing) throw new Error(`mock updateDoc: no such doc ${ref.id}`);
  currentStore.set(ref.id, { ...existing, ...updates });
}
async function setDoc(ref, data, opts) {
  const existing = currentStore.get(ref.id) || {};
  currentStore.set(ref.id, opts && opts.merge ? { ...existing, ...data } : { ...data });
}
function getFirestore() { return { __fake: true }; }
function initializeApp() { return { __fake: true }; }
function getApps() { return []; }
function getApp() { return {}; }

const fakeAppModule = { initializeApp, getApps, getApp };
const fakeFirestoreModule = { getFirestore, collection, query, where, getDocs, doc: docRef, setDoc, updateDoc };

const appPath = require.resolve('firebase/app');
const firestorePath = require.resolve('firebase/firestore');
require.cache[appPath] = { id: appPath, filename: appPath, loaded: true, exports: fakeAppModule };
require.cache[firestorePath] = { id: firestorePath, filename: firestorePath, loaded: true, exports: fakeFirestoreModule };

process.env.ETIME_CORP = 'fixture-corp';
process.env.ETIME_USER = 'fixture-user';
process.env.ETIME_PASS = 'fixture-pass';

// eTimeOffice punch data for the date under test -- reassigned per case.
let currentPunchRecords = [];
global.fetch = async () => ({
  ok: true,
  json: async () => ({ InOutPunchData: currentPunchRecords }),
});

// Now safe to require the real module -- it will pick up the mocks above.
const biometricSync = require(path.join(projectRoot, 'api', 'biometric-sync.js'));
const { closeReconciliationNeededSessions, EMPCODE_TO_USERID, capSessionDuration } = biometricSync;
assert.strictEqual(typeof closeReconciliationNeededSessions, 'function', 'closeReconciliationNeededSessions must be exported for testing');

const NEHA_USER_ID = EMPCODE_TO_USERID['0015'];
const NEHA_EMPCODE = '0015';
const SOUVIK_USER_ID = EMPCODE_TO_USERID['011'];
const SOUVIK_EMPCODE = '011';
assert.ok(NEHA_USER_ID && SOUVIK_USER_ID, 'fixture depends on real EMPCODE_TO_USERID entries still existing');

const FIXTURE_DATE = '2099-01-01'; // never a real reconciled date, never colliding with RECONCILED_DATES

function hhmmToEpoch(isoDate, hhmm) {
  return new Date(`${isoDate}T${hhmm}:00+05:30`).getTime();
}
function toHHMM(epochMs) {
  return new Date(epochMs).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
}

// ── Frozen pre-fix reference implementation ─────────────────────────────
// Verbatim behavior of the ORIGINAL (buggy) function: every flagged doc is
// closed independently at biometric OUT, with no per-user grouping. Kept
// here (not pulled from git) so this file is self-contained and always
// runnable. Only handles the biometric-OUT path (sufficient for these
// fixtures, which always supply real punch data).
async function closeReconciliationNeededSessions_PREFIX(db, isoDate, confirm) {
  const { getDocs: gd, query: q, collection: c, where: w, doc: d, updateDoc: ud } = fakeFirestoreModule;
  const snap = await gd(q(c(db, 'timeLogs'), w('inProgress', '==', true), w('reconciliationNeeded', '==', true), w('date', '>=', isoDate), w('date', '<=', isoDate)));
  const userIdToEmpcode = new Map(Object.entries(EMPCODE_TO_USERID).map(([e, u]) => [u, e]));
  const records = currentPunchRecords;
  const punchByEmpcode = new Map(records.map((r) => [r.Empcode, r]));
  let closed = 0;
  for (const docSnap of snap.docs) {
    const data = docSnap.data();
    const startMs = data.sessionStartMs;
    const empcode = userIdToEmpcode.get(data.userId);
    const rec = empcode ? punchByEmpcode.get(empcode) : null;
    if (!rec || !rec.OUTTime || rec.OUTTime === '--:--') continue;
    const outMs = hhmmToEpoch(isoDate, rec.OUTTime);
    const { durationMins } = capSessionDuration(Math.round((outMs - startMs) / 1000));
    if (confirm) {
      await ud(d(db, 'timeLogs', docSnap.id), {
        inProgress: false, recovered: true, durationMins, endTime: toHHMM(outMs), reconciliationNeeded: false,
      });
      closed++;
    }
  }
  return { closed };
}

// ── Overlap detection (mirrors the diagnose script used on real prod data) ─
function toMins(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }
function findOverlaps(docs) {
  const withRange = docs.filter((d) => d.startTime && d.endTime).map((d) => ({ ...d, sMin: toMins(d.startTime), eMin: toMins(d.endTime) })).sort((a, b) => a.sMin - b.sMin);
  const overlaps = [];
  for (let i = 1; i < withRange.length; i++) {
    if (withRange[i].sMin < withRange[i - 1].eMin) overlaps.push([withRange[i - 1].id, withRange[i].id]);
  }
  return overlaps;
}

let passCount = 0, failCount = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); passCount++; }
  else { console.log(`  FAIL: ${label}`); failCount++; }
}

// ═══════════════════════════════════════════════════════════════════════
// CASE 1: Neha shape -- orphan (10:11) + lunch (unflagged, 13:59-14:10) +
// real final (14:10), biometric OUT 19:14. Reproduces the exact pattern
// from 2026-08-10.
// ═══════════════════════════════════════════════════════════════════════
function nehaFixtureDocs() {
  return new Map([
    ['fx-neha-orphan', {
      userId: NEHA_USER_ID, date: FIXTURE_DATE, inProgress: true, reconciliationNeeded: true,
      sessionStartMs: hhmmToEpoch(FIXTURE_DATE, '10:11'), startTime: '10:11', desc: 'Parea Cafe',
    }],
    ['fx-neha-lunch', {
      userId: NEHA_USER_ID, date: FIXTURE_DATE, inProgress: false, reconciliationNeeded: false, productive: false,
      startTime: '13:59', endTime: '14:10', durationMins: 11, desc: 'Lunch Break',
    }],
    ['fx-neha-final', {
      userId: NEHA_USER_ID, date: FIXTURE_DATE, inProgress: true, reconciliationNeeded: true,
      sessionStartMs: hhmmToEpoch(FIXTURE_DATE, '14:10'), startTime: '14:10', desc: 'Parea Cafe',
    }],
  ]);
}
const NEHA_PUNCH = [{ Empcode: NEHA_EMPCODE, Name: 'Neha (fixture)', INTime: '10:11', OUTTime: '19:14' }];
const NEHA_CEILING_MINS = 9 * 60 + 3; // 543m, real 2026-08-10 Work+OT

async function runNehaCase() {
  console.log('\n=== CASE 1: Neha shape (orphan + real final, same-day) ===');

  console.log('-- pre-fix reference (expected to reproduce the bug) --');
  currentStore = nehaFixtureDocs();
  currentPunchRecords = NEHA_PUNCH;
  await closeReconciliationNeededSessions_PREFIX({}, FIXTURE_DATE, true);
  const preOrphan = currentStore.get('fx-neha-orphan');
  const preFinal = currentStore.get('fx-neha-final');
  console.log(`  orphan endTime after pre-fix run: ${preOrphan.endTime}`);
  console.log(`  final endTime after pre-fix run:  ${preFinal.endTime}`);
  check('pre-fix: orphan wrongly stretched to biometric OUT (reproduces Bug C)', preOrphan.endTime === '19:14');
  check('pre-fix: final also stretched to biometric OUT', preFinal.endTime === '19:14');
  check('pre-fix: orphan and final ranges overlap (both end at OUT, orphan starts before final)', preOrphan.endTime === preFinal.endTime);

  console.log('-- fixed code (dry-run first) --');
  currentStore = nehaFixtureDocs();
  currentPunchRecords = NEHA_PUNCH;
  const dryRun = await closeReconciliationNeededSessions({}, FIXTURE_DATE, false);
  console.log('  dry-run report:', JSON.stringify(dryRun));
  check('dry-run does not write anything', currentStore.get('fx-neha-orphan').inProgress === true);
  check('dry-run counts 1 deoverlapped + 1 closedBiometric', dryRun.deoverlapped === 1 && dryRun.closedBiometric === 1);

  console.log('-- fixed code (confirm=true) --');
  const result = await closeReconciliationNeededSessions({}, FIXTURE_DATE, true);
  console.log('  write report:', JSON.stringify(result));
  const orphan = currentStore.get('fx-neha-orphan');
  const lunch = currentStore.get('fx-neha-lunch');
  const final = currentStore.get('fx-neha-final');
  console.log(`  orphan: ${orphan.startTime}-${orphan.endTime} (${orphan.durationMins}m)`);
  console.log(`  lunch:  ${lunch.startTime}-${lunch.endTime} (${lunch.durationMins}m) [untouched]`);
  console.log(`  final:  ${final.startTime}-${final.endTime} (${final.durationMins}m)`);

  check('orphan bounded to lunch start (13:59), not biometric OUT', orphan.endTime === '13:59');
  check('orphan durationMins recomputed correctly (228m)', orphan.durationMins === 228);
  check('lunch doc untouched (was never flagged)', lunch.startTime === '13:59' && lunch.endTime === '14:10' && lunch.durationMins === 11);
  check('final extended to real biometric OUT (19:14)', final.endTime === '19:14');
  check('only ONE doc (the true final) reaches biometric OUT', [orphan, final].filter((d) => d.endTime === '19:14').length === 1);

  const overlaps = findOverlaps([{ id: 'orphan', ...orphan }, { id: 'lunch', ...lunch }, { id: 'final', ...final }]);
  check('no time-range overlaps after fix', overlaps.length === 0);

  const total = orphan.durationMins + lunch.durationMins + final.durationMins;
  console.log(`  total: ${total}m vs ceiling ${NEHA_CEILING_MINS}m`);
  check(`repaired total (${total}m) is at/under biometric ceiling (${NEHA_CEILING_MINS}m)`, total <= NEHA_CEILING_MINS);
}

// ═══════════════════════════════════════════════════════════════════════
// CASE 2: Souvik shape -- triple overlap. Two flagged orphans
// (13:37, 14:06) straddling an unflagged lunch (13:48-14:06), plus a
// normal, NEVER-flagged doc (19:02-19:29) that is the actual true final
// segment -- invisible to the original flagged-only query. Biometric OUT
// 19:31.
// ═══════════════════════════════════════════════════════════════════════
function souvikFixtureDocs() {
  return new Map([
    ['fx-souvik-orphan1', {
      userId: SOUVIK_USER_ID, date: FIXTURE_DATE, inProgress: true, reconciliationNeeded: true,
      sessionStartMs: hhmmToEpoch(FIXTURE_DATE, '13:37'), startTime: '13:37', desc: 'Garcha Office',
    }],
    ['fx-souvik-lunch', {
      userId: SOUVIK_USER_ID, date: FIXTURE_DATE, inProgress: false, reconciliationNeeded: false, productive: false,
      startTime: '13:48', endTime: '14:06', durationMins: 18, desc: 'Lunch Break',
    }],
    ['fx-souvik-orphan2', {
      userId: SOUVIK_USER_ID, date: FIXTURE_DATE, inProgress: true, reconciliationNeeded: true,
      sessionStartMs: hhmmToEpoch(FIXTURE_DATE, '14:06'), startTime: '14:06', desc: 'Garcha Office',
    }],
    ['fx-souvik-true-final', {
      // Normal, already-closed doc -- NEVER flagged (inProgress:false,
      // reconciliationNeeded:false from the start). This is exactly what
      // made Souvik's real case a triple overlap: the query that finds
      // flagged docs never sees this one at all.
      userId: SOUVIK_USER_ID, date: FIXTURE_DATE, inProgress: false, reconciliationNeeded: false,
      startTime: '19:02', endTime: '19:29', durationMins: 27, desc: 'Garcha Office',
    }],
  ]);
}
const SOUVIK_PUNCH = [{ Empcode: SOUVIK_EMPCODE, Name: 'Souvik (fixture)', INTime: '11:53', OUTTime: '19:31' }];

async function runSouvikCase() {
  console.log('\n=== CASE 2: Souvik shape (triple overlap, true final never flagged) ===');

  console.log('-- pre-fix reference (expected to reproduce the bug) --');
  currentStore = souvikFixtureDocs();
  currentPunchRecords = SOUVIK_PUNCH;
  await closeReconciliationNeededSessions_PREFIX({}, FIXTURE_DATE, true);
  const preO1 = currentStore.get('fx-souvik-orphan1');
  const preO2 = currentStore.get('fx-souvik-orphan2');
  const preTrueFinal = currentStore.get('fx-souvik-true-final');
  console.log(`  orphan1 endTime: ${preO1.endTime}, orphan2 endTime: ${preO2.endTime}, true-final endTime (untouched by either path): ${preTrueFinal.endTime}`);
  check('pre-fix: orphan1 wrongly stretched to biometric OUT', preO1.endTime === '19:31');
  check('pre-fix: orphan2 also wrongly stretched to biometric OUT', preO2.endTime === '19:31');
  const preOverlaps = findOverlaps([
    { id: 'orphan1', ...preO1 }, { id: 'lunch', ...currentStore.get('fx-souvik-lunch') },
    { id: 'orphan2', ...preO2 }, { id: 'true-final', ...preTrueFinal },
  ]);
  console.log(`  overlaps found: ${JSON.stringify(preOverlaps)}`);
  check('pre-fix: triple overlap detected (orphan1, orphan2 and true-final all collide)', preOverlaps.length >= 2);

  console.log('-- fixed code (confirm=true) --');
  currentStore = souvikFixtureDocs();
  currentPunchRecords = SOUVIK_PUNCH;
  const result = await closeReconciliationNeededSessions({}, FIXTURE_DATE, true);
  console.log('  write report:', JSON.stringify(result));
  const o1 = currentStore.get('fx-souvik-orphan1');
  const lunch = currentStore.get('fx-souvik-lunch');
  const o2 = currentStore.get('fx-souvik-orphan2');
  const trueFinal = currentStore.get('fx-souvik-true-final');
  console.log(`  orphan1:    ${o1.startTime}-${o1.endTime} (${o1.durationMins}m)`);
  console.log(`  lunch:      ${lunch.startTime}-${lunch.endTime} (${lunch.durationMins}m) [untouched]`);
  console.log(`  orphan2:    ${o2.startTime}-${o2.endTime} (${o2.durationMins}m)`);
  console.log(`  true-final: ${trueFinal.startTime}-${trueFinal.endTime} (${trueFinal.durationMins}m) [untouched -- not flagged, not this function's job]`);

  check('orphan1 bounded to lunch start (13:48)', o1.endTime === '13:48' && o1.durationMins === 11);
  check('orphan2 bounded to true-final\'s start (19:02), NOT biometric OUT', o2.endTime === '19:02' && o2.durationMins === 296);
  check('true-final doc completely untouched (never flagged, not this function\'s job)', trueFinal.startTime === '19:02' && trueFinal.endTime === '19:29' && trueFinal.durationMins === 27);
  check('neither orphan reaches biometric OUT (19:31) -- that was exactly Bug C\'s failure mode', o1.endTime !== '19:31' && o2.endTime !== '19:31');
  check('result.deoverlapped counts both bounded orphans, closedBiometric counts none (true final was never flagged)', result.deoverlapped === 2 && result.closedBiometric === 0);

  const overlaps = findOverlaps([
    { id: 'orphan1', ...o1 }, { id: 'lunch', ...lunch }, { id: 'orphan2', ...o2 }, { id: 'true-final', ...trueFinal },
  ]);
  console.log(`  overlaps after fix: ${JSON.stringify(overlaps)}`);
  check('no time-range overlaps after fix (triple overlap fully resolved)', overlaps.length === 0);
}

// ═══════════════════════════════════════════════════════════════════════
// CASE 3: single-flagged-doc case (Ridhi/Taskiya shape) must be BYTE-
// IDENTICAL in behavior to before the fix -- this is the explicit
// "must not change" requirement.
// ═══════════════════════════════════════════════════════════════════════
async function runSingleDocCase() {
  console.log('\n=== CASE 3: single flagged doc, nothing else that day (Ridhi/Taskiya shape) ===');
  currentStore = new Map([
    ['fx-ridhi-only', {
      userId: NEHA_USER_ID, date: FIXTURE_DATE, inProgress: true, reconciliationNeeded: true,
      sessionStartMs: hhmmToEpoch(FIXTURE_DATE, '10:54'), startTime: '10:54', desc: 'Parea Cafe',
    }],
  ]);
  currentPunchRecords = [{ Empcode: NEHA_EMPCODE, Name: 'Ridhi-shape (fixture)', INTime: '10:54', OUTTime: '19:12' }];
  const result = await closeReconciliationNeededSessions({}, FIXTURE_DATE, true);
  console.log('  write report:', JSON.stringify(result));
  const solo = currentStore.get('fx-ridhi-only');
  console.log(`  solo doc: ${solo.startTime}-${solo.endTime} (${solo.durationMins}m)`);
  check('single flagged doc with nothing later closes straight at biometric OUT (unchanged behavior)', solo.endTime === '19:12');
  check('closedBiometric counts it, deoverlapped stays 0', result.closedBiometric === 1 && result.deoverlapped === 0);
}

(async () => {
  await runNehaCase();
  await runSouvikCase();
  await runSingleDocCase();

  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
})().catch((e) => { console.error('FIXTURE ERROR:', e); process.exit(1); });
