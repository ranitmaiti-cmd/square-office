// Fixture for the Team Leave Bank STATUS badge fix (V33, 2026-09-19).
//
// The badge used to key on medLeft alone, so Neha (med 7 / cas -4) and
// Taskiya (med 12 / cas 0) read "OK". It now takes the worst state across
// BOTH buckets and names the bucket. Rules (agreed with Ranit):
//   medical: <0 Negative, ==0 Exhausted, <=3 Low, else OK
//   casual:  <0 Negative, ==0 Exhausted, <=1 Low, else OK  (5-day pool)
//   badge = worst of the two, labelled "<State> · medical|casual|med+cas"
//
// Central claims under test:
//  - leaveBankStatus() truth table, incl. the reported cases
//  - the REAL renderTeamLeaveBank() (extracted, executed in a vm) renders
//    the expected badge for every person in the live bank
//  - display-only: no db/write call in either function
//  - isolation: the helper and the badge block are byte-identical to main's
//    (written to hold before and after later edits to the same renderer)
//
// Run with: node test/fix-leave-bank-status-badge.test.js
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
const renderSrc = extractFunction(fullScript, 'renderTeamLeaveBank');

// ─────────────────────────────────────────────────────────────
console.log('=== leaveBankStatus() truth table ===');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(helperSrc, sandbox);
const st = (m, c) => vm.runInContext(`leaveBankStatus(${m}, ${c})`, sandbox);

check('both healthy (7 / 3.5) -> OK', st(7, 3.5).label === 'OK' && st(7, 3.5).state === 'ok');
check('boundary: med 3.5 / cas 2 -> OK', st(3.5, 2).label === 'OK');
check('med 3 / cas 4 -> Low · medical', st(3, 4).label === 'Low · medical');
check('med 2.5 / cas 2 -> Low · medical', st(2.5, 2).label === 'Low · medical');
check('med 5.5 / cas 1 -> Low · casual (casual Low line is <=1)', st(5.5, 1).label === 'Low · casual');
check('med 5 / cas 1.5 -> OK (casual just above the Low line)', st(5, 1.5).label === 'OK');
check('med 2 / cas 1 -> Low · med+cas (both buckets named)', st(2, 1).label === 'Low · med+cas');
check('med 12 / cas 0 (Taskiya) -> Exhausted · casual', st(12, 0).label === 'Exhausted · casual');
check('med 0 / cas 0 (Souvik as stored) -> Exhausted · med+cas', st(0, 0).label === 'Exhausted · med+cas');
check('med 0 / cas 4 -> Exhausted · medical', st(0, 4).label === 'Exhausted · medical');
check('med 7 / cas -4 (Neha) -> Negative · casual', st(7, -4).label === 'Negative · casual');
check('med -1 / cas -1 (Rai) -> Negative · med+cas', st(-1, -1).label === 'Negative · med+cas');
check('med -1 / cas 4 -> Negative · medical', st(-1, 4).label === 'Negative · medical');
check('negative outranks exhausted: med 0 / cas -1 -> Negative · casual', st(0, -1).label === 'Negative · casual');
check('negative outranks low: med 2 / cas -3 -> Negative · casual', st(2, -3).label === 'Negative · casual');
check('exhausted outranks low: med 2 / cas 0 -> Exhausted · casual', st(2, 0).label === 'Exhausted · casual');
check('state field carries the worst state for styling', st(7, -4).state === 'negative' && st(12, 0).state === 'exhausted' && st(3, 4).state === 'low');

// ─────────────────────────────────────────────────────────────
console.log('\n=== the REAL renderTeamLeaveBank() against the live bank ===');
// Live bank as audited from Firestore on 2026-09-19 (stored medLeft/casLeft).
const LIVE = [
  ['Angana', 7, 3.5, 'OK'],
  ['Ridhi', 2.5, 2, 'Low · medical'],
  ['Souvik', 0, 0, 'Exhausted · med+cas'],
  ['Suravi', 5.5, 1, 'Low · casual'],
  ['Tasmin', 3, 4, 'Low · medical'],
  ['Rai', -1, -1, 'Negative · med+cas'],
  ['Neha', 7, -4, 'Negative · casual'],
  ['Taskiya', 12, 0, 'Exhausted · casual'],
];
const el = { innerHTML: '' };
const renderSandbox = {
  document: { getElementById: (id) => (id === 'teamLeaveBank' ? el : null) },
  currentUser: { isAdmin: true },
  users: [{ id: 'admin', name: 'Admin', isAdmin: true, medLeft: 12, casLeft: 5 }]
    .concat(LIVE.map(([name, m, c], i) => ({ id: 'u' + i, name, isAdmin: false, medLeft: m, casLeft: c }))),
  leaveRequests: [],
  Date,
  String, Math,
};
vm.createContext(renderSandbox);
vm.runInContext(helperSrc, renderSandbox);
vm.runInContext(renderSrc, renderSandbox);
vm.runInContext('renderTeamLeaveBank()', renderSandbox);
const html = el.innerHTML;
check('renderTeamLeaveBank() produced a table', html.includes('<table'));
for (const [name, , , expected] of LIVE) {
  const rowStart = html.indexOf(`>${name}</td>`);
  const rowEnd = html.indexOf('</tr>', rowStart);
  const row = html.slice(rowStart, rowEnd);
  check(`${name} row renders badge "${expected}"`, rowStart > 0 && row.includes(`>${expected}</span>`));
}
check('admin user is not listed in the bank', !html.includes('>Admin</td>'));

// ─────────────────────────────────────────────────────────────
console.log('\n=== display-only: no writes, no reads ===');
check('leaveBankStatus() touches no db/firebase/localStorage', !/\bdb\b|firebase|localStorage|\.set\(|\.update\(|\.delete\(/.test(helperSrc));
check('renderTeamLeaveBank() touches no db write', !/\.set\(|\.update\(|\.delete\(|\.add\(|saveUser|saveData/.test(renderSrc));

// ─────────────────────────────────────────────────────────────
console.log('\n=== isolation vs main ===');
// V33 is on main now, so "diff vs main" can no longer mean "what V33 added".
// These hold both before and after later edits to renderTeamLeaveBank():
// the helper and the badge block must stay byte-identical to main's.
check('leaveBankStatus() is byte-for-byte identical to main', helperSrc === extractFunction(mainScript, 'leaveBankStatus'));
const badgeOf = (fn) => {
  const a2 = fn.indexOf('const status = leaveBankStatus(');
  const b2 = fn.indexOf('>${status.label}</span>`;', fn.indexOf("status.state === 'low'"));
  return a2 > 0 && b2 > a2 ? fn.slice(a2, b2) : null;
};
const mainRender = extractFunction(mainScript, 'renderTeamLeaveBank');
check('located the badge block in both versions', !!badgeOf(renderSrc) && !!badgeOf(mainRender));
check('the badge block in renderTeamLeaveBank() is byte-for-byte identical to main', badgeOf(renderSrc) === badgeOf(mainRender));
check('the old medLeft-only badge is gone from both', !renderSrc.includes('const statusBadge = medLeft < 0') && !mainRender.includes('const statusBadge = medLeft < 0'));
const bumped = /const APP_VERSION = '(\d{4}-\d{2}-\d{2}\.\d+)'/.exec(fullScript)[1];
check(`APP_VERSION is well-formed (${bumped})`, !!bumped);
check('version.json matches APP_VERSION', JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'version.json'), 'utf8')).version === bumped);
check('inline <script> still parses', (() => { try { new Function(fullScript); return true; } catch (e) { console.log('   ', e.message); return false; } })());

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
