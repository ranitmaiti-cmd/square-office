// Fixture test for the SWEEP RE-FLAG RACE fix: the three stale-heartbeat
// sweep functions (cleanupStaleTimers, finalizeStaleHeartbeatSessions,
// finalizeStaleHeartbeatSessionsAllUsers) each read an initial snapshot,
// decide "stale" from it, then write reconciliationNeeded:true per doc --
// with no re-verification immediately before that write. If a session
// closes cleanly (closeCurrentSessionNow() writes reconciliationNeeded:
// false in the SAME update as inProgress:false) in the gap between the
// snapshot read and a sweep's per-doc write landing, the sweep's stale
// write can re-flag a doc that was JUST correctly resolved -- since sweep
// writes only ever touch reconciliationNeeded/reconciliationNeededSince,
// never inProgress, there's nothing to stop it.
//
// Real production case: Rai's 29 Aug session (mtdzurqe393bgg) closed
// correctly at 08:57:52.166Z (endTime/durationMins/desc all reflect a
// clean close); reconciliationNeededSince shows 08:57:53.488Z -- a sweep
// write landing 1.3s later, re-flagging a doc that had already been
// resolved.
//
// THE CRITICAL FIXTURE below models this race directly: the mocked
// single-doc re-verify read returns inProgress:false (simulating the close
// having landed in the gap since the sweep's own initial snapshot was
// taken) and asserts the flag write must NOT fire.
//
// Extracts the ACTUAL function source directly from index.html (brace-
// matched, not retyped) and runs it in a vm sandbox -- same discipline as
// every other fixture in this repo.
//
// Run with: node test/fix-sweep-reflag-race-guard.test.js
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

function extractFunction(source, name, fromIndex = 0) {
  let startIdx = source.indexOf(`async function ${name}(`, fromIndex);
  if (startIdx < 0) startIdx = source.indexOf(`function ${name}(`, fromIndex);
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
  const end = source.indexOf(';', idx);
  return source.slice(idx, end + 1);
}

const staleHeartbeatMsSrc = extractConstLine(fullScript, 'STALE_HEARTBEAT_MS');
const isStillFlaggableSrc = extractFunction(fullScript, 'isStillFlaggableOnServer');
const extractLastSeenMsSrc = extractFunction(fullScript, 'extractLastSeenMs');
const cleanupStaleTimersSrc = extractFunction(fullScript, 'cleanupStaleTimers');
const finalizeStaleHeartbeatSessionsSrc = extractFunction(fullScript, 'finalizeStaleHeartbeatSessions');
const finalizeStaleHeartbeatSessionsAllUsersSrc = extractFunction(fullScript, 'finalizeStaleHeartbeatSessionsAllUsers');

// Confirm the real source actually implements the fix -- not hand-verified.
[cleanupStaleTimersSrc, finalizeStaleHeartbeatSessionsSrc, finalizeStaleHeartbeatSessionsAllUsersSrc].forEach((fnSrc, i) => {
  const names = ['cleanupStaleTimers', 'finalizeStaleHeartbeatSessions', 'finalizeStaleHeartbeatSessionsAllUsers'];
  assert.ok(fnSrc.includes('isStillFlaggableOnServer('), `${names[i]} does not call isStillFlaggableOnServer() -- re-verify guard not wired in as expected`);
});

const STALE_HEARTBEAT_MS_MATCH = staleHeartbeatMsSrc.match(/=\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)/);
assert.ok(STALE_HEARTBEAT_MS_MATCH, 'could not parse STALE_HEARTBEAT_MS');
const STALE_HEARTBEAT_MS = Number(STALE_HEARTBEAT_MS_MATCH[1]) * Number(STALE_HEARTBEAT_MS_MATCH[2]) * Number(STALE_HEARTBEAT_MS_MATCH[3]);

let passCount = 0, failCount = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); passCount++; }
  else { console.log(`  FAIL: ${label}`); failCount++; }
}

