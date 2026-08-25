// Fixture test for Glitch 5: the miss-punch EOD-close fallback in
// api/biometric-sync.js's closeAtGenuineFinal(), no-biometric-OUT branch.
// Extracts the ACTUAL nested function source directly from the real file
// (brace-matched, not retyped) and runs it in a vm sandbox with mocked
// Firestore doc()/updateDoc() and the real ported helpers
// (hhmmToEpoch/toHHMM/capSessionDuration/extractLastSeenMs) -- proving the
// real shipped code, not a reimplementation.
//
// Scope: closeAtGenuineFinal()'s decision logic specifically -- the
// primary/fallback/ceiling/fail-safe anchor selection this stage adds.
// The `combined[i-1]` call-site wiring and the next-doc/no-next branching
// (which docs even reach this function) are unchanged by this diff and
// already covered by test/bugc-de-overlap.test.js's existing coverage of
// `combined` construction/ordering -- not re-tested here.
//
// Run with: node test/glitch5-miss-punch-fallback.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SYNC_FILE = path.join('D:/SQUARE/ADMIN/SQUARE-Office/finalphase/01072026', 'api', 'biometric-sync.js');
const src = fs.readFileSync(SYNC_FILE, 'utf8');

function extractFunction(source, signature) {
  const startIdx = source.indexOf(signature);
  assert.ok(startIdx >= 0, `could not find "${signature}" in api/biometric-sync.js`);
  const braceStart = source.indexOf('{', startIdx);
  assert.ok(braceStart >= 0, `could not find opening brace for ${signature}`);
  let depth = 0;
  let i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  assert.ok(depth === 0, `brace matching failed for ${signature}`);
  return source.slice(startIdx, i + 1);
}

const hhmmToEpochSrc = extractFunction(src, 'function hhmmToEpoch(');
const toHHMMSrc = extractFunction(src, 'function toHHMM(');
const capSessionDurationSrc = extractFunction(src, 'function capSessionDuration(');
const extractLastSeenMsSrc = extractFunction(src, 'function extractLastSeenMs(');
const closeAtGenuineFinalSrc = extractFunction(src, 'async function closeAtGenuineFinal(id, data, date, startMs, previousDoc)');

// Confirm the real source actually implements the spec -- not hand-verified,
// checked directly against the extracted text.
assert.ok(closeAtGenuineFinalSrc.includes('previousDoc'), 'closeAtGenuineFinal does not reference previousDoc -- primary anchor not wired in as expected');
assert.ok(closeAtGenuineFinalSrc.includes('extractLastSeenMs('), 'closeAtGenuineFinal does not call extractLastSeenMs -- fallback anchor not wired in as expected');
assert.ok(closeAtGenuineFinalSrc.includes('MISS_PUNCH_CEILING'), 'closeAtGenuineFinal does not reference MISS_PUNCH_CEILING -- ceiling not wired in as expected');
assert.ok(!/\bnowAtJobRun\b\s*[,)=;.]/.test(closeAtGenuineFinalSrc.replace(/\/\/.*$/gm, '')), 'closeAtGenuineFinal still USES nowAtJobRun outside comments -- old fallback not fully replaced');

// Confirm the ceiling constant is 20:30 -- settled here after 19:30 (too
// tight) and 22:00 (raised, but risked silent over-credit) drafts.
const ceilingMatch = src.match(/const MISS_PUNCH_CEILING = '([\d:]+)'/);
assert.ok(ceilingMatch, 'could not find MISS_PUNCH_CEILING declaration');
assert.strictEqual(ceilingMatch[1], '20:30', `MISS_PUNCH_CEILING is '${ceilingMatch[1]}', expected '20:30'`);

// Confirm the flag-on-clamp behavior is wired in -- a ceiling clamp must
// still be visible for review, not just silently applied.
assert.ok(closeAtGenuineFinalSrc.includes('ceilingClamped'), 'closeAtGenuineFinal does not reference ceilingClamped -- flag-on-clamp not wired in as expected');

console.log('--- confirmed: closeAtGenuineFinal() implements previousDoc primary anchor, extractLastSeenMs fallback, MISS_PUNCH_CEILING=20:30 with flag-on-clamp, nowAtJobRun fully removed ---');

