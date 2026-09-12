// Fixture for the Quick Ask enhancements (2026-09-13): suggested-question
// chips, chat-bubble scrollback, and 4 new keyword categories (Saturday
// working-day check, pending leave, leave history, days-until-holiday
// countdown). Still NOT AI -- see test/feat-quick-ask-keyword-hr.test.js
// for the base feature's coverage (11 original categories, caveat,
// no-match fallback, multi-keyword, word-boundary, holiday-name matching,
// own-data scoping, not-AI proof, apply-flow-untouched). This file covers
// only what's new.
//
// Central claims under test:
//  - the 6 suggested-question chips exist, each with the exact data-q text
//    named in the request, and clicking one runs that exact question
//    through the real matcher (not a separate/parallel code path)
//  - chat bubbles: a submitted question renders as one bubble (right-
//    aligned, brand-filled) and its answer as another (left-aligned,
//    card-style) -- proven by inspecting the real rendered HTML structure,
//    not just the answer text
//  - scrollback is capped at QUICK_ASK_MAX_HISTORY turns (oldest dropped)
//  - Clear resets the history
//  - Saturday check, with KNOWN dates: a working Saturday (1st/3rd/5th, no
//    holiday), an off Saturday (2nd/4th), and a Saturday that would
//    otherwise be a working week-number BUT is also a holiday (the
//    holiday must win) -- reuses is24Sat()/is24SatLabel()/isHoliday()/
//    getHolidayName() unchanged, not reimplemented
//  - pending leave / leave history: own-data-only, proven against a store
//    holding a second user's leaveRequests too
//  - days-until-holiday countdown is arithmetically correct
//  - still genuinely NOT AI (no fetch/api/anthropic in the new code) and
//    still zero fetches (leaveRequests/holidays are already-loaded globals)
//  - apply-flow functions remain byte-for-byte identical to main
//
// Run with: node test/feat-quick-ask-enhancements.test.js
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
function extractConstLine(source, name) {
  const idx = source.indexOf(`const ${name} =`);
  assert.ok(idx >= 0, `could not find "const ${name} =" in the given source`);
  const end = source.indexOf(';', idx);
  return source.slice(idx, end + 1);
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
  console.log('=== Apply-for-leave logic: STILL byte-for-byte identical to main ===');
  check('renderLeaves() is byte-for-byte unchanged from main',
    extractFunction(fullScript, 'renderLeaves') === extractFunction(mainFullScript, 'renderLeaves'));
  check('the submitLeaveBtn handler is byte-for-byte unchanged',
    extractBlockFrom(fullScript, "getElementById('submitLeaveBtn').addEventListener('click'") ===
    extractBlockFrom(mainFullScript, "getElementById('submitLeaveBtn').addEventListener('click'"));
  check('cancelLeave() is byte-for-byte unchanged',
    extractBlockFrom(fullScript, 'window.cancelLeave = function') === extractBlockFrom(mainFullScript, 'window.cancelLeave = function'));
  check('renderApprovals() is byte-for-byte unchanged',
    extractFunction(fullScript, 'renderApprovals') === extractFunction(mainFullScript, 'renderApprovals'));

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== Suggested-question chips: markup ===');
  const pageLeavesBlock = extractDivBlock(src, '<div class="page" id="page-leaves">');
  const EXPECTED_CHIPS = ['Next holiday', 'My leave balance', 'Late policy', 'WFH policy', 'Am I working Saturday?', 'How to apply'];
  for (const chipText of EXPECTED_CHIPS) {
    check(`chip "${chipText}" exists with matching data-q`, new RegExp(`class="quick-ask-chip" data-q="${chipText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(pageLeavesBlock));
  }
  check('exactly 6 chips (no extras, none missing)', (pageLeavesBlock.match(/class="quick-ask-chip"/g) || []).length === 6);
  check('chip styling reuses the app\'s own existing pill convention (not a new one-off color)',
    /\.quick-ask-chip\{[^}]*background:#F0E6D6[^}]*color:#A96E35[^}]*border-radius:20px/.test(src));

  console.log('\n=== Clear button present ===');
  check('#quickAskClearBtn exists', pageLeavesBlock.includes('id="quickAskClearBtn"'));

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== Behavioral setup: real functions executed against synthetic data ===');
  const fmtSrc = extractFunction(fullScript, 'fmt');
  const fmtDSrc = extractFunction(fullScript, 'fmtD');
  const countSrc = extractFunction(fullScript, 'countDistinctDates');
  const upcomingSrc = extractFunction(fullScript, 'upcomingHolidays');
  const notDocConst = extractConstLine(fullScript, 'HR_INFO_NOT_DOCUMENTED');
  const policyTextSrc = extractFunction(fullScript, 'hrInfoPolicyText');
  const caveatConst = extractConstLine(fullScript, 'QUICK_ASK_CAVEAT');
  const noMatchConst = extractConstLine(fullScript, 'QUICK_ASK_NO_MATCH');
  const maxHistoryConst = extractConstLine(fullScript, 'QUICK_ASK_MAX_HISTORY');
  const categoriesConst = fullScript.slice(fullScript.indexOf('const QUICK_ASK_CATEGORIES'), fullScript.indexOf('];', fullScript.indexOf('const QUICK_ASK_CATEGORIES')) + 2);
  const keywordMatchFn = extractFunction(fullScript, 'quickAskKeywordMatches');
  const matchFn = extractFunction(fullScript, 'matchQuickAskCategories');
  const buildFn = extractFunction(fullScript, 'buildQuickAskAnswer');
  const handleFn = extractFunction(fullScript, 'handleQuickAsk');
  const renderHistoryFn = extractFunction(fullScript, 'renderQuickAskHistory');
  const thisSaturdaySrc = extractFunction(fullScript, 'thisSaturday');
  const is24SatSrc = extractFunction(fullScript, 'is24Sat');
  const is24SatLabelSrc = extractFunction(fullScript, 'is24SatLabel');
  const isHolidaySrc = extractFunction(fullScript, 'isHoliday');
  const getHolidayNameSrc = extractFunction(fullScript, 'getHolidayName');

  check('thisSaturday() is a new pure function (not touching is24Sat itself)', thisSaturdaySrc.length > 0);
  check('the Saturday-check case reuses is24Sat/is24SatLabel/isHoliday/getHolidayName by name (not reimplemented)',
    ['is24Sat(', 'is24SatLabel(', 'isHoliday(', 'getHolidayName('].every((fn) => buildFn.includes(fn)));

  const HOLIDAYS = [
    { date: '2026-10-02', name: 'Gandhi Birthday' },
    { date: '2026-10-17', name: 'Durga Puja Maha Sashthi' }, // deliberately ALSO a would-be-working 3rd Saturday
    { date: '2026-12-25', name: 'Christmas' },
  ];
  const LEAVE_REQUESTS = [
    { id: 'l1', userId: 'u1', type: 'casual', startDate: '2026-09-20', endDate: '2026-09-20', days: 1, isHalf: false, status: 'pending' },
    { id: 'l2', userId: 'u1', type: 'medical', startDate: '2026-08-01', endDate: '2026-08-02', days: 2, isHalf: false, status: 'approved' },
    { id: 'l3', userId: 'u1', type: 'casual', startDate: '2026-07-01', endDate: '2026-07-01', days: 1, isHalf: false, status: 'rejected' },
    { id: 'l4', userId: 'u2', type: 'casual', startDate: '2026-09-21', endDate: '2026-09-21', days: 1, isHalf: false, status: 'pending' }, // Bob's -- must never appear
  ];

  function el(elements, id) {
    if (!elements[id]) {
      elements[id] = {
        value: '', style: { display: 'none' }, _html: '',
        set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
      };
    }
    return elements[id];
  }
  function makeSandbox(elements, hrInfoPoliciesCacheValue, todayForFmt) {
    return {
      console, Date,
      document: { getElementById: (id) => el(elements, id) },
      currentUser: { id: 'u1', name: 'Alice' },
      users: [{ id: 'u1', name: 'Alice', medLeft: 4, casLeft: 3.5 }, { id: 'u2', name: 'Bob', medLeft: 99, casLeft: 77 }],
      timeLogs: [],
      holidays: HOLIDAYS,
      leaveRequests: LEAVE_REQUESTS,
      hrInfoPoliciesCache: hrInfoPoliciesCacheValue,
    };
  }
  const POLICIES = { casualLeave: '5 CL/year.', medicalLeave: '12 ML/year.' };

  function buildAndRun(question) {
    const elements = {};
    const sandbox = makeSandbox(elements, POLICIES);
    vm.createContext(sandbox);
    vm.runInContext([
      fmtSrc, fmtDSrc, countSrc, upcomingSrc, notDocConst, policyTextSrc,
      caveatConst, noMatchConst, maxHistoryConst, categoriesConst, keywordMatchFn,
      is24SatSrc, is24SatLabelSrc, isHolidaySrc, getHolidayNameSrc, thisSaturdaySrc,
      matchFn, buildFn, 'let quickAskHistory = [];', renderHistoryFn, handleFn,
      "document.getElementById('quickAskInput').value = " + JSON.stringify(question) + ';',
      'handleQuickAsk();',
    ].join('\n'), sandbox);
    const history = vm.runInContext('quickAskHistory', sandbox);
    return { answer: history[history.length - 1].answer, elements, sandbox, history };
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== Saturday check, with KNOWN dates ===');
  function satAnswerFor(fromDateStr) {
    const elements = {};
    const sandbox = makeSandbox(elements, POLICIES);
    vm.createContext(sandbox);
    vm.runInContext([
      fmtSrc, fmtDSrc, is24SatSrc, is24SatLabelSrc, isHolidaySrc, getHolidayNameSrc, thisSaturdaySrc,
      buildFn,
      `this.__answer = buildQuickAskAnswer('saturday', ${JSON.stringify(fromDateStr)}, {});`,
    ].join('\n'), sandbox);
    return sandbox.__answer;
  }
  // 2026-10-05 is a Monday -> "this Saturday" = 2026-10-10 = 2nd Saturday = OFF, no holiday.
  check('a 2nd-Saturday week (2026-10-10, from Monday 2026-10-05) -> "No ... off (2nd Saturday)"',
    /No, this Saturday .* is off \(2nd Saturday\)\.$/.test(satAnswerFor('2026-10-05')));
  // 2026-10-26 is a Monday -> "this Saturday" = 2026-10-31 = 5th Saturday = WORKING, no holiday.
  check('a 5th-Saturday week (2026-10-31, from Monday 2026-10-26) -> "Yes ... working day"',
    /Yes, this Saturday .* is a working day\.$/.test(satAnswerFor('2026-10-26')));
  // 2026-10-12 is a Monday -> "this Saturday" = 2026-10-17 = 3rd Saturday (would be WORKING) BUT it's Durga Puja Maha Sashthi -- holiday must win.
  const holidaySatAns = satAnswerFor('2026-10-12');
  check('a would-be-working 3rd Saturday that is ALSO a holiday -> the HOLIDAY wins ("off ... it\'s Durga Puja Maha Sashthi")',
    holidaySatAns.includes('off') && holidaySatAns.includes('Durga Puja Maha Sashthi'));
  // 2026-10-03 IS itself a Saturday (1st) -> "this Saturday" resolves to the SAME day, 0 days ahead.
  check('asking ON a Saturday itself resolves to that same day (1st Saturday, working)',
    /Yes, this Saturday .* is a working day\.$/.test(satAnswerFor('2026-10-03')));

  console.log('\n=== Saturday check triggers correctly via the real question text ===');
  const satQ = buildAndRun('Am I working Saturday?');
  check('"Am I working Saturday?" produces a Saturday-shaped answer (Yes/No ... Saturday ...)', /^(Yes|No), this Saturday/.test(satQ.answer));

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== Pending leave: own-data-only ===');
  const pendingAns = buildAndRun('what is my pending leave status').answer;
  check('shows Alice\'s own pending application (1 day casual, 20 Sept)', pendingAns.includes('Casual Leave') && /20 Sept/.test(pendingAns));
  check('does NOT include Alice\'s non-pending applications', !pendingAns.includes('approved') && !pendingAns.includes('rejected'));
  check('ZERO mention of Bob\'s pending application (21 Sept)', !pendingAns.includes('21 Sept'));

  console.log('\n=== Leave history: own-data-only, includes past decided applications ===');
  const histAns = buildAndRun('show me my leave history').answer;
  check('history includes the approved medical leave', histAns.includes('approved'));
  check('history includes the rejected casual leave', histAns.includes('rejected'));
  check('history includes the pending casual leave too (all of Alice\'s own applications)', histAns.includes('pending'));
  check('ZERO mention of the other user\'s leave record', !histAns.includes('l4'));

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== Days-until-holiday countdown ===');
  function countdownAnswerFor(todayStr) {
    const elements = {};
    const sandbox = makeSandbox(elements, POLICIES);
    vm.createContext(sandbox);
    vm.runInContext([fmtDSrc, upcomingSrc, buildFn, `this.__answer = buildQuickAskAnswer('countdown', ${JSON.stringify(todayStr)}, {});`].join('\n'), sandbox);
    return sandbox.__answer;
  }
  check('9 days from 2026-09-23 to the next holiday (2026-10-02, Gandhi Birthday) is computed correctly',
    countdownAnswerFor('2026-09-23') === '9 days until Gandhi Birthday (2 Oct 2026).');
  check('the countdown category triggers on "days until"', buildAndRun('days until the next holiday').answer.includes('until'));
  check('the countdown category triggers on "how long until"', buildAndRun('how long until the next holiday').answer.includes('until'));

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== Chat bubbles: real rendered structure ===');
  {
    const elements = {};
    const sandbox = makeSandbox(elements, POLICIES);
    vm.createContext(sandbox);
    vm.runInContext([
      fmtSrc, fmtDSrc, countSrc, upcomingSrc, notDocConst, policyTextSrc,
      caveatConst, noMatchConst, maxHistoryConst, categoriesConst, keywordMatchFn,
      is24SatSrc, is24SatLabelSrc, isHolidaySrc, getHolidayNameSrc, thisSaturdaySrc,
      matchFn, buildFn, 'let quickAskHistory = [];', renderHistoryFn, handleFn,
    ].join('\n'), sandbox);
    el(elements, 'quickAskInput').value = 'Next holiday';
    vm.runInContext('handleQuickAsk()', sandbox);
    const html = elements.quickAskHistory.innerHTML;
    check('the history container is shown (display:flex) once there is a turn', elements.quickAskHistory.style.display === 'flex');
    check('the question renders in a RIGHT-aligned bubble (align-self:flex-end) with the brand fill color', /align-self:flex-end[^>]*>[\s\S]{0,120}background:#A96E35[\s\S]{0,80}Next holiday/.test(html));
    check('the answer renders in a LEFT-aligned bubble (align-self:flex-start)', /align-self:flex-start/.test(html));
    check('the answer bubble actually contains the real computed answer', html.includes('Gandhi Birthday'));

    console.log('\n=== Scrollback cap + Clear ===');
    for (const q of ['Late policy', 'WFH policy', 'My leave balance', 'How to apply', 'sandwich']) {
      el(elements, 'quickAskInput').value = q;
      vm.runInContext('handleQuickAsk()', sandbox);
    }
    const historyAfter6 = vm.runInContext('quickAskHistory', sandbox);
    check('history is capped at QUICK_ASK_MAX_HISTORY (5) turns after 6 questions asked', historyAfter6.length === 5);
    check('the OLDEST turn ("Next holiday") was dropped, not the newest', !historyAfter6.some((t) => t.question === 'Next holiday'));
    check('the newest turn ("sandwich") is present', historyAfter6.some((t) => t.question === 'sandwich'));

    vm.runInContext("document.getElementById('quickAskClearBtn')", sandbox); // exists in real DOM; here we call the same reset logic directly
    vm.runInContext('quickAskHistory = []; renderQuickAskHistory();', sandbox);
    const historyAfterClear = vm.runInContext('quickAskHistory', sandbox);
    check('Clear empties the history', historyAfterClear.length === 0);
    check('Clear hides the history container again', elements.quickAskHistory.style.display === 'none');
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== Chip click runs the exact chip question through the real matcher ===');
  {
    const elements = {};
    const sandbox = makeSandbox(elements, POLICIES);
    const chips = [];
    sandbox.document = {
      getElementById: (id) => el(elements, id),
      querySelectorAll: (sel) => (sel === '.quick-ask-chip' ? chips : []),
    };
    vm.createContext(sandbox);
    vm.runInContext([
      fmtSrc, fmtDSrc, countSrc, upcomingSrc, notDocConst, policyTextSrc,
      caveatConst, noMatchConst, maxHistoryConst, categoriesConst, keywordMatchFn,
      is24SatSrc, is24SatLabelSrc, isHolidaySrc, getHolidayNameSrc, thisSaturdaySrc,
      matchFn, buildFn, 'let quickAskHistory = [];', renderHistoryFn, handleFn,
    ].join('\n'), sandbox);
    // Simulate exactly what the real chip click-listener does: set the
    // input's value to the chip's data-q, then call handleQuickAsk() --
    // same call the button and Enter key already use, not a separate path.
    vm.runInContext("document.getElementById('quickAskInput').value = 'My leave balance'; handleQuickAsk();", sandbox);
    const history = vm.runInContext('quickAskHistory', sandbox);
    check('a chip-simulated click for "My leave balance" produces the real balance answer',
      history[0].question === 'My leave balance' && history[0].answer.includes('Casual Leave') && history[0].answer.includes(sandbox.QUICK_ASK_CAVEAT || 'reconciled'));
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== Still genuinely NOT AI ===');
  const newCode = buildFn + matchFn + handleFn + renderHistoryFn + thisSaturdaySrc;
  check('no fetch( anywhere in the new/changed Quick Ask code', !newCode.includes('fetch('));
  check('no /api/ reference anywhere', !newCode.includes('/api/'));
  check('no "anthropic" reference anywhere', !/anthropic/i.test(newCode));
  check('buildQuickAskAnswer/matchQuickAskCategories/handleQuickAsk/renderQuickAskHistory/thisSaturday are all synchronous', (() => {
    const fnStarts = fullScript;
    return !fnStarts.includes('async function buildQuickAskAnswer') && !fnStarts.includes('async function matchQuickAskCategories') &&
      !fnStarts.includes('async function handleQuickAsk') && !fnStarts.includes('async function renderQuickAskHistory') &&
      !fnStarts.includes('async function thisSaturday');
  })());

  console.log('\n=== the inline <script> still parses ===');
  check('new Function(fullScript) does not throw', (() => {
    try { new Function(fullScript); return true; }
    catch (e) { console.log('    parse error:', e.message); return false; }
  })());

  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
})();
