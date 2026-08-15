// Fixture test for Glitch 3: the orphan-recovery-modal duplicate-self-report
// bug. restoreTimerState() now checks whether the SPECIFIC session a stale
// local timerState refers to (via sessionLogId) is already resolved
// server-side before prompting for a self-report -- Taskiya's 12 Aug
// duplicate (a real 420m doc + a spurious 510m self-report on top of it)
// is exactly what this prevents.
//
// Extracts the ACTUAL function source directly from index.html (brace-
// matched, not retyped) and runs it in a vm sandbox with mocked db/
// localStorage -- proving the real shipped code, same discipline as every
// other fixture in this repo.
//
// Run with: node fix-orphan-recovery-duplicate-guard.test.js
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

const restoreTimerStateSrc = extractFunction(fullScript, 'restoreTimerState');
const MAX_SESSION_HOURS_MATCH = fullScript.match(/const MAX_SESSION_HOURS\s*=\s*(\d+);/);
assert.ok(MAX_SESSION_HOURS_MATCH, 'could not find MAX_SESSION_HOURS in index.html');
const MAX_SESSION_HOURS = parseInt(MAX_SESSION_HOURS_MATCH[1], 10);

console.log('--- extracted guard (top of the hours >= MAX_SESSION_HOURS branch) ---');
{
  const idx = restoreTimerStateSrc.indexOf('if (hours >= MAX_SESSION_HOURS)');
  console.log(restoreTimerStateSrc.slice(idx, idx + 900) + '\n  ...\n');
}

// Builds a sandbox with a stale localStorage.timerState (started well past
// MAX_SESSION_HOURS ago) pointing at `sessionLogId`, and a mocked Firestore
// `db` returning whatever `serverDoc` says for that id (null = doc missing,
// or a shape with `exists`/`data()`). `serverGetShouldThrow` simulates a
// fetch failure instead.
function buildSandbox({ sessionLogId, serverDoc, serverGetShouldThrow = false, omitSessionLogId = false }) {
  const modalCalls = [];
  const removedKeys = [];
  const localStorageStore = {};

  const state = {
    running: true,
    startedAt: Date.now() - (MAX_SESSION_HOURS + 3) * 60 * 60 * 1000, // well past the threshold
    linkedPlan: { project: 'Test Project', projectId: 'p1', phase: 'Schematic Design', typology: 'Schematic Design' },
    ...(omitSessionLogId ? {} : { sessionLogId }),
  };
  localStorageStore['timerState'] = JSON.stringify(state);

  const sandbox = {
    console,
    MAX_SESSION_HOURS,
    timerInterval: null,
    clearInterval: () => {},
    localStorage: {
      getItem: (k) => (k in localStorageStore ? localStorageStore[k] : null),
      setItem: (k, v) => { localStorageStore[k] = v; },
      removeItem: (k) => { removedKeys.push(k); delete localStorageStore[k]; },
    },
    orphanTimerState: null,
    showOrphanRecoveryModal: (st, hrs) => { modalCalls.push({ state: st, hours: hrs }); },
    db: {
      collection: (name) => ({
        doc: (id) => ({
          get: () => {
            if (serverGetShouldThrow) return Promise.reject(new Error('simulated network failure'));
            if (serverDoc === null) return Promise.resolve({ exists: false, data: () => undefined });
            return Promise.resolve({ exists: true, data: () => serverDoc });
          },
        }),
      }),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(restoreTimerStateSrc, sandbox);
  return { sandbox, modalCalls, removedKeys, localStorageStore };
}

let passCount = 0, failCount = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); passCount++; }
  else { console.log(`  FAIL: ${label}`); failCount++; }
}