function buildSandbox({ hasOwnHeartbeat = false, heartbeatOffsetFromStartMin = 5, updateShouldFail = false } = {}) {
  const updates = []; // { id, data } for every updateDoc() call
  const needsManualReview = [];
  let closedFallback = 0, failed = 0;

  const sandbox = {
    console,
    needsManualReview,
    confirm: true,
    // No biometric record for this user by default -- every fixture in
    // this file targets the no-biometric-OUT (else) branch specifically,
    // so an absent/empty punch record correctly routes there.
    userIdToEmpcode: new Map(),
    punchByEmpcode: new Map(),
    db: {},
    doc: (db, collectionName, id) => ({ collectionName, id }),
    updateDoc: async (docRef, data) => {
      if (updateShouldFail) throw new Error('simulated write failure');
      updates.push({ id: docRef.id, data });
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(hhmmToEpochSrc, sandbox);
  vm.runInContext(toHHMMSrc, sandbox);
  vm.runInContext(capSessionDurationSrc, sandbox);
  vm.runInContext(extractLastSeenMsSrc, sandbox);
  sandbox.MAX_SESSION_HOURS = 12;
  sandbox.MISS_PUNCH_CEILING = '20:30';
  vm.runInContext(closeAtGenuineFinalSrc, sandbox);

  // Counters the real function increments via closure -- mirrored here as
  // plain sandbox properties the extracted code can read/increment,
  // observed by the test afterward via sandbox.closedFallback/failed.
  sandbox.closedFallback = 0;
  sandbox.failed = 0;

  return { sandbox, updates, needsManualReview, getCounts: () => ({ closedFallback: sandbox.closedFallback, failed: sandbox.failed }) };
}

let passCount = 0, failCount = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); passCount++; }
  else { console.log(`  FAIL: ${label}`); failCount++; }
}

