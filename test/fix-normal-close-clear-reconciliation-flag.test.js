// Fixture test for: closeCurrentSessionNow() now clears reconciliationNeeded
// on the session it's closing -- the known cause of the Angana residue
// (msmrahdqbmqg0w, logged in FINDINGS-2026-08-10.md) where a doc flagged
// stale at some point, then closed cleanly through the ordinary task-switch/
// logout path, stayed stuck showing "needs reconciliation" forever.
//
// Extracts the ACTUAL function source directly from index.html (brace-
// matched, not retyped) and runs it in a vm sandbox with mocked db/DOM-free
// collaborators -- proving the real shipped code, same discipline as every
// other fixture in this repo.
//
// Run with: node fix-normal-close-clear-reconciliation-flag.test.js
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

const closeCurrentSessionNowSrc = extractFunction(fullScript, 'closeCurrentSessionNow');
const capSessionDurationSrc = extractFunction(fullScript, 'capSessionDuration');
const MAX_SESSION_HOURS_MATCH = fullScript.match(/const MAX_SESSION_HOURS\s*=\s*(\d+);/);
assert.ok(MAX_SESSION_HOURS_MATCH, 'could not find MAX_SESSION_HOURS in index.html');

console.log('--- extracted closeCurrentSessionNow() write payload (from real index.html) ---');
{
  const idx = closeCurrentSessionNowSrc.indexOf("db.collection('timeLogs')");
  console.log(closeCurrentSessionNowSrc.slice(idx, idx + 700) + '\n  ...\n');
}

function buildSandbox({ timeLogsArray, sessionStartedAt, sessionId, plan }) {
  const writeCalls = [];
  const sandbox = {
    console,
    MAX_SESSION_HOURS: parseInt(MAX_SESSION_HOURS_MATCH[1], 10),
    timeLogs: timeLogsArray,
    timerRunning: true,
    currentSessionLogId: sessionId,
    timerStartedAt: sessionStartedAt,
    timerLinkedPlan: plan,
    detachSessionCloseListener: () => {},
    renderTimeLog: () => {},
    renderProjectsBudget: () => {},
    db: {
      collection: (name) => ({
        doc: (id) => ({
          update: (payload) => {
            writeCalls.push({ collection: name, id, payload });
            return Promise.resolve();
          },
        }),
      }),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(capSessionDurationSrc, sandbox);
  vm.runInContext(closeCurrentSessionNowSrc, sandbox);
  return { sandbox, writeCalls };
}

let passCount = 0, failCount = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); passCount++; }
  else { console.log(`  FAIL: ${label}`); failCount++; }
}

// ═══════════════════════════════════════════════════════════════════════
// CASE 1: a session that was flagged stale (reconciliationNeeded:true),
// then closed cleanly through the ordinary path -- must end with
// reconciliationNeeded:false, in BOTH the Firestore write payload and the
// local array mirror. This is the Angana-shape fix.
// ═══════════════════════════════════════════════════════════════════════
console.log('=== CASE 1: flagged-then-cleanly-closed session -- reconciliationNeeded cleared ===');
{
  const sessionId = 'flagged-session-1';
  const otherSessionId = 'unrelated-flagged-session';
  const timeLogsArray = [
    { id: sessionId, userId: 'u1', reconciliationNeeded: true, inProgress: true },
    { id: otherSessionId, userId: 'u2', reconciliationNeeded: true, inProgress: true }, // untouched control, see CASE 2
  ];
  const { sandbox, writeCalls } = buildSandbox({
    timeLogsArray,
    sessionStartedAt: Date.now() - 60 * 60 * 1000, // 1h ago
    sessionId,
    plan: { project: 'Test Project', typology: 'Schematic Design', phase: 'Schematic Design' },
  });

  const result = vm.runInContext(`closeCurrentSessionNow('switched to Other Project')`, sandbox);
  check('close returned a result (session was actually closed)', result !== null);
  check('exactly one write fired', writeCalls.length === 1);
  check('write targeted the correct session id', writeCalls[0].id === sessionId);
  check('write payload sets inProgress:false', writeCalls[0].payload.inProgress === false);
  check('write payload sets reconciliationNeeded:false', writeCalls[0].payload.reconciliationNeeded === false);

  const mirroredEntry = sandbox.timeLogs.find((l) => l.id === sessionId);
  check('local array mirror also has reconciliationNeeded:false', mirroredEntry.reconciliationNeeded === false);
  check('local array mirror has inProgress:false', mirroredEntry.inProgress === false);
}

// ═══════════════════════════════════════════════════════════════════════
// CASE 2: a DIFFERENT session that's flagged stale but is NOT the one
// being closed must stay untouched -- reconciliationNeeded:true still,
// proving this fix doesn't leak into unrelated docs. Uses the same
// sandbox state as CASE 1 (the "otherSessionId" control entry).
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== CASE 2: a different, still-genuinely-stale session is untouched ===');
{
  const sessionId = 'flagged-session-1';
  const otherSessionId = 'unrelated-flagged-session';
  const timeLogsArray = [
    { id: sessionId, userId: 'u1', reconciliationNeeded: true, inProgress: true },
    { id: otherSessionId, userId: 'u2', reconciliationNeeded: true, inProgress: true },
  ];
  const { sandbox, writeCalls } = buildSandbox({
    timeLogsArray,
    sessionStartedAt: Date.now() - 60 * 60 * 1000,
    sessionId,
    plan: { project: 'Test Project', typology: 'Schematic Design', phase: 'Schematic Design' },
  });

  vm.runInContext(`closeCurrentSessionNow('switched to Other Project')`, sandbox);

  check('only ONE write fired (the other session was never touched)', writeCalls.length === 1);
  check('the other write was NOT for the unrelated session', writeCalls.every((w) => w.id !== otherSessionId));
  const otherEntry = sandbox.timeLogs.find((l) => l.id === otherSessionId);
  check('unrelated session still shows reconciliationNeeded:true in the local array', otherEntry.reconciliationNeeded === true);
  check('unrelated session still shows inProgress:true (genuinely still open/stale)', otherEntry.inProgress === true);
}

// ═══════════════════════════════════════════════════════════════════════
// CASE 3: a session that was NEVER flagged (reconciliationNeeded absent/
// undefined, the common case) still closes cleanly and correctly, with no
// error from explicitly setting the field to false on a doc that never
// had it. Confirms the fix doesn't require the field to have pre-existed.
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== CASE 3: never-flagged session still closes cleanly (field simply added as false) ===');
{
  const sessionId = 'never-flagged-session';
  const timeLogsArray = [{ id: sessionId, userId: 'u1', inProgress: true }]; // no reconciliationNeeded field at all
  const { sandbox, writeCalls } = buildSandbox({
    timeLogsArray,
    sessionStartedAt: Date.now() - 30 * 60 * 1000,
    sessionId,
    plan: { project: 'Test Project', typology: 'Schematic Design', phase: 'Schematic Design' },
  });

  const result = vm.runInContext(`closeCurrentSessionNow('closed at logout')`, sandbox);
  check('close succeeded', result !== null);
  check('write payload sets reconciliationNeeded:false (harmless on a doc that never had it)', writeCalls[0].payload.reconciliationNeeded === false);
}

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
