// Fixture for the Leave + HR Info tab merge (2026-09-12, Option A).
//
// This is a container-and-routing consolidation, not a logic change --
// the central claim under test is literally "nothing about how leave gets
// applied for, cancelled, or approved changed by one byte." That's proven
// here by diffing the CURRENT branch's index.html against `main`'s actual
// committed content (via `git show main:index.html`), function by function
// -- not by re-reading the spec and hoping, by comparing real bytes.
//
// Central claims under test:
//  - renderLeaves(), the applyLeaveBtn handler, the #leaveModal markup,
//    cancelLeave(), and the approval (approve/reject) handlers inside
//    renderApprovals() are BYTE-FOR-BYTE IDENTICAL to what's on main
//  - the submitLeaveBtn handler (the actual apply-for-leave submission
//    logic: sandwich rule, ML->CL fallback, same-day-ML auto-approve,
//    balance deduction) is byte-for-byte identical to main
//  - routing: opening the 'leaves' page calls BOTH renderLeaves() AND
//    renderHrInfo()
//  - the reconciliation caveat is static markup sitting directly under
//    the EXISTING #leaveBalance balance-grid, not a second balance card
//  - no duplicate balance: #hrInfoBalance (HR Info's old separate balance
//    section) no longer exists anywhere, and renderHrInfo() no longer
//    writes to it
//  - no dangling HR Info references: #page-hrinfo, data-page="hrinfo" are
//    both fully gone
//  - id="page-leaves" / data-page="leaves" kept internally unchanged --
//    only the visible nav label changed to "Leave & HR"
//
// Run with: node test/fix-merge-leave-hrinfo-tabs.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const assert = require('assert');

// Normalize line endings before any comparison -- the local working tree
// checks out CRLF, but `git show main:...` returns the blob's raw LF
// content. Without normalizing, every multi-line comparison below would
// report a spurious difference caused entirely by \r\n vs \n, not by any
// real content change.
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
// Extract a <div>...</div> block by counting nested <div ...> opens against
// </div> closes -- robust to exact whitespace, unlike a literal end-marker
// string match.
function extractDivBlock(html, startMarker) {
  const s = html.indexOf(startMarker);
  assert.ok(s >= 0, `could not find HTML start marker: ${startMarker}`);
  const tagRe = /<div\b[^>]*>|<\/div>/g;
  tagRe.lastIndex = s;
  let depth = 0, m, end = -1;
  while ((m = tagRe.exec(html))) {
    if (m[0].startsWith('</')) depth--; else depth++;
    if (depth === 0) { end = m.index + m[0].length; break; }
  }
  assert.ok(end >= 0, `unbalanced <div> starting at marker: ${startMarker}`);
  return html.slice(s, end);
}

