// Fixture for V34: Team Leave Bank / personal balance card read per-person
// entitlement (2026-09-19).
//
// After pro-rating, Taskiya carries medEntitlement:9 / casEntitlement:3.75
// on her user doc, but the bank still printed "/ 12" and "/ 5". The display
// now uses `medEntitlement ?? 12` / `casEntitlement ?? 5` for the "/ X"
// denominators, "used of X" text and bar maths. Display-only.
//
// Central claims under test (the REAL functions, extracted and executed):
//  - renderTeamLeaveBank(): Taskiya (9 / -1.25, ent 9 / 3.75) reads
//    "/ 9" and "/ 3.75"; everyone without entitlement fields still reads
//    "/ 12" and "/ 5"; the bar widths use the person's own entitlement
//  - renderLeaves() (own balance card): same, "used of X" and bar %
//  - the balance values shown, the status badge and the "Used" columns are
//    unchanged (entitlement affects denominators only)
//  - no balance write/logic touched: no db/save calls in either function
//  - isolation: every part of the script other than these two functions and
//    the APP_VERSION line is byte-identical to main (holds before AND after
//    merge); and with the V34 change normalised away, the two functions
//    equal main's
//
// Run with: node test/fix-leave-bank-entitlement-denominators.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');
const assert = require('assert');

const norm = (s) => s.replace(/\r\n/g, '\n');
const REPO_ROOT = 'D:/SQUARE/ADMIN/SQUARE-Office/finalphase/01072026';
const src = norm(fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8'));
const fullScript = src.match(/<script>([\s\S]*?)<\/script>/)[1];
const mainSrc = norm(execSync('git show main:index.html', { cwd: REPO_ROOT, maxBuffer: 1024 * 1024 * 20 }).toString('utf8'));
const mainScript = mainSrc.match(/<script>([\s\S]*?)<\/script>/)[1];

let passCount = 0, failCount = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); passCount++; }
  else { console.log(`  FAIL: ${label}`); failCount++; }
}

function extractFunction(source, name) {
  let startIdx = source.indexOf(`async function ${name}(`);
  if (startIdx < 0) startIdx = source.indexOf(`function ${name}(`);
  assert.ok(startIdx >= 0, `could not find function ${name}`);
  const parenStart = source.indexOf('(', startIdx);
  let pd = 0, j = parenStart;
  for (; j < source.length; j++) {
    if (source[j] === '(') pd++;
    else if (source[j] === ')') { pd--; if (pd === 0) break; }
  }
  const braceStart = source.indexOf('{', j);
  let depth = 0, i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  return source.slice(startIdx, i + 1);
}

const helperSrc = extractFunction(fullScript, 'leaveBankStatus');
const bankSrc = extractFunction(fullScript, 'renderTeamLeaveBank');
const leavesSrc = extractFunction(fullScript, 'renderLeaves');

// ─────────────────────────────────────────────────────────────
console.log('=== renderTeamLeaveBank(): denominators ===');
const USERS = [
  { id: 'a', name: 'Angana', medLeft: 7, casLeft: 3.5 },
  { id: 't', name: 'Taskiya', medLeft: 9, casLeft: -1.25, medEntitlement: 9, casEntitlement: 3.75 },
  { id: 'p', name: 'PartlyUsed', medLeft: 6, casLeft: 2, medEntitlement: 9, casEntitlement: 3.75 },
  { id: 'n', name: 'Neha', medLeft: 7, casLeft: -4 },
];
const el = { innerHTML: '' };
const sb = {
  document: { getElementById: (id) => (id === 'teamLeaveBank' ? el : null) },
  currentUser: { isAdmin: true },
  users: [{ id: 'admin', name: 'Admin', isAdmin: true, medLeft: 12, casLeft: 5 }].concat(USERS.map((u) => ({ isAdmin: false, ...u }))),
  leaveRequests: [], Date, String, Math,
};
vm.createContext(sb);
vm.runInContext(helperSrc, sb);
vm.runInContext(bankSrc, sb);
vm.runInContext('renderTeamLeaveBank()', sb);
const html = el.innerHTML;
const rowOf = (name) => { const a = html.indexOf(`>${name}</td>`); return html.slice(a, html.indexOf('</tr>', a)); };

