// Fixture for Quick Ask (2026-09-12) -- a NON-AI, pure client-side
// keyword-matching HR box at the top of the Leave & HR tab. No API, no
// network call, no cost: matches keywords against data already loaded on
// the tab (hrInfoPoliciesCache set by renderHrInfo(), plus the same
// holidays/timeLogs/users globals the rest of the tab already uses).
//
// Central claims under test:
//  - each documented keyword maps to the right category/answer
//  - CL/ML/balance answers include the reconciliation caveat verbatim
//  - the no-match fallback fires on gibberish and names what IS answerable
//  - multiple matched categories are ALL answered, not just the first
//  - word-boundary matching: "holidays" alone must NOT also trigger the
//    attendance answer via the substring "days" hiding inside it
//  - dynamic holiday-name matching (an actual holiday's name in the
//    question triggers the holiday category even without the word
//    "holiday" itself)
//  - own-data scoping: balance/attendance answers reflect ONLY the
//    current user, proven against a store holding a second user
//  - genuinely NOT AI: no fetch(/api/(/anthropic anywhere in the Quick
//    Ask functions, and handleQuickAsk() is synchronous (not async) --
//    proof there's no new network round-trip at all
//  - renderLeaves()/the apply flow/approval handlers remain byte-for-byte
//    unchanged from main; renderHrInfo() gained exactly the one cache line
//  - the Quick Ask box markup sits at the TOP of page-leaves, before the
//    balance-grid
//
// Run with: node test/feat-quick-ask-keyword-hr.test.js
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
  let isAsync = startIdx >= 0;
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
  return { src: source.slice(startIdx, i + 1), isAsync };
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
    extractFunction(fullScript, 'renderLeaves').src === extractFunction(mainFullScript, 'renderLeaves').src);
  check('the submitLeaveBtn handler is byte-for-byte unchanged',
    extractBlockFrom(fullScript, "getElementById('submitLeaveBtn').addEventListener('click'") ===
    extractBlockFrom(mainFullScript, "getElementById('submitLeaveBtn').addEventListener('click'"));
  check('the applyLeaveBtn handler is byte-for-byte unchanged',
    extractBlockFrom(fullScript, "getElementById('applyLeaveBtn').addEventListener('click'") ===
    extractBlockFrom(mainFullScript, "getElementById('applyLeaveBtn').addEventListener('click'"));
  check('cancelLeave() is byte-for-byte unchanged',
    extractBlockFrom(fullScript, 'window.cancelLeave = function') === extractBlockFrom(mainFullScript, 'window.cancelLeave = function'));
  check('renderApprovals() is byte-for-byte unchanged',
    extractFunction(fullScript, 'renderApprovals').src === extractFunction(mainFullScript, 'renderApprovals').src);
  check('the #leaveModal markup is byte-for-byte unchanged',
    extractDivBlock(src, '<div class="modal-backdrop" id="leaveModal">') ===
    extractDivBlock(mainSrc, '<div class="modal-backdrop" id="leaveModal">'));

  console.log('\n=== renderHrInfo() changed by exactly the one intended cache line ===');
  const hrInfoNow = extractFunction(fullScript, 'renderHrInfo').src;
  const hrInfoMain = extractFunction(mainFullScript, 'renderHrInfo').src;
  check('renderHrInfo() now sets hrInfoPoliciesCache', hrInfoNow.includes('hrInfoPoliciesCache = policies;'));
  check('removing just that one line makes it identical to main\'s renderHrInfo()',
    hrInfoNow.replace('\n  hrInfoPoliciesCache = policies; // 2026-09-12: Quick Ask reuses this -- no new fetch of its own.', '') === hrInfoMain);

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== Quick Ask box markup sits at the TOP of page-leaves, before the balance-grid ===');
  const pageLeavesBlock = extractDivBlock(src, '<div class="page" id="page-leaves">');
  check('#quickAskInput exists inside page-leaves', pageLeavesBlock.includes('id="quickAskInput"'));
  check('#quickAskBtn exists inside page-leaves', pageLeavesBlock.includes('id="quickAskBtn"'));
  check('#quickAskAnswer exists inside page-leaves', pageLeavesBlock.includes('id="quickAskAnswer"'));
  check('Quick Ask markup appears BEFORE the balance-grid (it is at the top)',
    pageLeavesBlock.indexOf('id="quickAskInput"') < pageLeavesBlock.indexOf('id="leaveBalance"'));

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== Genuinely NOT AI: no fetch/api/anthropic anywhere in the Quick Ask code, fully synchronous ===');
  const matchFn = extractFunction(fullScript, 'matchQuickAskCategories');
  const buildFn = extractFunction(fullScript, 'buildQuickAskAnswer');
  const handleFn = extractFunction(fullScript, 'handleQuickAsk');
  const quickAskAllCode = matchFn.src + buildFn.src + handleFn.src;
  check('no fetch( anywhere in Quick Ask code', !quickAskAllCode.includes('fetch('));
  check('no /api/ reference anywhere in Quick Ask code', !quickAskAllCode.includes('/api/'));
  check('no "anthropic" reference anywhere in Quick Ask code', !/anthropic/i.test(quickAskAllCode));
  check('handleQuickAsk() is NOT async (fully synchronous -- no new network round-trip)', !handleFn.isAsync);
  check('matchQuickAskCategories() is NOT async', !matchFn.isAsync);
  check('buildQuickAskAnswer() is NOT async', !buildFn.isAsync);

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== Behavioral: real functions executed against synthetic data ===');
  const fmtSrc = extractFunction(fullScript, 'fmt').src;
  const fmtDSrc = extractFunction(fullScript, 'fmtD').src;
  const countSrc = extractFunction(fullScript, 'countDistinctDates').src;
  const upcomingSrc = extractFunction(fullScript, 'upcomingHolidays').src;
  const notDocConst = extractConstLine(fullScript, 'HR_INFO_NOT_DOCUMENTED');
  const policyTextSrc = extractFunction(fullScript, 'hrInfoPolicyText').src;
  const caveatConst = extractConstLine(fullScript, 'QUICK_ASK_CAVEAT');
  const noMatchConst = extractConstLine(fullScript, 'QUICK_ASK_NO_MATCH');
  const categoriesConst = fullScript.slice(fullScript.indexOf('const QUICK_ASK_CATEGORIES'), fullScript.indexOf('];', fullScript.indexOf('const QUICK_ASK_CATEGORIES')) + 2);
  const keywordMatchFn = extractFunction(fullScript, 'quickAskKeywordMatches').src;

  function el(elements, id) {
    if (!elements[id]) elements[id] = { value: '', style: { display: 'none' }, _text: '', set textContent(v) { this._text = v; }, get textContent() { return this._text; } };
    return elements[id];
  }

  function makeSandbox(elements, hrInfoPoliciesCacheValue) {
    return {
      console,
      document: { getElementById: (id) => el(elements, id) },
      currentUser: { id: 'u1', name: 'Alice' },
      users: [
        { id: 'u1', name: 'Alice', medLeft: 4, casLeft: 3.5 },
        { id: 'u2', name: 'Bob (someone else entirely)', medLeft: 99, casLeft: 77 },
      ],
      timeLogs: [
        { userId: 'u1', date: '2026-09-01', durationMins: 480 },
        { userId: 'u1', date: '2026-09-03', durationMins: 200 },
        { userId: 'u1', date: '2026-09-07', durationMins: 0 },
        { userId: 'u2', date: '2026-09-05', durationMins: 600 },
      ],
      holidays: [
        { date: '2026-01-01', name: "New Year's Day" },
        { date: '2026-10-02', name: 'Gandhi Birthday' },
        { date: '2026-10-17', name: 'Durga Puja Maha Sashthi' },
        { date: '2026-12-25', name: 'Christmas' },
      ],
      hrInfoPoliciesCache: hrInfoPoliciesCacheValue,
    };
  }

  const POLICIES = {
    casualLeave: '5 CL/year, accrued 1.25/quarter.',
    medicalLeave: '12 ML/year.',
    sandwichRule: 'Forward-only through Sundays and 2nd/4th Saturdays.',
    latePolicy: 'Reporting after 11:00 AM is considered late...',
    halfDay: '2:30 PM is the half-day benchmark.',
    wfh: '1 WFH day/month per eligible employee.',
    officeTiming: 'No rigid start/end time.',
    // leaveApplicationProcess deliberately OMITTED -- must fall back
  };

  function buildAndRun(question, hrInfoPoliciesCacheValue) {
    const elements = {};
    const sandbox = makeSandbox(elements, hrInfoPoliciesCacheValue);
    vm.createContext(sandbox);
    vm.runInContext([
      fmtSrc, fmtDSrc, countSrc, upcomingSrc, notDocConst, policyTextSrc,
      caveatConst, noMatchConst, categoriesConst, keywordMatchFn,
      matchFn.src, buildFn.src, handleFn.src,
    ].join('\n'), sandbox);
    el(elements, 'quickAskInput').value = question;
    vm.runInContext('handleQuickAsk()', sandbox);
    return { answer: elements.quickAskAnswer._text, shown: elements.quickAskAnswer.style.display, sandbox };
  }

  const KEYWORD_CASES = [
    { q: 'What is the next holiday?', expectIncludes: ['Gandhi Birthday'] },
    { q: 'How many CL do I have', expectIncludes: ['5 CL/year', '3.5 CL left', QUICK_CAVEAT() ] },
    { q: 'sick leave rules', expectIncludes: ['12 ML/year.', '4 ML left', QUICK_CAVEAT()] },
    { q: 'leave left', expectIncludes: ['3.5 Casual Leave', '4 Medical Leave', QUICK_CAVEAT()] },
    { q: 'late coming policy', expectIncludes: ['Reporting after 11:00 AM'] },
    { q: 'half-day rule', expectIncludes: ['2:30 PM'] },
    { q: 'can I work from home', expectIncludes: ['1 WFH day/month'] },
    { q: 'sandwich rule?', expectIncludes: ['Forward-only'] },
    { q: 'how to apply for leave', expectIncludes: ['Not documented yet'] },
    { q: 'how many days present', expectIncludes: ["You've been present"] },
    { q: 'office timing please', expectIncludes: ['No rigid start/end time'] },
  ];
  function QUICK_CAVEAT() { return 'being reconciled'; }

  for (const c of KEYWORD_CASES) {
    const { answer } = buildAndRun(c.q, POLICIES);
    const ok = c.expectIncludes.every((frag) => answer.includes(frag));
    check(`"${c.q}" -> answer includes ${JSON.stringify(c.expectIncludes)}`, ok);
    if (!ok) console.log('    got:', answer);
  }

  console.log('\n=== Caveat present verbatim on balance-related answers ===');
  const balAns = buildAndRun('what is my leave balance', POLICIES).answer;
  check('balance answer includes the caveat verbatim', balAns.includes('Leave balances are currently being reconciled \u2014 please confirm with HR before relying on this number.'));

  console.log('\n=== No-match fallback (gibberish) ===');
  const gib = buildAndRun('asdkjfh qwoeiru zzxcv', POLICIES);
  check('gibberish triggers the no-match fallback, not a crash or blank', gib.answer.includes('I can answer about leave balance, holidays'));
  check('the fallback names something answerable (not a dead end)', /leave balance|holidays|late\/WFH/.test(gib.answer));

  console.log('\n=== Multiple keywords -> multiple answers ===');
  const multi = buildAndRun('casual leave and wfh policy please', POLICIES).answer;
  check('a question mentioning two topics gets BOTH answers', multi.includes('5 CL/year') && multi.includes('1 WFH day/month'));

  console.log('\n=== Word-boundary correctness: "holidays" alone must NOT trigger attendance via "days" ===');
  const holOnly = buildAndRun('what are the upcoming holidays', POLICIES).answer;
  check('a pure holiday question does NOT also return an attendance answer', !holOnly.includes("You've been present"));
  check('but a genuine attendance question DOES', buildAndRun('how many days have I been present', POLICIES).answer.includes("You've been present"));

  console.log('\n=== Dynamic holiday-name matching ===');
  const nameMatch = buildAndRun('tell me about Durga Puja Maha Sashthi', POLICIES);
  check('a question containing an actual holiday NAME triggers the holiday answer even without the word "holiday"',
    nameMatch.answer.includes('Gandhi Birthday')); // still reports the NEXT holiday, proving the holiday category fired

  console.log('\n=== Own-data scoping: proven against a store holding a SECOND user ===');
  const scoped = buildAndRun('what is my balance', POLICIES).answer;
  check('balance answer states Alice\'s own numbers (3.5 Casual, 4 Medical)',
    scoped.includes('3.5 Casual Leave') && scoped.includes('4 Medical Leave'));
  check('ZERO mention of the other user\'s numbers (99/77) in the balance answer', !scoped.includes('99') && !scoped.includes('77'));
  check('ZERO mention of the other user\'s name anywhere', !scoped.includes('Bob'));
  const attScoped = buildAndRun('attendance this month', POLICIES).answer;
  check('attendance answer counts only Alice\'s own logs (2 distinct productive days, not Bob\'s)', attScoped.includes('2 days'));

  console.log('\n=== Still-loading guard (cache not yet populated) ===');
  const loading = buildAndRun('what is my balance', null);
  check('if hrInfoPoliciesCache is not yet set, shows a friendly "still loading" message, not a crash', loading.answer.includes('Still loading'));

  console.log('\n=== Enter-key and click wiring present ===');
  check('quickAskBtn click listener wired to handleQuickAsk', /getElementById\('quickAskBtn'\)\?\.addEventListener\('click', handleQuickAsk\)/.test(fullScript));
  check('quickAskInput Enter-key wired to handleQuickAsk', /getElementById\('quickAskInput'\)\?\.addEventListener\('keydown'[\s\S]{0,120}handleQuickAsk\(\)/.test(fullScript));

  console.log('\n=== the inline <script> still parses ===');
  check('new Function(fullScript) does not throw', (() => {
    try { new Function(fullScript); return true; }
    catch (e) { console.log('    parse error:', e.message); return false; }
  })());

  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
})();