// heartbeatSecondsAgo: the STALE session's lastHeartbeat, as seconds-ago
// from `now` (must exceed STALE_HEARTBEAT_MS to be a flagging candidate).
// serverInProgressAtWriteTime: what the re-verify read returns -- this is
// the whole point of the fixture. true = still genuinely open (normal
// case, must flag). false = closed in the gap since the sweep's own
// snapshot (the race case, must NOT flag).
function buildSandbox({ docId, userId, heartbeatSecondsAgo, serverInProgressAtWriteTime, reconciliationNeededAlready = false, isOwnCurrentSession = false, isAdmin = true, dateStr, verifyReadShouldThrow = false }) {
  const now = Date.now();
  const updates = []; // every .update(id, data) actually WRITTEN (the flag write itself)
  const verifyReads = []; // every isStillFlaggableOnServer() re-check read
  const toasts = [];

  const docData = {
    userId, date: dateStr || 'ANY-DATE-NOT-USED', // cleanupStaleTimers filters date<today itself; other two don't filter by date
    reconciliationNeeded: reconciliationNeededAlready,
    lastHeartbeat: { seconds: Math.floor((now - heartbeatSecondsAgo * 1000) / 1000) },
  };

  const sandbox = {
    console, Date, Object, Math,
    currentSessionLogId: isOwnCurrentSession ? docId : 'some-other-session-id',
    currentUser: { id: 'admin1', isAdmin },
    timeLogs: [{ id: docId, ...docData }],
    users: [{ id: userId, name: 'Test User' }],
    renderDashboard: () => {}, renderTimeLog: () => {},
    showNotificationToast: () => {},
    db: {
      collection: () => ({
        where: () => ({
          where: () => ({
            get: async () => ({
              empty: false, size: 1,
              docs: [{ id: docId, data: () => docData }],
              forEach: (fn) => fn({ id: docId, data: () => docData }),
            }),
          }),
          get: async () => ({
            empty: false, size: 1,
            docs: [{ id: docId, data: () => docData }],
            forEach: (fn) => fn({ id: docId, data: () => docData }),
          }),
        }),
        doc: (id) => ({
          get: async (opts) => {
            verifyReads.push({ id, opts });
            if (verifyReadShouldThrow) throw new Error('simulated network failure');
            return { exists: true, data: () => ({ inProgress: serverInProgressAtWriteTime }) };
          },
          update: async (data) => { updates.push({ id, data }); },
        }),
      }),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(staleHeartbeatMsSrc, sandbox);
  vm.runInContext(extractLastSeenMsSrc, sandbox);
  vm.runInContext(isStillFlaggableSrc, sandbox);
  vm.runInContext(cleanupStaleTimersSrc, sandbox);
  vm.runInContext(finalizeStaleHeartbeatSessionsSrc, sandbox);
  vm.runInContext(finalizeStaleHeartbeatSessionsAllUsersSrc, sandbox);
  return { sandbox, updates, verifyReads };
}

async function run() {
  const staleSecs = Math.ceil(STALE_HEARTBEAT_MS / 1000) + 120; // comfortably past the threshold

  // ═══════════════════════════════════════════════════════════════════
  // *** THE CRITICAL FIXTURE ***: models the actual race, against all
  // three sweep functions. The doc LOOKED stale in the sweep's own initial
  // snapshot (that's how it got into the loop at all) -- but the re-verify
  // read (simulating the moment right before the write) shows it has since
  // closed. The flag write must NOT fire.
  // ═══════════════════════════════════════════════════════════════════
  console.log('=== CRITICAL: race fixture -- doc closes between snapshot-read and write -- sweep must NOT re-flag ===');
  {
    // finalizeStaleHeartbeatSessionsAllUsers (admin-wide sweep -- Rai's real case)
    const { sandbox, updates, verifyReads } = buildSandbox({
      docId: 'mtdzurqe393bgg', userId: 'mmllpgkndzw', heartbeatSecondsAgo: staleSecs,
      serverInProgressAtWriteTime: false, // <-- closed in the gap, the race
    });
    const result = await vm.runInContext('finalizeStaleHeartbeatSessionsAllUsers', sandbox)();
    check('[AllUsers] re-verify read was performed', verifyReads.length === 1 && verifyReads[0].id === 'mtdzurqe393bgg');
    check('[AllUsers] re-verify read used source:server (same freshness guarantee as the rest of this file)', verifyReads[0].opts && verifyReads[0].opts.source === 'server');
    check('[AllUsers] NO flag write fired -- the race was caught', updates.length === 0);
    check('[AllUsers] result counts this as closedSinceRead, not flagged', result.closedSinceRead === 1 && result.flagged === 0);
  }
  {
    // finalizeStaleHeartbeatSessions (per-user sweep)
    const { sandbox, updates } = buildSandbox({
      docId: 'doc-b', userId: 'u1', heartbeatSecondsAgo: staleSecs,
      serverInProgressAtWriteTime: false,
    });
    await vm.runInContext('finalizeStaleHeartbeatSessions', sandbox)();
    check('[per-user] NO flag write fired', updates.length === 0);
  }
  {
    // cleanupStaleTimers (previous-day sweep) -- needs date < today
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const { sandbox, updates } = buildSandbox({
      docId: 'doc-c', userId: 'u1', heartbeatSecondsAgo: staleSecs,
      serverInProgressAtWriteTime: false, dateStr: yesterday,
    });
    // cleanupStaleTimers reads `today` via `fmt(new Date())` -- stub it in.
    sandbox.fmt = (d) => new Date().toISOString().slice(0, 10);
    await vm.runInContext('cleanupStaleTimers', sandbox)();
    check('[previous-day] NO flag write fired', updates.length === 0);
  }

  // ═══════════════════════════════════════════════════════════════════
  // CASE: genuinely still stale at write time (no race) -- all three must
  // flag exactly as before this fix. Confirms the guard doesn't just
  // suppress every write.
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== CASE: genuinely still open at write time -- flags normally, unaffected ===');
  {
    const { sandbox, updates, verifyReads } = buildSandbox({
      docId: 'still-stale-doc', userId: 'u2', heartbeatSecondsAgo: staleSecs,
      serverInProgressAtWriteTime: true, // still genuinely open
    });
    const result = await vm.runInContext('finalizeStaleHeartbeatSessionsAllUsers', sandbox)();
    check('re-verify read was performed', verifyReads.length === 1);
    check('flag write DID fire (genuinely still stale)', updates.length === 1 && updates[0].id === 'still-stale-doc');
    check('write payload unchanged from before this fix (reconciliationNeeded:true + Since)', updates[0].data.reconciliationNeeded === true && typeof updates[0].data.reconciliationNeededSince === 'string');
    check('result counts this as flagged, not closedSinceRead', result.flagged === 1 && result.closedSinceRead === 0);
  }

  // ═══════════════════════════════════════════════════════════════════
  // CASE: re-verify read itself fails (network error) -- fail-closed:
  // must NOT flag (same direction as every other race guard in this file),
  // and must not crash the whole sweep.
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== CASE: re-verify read fails -- fails CLOSED (does not flag), does not crash ===');
  {
    const { sandbox, updates } = buildSandbox({
      docId: 'flaky-doc', userId: 'u3', heartbeatSecondsAgo: staleSecs,
      serverInProgressAtWriteTime: true, verifyReadShouldThrow: true,
    });
    let threw = false;
    let result;
    try { result = await vm.runInContext('finalizeStaleHeartbeatSessionsAllUsers', sandbox)(); }
    catch (e) { threw = true; console.error('  unexpected throw:', e.message); }
    check('did NOT crash the sweep', !threw);
    check('did NOT flag (fail-closed on an unverifiable re-check)', updates.length === 0);
    check('status still ok (one bad doc does not fail the whole run)', result.status === 'ok');
  }

  // ═══════════════════════════════════════════════════════════════════
  // CASE: fresh heartbeat (not stale at all) -- re-verify must not even
  // run; the existing freshness check still short-circuits first, same as
  // before this fix (no wasted extra read on the common healthy case).
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== CASE: heartbeat still fresh -- re-verify never runs (existing short-circuit unaffected) ===');
  {
    const { sandbox, updates, verifyReads } = buildSandbox({
      docId: 'fresh-doc', userId: 'u4', heartbeatSecondsAgo: 30, // well under the threshold
      serverInProgressAtWriteTime: true,
    });
    await vm.runInContext('finalizeStaleHeartbeatSessionsAllUsers', sandbox)();
    check('no re-verify read attempted (freshness check already skipped it)', verifyReads.length === 0);
    check('no flag write', updates.length === 0);
  }

  // ═══════════════════════════════════════════════════════════════════
  // CASE: already flagged (reconciliationNeeded already true) -- re-verify
  // must not even run; the existing "already flagged" short-circuit fires
  // first, same as before this fix.
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== CASE: already flagged -- re-verify never runs (existing short-circuit unaffected) ===');
  {
    const { sandbox, updates, verifyReads } = buildSandbox({
      docId: 'already-flagged-doc', userId: 'u5', heartbeatSecondsAgo: staleSecs,
      serverInProgressAtWriteTime: true, reconciliationNeededAlready: true,
    });
    await vm.runInContext('finalizeStaleHeartbeatSessionsAllUsers', sandbox)();
    check('no re-verify read attempted (already-flagged check already skipped it)', verifyReads.length === 0);
    check('no flag write', updates.length === 0);
  }

  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
}

run();
