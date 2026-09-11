// Fixture for the holidays carve-out from the batch save (V25, 2026-09-10).
//
// Problem: `holidays` was a key in saveData()'s `dataToSave` object, which
// every open tab writes to companyData/squareDB every 30s using its OWN
// in-memory `holidays`. A tab that loaded before a holiday change (or before
// the array was ever populated) silently reverted squareDB.holidays to its
// stale copy on the next periodic tick -- last-write-wins. This is the exact
// failure mode already carved out for leaveRequests (V14.2.6) and
// casLeft/medLeft (V14.2.40c).
//
// Fix: remove `holidays` from `dataToSave`; add saveHolidaysGranular(), a
// targeted .update({ holidays }) of just that one field; call it from the two
// canManageHolidays()-gated mutation points (add / delete) and the backup
// restore path instead of autoSave().
//
// Central claims under test:
//  - saveData()'s dataToSave literal no longer has a `holidays` key
//  - every OTHER dataToSave key is still there (nothing else dropped)
//  - saveHolidaysGranular() exists, uses .update() (not .set(), which would
//    wipe sibling fields), and writes exactly { holidays: <in-memory array> }
//    to companyData/squareDB -- proven by executing the real function
//  - the add-holiday handler and deleteHoliday() now call
//    saveHolidaysGranular() and NOT autoSave()
//  - the backup-restore path also persists holidays explicitly
//  - isHoliday() / getHolidayName() are byte-for-byte unchanged (the READ
//    path must be untouched)
//  - loadData() still seeds `holidays` from squareDB on load
//  - the inline <script> still parses
//
// Run with: node test/fix-holidays-carve-out-of-save.test.js
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

let passCount = 0, failCount = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); passCount++; }
  else { console.log(`  FAIL: ${label}`); failCount++; }
}