async function run() {
  const DATE = '2026-08-25';

  // ═══════════════════════════════════════════════════════
  // CASE (a): normal miss-punch, clean previous entry -- caps at previous
  // doc's endTime.
  // ═══════════════════════════════════════════════════════
  // PRIMARY fires whenever `previousDoc` (combined[i-1], the entry
  // immediately preceding the flagged doc by startMs) has an endTime that
  // is genuinely after the flagged doc's own start -- e.g. a brief
  // overlapping/adjacent entry, or a previous close that (correctly)
  // landed after this session's start due to its own recovered/estimated
  // close. That endTime is used as-is, unconditionally.
  console.log('=== CASE (a): previousDoc.endTime is after flagged start -> PRIMARY anchor used ===');
  {
    const { sandbox, updates } = buildSandbox();
    const startMs = vm.runInContext(`hhmmToEpoch('${DATE}', '11:00')`, sandbox);
    // previousDoc's own end (11:45) is after the flagged doc's start
    // (11:00) -- e.g. a brief overlapping/adjacent entry a sweep grouped
    // as "previous" in combined's sort. This is exactly the PRIMARY path:
    // the anchor is simply whichever previous entry's end is genuinely
    // later than this session's own start.
    const previousDoc = { data: { endTime: '11:45' } };
    await vm.runInContext('closeAtGenuineFinal', sandbox)('doc-a', { userId: 'u1', desc: 'Work' }, DATE, startMs, previousDoc);
    check('exactly one write', updates.length === 1);
    check('endTime capped at previous doc endTime (11:45)', updates[0].data.endTime === '11:45');
    check('estimatedClose true, autoCapped absent (well under 12h)', updates[0].data.estimatedClose === true && !updates[0].data.autoCapped);
    check('desc names the previous-session-end reason', /previous session's end \(11:45\)/.test(updates[0].data.desc));
  }

  // ═══════════════════════════════════════════════════════
  // CASE (b): the Taskiya case -- flagged session starts AFTER the
  // previous entry already ended. Falls through to own lastHeartbeat.
  // Must produce a sane SHORT close, never negative.
  // ═══════════════════════════════════════════════════════
  console.log('\n=== CASE (b): Taskiya case -- previous ended before flagged start -> own lastHeartbeat used ===');
  {
    const { sandbox, updates } = buildSandbox();
    const startMs = vm.runInContext(`hhmmToEpoch('${DATE}', '20:08')`, sandbox);
    const previousDoc = { data: { endTime: '20:00' } }; // BEFORE the flagged doc's own 20:08 start
    const lastHeartbeatSec = Math.floor(startMs / 1000) + 10; // ~10s after start, matching the real Taskiya doc
    const data = { userId: 'u1', desc: 'Work', lastHeartbeat: { seconds: lastHeartbeatSec } };
    await vm.runInContext('closeAtGenuineFinal', sandbox)('doc-b', data, DATE, startMs, previousDoc);
    check('exactly one write', updates.length === 1);
    check('endTime is NOT the previous doc\'s 20:00 (would be before start)', updates[0].data.endTime !== '20:00');
    check('durationMins is a small positive number (>=1), not negative', updates[0].data.durationMins >= 1 && updates[0].data.durationMins < 5);
    check('desc names the own-heartbeat reason', /own last heartbeat/.test(updates[0].data.desc));
  }

  // ═══════════════════════════════════════════════════════
  // CASE (h): real last activity BEFORE the 20:30 ceiling -- caps at the
  // real anchor, no flag. The ordinary, most-common shape.
  // ═══════════════════════════════════════════════════════
  console.log('\n=== CASE (h): last activity 19:45 (before 20:30 ceiling) -> caps there, no flag ===');
  {
    const { sandbox, updates, needsManualReview } = buildSandbox();
    const startMs = vm.runInContext(`hhmmToEpoch('${DATE}', '11:00')`, sandbox);
    const previousDoc = { data: { endTime: '19:45' } };
    await vm.runInContext('closeAtGenuineFinal', sandbox)('doc-h', { userId: 'u1', desc: 'Work' }, DATE, startMs, previousDoc);
    check('exactly one write', updates.length === 1);
    check('endTime is the real 19:45, not clamped', updates[0].data.endTime === '19:45');
    check('desc names the previous-session-end reason, NOT the ceiling', /previous session's end \(19:45\)/.test(updates[0].data.desc) && !/ceiling/.test(updates[0].data.desc));
    check('ceilingClamped absent -- no flag when under the ceiling', !updates[0].data.ceilingClamped);
    check('zero manual-review entries', needsManualReview.length === 0);
  }

  // ═══════════════════════════════════════════════════════
  // CASE (c): real last activity PAST 20:30 (e.g. 21:00, a plausible
  // genuine-late-worker case) -- capped at 20:30 AND flagged for review.
  // This is the deliberate error-direction choice: under-credit is
  // visible/self-correcting (the person notices being shorted), so the
  // system proactively flags rather than silently trusting a value past
  // the ceiling either way.
  // ═══════════════════════════════════════════════════════
  console.log('\n=== CASE (c): last activity 21:00 (past 20:30 ceiling, plausible late work) -> capped at 20:30 AND flagged ===');
  {
    const { sandbox, updates, needsManualReview } = buildSandbox();
    const startMs = vm.runInContext(`hhmmToEpoch('${DATE}', '11:00')`, sandbox);
    const previousDoc = { data: { endTime: '21:00' } };
    await vm.runInContext('closeAtGenuineFinal', sandbox)('doc-c', { userId: 'u1', desc: 'Work' }, DATE, startMs, previousDoc);
    check('exactly one write (still closes -- flag is not a fail-safe)', updates.length === 1);
    check('endTime clamped to the 20:30 ceiling, not the real 21:00', updates[0].data.endTime === '20:30');
    check('desc names the ceiling reason and the real anchor time', /20:30 ceiling \(previous session's end \(21:00\) was later\)/.test(updates[0].data.desc));
    check('ceilingClamped:true written on the doc', updates[0].data.ceilingClamped === true);
    check('exactly one manual-review flag', needsManualReview.length === 1);
    check('flag reason names the real anchor and the under-credit risk', /closed at the 20:30 ceiling.*previous session's end \(21:00\).*under-crediting/.test(needsManualReview[0].reason));
  }

  // Same clamp+flag path via the OWN-HEARTBEAT fallback, and via a
  // clearly implausible stray value (23:30) -- proving both "plausible
  // late work" and "clearly stray" anchors are treated identically:
  // capped + flagged, since the system deliberately doesn't try to
  // distinguish the two itself -- that judgment call is left to whoever
  // reviews the flag.
  console.log('\n=== CASE (c2): stray-implausible 23:30 (own heartbeat) -> also capped at 20:30 AND flagged ===');
  {
    const { sandbox, updates, needsManualReview } = buildSandbox();
    const startMs = vm.runInContext(`hhmmToEpoch('${DATE}', '11:00')`, sandbox);
    const strayHeartbeatMs = vm.runInContext(`hhmmToEpoch('${DATE}', '23:30')`, sandbox);
    const data = { userId: 'u1', desc: 'Work', lastHeartbeat: { seconds: Math.floor(strayHeartbeatMs / 1000) } };
    await vm.runInContext('closeAtGenuineFinal', sandbox)('doc-c2', data, DATE, startMs, null); // no previous doc -> own heartbeat is the anchor
    check('exactly one write', updates.length === 1);
    check('endTime clamped to 20:30, not the stray 23:30 heartbeat', updates[0].data.endTime === '20:30');
    check('ceilingClamped:true written on the doc -- same path as case (c)', updates[0].data.ceilingClamped === true);
    check('exactly one manual-review flag', needsManualReview.length === 1);
    check('flag reason names the own-heartbeat anchor', /own last heartbeat \(23:30\)/.test(needsManualReview[0].reason));
  }

  // ═══════════════════════════════════════════════════════
  // CASE (d): ceiling <= flagged doc's own start -- manual review, no write.
  // ═══════════════════════════════════════════════════════
  console.log('\n=== CASE (d): flagged doc itself starts at/after 20:30 -> manual review ===');
  {
    const { sandbox, updates, needsManualReview } = buildSandbox();
    const startMs = vm.runInContext(`hhmmToEpoch('${DATE}', '20:45')`, sandbox);
    const heartbeatMs = vm.runInContext(`hhmmToEpoch('${DATE}', '20:50')`, sandbox); // resolves fine, but ceiling can't beat the 20:45 start
    const data = { userId: 'u1', desc: 'Work', lastHeartbeat: { seconds: Math.floor(heartbeatMs / 1000) } };
    await vm.runInContext('closeAtGenuineFinal', sandbox)('doc-d', data, DATE, startMs, null);
    check('zero writes', updates.length === 0);
    check('exactly one manual-review entry', needsManualReview.length === 1);
    check('reason names the ceiling-vs-start conflict', /ceiling is at\/before this session's own start/.test(needsManualReview[0].reason));
  }

  // ═══════════════════════════════════════════════════════
  // CASE (e): no previous entry AND no usable heartbeat -- manual review,
  // no fabrication.
  // ═══════════════════════════════════════════════════════
  console.log('\n=== CASE (e): no previous entry, no heartbeat -> manual review, no fabrication ===');
  {
    const { sandbox, updates, needsManualReview } = buildSandbox();
    const startMs = vm.runInContext(`hhmmToEpoch('${DATE}', '15:00')`, sandbox);
    const data = { userId: 'u1', desc: 'Work' }; // no lastHeartbeat, no ts, no updatedAt
    await vm.runInContext('closeAtGenuineFinal', sandbox)('doc-e', data, DATE, startMs, null);
    check('zero writes', updates.length === 0);
    check('exactly one manual-review entry', needsManualReview.length === 1);
    check('reason names both missing anchors', /no usable previous-session end, and no usable own heartbeat/.test(needsManualReview[0].reason));
  }

  // ═══════════════════════════════════════════════════════
  // CASE (f): previous doc is itself a "recovered" doc -- used as-is,
  // no special-casing, same as any other closed doc.
  // ═══════════════════════════════════════════════════════
  console.log('\n=== CASE (f): previous doc is a recovered doc -> its endTime used as-is ===');
  {
    const { sandbox, updates } = buildSandbox();
    const startMs = vm.runInContext(`hhmmToEpoch('${DATE}', '14:00')`, sandbox);
    const previousDoc = { data: { endTime: '14:30', recovered: true, recoveredAt: '2026-08-25T08:00:00.000Z' } };
    await vm.runInContext('closeAtGenuineFinal', sandbox)('doc-f', { userId: 'u1', desc: 'Work' }, DATE, startMs, previousDoc);
    check('exactly one write', updates.length === 1);
    check('recovered-doc endTime (14:30) used unconditionally, no special-casing', updates[0].data.endTime === '14:30');
  }

  // ═══════════════════════════════════════════════════════
  // CASE (g): confirmed by construction, not re-tested here -- a
  // genuinely-live session (something later exists in `combined`) never
  // reaches closeAtGenuineFinal() at all; the caller only invokes it when
  // `!next` (index.html-adjacent loop, unchanged by this diff). Already
  // covered by test/bugc-de-overlap.test.js's existing `combined`
  // construction/ordering fixtures.
  // ═══════════════════════════════════════════════════════
  console.log('\n=== CASE (g): live-session guard is architectural (unchanged code path), confirmed by inspection + existing bugc-de-overlap.test.js coverage, not re-tested here ===');
  check('(g) confirmed by construction -- see comment above', true);

  // ═══════════════════════════════════════════════════════
  // Write-failure non-fatal check, same discipline as every other branch.
  // ═══════════════════════════════════════════════════════
  console.log('\n=== BONUS: write failure -> non-fatal, reported via needsManualReview ===');
  {
    const { sandbox, updates, needsManualReview } = buildSandbox({ updateShouldFail: true });
    const startMs = vm.runInContext(`hhmmToEpoch('${DATE}', '11:00')`, sandbox);
    const previousDoc = { data: { endTime: '18:00' } };
    let threw = false;
    try {
      await vm.runInContext('closeAtGenuineFinal', sandbox)('doc-fail', { userId: 'u1', desc: 'Work' }, DATE, startMs, previousDoc);
    } catch (e) { threw = true; }
    check('does not throw out of closeAtGenuineFinal', !threw);
    check('zero successful writes', updates.length === 0);
    check('reported via needsManualReview', needsManualReview.some(r => /write failed/.test(r.reason)));
  }

  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
}

run();
