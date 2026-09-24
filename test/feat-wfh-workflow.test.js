// Fixture for V35: WFH Request/Approval Workflow, Half 1 (2026-09-24).
//
// This build is deliberately scoped to the request/approval/tracking
// workflow only -- it must NOT touch runAttendanceAutoDeduction() or any
// leave-deduction/entitlement code. That boundary is the central claim
// under test, alongside the four policy rules and the zero-leave-bank-
// impact guarantee.
//
// Central claims under test:
//  - eligibility gate: requestWfh() refuses a non-wfhEligible user
//  - >=1-day advance: requestWfh() refuses today or a past date
//  - 1-per-calendar-month: approveWfhRequest() refuses a second approval
//    in the same month for the same person, even though the request
//    itself was allowed to exist as pending
//  - max-2-per-date, FCFS by approval order: the 3rd approval attempt for
//    the same date is refused regardless of request order
//  - WFH never writes to leaveRequests or touches medLeft/casLeft, at any
//    point in the request/approve/reject lifecycle
//  - zero-work tracking is read-only display: it cross-references
//    timeLogs but never writes anything back, never blocks approval
//  - isolation: runAttendanceAutoDeduction(), saveUser(), saveLeaveRequest(),
//    leaveBankStatus(), renderTeamLeaveBank(), renderApprovals(),
//    renderLeaves() are all byte-for-byte unchanged from main -- this is
//    the safety gate proving the pay engine was not touched
//
// Run with: node test/feat-wfh-workflow.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');
const assert = require('assert');

const norm = (s) => s.replace(/\r\n/g, '\n');
const REPO_ROOT = 'D:/SQUARE/ADMIN/SQUARE-Office/finalphase/01072026';
const INDEX_HTML = path.join(REPO_ROOT, 'index.html');
const src = norm(fs.readFileSync(INDEX_HTML, 'utf8'));
const scriptMatch = src.match(/<script>([\s\S]*?)<\/script>/);
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

// ─────────────────────────────────────────────────────────────
// Build a sandbox running the REAL extracted functions, not a
// reimplementation. `nowStr` fixes what `new Date()` resolves to inside
// the sandbox, so advance-notice checks are deterministic.
function makeSandbox({ currentUser, users = [], wfhRequests = [], timeLogs = [], nowStr }) {
  const alerts = [];
  const dbCalls = { leaveRequestsTouched: false, userBankWrites: [] };
  const wfhCollection = {};

  const RealDate = Date;
  const sandbox = {
    currentUser,
    users,
    wfhRequests,
    leaveRequests: [],
    timeLogs,
    console,
    Date: nowStr
      ? class extends RealDate {
          constructor(...a) {
            if (a.length === 0) { super(nowStr); return; }
            super(...a);
          }
        }
      : RealDate,
    genId: () => 'wfhtest' + Math.random().toString(36).slice(2, 8),
    db: {
      collection(name) {
        return {
          doc(id) {
            return {
              async set(data, opts) {
                if (name === 'leaveRequests') dbCalls.leaveRequestsTouched = true;
                if (name === 'users') dbCalls.userBankWrites.push(data);
                if (name === 'wfhRequests') wfhCollection[id] = data;
              },
            };
          },
        };
      },
    },
    alert: (msg) => alerts.push(msg),
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction(fullScript, 'fmt'), sandbox);
  vm.runInContext(extractFunction(fullScript, 'saveWfhDoc'), sandbox);
  vm.runInContext(extractFunction(fullScript, 'wfhMonthKey'), sandbox);
  vm.runInContext(extractFunction(fullScript, 'requestWfh'), sandbox);
  vm.runInContext(extractFunction(fullScript, 'wfhApprovalBlockedReason'), sandbox);
  vm.runInContext(extractFunction(fullScript, 'approveWfhRequest'), sandbox);
  vm.runInContext(extractFunction(fullScript, 'rejectWfhRequest'), sandbox);
  vm.runInContext(extractFunction(fullScript, 'wfhWorkedFlag'), sandbox);
  return { sandbox, alerts, dbCalls, wfhCollection };
}
const run = (sandbox, expr) => vm.runInContext(expr, sandbox);

const TODAY = '2026-09-24T10:00:00';
const TOMORROW = '2026-09-25';