(async () => {
  // ─────────────────────────────────────────────────────────────
  console.log('=== Apply-for-leave logic: byte-for-byte identical to main ===');
  check('renderLeaves() is byte-for-byte unchanged from main',
    extractFunction(fullScript, 'renderLeaves') === extractFunction(mainFullScript, 'renderLeaves'));
  check('the submitLeaveBtn handler (sandwich rule, ML->CL fallback, same-day-ML, balance deduction) is byte-for-byte unchanged',
    extractBlockFrom(fullScript, "getElementById('submitLeaveBtn').addEventListener('click'") ===
    extractBlockFrom(mainFullScript, "getElementById('submitLeaveBtn').addEventListener('click'"));
  check('the applyLeaveBtn (open-modal) handler is byte-for-byte unchanged',
    extractBlockFrom(fullScript, "getElementById('applyLeaveBtn').addEventListener('click'") ===
    extractBlockFrom(mainFullScript, "getElementById('applyLeaveBtn').addEventListener('click'"));
  check('cancelLeave() is byte-for-byte unchanged',
    extractBlockFrom(fullScript, 'window.cancelLeave = function') === extractBlockFrom(mainFullScript, 'window.cancelLeave = function'));
  check('renderApprovals() (approve/reject handlers, balance decrement on approval) is byte-for-byte unchanged',
    extractFunction(fullScript, 'renderApprovals') === extractFunction(mainFullScript, 'renderApprovals'));
  check('the #leaveModal markup (apply form: type/duration/dates/reason) is byte-for-byte unchanged',
    extractDivBlock(src, '<div class="modal-backdrop" id="leaveModal">') ===
    extractDivBlock(mainSrc, '<div class="modal-backdrop" id="leaveModal">'));

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== Routing: opening \'leaves\' calls BOTH renderLeaves() and renderHrInfo() ===');
  check("if(page==='leaves') calls renderLeaves()", /if\(page===['"]leaves['"]\)\s*\{[^}]*renderLeaves\(\);/.test(fullScript));
  check("if(page==='leaves') ALSO calls renderHrInfo()", /if\(page===['"]leaves['"]\)\s*\{[^}]*renderHrInfo\(\);/.test(fullScript));
  check("the old standalone if(page==='hrinfo') routing line is gone", !/if\(page===['"]hrinfo['"]\)/.test(fullScript));

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== Caveat attached to the EXISTING balance display, no duplicate balance ===');
  const pageLeavesBlock = extractDivBlock(src, '<div class="page" id="page-leaves">');
  check('the balance-grid (#leaveBalance) is present exactly once', (pageLeavesBlock.match(/id="leaveBalance"/g) || []).length === 1);
  check('the reconciliation caveat text appears in page-leaves, directly after the balance-grid div',
    /id="leaveBalance"><\/div>\s*<div[^>]*>⚠ Leave balances are currently being reconciled/.test(pageLeavesBlock));
  // Matches the ⚠-prefixed STATIC UI BANNER specifically, not the bare
  // phrase -- Quick Ask (2026-09-12) legitimately reuses the same wording
  // in a JS string constant (QUICK_ASK_CAVEAT, no ⚠ prefix) for its own
  // dynamically-built answers, which is a deliberate second, different use
  // of the phrase, not a leftover duplicate UI section.
  check('there is only ONE static balance-caveat UI banner in the whole file (no leftover second copy)',
    (src.match(/⚠ Leave balances are currently being reconciled/g) || []).length === 1);
  check('#hrInfoBalance (the old separate HR Info balance card) no longer exists anywhere', !src.includes('hrInfoBalance'));
  check('renderHrInfo() no longer references a second balance element',
    !extractFunction(fullScript, 'renderHrInfo').includes('hrInfoBalance'));
  check('renderHrInfo() explicitly documents why the balance section was dropped (not silently deleted)',
    /separate "My Leave Balance" section was\s*\n?\s*\/\/ dropped/.test(fullScript) || fullScript.includes('separate "My Leave Balance" section was'));

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== HR Info sections present inside page-leaves ===');
  for (const id of ['hrInfoAttendance', 'hrInfoLeavePolicy', 'hrInfoHolidays', 'hrInfoTimingPolicy', 'hrInfoHowToApply']) {
    check(`#${id} is inside the page-leaves block`, pageLeavesBlock.includes(`id="${id}"`));
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== No dangling HR Info references ===');
  check('id="page-hrinfo" no longer exists anywhere', !src.includes('id="page-hrinfo"'));
  check('data-page="hrinfo" no longer exists anywhere', !src.includes('data-page="hrinfo"'));
  check('there is no separate "HR Info" nav item anymore', !src.includes('>HR Info<'));

  console.log('\n=== id/data-page="leaves" kept internally unchanged; only the visible label changed ===');
  check('id="page-leaves" still exists (unchanged)', src.includes('id="page-leaves"'));
  check('data-page="leaves" still exists (unchanged)', src.includes('data-page="leaves"'));
  check('the visible nav label is now "Leave & HR"', /data-page="leaves">[^<]*<span[^>]*>[^<]*<\/span>Leave & HR</.test(src));

  console.log('\n=== the inline <script> still parses ===');
  check('new Function(fullScript) does not throw', (() => {
    try { new Function(fullScript); return true; }
    catch (e) { console.log('    parse error:', e.message); return false; }
  })());

  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
})();
