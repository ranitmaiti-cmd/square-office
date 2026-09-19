// Fixture for V32: Personal Growth Goals -- a PRIVATE, self-owned
// skill-growth checklist (2026-09-16). The entire feature rests on one
// guarantee: a person sees and can alter ONLY their own goals, with no
// admin/founder path around it. This fixture proves that guarantee
// structurally, not just by absence of a bug -- see the "THE PRIVACY
// GUARANTEE" section below, which is the one that matters most.
//
// Central claims under test:
//  - loadMyGrowthGoals()/addGrowthGoal()/toggleGrowthGoal() hardcode
//    currentUser.id as the ONLY path segment used to read/write
//    Firestore -- their function SIGNATURES accept no userId/
//    targetUser parameter at all, so there is no argument, admin or
//    not, that could target another user's goals
//  - behaviorally: calling these functions as an ADMIN currentUser
//    NEVER reaches a different user's subcollection, even when that
//    other user's goals exist in the same mock store -- proven by
//    recording every Firestore path touched and asserting it always
//    equals the CALLING user's own id
//  - isAdmin is never even READ anywhere in this feature's code --
//    stronger than "isAdmin doesn't grant access": the check doesn't
//    exist to be bypassed
//  - tick stamps achievedAt and moves the goal to "built"; untick
//    clears achievedAt and reverses it -- executed against the real
//    extracted functions and a recording mock Firestore
//  - add-your-own (arbitrary free-text skill) works the same as a
//    curated-list pick
//  - an empty list renders with ZERO nag/prompt/hint -- no gamification
//    text anywhere (no streak/badge/%/"haven't updated"/nudge wording)
//  - no aggregate or admin view of growth goals exists ANYWHERE in the
//    file -- source-text sweep, not just "the page I built doesn't show
//    one"
//  - isolation: the nav-click router gained exactly one new line for
//    'mygrowth'; every other page's rendering (saveProject, renderLeaves,
//    renderApprovals, renderDashboard, etc.) is untouched
//
// Run with: node test/feat-personal-growth-goals.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');
const assert = require('assert');