(async () => {
  // ═══════════════════════════════════════════════════════════════════
  // CASE (a): stale local state, session doc inProgress:false (already
  // resolved server-side) -- discarded, NO modal, NO duplicate write path
  // ever gets a chance to fire.
  // ═══════════════════════════════════════════════════════════════════
  console.log('=== CASE (a): already resolved server-side -- discarded, no modal ===');
  {
    const { sandbox, modalCalls, removedKeys } = buildSandbox({
      sessionLogId: 'resolved-doc-1',
      serverDoc: { inProgress: false, durationMins: 420 },
    });
    await vm.runInContext('restoreTimerState()', sandbox);
    check('modal was NOT shown', modalCalls.length === 0);
    check('localStorage.timerState was removed (stale state cleaned up)', removedKeys.includes('timerState'));
  }

  // ═══════════════════════════════════════════════════════════════════
  // CASE (b): genuinely-open session, inProgress:true -- modal shows as
  // today, behavior unchanged.
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== CASE (b): still genuinely open -- modal shows, unchanged behavior ===');
  {
    const { sandbox, modalCalls, removedKeys } = buildSandbox({
      sessionLogId: 'still-open-doc-1',
      serverDoc: { inProgress: true, durationMins: 45 },
    });
    await vm.runInContext('restoreTimerState()', sandbox);
    check('modal WAS shown', modalCalls.length === 1);
    check('localStorage.timerState was NOT removed (still pending a decision)', !removedKeys.includes('timerState'));
  }

  // ═══════════════════════════════════════════════════════════════════
  // CASE (c): sessionLogId points to a doc that no longer exists -- must
  // fail gracefully. Defined behavior: falls through to the existing
  // prompt (can't positively confirm resolution, so don't guess either
  // way -- same fail-closed principle as Stage 0's delete guard).
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== CASE (c): session doc missing entirely -- falls through to prompt, no crash ===');
  {
    const { sandbox, modalCalls } = buildSandbox({
      sessionLogId: 'deleted-doc-1',
      serverDoc: null, // doc does not exist
    });
    let threw = false;
    try {
      await vm.runInContext('restoreTimerState()', sandbox);
    } catch (e) {
      threw = true;
      console.error('  unexpected throw:', e.message);
    }
    check('did NOT crash', !threw);
    check('falls through to showing the prompt (cannot confirm resolution)', modalCalls.length === 1);
  }

  // ═══════════════════════════════════════════════════════════════════
  // CASE (d): no sessionLogId on the local state at all (older/legacy
  // localStorage predating that field) -- falls through to current
  // behavior, no crash on the missing field.
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== CASE (d): no sessionLogId at all (legacy state) -- falls through, no crash ===');
  {
    const { sandbox, modalCalls } = buildSandbox({
      omitSessionLogId: true,
      serverDoc: { inProgress: false }, // irrelevant -- should never even be queried
    });
    let threw = false;
    try {
      await vm.runInContext('restoreTimerState()', sandbox);
    } catch (e) {
      threw = true;
      console.error('  unexpected throw:', e.message);
    }
    check('did NOT crash', !threw);
    check('falls through to showing the prompt (no id to check against)', modalCalls.length === 1);
  }

  // ═══════════════════════════════════════════════════════════════════
  // BONUS CASE: server fetch itself fails (network error) -- same
  // fail-closed principle, falls through to prompt rather than guessing.
  // Not explicitly asked for but a natural extension of the same design,
  // worth proving rather than leaving unverified.
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== BONUS: verify fetch throws -- falls through to prompt, fail-closed ===');
  {
    const { sandbox, modalCalls } = buildSandbox({
      sessionLogId: 'fetch-fails-doc-1',
      serverDoc: { inProgress: false },
      serverGetShouldThrow: true,
    });
    let threw = false;
    try {
      await vm.runInContext('restoreTimerState()', sandbox);
    } catch (e) {
      threw = true;
      console.error('  unexpected throw:', e.message);
    }
    check('did NOT crash (error caught internally)', !threw);
    check('falls through to showing the prompt on fetch failure', modalCalls.length === 1);
  }

  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
})().catch((e) => { console.error('FIXTURE ERROR:', e); process.exit(1); });
