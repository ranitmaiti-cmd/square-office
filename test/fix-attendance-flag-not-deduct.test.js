// Fixture for V30: runAttendanceAutoDeduction() converted from AUTO-DEDUCT
// to FLAG-FOR-REVIEW (2026-09-13). See FINDINGS-2026-08-10.md for the
// read-only scoping this build implements: the trigger (working day, no
// approved leave, zero OMS timeLog activity that day) never checked
// biometric data and never will (none exists in-app) -- 264 wrong
// auto-deductions already exist in production from it, including
// impossible negative CL balances that kept re-breaking manual
// corrections because the engine stayed armed. This build stops the
// SILENT CONSEQUENCE, not the trigger: the scan still runs on every admin
// login, but now writes a pending review item instead of deducting.
//
// Central claims under test:
//  - the scan flags (status:'pending' leaveRequests doc, isSystemFlagged:true,
//    autoDeducted:false) instead of deducting, for a real working-day/
//    no-approved-leave/no-OMS-activity case -- executed against the ACTUAL
//    extracted function, not a reimplementation
//  - the ORIGINAL trigger conditions are preserved: a user WITH approved
//    leave that day, or WITH any timeLogs activity that day, is still
//    correctly skipped
//  - runAttendanceAutoDeduction() NEVER calls saveUser() -- no casLeft/
//    medLeft write fires on login, for any user, under any circumstance
//  - balance only changes when an admin explicitly clicks Approve in
//    renderApprovals() -- executed against the REAL Approve handler
//  - autoDeducted is set to true ONLY at Approve time, never at flag time,
//    proven both structurally (source text) and behaviorally (the
//    3-consecutive-months warning fires for 3 CONFIRMED autoDeducted:true
//    months and does NOT fire for 3 still-pending flagged months)
//  - Reject dismisses cleanly: no balance change, no autoDeducted flip
//  - renderApprovals() visually distinguishes a system-flagged item
//    ("🚩 Possible Absence") from a real, person-submitted leave request
//
// Run with: node test/fix-attendance-flag-not-deduct.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const REPO_ROOT = 'D:/SQUARE/ADMIN/SQUARE-Office/finalphase/01072026';
const INDEX_HTML = path.join(REPO_ROOT, 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');
const scriptMatch = src.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(scriptMatch, 'could not find inline <script> block in index.html');
const fullScript = scriptMatch[1];

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

const runScanSrc = extractFunction(fullScript, 'runAttendanceAutoDeduction');
const renderApprovalsSrc = extractFunction(fullScript, 'renderApprovals');
const fmtSrc = extractFunction(fullScript, 'fmt');
const is24SatSrc = extractFunction(fullScript, 'is24Sat');
const isHolidaySrc = fullScript.match(/function isHoliday\([^)]*\)\{[^}]*\}/)[0];
const isClosedDaySrc = fullScript.match(/function isClosedDay\([^)]*\)\{[^}]*\}/)[0];
const attendanceExcludedMatch = fullScript.match(/const ATTENDANCE_EXCLUDED = \[[^\]]*\];/);
assert.ok(attendanceExcludedMatch, 'could not find ATTENDANCE_EXCLUDED');