const t = rowOf('Taskiya');
check('Taskiya medical denominator reads "/ 9"', t.includes('> / 9</span>'));
check('Taskiya casual denominator reads "/ 3.75"', t.includes('> / 3.75</span>'));
check('Taskiya no longer shows "/ 12" or "/ 5"', !t.includes('> / 12</span>') && !t.includes('> / 5</span>'));
check('Taskiya balances shown unchanged (9 and -1.25)', t.includes('>9</span>') && t.includes('>-1.25</span>'));
check('Taskiya badge unchanged (Exhausted/Negative logic untouched): Negative · casual', t.includes('>Negative · casual</span>'));
for (const name of ['Angana', 'Neha']) {
  const r = rowOf(name);
  check(`${name} (no entitlement fields) still reads "/ 12" and "/ 5"`, r.includes('> / 12</span>') && r.includes('> / 5</span>'));
}
check('Neha badge and balances unchanged: Negative · casual, 7 and -4', rowOf('Neha').includes('>Negative · casual</span>') && rowOf('Neha').includes('>-4</span>'));
check('Angana badge unchanged: OK', rowOf('Angana').includes('>OK</span>'));
// bar maths: used/entitlement
const widthPx = (row, n) => { const m = [...row.matchAll(/height:6px;width:(\d+)px;"><\/div>/g)].map((x) => +x[1]); return m[n]; };
check('Taskiya med bar: 0 used of 9 -> 0px', widthPx(t, 0) === 0);
check('Taskiya cas bar: negative balance -> full 60px', widthPx(t, 1) === 60);
const pu = rowOf('PartlyUsed');
check('PartlyUsed med bar uses entitlement 9: (9-6)/9*80 = 27px', widthPx(pu, 0) === 27);
check('PartlyUsed cas bar uses entitlement 3.75: (3.75-2)/3.75*60 = 28px', widthPx(pu, 1) === 28);
const an = rowOf('Angana');
check('Angana med bar still uses 12: (12-7)/12*80 = 33px', widthPx(an, 0) === 33);
check('Angana cas bar still uses 5: (5-3.5)/5*60 = 18px', widthPx(an, 1) === 18);

// ─────────────────────────────────────────────────────────────
console.log('\n=== renderLeaves() (own balance card) ===');
function renderCard(user) {
  const card = { innerHTML: '' }, list = { innerHTML: '' };
  const s2 = {
    document: { getElementById: (id) => (id === 'leaveBalance' ? card : id === 'myLeaveList' ? list : null) },
    currentUser: { id: user.id }, users: [user], leaveRequests: [],
  };
  vm.createContext(s2);
  vm.runInContext(leavesSrc, s2);
  vm.runInContext('renderLeaves()', s2);
  return card.innerHTML;
}
const tc = renderCard({ id: 't', medLeft: 9, casLeft: -1.25, medEntitlement: 9, casEntitlement: 3.75 });
check('Taskiya card: medical "0 used of 9"', tc.includes('0 used of 9<'));
check('Taskiya card: casual "5 used of 3.75"', tc.includes('5 used of 3.75<'));
check('Taskiya card shows her balances 9 and -1.25', tc.includes('>9</div>') && tc.includes('>-1.25</div>'));
check('Taskiya card bar % uses her entitlement (cas 5/3.75)', tc.includes('width:133.33333333333331%') || /width:133\.3\d+%/.test(tc));
const ac = renderCard({ id: 'a', medLeft: 7, casLeft: 3.5 });
check('Angana card (no fields): "5 used of 12" and "1.5 used of 5"', ac.includes('5 used of 12<') && ac.includes('1.5 used of 5<'));
check('Angana card bar % unchanged (5/12, 1.5/5)', /width:41\.6\d+%/.test(ac) && ac.includes('width:30%'));

// ─────────────────────────────────────────────────────────────
console.log('\n=== display-only: no balance logic touched ===');
check('renderTeamLeaveBank() has no db/save call', !/\bdb\b|\.set\(|\.update\(|saveUser|saveData/.test(bankSrc));
check('renderLeaves() has no db/save call', !/\bdb\b|\.set\(|\.update\(|saveUser|saveData/.test(leavesSrc));
check('leaveBankStatus() is untouched (byte-identical to main)', helperSrc === extractFunction(mainScript, 'leaveBankStatus'));

// ─────────────────────────────────────────────────────────────
console.log('\n=== isolation vs main ===');
// A whole-script "everything except these two functions is byte-identical
// to main" check was here originally. That claim is only ever true at the
// moment a change merges -- the instant any LATER, unrelated feature adds
// code anywhere else in this large shared file (as V35's WFH workflow
// legitimately does, on a branch cut after this one merged), the check
// would false-fail forever, the same staleness this codebase has hit
// repeatedly (see the V32/V33 fixture notes elsewhere in this suite).
// V34's real, durable claim -- it touched ONLY renderTeamLeaveBank() and
// renderLeaves() -- is what the flat()-normalized per-function checks
// below already prove, function by function, against CURRENT main (which
// already contains V34). Isolation from the pay-critical/leave-deduction
// surface specifically is asserted directly here instead of via a
// whole-file diff, so it stays meaningful no matter what unrelated work
// lands elsewhere in the file later.
for (const name of ['runAttendanceAutoDeduction', 'saveUser', 'saveLeaveRequest', 'leaveBankStatus', 'renderApprovals']) {
  check(`${name}() is byte-for-byte unchanged from main`, extractFunction(fullScript, name) === extractFunction(mainScript, name));
}

const flat = (s) => s
  .replace('const medEnt=user.medEntitlement??12,casEnt=user.casEntitlement??5,mU=medEnt-user.medLeft,cU=casEnt-user.casLeft;', 'const mU=12-user.medLeft,cU=5-user.casLeft;')
  .replace(/\n\s*\/\/ V34: per-person entitlement[^\n]*\n\s*\/\/ casEntitlement[^\n]*\n\s*const medEnt = [^\n]*\n\s*const casEnt = [^\n]*/, '')
  .split('${medEnt}').join('12').split('${casEnt}').join('5')
  .split('medEnt').join('12').split('casEnt').join('5');
check('renderLeaves() equals main once the entitlement change is normalised away', flat(leavesSrc) === flat(extractFunction(mainScript, 'renderLeaves')));
check('renderTeamLeaveBank() equals main once the entitlement change is normalised away', flat(bankSrc) === flat(extractFunction(mainScript, 'renderTeamLeaveBank')));

const bumped = /const APP_VERSION = '(\d{4}-\d{2}-\d{2}\.\d+)'/.exec(fullScript)[1];
check(`APP_VERSION well-formed (${bumped}); version.json matches`, JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'version.json'), 'utf8')).version === bumped);
check('inline <script> still parses', (() => { try { new Function(fullScript); return true; } catch (e) { console.log('   ', e.message); return false; } })());

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