function extractFunction(source, name) {
  let startIdx = source.indexOf(`async function ${name}(`);
  if (startIdx < 0) startIdx = source.indexOf(`function ${name}(`);
  assert.ok(startIdx >= 0, `could not find "function ${name}(" in index.html`);
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

// Strip // line comments and /* */ blocks, preserving string literals -- so a
// check for "no longer calls autoSave()" can't be fooled by the word appearing
// in an explanatory code comment (e.g. "// V25: granular write, not autoSave()").
function stripComments(text) {
  let out = '', i = 0;
  const n = text.length;
  while (i < n) {
    const two = text.slice(i, i + 2);
    if (two === '//') { const e = text.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (two === '/*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (text[i] === "'" || text[i] === '"' || text[i] === '`') {
      const q = text[i]; out += text[i++];
      while (i < n && text[i] !== q) {
        if (text[i] === '\\') { out += text[i++]; if (i < n) out += text[i++]; continue; }
        out += text[i++];
      }
      if (i < n) out += text[i++];
      continue;
    }
    out += text[i++];
  }
  return out;
}

// Anchor on a unique string, then brace-match from the next '{'.
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

(async () => {
  // ─────────────────────────────────────────────────────────────
  console.log('=== dataToSave no longer carries `holidays`, everything else intact ===');
  const saveDataSrc = extractFunction(fullScript, 'saveData');
  const dtsMatch = saveDataSrc.match(/const dataToSave = \{([\s\S]*?)\};/);
  assert.ok(dtsMatch, 'could not find the dataToSave object literal in saveData()');
  const dtsBody = dtsMatch[1];

  check('dataToSave literal has NO `holidays` key', !/\bholidays\b/.test(dtsBody));

  for (const key of ['clients', 'typologies', 'changeRequests', 'budgetTemplates',
    'timestamp', 'instanceId', 'savedBy', 'projectCount', 'timeLogCount',
    'planEntryCount', 'leaveRequestCount']) {
    check(`dataToSave literal still has \`${key}\``, new RegExp(`\\b${key}\\b`).test(dtsBody));
  }

  check('saveData() still writes squareDB via .update() (not .set())',
    /doc\("squareDB"\)\.update\(dataToSave\)/.test(saveDataSrc));

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== saveHolidaysGranular(): exists, .update({ holidays }) to squareDB, executed for real ===');
  const shgSrc = extractFunction(fullScript, 'saveHolidaysGranular');
  check('saveHolidaysGranular() is defined', shgSrc.length > 0);
  check('it uses .update( (NOT .set(, which would replace the whole doc)',
    shgSrc.includes('.update(') && !shgSrc.includes('.set('));
  check('it targets companyData/squareDB',
    /collection\("companyData"\)\.doc\("squareDB"\)/.test(shgSrc));
  check('it still respects the staleVersionLockout write-pause guard',
    shgSrc.includes('if (staleVersionLockout) return'));

  let updateArg = null, collArg = null, docArg = null;
  const sandbox = {
    console,
    staleVersionLockout: false,
    holidays: [
      { id: 'h1', date: '2026-01-01', name: "New Year's Day" },
      { id: 'h2', date: '2026-08-15', name: 'Independence Day' },
    ],
    alert: () => {},
    db: {
      collection(c) { collArg = c; return { doc(d) { docArg = d; return { update(o) { updateArg = o; return Promise.resolve(); } }; } }; },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(shgSrc + '\nglobalThis.__run = saveHolidaysGranular;', sandbox);
  await sandbox.__run();

  check('called db.collection("companyData")', collArg === 'companyData');
  check('called .doc("squareDB")', docArg === 'squareDB');
  check('update() payload has exactly one key: holidays',
    updateArg && Object.keys(updateArg).length === 1 && 'holidays' in updateArg);
  check('update() payload holidays === the in-memory array (same entries, same order)',
    JSON.stringify(updateArg.holidays) === JSON.stringify(sandbox.holidays));

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== the mutation points now call saveHolidaysGranular(), not autoSave() ===');
  const addHandler = stripComments(extractBlockFrom(fullScript, "getElementById('saveHolidayBtn').addEventListener('click'"));
  check('add-holiday handler calls saveHolidaysGranular()', addHandler.includes('saveHolidaysGranular('));
  check('add-holiday handler no longer calls autoSave() (comments stripped)', !addHandler.includes('autoSave('));

  const delHandler = stripComments(extractBlockFrom(fullScript, 'window.deleteHoliday=async function'));
  check('deleteHoliday() calls saveHolidaysGranular()', delHandler.includes('saveHolidaysGranular('));
  check('deleteHoliday() no longer calls autoSave() (comments stripped)', !delHandler.includes('autoSave('));

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== backup restore persists holidays explicitly (regression guard) ===');
  const restoreHandler = extractBlockFrom(fullScript, "getElementById('importFileInput').addEventListener('change'");
  check('restore path calls saveHolidaysGranular() AFTER saveData()',
    restoreHandler.includes('saveHolidaysGranular(') &&
    restoreHandler.indexOf('await saveData()') < restoreHandler.indexOf('saveHolidaysGranular('));

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== the READ path is byte-for-byte untouched ===');
  check('isHoliday() body is exactly the known-good implementation',
    fullScript.includes("function isHoliday(d){ const ds=fmt(d); return holidays.some(h=>h.date===ds); }"));
  check('getHolidayName() body is exactly the known-good implementation',
    fullScript.includes("function getHolidayName(d){ const ds=fmt(d); const h=holidays.find(h=>h.date===ds); return h?h.name:null; }"));
  check('loadData() still seeds in-memory holidays from squareDB on load',
    /holidays = data\.holidays \|\| \[\];/.test(fullScript));
  check('isClosedDayStr() still reads holidays from a passed-in list (unchanged pure helper)',
    fullScript.includes('function isClosedDayStr(dateStr, holidaysList)'));

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== the inline <script> still parses ===');
  check('new Function(fullScript) does not throw', (() => {
    try { new Function(fullScript); return true; }
    catch (e) { console.log('    parse error:', e.message); return false; }
  })());

  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
})();