// ── Test-data helpers (date math ONLY, for building synthetic scan
// windows -- not a reimplementation of anything under test) ──
function is2nd4thSat(d) { if (d.getDay() !== 6) return false; const wk = Math.floor((d.getDate() - 1) / 7) + 1; return wk === 2 || wk === 4; }
function isOpenDay(d) { return d.getDay() !== 0 && !is2nd4thSat(d); }
function fmtLocal(d) { const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0'); return `${y}-${m}-${day}`; }

function makeMockDb(companyDataDoc) {
  const calls = [];
  const leaveRequestsStore = {};
  const db = {
    collection(name) {
      if (name === 'companyData') {
        return {
          doc() {
            return {
              async get() { calls.push({ op: 'companyData.get' }); return { data: () => ({ ...companyDataDoc }) }; },
              async update(fields) { calls.push({ op: 'companyData.update', fields }); Object.assign(companyDataDoc, fields); },
            };
          },
        };
      }
      if (name === 'leaveRequests') {
        return {
          doc(id) {
            return {
              async set(data) { calls.push({ op: 'leaveRequests.set', id, data }); leaveRequestsStore[id] = data; },
            };
          },
          async get() {
            calls.push({ op: 'leaveRequests.getAll' });
            const docs = Object.values(leaveRequestsStore);
            return { forEach(fn) { docs.forEach((d) => fn({ data: () => d })); } };
          },
        };
      }
      throw new Error('unexpected collection: ' + name);
    },
  };
  return { db, calls, leaveRequestsStore };
}

function makeGenId() {
  let n = 0;
  return () => `testid${++n}`;
}

(async () => {
  // ─────────────────────────────────────────────────────────────
  console.log('=== Structural: flagRecord is pending/not-yet-confirmed by construction ===');
  check('the written record uses status: \'pending\', not \'approved\'', /status:\s*'pending'/.test(runScanSrc));
  check('autoDeducted is false at flag time', /autoDeducted:\s*false,?\s*\/\//.test(runScanSrc));
  check('isSystemFlagged:true marks it as system-originated', /isSystemFlagged:\s*true/.test(runScanSrc));
  check('the reason text carries the 🚩 System-flagged marker', runScanSrc.includes('🚩 System-flagged'));
  check('runAttendanceAutoDeduction() never calls saveUser(), anywhere in its source', !runScanSrc.includes('saveUser('));
  check('runAttendanceAutoDeduction() never assigns to user.medLeft or user.casLeft', !/user\.(medLeft|casLeft)\s*=/.test(runScanSrc));

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== Behavioral: the scan flags instead of deducting, preserves the original trigger ===');
  {
    // Build a 7-real-calendar-day scan window ending yesterday, find every
    // OPEN (non-Sunday, non-2nd/4th-Sat) day in it -- robust to whatever
    // the real weekday distribution is on the day this test runs.
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
    const rangeStart = new Date(today); rangeStart.setDate(rangeStart.getDate() - 7);
    const openDays = [];
    for (const d = new Date(rangeStart); d <= yesterday; d.setDate(d.getDate() + 1)) {
      if (isOpenDay(d)) openDays.push(fmtLocal(d));
    }
    assert.ok(openDays.length >= 1, 'test window must contain at least one open day');
    const targetAbsentDay = openDays[openDays.length - 1]; // most recent open day
    const otherOpenDays = openDays.slice(0, -1);

    const lastCheckDate = new Date(rangeStart); lastCheckDate.setDate(lastCheckDate.getDate() - 1);

    const userAbsent = { id: 'u-absent', name: 'Absent Person', medLeft: 5, casLeft: 3 };
    const userOnLeave = { id: 'u-leave', name: 'On Leave Person', medLeft: 12, casLeft: 5 };
    const userLoggedTime = { id: 'u-logged', name: 'Logged Time Person', medLeft: 12, casLeft: 5 };
    const userExhaustedML = { id: 'u-exhausted', name: 'Exhausted ML Person', medLeft: 0, casLeft: 5 };
    const users = [userAbsent, userOnLeave, userLoggedTime, userExhaustedML];

    // userOnLeave's approved leave spans the WHOLE scan window (not just
    // targetAbsentDay) -- otherwise Check 3 (no OMS activity) would still
    // flag them on every OTHER day in range, since they have no timeLogs
    // either. Calendar-date string comparison covers the weekend gaps
    // between openDays fine; those days are never scanned anyway.
    const leaveRequests = [
      { id: 'existing-leave-1', userId: userOnLeave.id, status: 'approved', startDate: fmtLocal(rangeStart), endDate: fmtLocal(yesterday), type: 'casual', days: openDays.length },
    ];
    // Every OTHER open day gets a timeLogs row for absent/exhausted users so
    // ONLY targetAbsentDay produces a flag for them; userLoggedTime gets a
    // row on targetAbsentDay itself (so Check 3 correctly skips them).
    const timeLogs = [];
    [userAbsent, userExhaustedML].forEach((u) => {
      otherOpenDays.forEach((ds) => timeLogs.push({ userId: u.id, date: ds, durationMins: 60 }));
    });
    timeLogs.push({ userId: userLoggedTime.id, date: targetAbsentDay, durationMins: 45 });
    otherOpenDays.forEach((ds) => timeLogs.push({ userId: userLoggedTime.id, date: ds, durationMins: 60 }));

    const { db, calls, leaveRequestsStore } = makeMockDb({ lastAttendanceCheck: fmtLocal(lastCheckDate) });
    const saveUserCalls = [];
    const sandbox = {
      console, Date, Math, Object,
      currentUser: { name: 'Admin User', isAdmin: true },
      db, users, leaveRequests, timeLogs, holidays: [],
      genId: makeGenId(),
      saveUser: async (u) => { saveUserCalls.push({ id: u.id, medLeft: u.medLeft, casLeft: u.casLeft }); },
      showToast: (msg) => { sandbox._lastToast = msg; },
      renderDashboard: () => {},
      updateApprovalBadge: () => {},
    };
    vm.createContext(sandbox);
    vm.runInContext(fmtSrc, sandbox);
    vm.runInContext(is24SatSrc, sandbox);
    vm.runInContext(isHolidaySrc, sandbox);
    vm.runInContext(isClosedDaySrc, sandbox);
    vm.runInContext(attendanceExcludedMatch[0], sandbox);
    vm.runInContext(runScanSrc, sandbox);
    await vm.runInContext('runAttendanceAutoDeduction()', sandbox);

    const writtenFlags = Object.values(leaveRequestsStore).filter((d) => d.isSystemFlagged);
    // Exactly the two genuinely-absent users (userAbsent, userExhaustedML)
    // on exactly the target day -- userOnLeave and userLoggedTime must be
    // excluded entirely (checked below).
    check('exactly two system-flagged records were written (only the genuinely absent users, only on the target day)', writtenFlags.length === 2 && writtenFlags.every((f) => f.startDate === targetAbsentDay));
    const flag = writtenFlags.find((f) => f.userId === userAbsent.id);
    check('the flagged record is for the correct user', flag && flag.userId === userAbsent.id);
    check('the flagged record is for the correct date', flag && flag.startDate === targetAbsentDay);
    check('the flagged record has status: pending', flag && flag.status === 'pending');
    check('the flagged record has autoDeducted: false', flag && flag.autoDeducted === false);
    check('the flagged record picks medical as the provisional bank (user has ML remaining)', flag && flag.type === 'medical' && flag.leaveType === 'ML');
    check('the flagged record reason carries the system-flagged marker', flag && flag.reason.includes('🚩 System-flagged'));

    check('the user WITH approved leave that day was correctly skipped (unchanged trigger, Check 1)', !writtenFlags.some((f) => f.userId === userOnLeave.id));
    check('the user WITH OMS activity that day was correctly skipped (unchanged trigger, Check 3)', !writtenFlags.some((f) => f.userId === userLoggedTime.id));

    check('saveUser() was NEVER called during the scan -- no casLeft/medLeft write fires on login', saveUserCalls.length === 0);
    check('userAbsent.medLeft is unchanged in memory', userAbsent.medLeft === 5);
    check('userAbsent.casLeft is unchanged in memory', userAbsent.casLeft === 3);

    check('lastAttendanceCheck was advanced to yesterday', calls.some((c) => c.op === 'companyData.update' && c.fields.lastAttendanceCheck === fmtLocal(yesterday)));
    check('the toast/summary language says "flagged for review", not "auto-deducted"', typeof sandbox._lastToast === 'string' && /flagged for review/i.test(sandbox._lastToast) && !/auto-deducted/i.test(sandbox._lastToast));

    console.log('\n--- Same scan, exhausted-ML user: provisional bank falls back to casual ---');
    const exhaustedFlag = Object.values(leaveRequestsStore).find((d) => d.isSystemFlagged && d.userId === userExhaustedML.id);
    check('the exhausted-ML user is flagged too (genuinely absent)', !!exhaustedFlag);
    check('their provisional bank is casual/CL (ML already at 0)', exhaustedFlag && exhaustedFlag.type === 'casual' && exhaustedFlag.leaveType === 'CL');
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== Behavioral: the 3-consecutive-months warning counts CONFIRMED absences only ===');
  async function runWarningScenario(autoDeductedValue) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
    // A short 2-day window with everyone logging activity every day, so the
    // scan itself produces ZERO new flags -- isolates the warning block.
    const rangeStart = new Date(today); rangeStart.setDate(rangeStart.getDate() - 2);
    const lastCheckDate = new Date(rangeStart); lastCheckDate.setDate(lastCheckDate.getDate() - 1);
    const scanDays = [];
    for (const d = new Date(rangeStart); d <= yesterday; d.setDate(d.getDate() + 1)) scanDays.push(fmtLocal(d));

    const patternUser = { id: 'u-pattern', name: 'Pattern Person', medLeft: 12, casLeft: 5 };
    const users = [patternUser];
    const timeLogs = scanDays.map((ds) => ({ userId: patternUser.id, date: ds, durationMins: 60 }));

    const months = [];
    for (let i = 1; i <= 3; i++) { const d = new Date(); d.setMonth(d.getMonth() - i); months.push(new Date(d)); }
    const leaveRequests = months.map((d, i) => ({
      id: `hist-${i}`, userId: patternUser.id, status: 'approved',
      startDate: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-10`,
      endDate: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-10`,
      type: 'casual', days: 1, autoDeducted: autoDeductedValue, isSystemFlagged: true,
    }));

    const { db, leaveRequestsStore } = makeMockDb({ lastAttendanceCheck: fmtLocal(lastCheckDate) });
    const sandbox = {
      console, Date, Math, Object,
      currentUser: { name: 'Admin User', isAdmin: true },
      db, users, leaveRequests, timeLogs, holidays: [],
      genId: makeGenId(),
      saveUser: async () => {},
      showToast: () => {},
      renderDashboard: () => {},
      updateApprovalBadge: () => {},
    };
    vm.createContext(sandbox);
    vm.runInContext(fmtSrc, sandbox);
    vm.runInContext(is24SatSrc, sandbox);
    vm.runInContext(isHolidaySrc, sandbox);
    vm.runInContext(isClosedDaySrc, sandbox);
    vm.runInContext(attendanceExcludedMatch[0], sandbox);
    vm.runInContext(runScanSrc, sandbox);
    await vm.runInContext('runAttendanceAutoDeduction()', sandbox);

    return Object.values(leaveRequestsStore).some((d) => d.isSystemWarning);
  }
  check('3 months of CONFIRMED (autoDeducted:true) absences DOES trigger the warning', await runWarningScenario(true));
  check('3 months of still-PENDING (autoDeducted:false) flags does NOT trigger the warning', !(await runWarningScenario(false)));

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== Behavioral: balance only changes on explicit Approve (renderApprovals()) ===');
  function makeCard() {
    const buttons = { '.btn-success': { onclick: null }, '.btn-danger': { onclick: null } };
    return { className: '', innerHTML: '', querySelector: (sel) => buttons[sel] || null };
  }
  function makeFakeDocument() {
    const appended = [];
    const approvalsListEl = { innerHTML: '', appendChild: (el) => appended.push(el) };
    return {
      doc: { getElementById: (id) => (id === 'approvalsList' ? approvalsListEl : null), createElement: () => makeCard() },
      appended,
    };
  }

  {
    const testUser = { id: 'u-approve', name: 'Approve Person', medLeft: 5, casLeft: 3 };
    const flagRecord = { id: 'flag-1', userId: testUser.id, userName: testUser.name, type: 'medical', leaveType: 'ML', startDate: '2026-09-01', endDate: '2026-09-01', days: 1, isHalf: false, reason: '🚩 System-flagged: possible absence — no OMS activity logged', status: 'pending', autoDeducted: false, isSystemFlagged: true, date: '2026-09-13' };
    const { db, leaveRequestsStore } = makeMockDb({});
    const saveUserCalls = [];
    const { doc: fakeDoc, appended } = makeFakeDocument();
    const sandbox = {
      console, Date, Math, Object,
      currentUser: { name: 'Admin User', isAdmin: true },
      document: fakeDoc,
      db, users: [testUser], leaveRequests: [flagRecord], changeRequests: [],
      saveUser: async (u) => { saveUserCalls.push({ id: u.id, medLeft: u.medLeft, casLeft: u.casLeft }); },
      renderDashboard: () => {}, renderTeamLeave: () => {}, renderTeamLeaveBank: () => {}, updateApprovalBadge: () => {},
      alert: () => {},
    };
    vm.createContext(sandbox);
    // renderApprovals() calls fmtD() for date display -- extract the real one.
    const fmtDSrc = fullScript.match(/function fmtD\([^)]*\)\{[\s\S]*?\n\}/)[0];
    vm.runInContext(fmtDSrc, sandbox);
    vm.runInContext(renderApprovalsSrc, sandbox);
    vm.runInContext('renderApprovals()', sandbox);

    check('a card was rendered for the pending flag', appended.length === 1);
    check('the card shows the "🚩 Possible Absence" label, not the generic "🌴 Leave" one', appended[0].innerHTML.includes('🚩 Possible Absence') && !appended[0].innerHTML.includes('🌴 Leave ·'));
    check('the card body text distinguishes it from a person-submitted reason', appended[0].innerHTML.includes('System-flagged'));

    const approveClick = appended[0].querySelector('.btn-success').onclick;
    assert.ok(typeof approveClick === 'function', 'Approve handler was not wired');
    await approveClick();

    check('saveUser() was called exactly once, on Approve', saveUserCalls.length === 1);
    check('medLeft was decremented by the flagged days (5 -> 4)', saveUserCalls[0].medLeft === 4);
    const writtenApproval = leaveRequestsStore[flagRecord.id];
    check('the Firestore write sets status: approved', writtenApproval && writtenApproval.status === 'approved');
    check('the Firestore write sets autoDeducted: true -- ONLY happens here, at Approve time', writtenApproval && writtenApproval.autoDeducted === true);
  }

  console.log('\n--- Reject dismisses cleanly: no balance change, no autoDeducted flip ---');
  {
    const testUser = { id: 'u-reject', name: 'Reject Person', medLeft: 5, casLeft: 3 };
    const flagRecord = { id: 'flag-2', userId: testUser.id, userName: testUser.name, type: 'medical', leaveType: 'ML', startDate: '2026-09-01', endDate: '2026-09-01', days: 1, isHalf: false, reason: '🚩 System-flagged: possible absence — no OMS activity logged', status: 'pending', autoDeducted: false, isSystemFlagged: true, date: '2026-09-13' };
    const { db, leaveRequestsStore } = makeMockDb({});
    const saveUserCalls = [];
    const { doc: fakeDoc, appended } = makeFakeDocument();
    const sandbox = {
      console, Date, Math, Object,
      currentUser: { name: 'Admin User', isAdmin: true },
      document: fakeDoc,
      db, users: [testUser], leaveRequests: [flagRecord], changeRequests: [],
      saveUser: async (u) => { saveUserCalls.push({ id: u.id }); },
      renderDashboard: () => {}, renderTeamLeave: () => {}, renderTeamLeaveBank: () => {}, updateApprovalBadge: () => {},
      alert: () => {},
    };
    vm.createContext(sandbox);
    const fmtDSrc = fullScript.match(/function fmtD\([^)]*\)\{[\s\S]*?\n\}/)[0];
    vm.runInContext(fmtDSrc, sandbox);
    vm.runInContext(renderApprovalsSrc, sandbox);
    vm.runInContext('renderApprovals()', sandbox);

    const rejectClick = appended[0].querySelector('.btn-danger').onclick;
    assert.ok(typeof rejectClick === 'function', 'Reject handler was not wired');
    await rejectClick();

    check('saveUser() was NEVER called on Reject', saveUserCalls.length === 0);
    check('testUser.medLeft is unchanged', testUser.medLeft === 5);
    const writtenRejection = leaveRequestsStore[flagRecord.id];
    check('the Firestore write sets status: rejected', writtenRejection && writtenRejection.status === 'rejected');
    check('the Firestore write does NOT set autoDeducted: true', writtenRejection && writtenRejection.autoDeducted !== true);
  }

  console.log('\n=== the inline <script> still parses ===');
  check('new Function(fullScript) does not throw', (() => {
    try { new Function(fullScript); return true; }
    catch (e) { console.log('    parse error:', e.message); return false; }
  })());

  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
})();