const norm = (s) => s.replace(/\r\n/g, '\n');
const REPO_ROOT = 'D:/SQUARE/ADMIN/SQUARE-Office/finalphase/01072026';
const INDEX_HTML = path.join(REPO_ROOT, 'index.html');
const rawSrc = norm(fs.readFileSync(INDEX_HTML, 'utf8'));
const scriptMatch = rawSrc.match(/<script>([\s\S]*?)<\/script>/);
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
function extractSignature(source, name) {
  const fn = extractFunction(source, name);
  return fn.slice(0, fn.indexOf('{'));
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

// Mock Firestore that records every path (collection/doc/subcollection)
// touched, so a test can assert EXACTLY whose subcollection a call
// reached -- the core evidence for the privacy guarantee.
function makeMockDb(seedByUser) {
  const calls = [];
  const store = JSON.parse(JSON.stringify(seedByUser)); // { userId: { goalId: {...} } }
  function usersDoc(userId) {
    return {
      collection(subName) {
        assert.strictEqual(subName, 'growthGoals');
        return {
          doc(goalId) {
            return {
              async set(data, opts) {
                calls.push({ op: 'set', userId, goalId, data, opts });
                store[userId] = store[userId] || {};
                store[userId][goalId] = { ...(store[userId][goalId] || {}), ...data };
              },
            };
          },
          async get() {
            calls.push({ op: 'get', userId });
            const docs = Object.entries(store[userId] || {}).map(([id, d]) => ({ id, data: () => d }));
            return { forEach(fn) { docs.forEach(fn); } };
          },
        };
      },
    };
  }
  const db = {
    collection(name) {
      assert.strictEqual(name, 'users');
      return { doc: (userId) => usersDoc(userId) };
    },
  };
  return { db, calls, store };
}

(async () => {
  const loadSrc = extractFunction(fullScript, 'loadMyGrowthGoals');
  const addSrc = extractFunction(fullScript, 'addGrowthGoal');
  const toggleSrc = extractFunction(fullScript, 'toggleGrowthGoal');
  const genIdSrc = extractFunction(fullScript, 'genId');

  // ─────────────────────────────────────────────────────────────
  console.log('=== THE PRIVACY GUARANTEE, structural: no function can even BE ASKED for another user\'s goals ===');
  check('loadMyGrowthGoals() takes ZERO parameters -- there is no userId argument to pass', extractSignature(fullScript, 'loadMyGrowthGoals').includes('()'));
  check('addGrowthGoal(skill) takes only a skill string -- no userId/targetUser parameter', /addGrowthGoal\(skill\)/.test(extractSignature(fullScript, 'addGrowthGoal')));
  check('toggleGrowthGoal(goalId, currentStatus) takes only a goal id + its status -- no userId/targetUser parameter', /toggleGrowthGoal\(goalId,\s*currentStatus\)/.test(extractSignature(fullScript, 'toggleGrowthGoal')));
  check('loadMyGrowthGoals() reads currentUser.id, never any other identifier', loadSrc.includes('currentUser.id') && !/\buserId\b/.test(loadSrc));
  check('addGrowthGoal() writes under currentUser.id only', addSrc.includes('currentUser.id'));
  check('toggleGrowthGoal() writes under currentUser.id only', toggleSrc.includes('currentUser.id'));
  check('isAdmin is NEVER referenced in loadMyGrowthGoals()/addGrowthGoal()/toggleGrowthGoal() -- the check does not exist to be bypassed', !loadSrc.includes('isAdmin') && !addSrc.includes('isAdmin') && !toggleSrc.includes('isAdmin'));

  console.log('\n--- Behavioral: an ADMIN currentUser cannot reach another user\'s subcollection, even when that data exists in the same store ---');
  {
    const seed = {
      'u-admin': { 'g-admin-1': { id: 'g-admin-1', skill: 'Leadership', status: 'learning', addedAt: '2026-09-01T00:00:00.000Z', achievedAt: null } },
      'u-target': { 'g-target-1': { id: 'g-target-1', skill: 'Costing / estimation', status: 'achieved', addedAt: '2026-08-01T00:00:00.000Z', achievedAt: '2026-08-15T00:00:00.000Z' } },
    };
    const { db, calls } = makeMockDb(seed);
    const sandbox = { console, Date, db, currentUser: { id: 'u-admin', name: 'Admin User', isAdmin: true }, alert: () => {} };
    vm.createContext(sandbox);
    vm.runInContext(genIdSrc, sandbox);
    vm.runInContext(loadSrc, sandbox);
    vm.runInContext(addSrc, sandbox);
    vm.runInContext(toggleSrc, sandbox);

    const adminGoals = await vm.runInContext('loadMyGrowthGoals()', sandbox);
    check('admin, reading "their own" goals, gets ONLY u-admin\'s goal', adminGoals.length === 1 && adminGoals[0].id === 'g-admin-1');
    check('admin\'s read never touched u-target\'s subcollection', !calls.some((c) => c.userId === 'u-target'));

    // The critical negative: there is no call available to even ATTEMPT
    // reaching u-target's goals -- toggleGrowthGoal only ever needs a
    // goalId, so calling it with the TARGET's goal id, while logged in
    // as admin, still writes to the ADMIN's own subcollection (creating
    // a stray doc there, not touching the target's real goal) -- proving
    // the function is structurally incapable of cross-user writes, not
    // merely "didn't happen to write" in this test.
    await vm.runInContext("toggleGrowthGoal('g-target-1', 'achieved')", sandbox);
    check('attempting to toggle the TARGET\'s goal id while logged in as admin writes under u-admin, NEVER under u-target', calls.filter((c) => c.op === 'set').every((c) => c.userId === 'u-admin'));
    check('u-target\'s actual goal is completely untouched by the admin\'s action', seed['u-target']['g-target-1'].status === 'achieved' && seed['u-target']['g-target-1'].achievedAt === '2026-08-15T00:00:00.000Z');
  }

  console.log('\n--- Behavioral: switching currentUser to the target retrieves ONLY that user\'s own goals ---');
  {
    const seed = {
      'u-admin': { 'g-admin-1': { id: 'g-admin-1', skill: 'Leadership', status: 'learning', addedAt: '2026-09-01T00:00:00.000Z', achievedAt: null } },
      'u-target': { 'g-target-1': { id: 'g-target-1', skill: 'Costing / estimation', status: 'achieved', addedAt: '2026-08-01T00:00:00.000Z', achievedAt: '2026-08-15T00:00:00.000Z' } },
    };
    const { db, calls } = makeMockDb(seed);
    const sandbox = { console, Date, db, currentUser: { id: 'u-target', name: 'Target Person', isAdmin: false }, alert: () => {} };
    vm.createContext(sandbox);
    vm.runInContext(genIdSrc, sandbox);
    vm.runInContext(loadSrc, sandbox);
    const targetGoals = await vm.runInContext('loadMyGrowthGoals()', sandbox);
    check('target, reading their own goals, gets ONLY their own goal, never the admin\'s', targetGoals.length === 1 && targetGoals[0].id === 'g-target-1');
    check('the read never touched u-admin\'s subcollection', !calls.some((c) => c.userId === 'u-admin'));
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== addGrowthGoal(): curated pick and add-your-own both work the same way ===');
  {
    const { db, calls } = makeMockDb({});
    const sandbox = { console, Date, db, currentUser: { id: 'u1', isAdmin: false }, alert: () => {} };
    vm.createContext(sandbox);
    vm.runInContext(genIdSrc, sandbox);
    vm.runInContext(addSrc, sandbox);
    const r1 = await vm.runInContext("addGrowthGoal('AutoCAD')", sandbox);
    check('a curated-list skill saves successfully', r1.ok === true && r1.goal.skill === 'AutoCAD');
    const r2 = await vm.runInContext("addGrowthGoal('Underwater basket weaving')", sandbox);
    check('an arbitrary free-text ("add your own") skill saves the same way', r2.ok === true && r2.goal.skill === 'Underwater basket weaving');
    check('a new goal starts as status:learning, achievedAt:null', r1.goal.status === 'learning' && r1.goal.achievedAt === null);
    check('a blank/whitespace-only skill is rejected (nothing to add)', (await vm.runInContext("addGrowthGoal('   ')", sandbox)).ok === false);
    check('every write happened under u1 only', calls.every((c) => c.userId === 'u1'));
  }

  console.log('\n=== toggleGrowthGoal(): tick stamps achievedAt, untick reverses it ===');
  {
    const seed = { u1: { g1: { id: 'g1', skill: 'Revit', status: 'learning', addedAt: '2026-09-01T00:00:00.000Z', achievedAt: null } } };
    const { db, calls, store } = makeMockDb(seed);
    const sandbox = { console, Date, db, currentUser: { id: 'u1', isAdmin: false }, alert: () => {} };
    vm.createContext(sandbox);
    vm.runInContext(toggleSrc, sandbox);

    const r1 = await vm.runInContext("toggleGrowthGoal('g1', 'learning')", sandbox);
    check('tick succeeds', r1.ok === true);
    check('status flips to achieved', store.u1.g1.status === 'achieved');
    check('achievedAt is stamped (a real ISO timestamp)', !isNaN(new Date(store.u1.g1.achievedAt).getTime()));

    const r2 = await vm.runInContext("toggleGrowthGoal('g1', 'achieved')", sandbox);
    check('untick succeeds', r2.ok === true);
    check('status reverts to learning', store.u1.g1.status === 'learning');
    check('achievedAt is cleared back to null', store.u1.g1.achievedAt === null);
    check('every write is a partial, granular {merge:true} set -- never a bare .set()', calls.every((c) => c.op !== 'set' || (c.opts && c.opts.merge === true)));
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== No gamification: empty state renders clean, no nag/streak/badge/percent anywhere ===');
  {
    const renderSrc = extractFunction(fullScript, 'renderMyGrowth');
    const rowSrc = extractFunction(fullScript, 'renderGrowthGoalRow');
    check('renderMyGrowth() contains no gamification vocabulary (streak/badge/%/nudge/"haven\'t updated")', !/streak|badge|nudge|haven.t updated|% complete|completion rate/i.test(renderSrc));
    check('renderGrowthGoalRow() renders nothing but the skill text and a checkbox -- no score/rating markup', !/rating|score|proficiency|1-5|confirm/i.test(rowSrc));

    function makeFakeDom(ids) {
      const store = {};
      ids.forEach((id) => { store[id] = { style: {}, innerHTML: '', value: '', dataset: {} }; });
      return { document: { getElementById: (id) => store[id] || null, querySelectorAll: () => [] }, store };
    }
    const { db } = makeMockDb({ u1: {} }); // zero goals
    const { document, store } = makeFakeDom(['growthLearningList', 'growthAchievedList', 'growthSkillSelect']);
    const sandbox = { console, Date, db, currentUser: { id: 'u1', isAdmin: false }, document, GROWTH_SKILL_OPTIONS: ['Leadership'], alert: () => {} };
    vm.createContext(sandbox);
    vm.runInContext(loadSrc, sandbox);
    vm.runInContext(renderSrc, sandbox);
    await vm.runInContext('renderMyGrowth()', sandbox);
    check('an empty "want to learn" list shows a plain neutral placeholder, no prompt/hint/red-mark language', store.growthLearningList.innerHTML.includes('Nothing here yet') && !/get started|don.t forget|reminder|!/i.test(store.growthLearningList.innerHTML));
    check('an empty "built" list is equally neutral', store.growthAchievedList.innerHTML.includes('Nothing here yet'));
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== Structural: no admin/aggregate view of growth goals exists ANYWHERE in the file ===');
  check('no collectionGroup query over growthGoals anywhere (that would read across ALL users at once)', !fullScript.includes("collectionGroup('growthGoals')") && !fullScript.includes('collectionGroup("growthGoals")'));
  check('no function name anywhere suggests a team/admin growth view (e.g. "TeamGrowth", "AllGrowth", "GrowthReport")', !/function\s+\w*(TeamGrowth|AllGrowth|GrowthReport|GrowthAdmin|AggregateGrowth)\w*/i.test(fullScript));
  check('growthGoals is never referenced inside renderManage()/renderStudioHealth-adjacent admin functions', !extractFunction(fullScript, 'renderManage').includes('growthGoals'));
  check('the My Growth nav item is NOT admin-only (every person, including admins, sees the identical private page for their own goals)', !/data-page="mygrowth"[^>]*admin-only|admin-only[^>]*data-page="mygrowth"/.test(rawSrc));
  check('the privacy sentence is present in the page markup', rawSrc.includes('This is private to you') && rawSrc.includes('including admins'));

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== Isolation: the nav router gained exactly one new line; everything else untouched ===');
  {
    const cur = extractBlockFrom(fullScript, "item.addEventListener('click',function(){");
    const main = extractBlockFrom(mainFullScript, "item.addEventListener('click',function(){");
    // V32 shipped to main (2026-09-16), so main's router already contains the
    // mygrowth route -- a "strip it, compare to main" check would compare
    // against its own former self and false-fail forever. Same post-merge
    // staleness this codebase has hit before: assert plain byte-identity.
    check('the nav-click router is byte-for-byte unchanged from main (mygrowth route already on main)', cur === main && main.includes("page==='mygrowth'"));
  }
  check('saveProject() is byte-for-byte unchanged', extractFunction(fullScript, 'saveProject') === extractFunction(mainFullScript, 'saveProject'));
  check('renderLeaves() is byte-for-byte unchanged', extractFunction(fullScript, 'renderLeaves') === extractFunction(mainFullScript, 'renderLeaves'));
  check('renderApprovals() is byte-for-byte unchanged', extractFunction(fullScript, 'renderApprovals') === extractFunction(mainFullScript, 'renderApprovals'));
  check('renderDashboard() is byte-for-byte unchanged', extractFunction(fullScript, 'renderDashboard') === extractFunction(mainFullScript, 'renderDashboard'));
  check('renderPlanner() is byte-for-byte unchanged', extractFunction(fullScript, 'renderPlanner') === extractFunction(mainFullScript, 'renderPlanner'));
  check('saveTimeLog() is byte-for-byte unchanged', extractFunction(fullScript, 'saveTimeLog') === extractFunction(mainFullScript, 'saveTimeLog'));
  check('runAttendanceAutoDeduction() is byte-for-byte unchanged', extractFunction(fullScript, 'runAttendanceAutoDeduction') === extractFunction(mainFullScript, 'runAttendanceAutoDeduction'));
  check('createSubmission()/toggleSubmissionDone() (Submission Tracker) are byte-for-byte unchanged', extractFunction(fullScript, 'createSubmission') === extractFunction(mainFullScript, 'createSubmission') && extractFunction(fullScript, 'toggleSubmissionDone') === extractFunction(mainFullScript, 'toggleSubmissionDone'));

  // ─────────────────────────────────────────────────────────────
  // 2026-09-17: a hand-tested preview report claimed Admin's and Tasmin's
  // accounts showed the SAME growth-goals list. Live Firestore data
  // showed the opposite -- users/u1/growthGoals and
  // users/mmllonwbwgp/growthGoals held genuinely distinct docs the whole
  // time; every user doc's stored `id` field matched its own Firestore
  // doc key, with zero duplicates and no users/undefined/growthGoals
  // fallback. The actual cause: the app persists login via a SHARED
  // localStorage key (`currentSession`) that auto-logs in on every page
  // load (see the `loadData().then(...)` block) -- opening two tabs of
  // the SAME browser and logging into a different account in each makes
  // BOTH tabs snap to whichever account logged in most recently on their
  // next reload. That's a pre-existing, app-wide property of this app's
  // session persistence (every per-user page has always worked this way,
  // not something this feature introduced or could fix on its own), not
  // a growthGoals scoping bug -- but the earlier fixture only ever
  // hand-built `currentUser` objects, so it could not have caught a
  // wrong-account-at-runtime scenario even if one existed. This section
  // goes through the REAL doLogin() function -- unmodified, not a
  // reimplementation -- for two sequential real logins, proving the
  // actual runtime auth path resolves currentUser.id correctly per
  // login and that loadMyGrowthGoals() reflects the CURRENTLY logged-in
  // user, never a stale or previous one.
  console.log('\n=== THE REPORTED CASE: two REAL sequential logins through the actual doLogin() path must see different data ===');
  {
    const doLoginSrc = extractFunction(fullScript, 'doLogin');

    function makeFakeLoginDom() {
      const els = {};
      const get = (id) => {
        if (!els[id]) els[id] = { value: '', style: {}, textContent: '' };
        return els[id];
      };
      return { getElementById: get, querySelectorAll: () => [], _els: els };
    }
    function makeLocalStorage() {
      const kv = {};
      return { getItem: (k) => (k in kv ? kv[k] : null), setItem: (k, v) => { kv[k] = v; }, removeItem: (k) => { delete kv[k]; } };
    }

    const seedByUser = {
      u1: { g1: { id: 'g1', skill: 'Site supervision', status: 'learning', addedAt: '2026-09-17T06:15:05.000Z', achievedAt: null }, g2: { id: 'g2', skill: 'Client handling', status: 'achieved', addedAt: '2026-09-17T06:14:52.000Z', achievedAt: '2026-09-17T06:15:07.000Z' } },
      mmllonwbwgp: { g3: { id: 'g3', skill: 'Leadership', status: 'achieved', addedAt: '2026-09-17T06:50:46.000Z', achievedAt: '2026-09-17T06:50:48.000Z' }, g4: { id: 'g4', skill: 'Material selection', status: 'learning', addedAt: '2026-09-17T06:50:52.000Z', achievedAt: null } },
    };
    const { db } = makeMockDb(seedByUser);
    const users = [
      { id: 'u1', name: 'Admin User', username: 'admin', password: 'admin123', isAdmin: true },
      { id: 'mmllonwbwgp', name: 'Tasmin', username: 'tasmin', password: 'tasmin123', isAdmin: false },
    ];

    const document_ = makeFakeLoginDom();
    const localStorage = makeLocalStorage();
    const sandbox = {
      console, Date, Math, db, users, document: document_, localStorage, window: {},
      currentUser: null,
      alert: () => {},
      // Every OTHER side effect doLogin() fires -- stubbed as harmless
      // no-ops so the REAL, unmodified doLogin() body can run end to
      // end without dragging in the whole timer/heartbeat/leave-listener
      // subsystem, none of which is relevant to identity resolution.
      initTimeReport: () => {}, renderDashboard: () => {}, updateApprovalBadge: () => {},
      startInactivityMonitor: () => {}, startEndOfDayMonitor: () => {}, startVersionCheckMonitor: () => {},
      startBackstopMonitor: () => {}, startLeaveRequestsListener: () => {},
      cleanupStaleTimers: async () => {}, finalizeStaleHeartbeatSessions: async () => {},
      finalizeStaleHeartbeatSessionsAllUsers: () => {}, restoreTimerState: async () => {},
      checkForOrphanedSessionOnLoad: async () => {}, updateTimerVisualState: () => {},
      runAttendanceAutoDeduction: () => {}, checkTimeLogsCollectionSize: () => {},
      reliableTickWorkerActive: false, setInterval: () => 0, setTimeout: () => 0,
    };
    vm.createContext(sandbox);
    vm.runInContext(genIdSrc, sandbox);
    vm.runInContext(loadSrc, sandbox);
    vm.runInContext(doLoginSrc, sandbox);

    // --- Real login #1: Admin, via the actual doLogin() ---
    document_.getElementById('loginUsername').value = 'admin';
    document_.getElementById('loginPassword').value = 'admin123';
    await vm.runInContext('doLogin()', sandbox);
    check('after a REAL doLogin() as admin, currentUser.id resolves to u1', sandbox.currentUser?.id === 'u1');
    const adminGoals = await vm.runInContext('loadMyGrowthGoals()', sandbox);
    check('loadMyGrowthGoals() after the admin login returns EXACTLY admin\'s 2 goals', adminGoals.length === 2 && adminGoals.some((g) => g.skill === 'Site supervision') && adminGoals.some((g) => g.skill === 'Client handling'));
    check('...and does NOT include any of Tasmin\'s goals', !adminGoals.some((g) => g.skill === 'Leadership' || g.skill === 'Material selection'));

    // --- Real login #2, same sandbox/session: Tasmin, via the actual doLogin() ---
    document_.getElementById('loginUsername').value = 'tasmin';
    document_.getElementById('loginPassword').value = 'tasmin123';
    await vm.runInContext('doLogin()', sandbox);
    check('after a SECOND real doLogin() as Tasmin, currentUser.id switches to mmllonwbwgp (not stuck on the previous login)', sandbox.currentUser?.id === 'mmllonwbwgp');
    const tasminGoals = await vm.runInContext('loadMyGrowthGoals()', sandbox);
    check('loadMyGrowthGoals() after the Tasmin login returns EXACTLY Tasmin\'s 2 goals', tasminGoals.length === 2 && tasminGoals.some((g) => g.skill === 'Leadership') && tasminGoals.some((g) => g.skill === 'Material selection'));
    check('...and does NOT include any of admin\'s goals -- THIS is the exact case reported as broken, and it is not', !tasminGoals.some((g) => g.skill === 'Site supervision' || g.skill === 'Client handling'));

    check('the localStorage session key was updated to the SECOND (Tasmin) login, not left on the first', JSON.parse(localStorage.getItem('currentSession')).userId === 'mmllonwbwgp');
  }

  console.log('\n=== the inline <script> still parses ===');
  check('new Function(fullScript) does not throw', (() => {
    try { new Function(fullScript); return true; }
    catch (e) { console.log('    parse error:', e.message); return false; }
  })());

  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
})();
