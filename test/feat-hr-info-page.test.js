// Fixture for renderHrInfo() and its helpers -- originally the standalone
// HR Info page (2026-09-12 AI-chatbot pivot), now folded into the merged
// "Leave & HR" tab (2026-09-12, see test/fix-merge-leave-hrinfo-tabs.test.js
// for the tab-structure/no-dangling-references/apply-flow-untouched claims).
// This file covers what's still true regardless of which tab hosts these
// sections: renderHrInfo()'s own internal correctness.
//
// Central claims under test:
//  - own-data scoping: rendered against a store holding a SECOND user's
//    timeLogs, the page shows ONLY the current user's own days-present
//    count -- zero mention of the other user's name/numbers/salary
//    anywhere across the sections renderHrInfo() still owns (My
//    Attendance, Leave Policy, Holidays, Office Timing, How to Apply --
//    NOT balance, which renderHrInfo() no longer renders at all post-merge)
//  - countDistinctDates()/upcomingHolidays() are pure and correct
//    (zero-duration logs excluded, holiday-on-today included, past
//    holidays excluded, correct sort/highlight of the next one)
//  - policy text falls back to "contact HR" for missing/empty fields,
//    including leaveApplicationProcess (not yet a real hrPolicies field)
//  - renderHrInfo() no longer touches any balance element at all (the
//    merge fixture proves #hrInfoBalance is gone file-wide; this proves
//    the function itself doesn't try to write to it)
//  - the leave-balance reconciliation caveat is present UNCONDITIONALLY
//    somewhere in the page (static markup, not something JS could omit)
//  - fetchHrPolicies() reads companyData/hrPolicies with source:'server'
//
// Run with: node test/feat-hr-info-page.test.js
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
function extractConstLine(source, name) {
  const idx = source.indexOf(`const ${name} =`);
  assert.ok(idx >= 0, `could not find "const ${name} =" in index.html`);
  const end = source.indexOf(';', idx);
  return source.slice(idx, end + 1);
}