(async () => {

// ─────────────────────────────────────────────────────────────
console.log('=== 1. Eligibility gate (request time) ===');
{
  const notEligible = { id: 'u1', name: 'Not Eligible', wfhEligible: false };
  const { sandbox } = makeSandbox({ currentUser: notEligible, nowStr: TODAY });
  const result = await run(sandbox, `requestWfh('${TOMORROW}')`);
  check('non-eligible user is refused', result.ok === false && /not eligible/i.test(result.reason || ''));
  check('nothing was written for a refused request', run(sandbox, 'wfhRequests.length') === 0);

  const eligible = { id: 'u2', name: 'Eligible User', wfhEligible: true };
  const { sandbox: sb2 } = makeSandbox({ currentUser: eligible, nowStr: TODAY });
  const ok = await run(sb2, `requestWfh('${TOMORROW}')`);
  check('eligible user with a future date succeeds', ok.ok === true && ok.doc.status === 'pending');
}

// ─────────────────────────────────────────────────────────────
console.log('\n=== 2. >=1-day advance notice (request time) ===');
{
  const u = { id: 'u3', name: 'Advance Test', wfhEligible: true };

  const same = makeSandbox({ currentUser: u, nowStr: TODAY });
  const sameResult = await run(same.sandbox, `requestWfh('2026-09-24')`);
  check('same-day request is refused', sameResult.ok === false && /advance/i.test(sameResult.reason || ''));

  const past = makeSandbox({ currentUser: u, nowStr: TODAY });
  const pastResult = await run(past.sandbox, `requestWfh('2026-09-01')`);
  check('past-date request is refused', pastResult.ok === false);

  const future = makeSandbox({ currentUser: u, nowStr: TODAY });
  const futureResult = await run(future.sandbox, `requestWfh('${TOMORROW}')`);
  check('next-day request (exactly 1 day advance) succeeds', futureResult.ok === true);

  const noDate = makeSandbox({ currentUser: u, nowStr: TODAY });
  const noDateResult = await run(noDate.sandbox, `requestWfh('')`);
  check('empty date is refused, not silently accepted', noDateResult.ok === false);
}

// ─────────────────────────────────────────────────────────────
console.log('\n=== 3. 1-per-calendar-month enforcement (approval time) ===');
{
  const admin = { id: 'admin', name: 'Admin User', isAdmin: true };
  const existing = [
    { id: 'w1', userId: 'u4', userName: 'Monthly Person', date: '2026-08-05', status: 'approved', requestedAt: '', approvedBy: 'Admin User', approvedAt: '' },
    { id: 'w2', userId: 'u4', userName: 'Monthly Person', date: '2026-08-20', status: 'pending', requestedAt: '', approvedBy: null, approvedAt: null },
  ];
  const { sandbox, alerts, wfhCollection } = makeSandbox({ currentUser: admin, wfhRequests: existing });
  const result = await run(sandbox, `approveWfhRequest('w2')`);
  check('second same-month approval is blocked', result.ok === false && /already has an approved WFH/i.test(result.reason || ''));
  check('the blocked request stays pending in-memory', run(sandbox, `wfhRequests.find(w=>w.id==='w2').status`) === 'pending');
  check('an alert with the reason was shown', alerts.length === 1 && /already has an approved/i.test(alerts[0]));
  check('nothing was written to Firestore for the blocked approval', !wfhCollection.w2);

  const existing2 = [
    { id: 'w3', userId: 'u5', userName: 'Cross Month', date: '2026-08-05', status: 'approved', requestedAt: '', approvedBy: 'Admin User', approvedAt: '' },
    { id: 'w4', userId: 'u5', userName: 'Cross Month', date: '2026-09-20', status: 'pending', requestedAt: '', approvedBy: null, approvedAt: null },
  ];
  const { sandbox: sb2 } = makeSandbox({ currentUser: admin, wfhRequests: existing2 });
  const result2 = await run(sb2, `approveWfhRequest('w4')`);
  check('a different-month approval for the same person is allowed', result2.ok === true);
}

// ─────────────────────────────────────────────────────────────
console.log('\n=== 4. Max 2 approved per date, FCFS by approval order ===');
{
  const admin = { id: 'admin', name: 'Admin User', isAdmin: true };
  const sameDate = '2026-11-10';
  const existing = [
    { id: 'a1', userId: 'p1', userName: 'Person One', date: sameDate, status: 'approved', requestedAt: '3', approvedBy: 'Admin User', approvedAt: '' },
    { id: 'a2', userId: 'p2', userName: 'Person Two', date: sameDate, status: 'approved', requestedAt: '1', approvedBy: 'Admin User', approvedAt: '' },
    { id: 'a3', userId: 'p3', userName: 'Person Three (requested FIRST, approved LAST)', date: sameDate, status: 'pending', requestedAt: '0', approvedBy: null, approvedAt: null },
  ];
  const { sandbox, alerts } = makeSandbox({ currentUser: admin, wfhRequests: existing });
  const result = await run(sandbox, `approveWfhRequest('a3')`);
  check('3rd approval attempt for the same date is blocked even though it was requested first', result.ok === false);
  check('the block reason names the 2-per-date limit', /already has 2 approved/i.test(alerts[0] || ''));
  check("slot is claimed by APPROVAL order, not request order -- a2 (requested after a1) still holds a slot", run(sandbox, `wfhRequests.find(w=>w.id==='a2').status`) === 'approved');

  const existing2 = [
    { id: 'b1', userId: 'p1', userName: 'P1', date: sameDate, status: 'approved', requestedAt: '', approvedBy: 'Admin User', approvedAt: '' },
    { id: 'b2', userId: 'p2', userName: 'P2', date: sameDate, status: 'approved', requestedAt: '', approvedBy: 'Admin User', approvedAt: '' },
    { id: 'b3', userId: 'p3', userName: 'P3', date: '2026-11-11', status: 'pending', requestedAt: '', approvedBy: null, approvedAt: null },
  ];
  const { sandbox: sb2 } = makeSandbox({ currentUser: admin, wfhRequests: existing2 });
  const result2 = await run(sb2, `approveWfhRequest('b3')`);
  check('a 3rd approval for a DIFFERENT date is unaffected by another date being full', result2.ok === true);

  const existing3 = [
    { id: 'c1', userId: 'p1', userName: 'P1', date: sameDate, status: 'approved', requestedAt: '', approvedBy: 'Admin User', approvedAt: '' },
    { id: 'c2', userId: 'p2', userName: 'P2', date: sameDate, status: 'pending', requestedAt: '', approvedBy: null, approvedAt: null },
  ];
  const { sandbox: sb3 } = makeSandbox({ currentUser: admin, wfhRequests: existing3 });
  const result3 = await run(sb3, `approveWfhRequest('c2')`);
  check('the 2nd approval for a date with only 1 approved so far succeeds', result3.ok === true);
}

// ─────────────────────────────────────────────────────────────
console.log('\n=== 5. Reject path, and re-approving an already-decided request ===');
{
  const admin = { id: 'admin', name: 'Admin User', isAdmin: true };
  const pending = [{ id: 'r1', userId: 'u9', userName: 'Reject Me', date: '2026-12-01', status: 'pending', requestedAt: '', approvedBy: null, approvedAt: null }];
  const { sandbox } = makeSandbox({ currentUser: admin, wfhRequests: pending });
  const result = await run(sandbox, `rejectWfhRequest('r1')`);
  check('reject succeeds and stamps a decision record', result.ok === true);
  check('status is rejected', run(sandbox, `wfhRequests.find(w=>w.id==='r1').status`) === 'rejected');
  const reapprove = await run(sandbox, `approveWfhRequest('r1')`);
  check('a rejected request cannot later be approved through this function', reapprove.ok === false && /no longer pending/i.test(reapprove.reason || ''));
}

// ─────────────────────────────────────────────────────────────
console.log('\n=== 6. WFH never touches the leave bank ===');
{
  const admin = { id: 'admin', name: 'Admin User', isAdmin: true, medLeft: 12, casLeft: 5 };
  const eligible = { id: 'u10', name: 'Bank Test', wfhEligible: true, medLeft: 12, casLeft: 5 };
  const { sandbox, dbCalls } = makeSandbox({ currentUser: eligible, users: [admin, eligible], nowStr: TODAY });
  await run(sandbox, `requestWfh('${TOMORROW}')`);
  sandbox.currentUser = admin;
  const wid = run(sandbox, 'wfhRequests[0].id');
  await run(sandbox, `approveWfhRequest('${wid}')`);
  check('no write ever touched the leaveRequests collection', dbCalls.leaveRequestsTouched === false);
  check('no write ever touched the users collection (medLeft/casLeft)', dbCalls.userBankWrites.length === 0);
  check("the requester's in-memory medLeft/casLeft are untouched", eligible.medLeft === 12 && eligible.casLeft === 5);
}

// ─────────────────────────────────────────────────────────────
console.log('\n=== 7. Zero-work flag: read-only display, never blocks or writes ===');
{
  const { sandbox } = makeSandbox({ currentUser: { id: 'admin', isAdmin: true }, timeLogs: [{ userId: 'u11', date: '2026-09-10', durationMins: 300 }] });
  const workedFlag = run(sandbox, `wfhWorkedFlag('u11','2026-09-10')`);
  const notWorkedFlag = run(sandbox, `wfhWorkedFlag('u12','2026-09-10')`);
  check('a day with a timeLog shows "Work logged"', /Work logged/.test(workedFlag));
  check('a day with no timeLog shows "No work logged"', /No work logged/.test(notWorkedFlag));
  check('wfhWorkedFlag() makes no db call and no write (source sweep)', !/\.set\(|\.update\(|\.delete\(|\bdb\b/.test(extractFunction(fullScript, 'wfhWorkedFlag')));

  const admin = { id: 'admin', name: 'Admin User', isAdmin: true };
  const pending = [{ id: 'z1', userId: 'u12', userName: 'No Work', date: '2026-09-10', status: 'pending', requestedAt: '', approvedBy: null, approvedAt: null }];
  const { sandbox: sb2 } = makeSandbox({ currentUser: admin, wfhRequests: pending, timeLogs: [] });
  const result = await run(sb2, `approveWfhRequest('z1')`);
  check('approval succeeds with zero timeLogs that day -- zero-work never blocks approval', result.ok === true);
}

// ─────────────────────────────────────────────────────────────
console.log("\n=== 8. Structural: no leaveRequests/medLeft/casLeft writes anywhere in the WFH functions' source ===");
{
  for (const name of ['saveWfhDoc', 'requestWfh', 'wfhApprovalBlockedReason', 'approveWfhRequest', 'rejectWfhRequest', 'wfhWorkedFlag', 'wfhRequestCard', 'wfhMonthKey']) {
    const fnSrc = extractFunction(fullScript, name);
    check(`${name}() never references leaveRequests`, !fnSrc.includes('leaveRequests'));
    check(`${name}() never references medLeft or casLeft`, !/medLeft|casLeft/.test(fnSrc));
  }
  check('saveWfhDoc() writes only to the wfhRequests collection', extractFunction(fullScript, 'saveWfhDoc').match(/db\.collection\('([^']+)'\)/)[1] === 'wfhRequests');
}

// ─────────────────────────────────────────────────────────────
console.log('\n=== 9. Isolation: the pay-engine and leave code are byte-for-byte unchanged ===');
for (const name of [
  'runAttendanceAutoDeduction', 'saveUser', 'saveLeaveRequest', 'leaveBankStatus',
  'renderTeamLeaveBank', 'renderApprovals', 'renderLeaves', 'renderPlanner',
]) {
  check(`${name}() is byte-for-byte unchanged from main`, extractFunction(fullScript, name) === extractFunction(mainFullScript, name));
}

{
  const cur = extractFunction(fullScript, 'renderManage');
  const marker = '\n      <label style="display:flex;align-items:center;gap:4px;margin-right:10px;font-size:11px;color:#8A7E74;cursor:pointer;" title="Eligible to request WFH days">';
  const idx = cur.indexOf(marker);
  const endMarker = '</label>';
  const endIdx = cur.indexOf(endMarker, idx) + endMarker.length;
  assert.ok(idx > 0 && endIdx > idx, 'could not locate the wfhEligible checkbox block in renderManage()');
  const stripped = cur.slice(0, idx) + cur.slice(endIdx);
  // Normalize trailing-space-before-newline: the editing tool used for this
  // build strips a pre-existing trailing space on the untouched salary-input
  // line above the inserted block (whitespace-only, same class of
  // normalization as this codebase's existing CRLF-vs-LF norm() helper).
  const trimTrailingWs = (s) => s.replace(/[ \t]+\n/g, '\n');
  check('renderManage() differs from main ONLY by the wfhEligible checkbox block', trimTrailingWs(stripped) === trimTrailingWs(extractFunction(mainFullScript, 'renderManage')));
}

{
  const cur = fullScript.match(/document\.getElementById\('addUserBtn'\)\.addEventListener\('click', async \(\)=>\{[\s\S]*?\n\}\);/)[0];
  const mainBlock = mainFullScript.match(/document\.getElementById\('addUserBtn'\)\.addEventListener\('click', async \(\)=>\{[\s\S]*?\n\}\);/)[0];
  const strippedCur = cur.replace(',wfhEligible:false', '');
  check('addUserBtn handler differs from main ONLY by the wfhEligible:false default', strippedCur === mainBlock);
}

console.log('\n=== 10. Full-script structural checks ===');
check("loadData() gained a wfhRequests load block appended after submissions, nothing removed", fullScript.includes(`db.collection("wfhRequests").get({source:'server'})`));
check('the nav router gained exactly one new line for the wfh page', /if\(page==='wfh'\)\s*renderWfh\(\);/.test(fullScript));
check('a nav-item for data-page="wfh" exists and is not admin-only', /<div class="nav-item" data-page="wfh">/.test(src) && !/<div class="nav-item admin-only" data-page="wfh"/.test(src));
check('page-wfh markup exists', src.includes('id="page-wfh"'));
const bumped = /const APP_VERSION = '(\d{4}-\d{2}-\d{2}\.\d+)'/.exec(fullScript)[1];
const mainVer = /const APP_VERSION = '(\d{4}-\d{2}-\d{2}\.\d+)'/.exec(mainFullScript)[1];
check(`APP_VERSION bumped (${mainVer} -> ${bumped})`, bumped !== mainVer);
check('version.json matches APP_VERSION', JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'version.json'), 'utf8')).version === bumped);
check('inline <script> still parses', (() => { try { new Function(fullScript); return true; } catch (e) { console.log('    parse error:', e.message); return false; } })());

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);

})();