(async () => {
  // ─────────────────────────────────────────────────────────────
  console.log('=== Pure functions: countDistinctDates() (unchanged from the chatbot build) ===');
  const countSrc = extractFunction(fullScript, 'countDistinctDates');
  const upcomingSrc = extractFunction(fullScript, 'upcomingHolidays');
  const notDocConst = extractConstLine(fullScript, 'HR_INFO_NOT_DOCUMENTED');
  const policyTextSrc = extractFunction(fullScript, 'hrInfoPolicyText');
  const policyBlockSrc = extractFunction(fullScript, 'hrInfoPolicyBlock');
  const fetchPoliciesSrc = extractFunction(fullScript, 'fetchHrPolicies');
  const renderSrc = extractFunction(fullScript, 'renderHrInfo');
  const fmtSrc = extractFunction(fullScript, 'fmt');
  const fmtDSrc = extractFunction(fullScript, 'fmtD');

  const pureSandbox = { console, Date, Set, Math };
  vm.createContext(pureSandbox);
  vm.runInContext(countSrc + '\n' + upcomingSrc + '\n' + notDocConst + '\n' + policyTextSrc, pureSandbox);

  check('counts distinct dates with productive time', vm.runInContext(
    `countDistinctDates([{date:'2026-09-01',durationMins:480},{date:'2026-09-01',durationMins:30},{date:'2026-09-05',durationMins:200}])`, pureSandbox) === 2);
  check('a zero-duration log does NOT count as present', vm.runInContext(`countDistinctDates([{date:'2026-09-03',durationMins:0}])`, pureSandbox) === 0);
  check('empty/undefined input -> 0, not a crash', vm.runInContext(`countDistinctDates([]) === 0 && countDistinctDates(undefined) === 0`, pureSandbox));

  console.log('\n=== Pure functions: upcomingHolidays() ===');
  vm.runInContext(`var hols = [{date:'2026-01-01',name:'A'},{date:'2026-12-25',name:'B'},{date:'2026-06-01',name:'C'}];`, pureSandbox);
  check('returns only holidays on/after today, sorted ascending regardless of input order',
    JSON.stringify(vm.runInContext(`upcomingHolidays(hols, '2026-02-01')`, pureSandbox)) === JSON.stringify([{ date: '2026-06-01', name: 'C' }, { date: '2026-12-25', name: 'B' }]));
  check('a holiday ON today is included (>=, not >)',
    vm.runInContext(`upcomingHolidays(hols, '2026-01-01').length`, pureSandbox) === 3);
  check('no upcoming holidays -> empty array, not a crash', vm.runInContext(`upcomingHolidays(hols, '2027-01-01').length`, pureSandbox) === 0);
  check('empty holidays array -> empty array', vm.runInContext(`upcomingHolidays([], '2026-01-01').length`, pureSandbox) === 0);

  console.log('\n=== hrInfoPolicyText(): "contact HR" fallback ===');
  check('a populated field passes through unchanged', vm.runInContext(`hrInfoPolicyText({casualLeave:'5 CL/year'}, 'casualLeave')`, pureSandbox) === '5 CL/year');
  check('an empty-string field falls back to HR_INFO_NOT_DOCUMENTED', vm.runInContext(`hrInfoPolicyText({latePolicy:''}, 'latePolicy') === HR_INFO_NOT_DOCUMENTED`, pureSandbox));
  check('a field entirely absent falls back to HR_INFO_NOT_DOCUMENTED', vm.runInContext(`hrInfoPolicyText({}, 'leaveApplicationProcess') === HR_INFO_NOT_DOCUMENTED`, pureSandbox));
  check('the fallback message tells the user to contact HR', vm.runInContext(`HR_INFO_NOT_DOCUMENTED`, pureSandbox).toLowerCase().includes('contact hr'));

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== renderHrInfo(): own-data scoping, proven against a store holding a SECOND user ===');
  const elements = {};
  function el(id) {
    if (!elements[id]) elements[id] = { _html: '', set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; } };
    return elements[id];
  }
  let capturedPoliciesCall = null;
  const dbSandbox = {
    collection(name) {
      return {
        doc(id) {
          return {
            async get(opts) {
              capturedPoliciesCall = { collection: name, doc: id, opts };
              return {
                exists: true,
                data: () => ({
                  casualLeave: '5 CL/year, accrued 1.25/quarter.',
                  medicalLeave: '12 ML/year.',
                  sandwichRule: 'Forward-only, through Sundays and 2nd/4th Saturdays.',
                  extraLeave: 'Tiered pro-rata after entitlement exhausted.',
                  officeTiming: 'No rigid start/end time.',
                  latePolicy: '', // deliberately empty -- must fall back
                  halfDay: '2:30 PM benchmark.',
                  wfh: '1 day/month, advance approval required.',
                  // leaveApplicationProcess deliberately OMITTED entirely
                }),
              };
            },
          };
        },
      };
    },
  };

  const sandbox = {
    console,
    document: { getElementById: el },
    db: dbSandbox,
    currentUser: { id: 'u1', name: 'Alice' },
    users: [
      { id: 'u1', name: 'Alice', medLeft: 4, casLeft: 3.5 },
      { id: 'u2', name: 'Bob (someone else entirely)', medLeft: 99, casLeft: 77, salary: 999999 },
    ],
    timeLogs: [
      { userId: 'u1', date: `${new Date().toISOString().slice(0, 7)}-01`, durationMins: 480 },
      { userId: 'u1', date: `${new Date().toISOString().slice(0, 7)}-01`, durationMins: 30 },  // same day, second session -- still counts once
      { userId: 'u1', date: `${new Date().toISOString().slice(0, 7)}-03`, durationMins: 200 }, // a SECOND distinct productive day
      { userId: 'u1', date: `${new Date().toISOString().slice(0, 7)}-07`, durationMins: 0 },   // zero duration -- must NOT count
      { userId: 'u2', date: `${new Date().toISOString().slice(0, 7)}-05`, durationMins: 600 }, // Bob's log -- must never appear
    ],
    holidays: [
      { date: '2020-01-01', name: 'Long past, must be excluded' },
      { date: '2085-01-01', name: 'Far future' },
      { date: '2085-03-01', name: 'Later future' },
    ],
  };
  vm.createContext(sandbox);
  vm.runInContext(fmtSrc + '\n' + fmtDSrc + '\n' + countSrc + '\n' + upcomingSrc + '\n' + notDocConst + '\n' + policyTextSrc + '\n' + policyBlockSrc + '\n' + fetchPoliciesSrc + '\n' + renderSrc, sandbox);
  await vm.runInContext('renderHrInfo()', sandbox);

  const attendanceHtml = elements.hrInfoAttendance.innerHTML;
  const allSectionsHtml = ['hrInfoAttendance', 'hrInfoLeavePolicy', 'hrInfoHolidays', 'hrInfoTimingPolicy', 'hrInfoHowToApply']
    .map((id) => elements[id] ? elements[id].innerHTML : '').join('\n');

  check('attendance shows 2 distinct present days (Alice\'s own logs only, zero-duration excluded)', attendanceHtml.includes('>2<'));
  check('ZERO mention of the other user\'s name anywhere across renderHrInfo()\'s sections', !allSectionsHtml.includes('Bob'));
  check('ZERO mention of the other user\'s balances (99/77) anywhere', !allSectionsHtml.includes('99') && !allSectionsHtml.includes('77'));
  check('ZERO mention of the other user\'s salary field', !allSectionsHtml.includes('999999'));
  check('renderHrInfo() never even attempts to create/touch a #hrInfoBalance element (post-merge: no separate balance section)', elements.hrInfoBalance === undefined);

  check('leave policy section shows the real casualLeave/medicalLeave/sandwichRule/extraLeave text', elements.hrInfoLeavePolicy.innerHTML.includes('5 CL/year') && elements.hrInfoLeavePolicy.innerHTML.includes('Forward-only'));
  check('timing policy section shows officeTiming/halfDay/wfh text', elements.hrInfoTimingPolicy.innerHTML.includes('No rigid start/end time') && elements.hrInfoTimingPolicy.innerHTML.includes('2:30 PM'));
  check('an empty policy field (latePolicy) falls back to the contact-HR message, not blank', elements.hrInfoTimingPolicy.innerHTML.includes('contact HR'));
  check('a genuinely absent field (leaveApplicationProcess) also falls back to contact-HR', elements.hrInfoHowToApply.innerHTML.toLowerCase().includes('contact hr'));

  check('holidays: past holiday (2020) is excluded', !elements.hrInfoHolidays.innerHTML.includes('Long past'));
  check('holidays: nearest future holiday is highlighted as "next up"', /Far future.*next up/.test(elements.hrInfoHolidays.innerHTML.replace(/\n/g, ' ')));
  check('holidays: the later future holiday is listed but NOT marked next up', elements.hrInfoHolidays.innerHTML.includes('Later future') && !/Later future.*next up/.test(elements.hrInfoHolidays.innerHTML.replace(/\n/g, ' ')));

  check('fetchHrPolicies() reads companyData/hrPolicies with source:\'server\'',
    capturedPoliciesCall && capturedPoliciesCall.collection === 'companyData' && capturedPoliciesCall.doc === 'hrPolicies' && capturedPoliciesCall.opts && capturedPoliciesCall.opts.source === 'server');

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== The leave-balance caveat is present UNCONDITIONALLY (static markup) ===');
  check('the reconciliation caveat text is in the page markup itself, not something JS could omit',
    /being reconciled.*confirm with HR/i.test(src));

  // Nav-tab visibility, page-container id, and routing are now the merged
  // "Leave & HR" tab's concern (data-page="leaves", not "hrinfo") --
  // covered in full by test/fix-merge-leave-hrinfo-tabs.test.js, not
  // re-tested here to avoid asserting on markup this file no longer owns.

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== The AI-chatbot approach is genuinely gone ===');
  check('no reference to /api/ask-square anywhere in the file', !src.includes('/api/ask-square'));
  check('submitAskSquareQuestion no longer exists as a live identifier', !fullScript.includes('function submitAskSquareQuestion'));
  check('renderAskSquare (the old chatbot page hook) no longer exists', !fullScript.includes('function renderAskSquare'));
  check('no leftover askSquareInput/askSquareBtn/askSquareAnswer/askSquareStatus element ids', !src.includes('askSquareInput') && !src.includes('askSquareBtn') && !src.includes('askSquareAnswer') && !src.includes('askSquareStatus'));

  console.log('\n=== the inline <script> still parses ===');
  check('new Function(fullScript) does not throw', (() => {
    try { new Function(fullScript); return true; }
    catch (e) { console.log('    parse error:', e.message); return false; }
  })());

  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
})();
