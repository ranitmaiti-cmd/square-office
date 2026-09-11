// Fixture for Ask Square's CLIENT side (index.html) -- the nav tab, page
// markup, and submitAskSquareQuestion()'s fetch/timeout/error-handling
// logic. The server-side endpoint (api/ask-square.js) has its own fixture:
// test/feat-ask-square.test.js.
//
// Central claims under test:
//  - the nav tab is visible to EVERYONE (no admin-only class, no
//    display:none) -- per the confirmed decision, own-data-only makes it
//    exactly as safe for staff as for admins
//  - the page posts to /api/ask-square with EXACTLY { question, userId:
//    currentUser.id } -- never a hardcoded or different id
//  - a ~20s AbortController timeout is wired (the "first wait for a
//    response" UX in OMS)
//  - the answer is rendered via .textContent, never .innerHTML -- the
//    response text is LLM output and must never be interpreted as markup
//  - every error path (429 rate-limited, 400 bad input, 5xx, timeout,
//    network failure) shows a friendly message and never leaks a raw
//    error object or exception message to the user
//  - the routing wiring (data-page -> renderAskSquare()) is present
//
// Run with: node test/feat-ask-square-client.test.js
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

(async () => {
  // ─────────────────────────────────────────────────────────────
  console.log('=== Nav tab: visible to EVERYONE, not admin-gated ===');
  const navLineMatch = src.match(/<div class="nav-item[^"]*" data-page="asksquare">[\s\S]{0,120}/);
  assert.ok(navLineMatch, 'could not find the Ask Square nav-item markup');
  const navLine = navLineMatch[0];
  check('nav item has NO "admin-only" class', !navLine.includes('admin-only'));
  check('nav item has NO inline display:none (unlike the admin-only Manage/Studio Health items)', !navLine.includes('display:none'));
  check('nav item label reads "Ask Square"', navLine.includes('Ask Square'));

  console.log('\n=== Page markup ===');
  check('page div #page-asksquare exists', src.includes('id="page-asksquare"'));
  check('input #askSquareInput exists', src.includes('id="askSquareInput"'));
  check('button #askSquareBtn exists', src.includes('id="askSquareBtn"'));
  check('status area #askSquareStatus exists', src.includes('id="askSquareStatus"'));
  check('answer area #askSquareAnswer exists', src.includes('id="askSquareAnswer"'));
  check('the page states its own scope to the user (own data + public info, read-only)',
    /can't see anyone else's records/.test(src) && /can't approve, change, or delete/.test(src));

  console.log('\n=== Routing ===');
  check("routing wires data-page='asksquare' to renderAskSquare()",
    /if\(page===['"]asksquare['"]\)\s*renderAskSquare\(\);/.test(fullScript));

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== submitAskSquareQuestion(): executed for real against a mocked fetch ===');
  const renderSrc = extractFunction(fullScript, 'renderAskSquare');
  const submitSrc = extractFunction(fullScript, 'submitAskSquareQuestion');

  function makeEl() {
    return { value: '', textContent: '', style: { display: 'none' }, disabled: false, focus() {} };
  }

  function runScenario({ fetchImpl, questionText = 'How much CL do I have?' }) {
    const elements = {
      askSquareInput: makeEl(),
      askSquareStatus: makeEl(),
      askSquareAnswer: makeEl(),
      askSquareBtn: makeEl(),
    };
    elements.askSquareInput.value = questionText;
    const sandbox = {
      console,
      document: { getElementById: (id) => elements[id] },
      currentUser: { id: 'u1', name: 'Alice' },
      fetch: fetchImpl,
      AbortController: global.AbortController,
      setTimeout, clearTimeout,
    };
    vm.createContext(sandbox);
    vm.runInContext(submitSrc, sandbox);
    return { run: () => vm.runInContext('submitAskSquareQuestion()', sandbox), elements, sandbox };
  }

  let capturedFetchArgs = null;
  {
    const { run, elements } = runScenario({
      fetchImpl: async (url, opts) => {
        capturedFetchArgs = { url, opts };
        return { ok: true, status: 200, json: async () => ({ answer: 'You have 6 medical leave days left. Note: leave balances are being reconciled.' }) };
      },
    });
    await run();
    check('POSTs to exactly /api/ask-square', capturedFetchArgs.url === '/api/ask-square');
    check('method is POST', capturedFetchArgs.opts.method === 'POST');
    check('Content-Type header is application/json', capturedFetchArgs.opts.headers['Content-Type'] === 'application/json');
    const sentBody = JSON.parse(capturedFetchArgs.opts.body);
    check('body has exactly { question, userId } -- no extra fields', Object.keys(sentBody).sort().join(',') === 'question,userId');
    check('userId sent is currentUser.id (u1), never a hardcoded or different value', sentBody.userId === 'u1');
    check('question sent matches what was typed', sentBody.question === 'How much CL do I have?');
    check('an AbortSignal was passed (timeout wiring present)', !!capturedFetchArgs.opts.signal);
    check('answer is rendered via .textContent (never .innerHTML -- LLM output must not be parsed as markup)',
      elements.askSquareAnswer.textContent.includes('6 medical leave days') && elements.askSquareAnswer.innerHTML === undefined);
    check('answer area is shown, status area is hidden on success',
      elements.askSquareAnswer.style.display === 'block' && elements.askSquareStatus.style.display === 'none');
    check('button re-enabled after completion', elements.askSquareBtn.disabled === false);
  }

  console.log('\n=== ~20s timeout is wired via AbortController ===');
  check('submitAskSquareQuestion() source sets a ~20000ms abort timeout', /setTimeout\(\(\)\s*=>\s*controller\.abort\(\),\s*20000\)/.test(submitSrc));

  console.log('\n=== Error paths never leak raw error detail ===');
  {
    const { run, elements } = runScenario({
      fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ error: 'rate_limited', message: "You've reached today's limit of 20 questions. Try again tomorrow, or ask HR directly." }) }),
    });
    await run();
    check('429 shows the server\'s friendly message', elements.askSquareStatus.textContent.includes('ask HR directly'));
    check('429 does not show the answer area', elements.askSquareAnswer.style.display !== 'block');
  }
  {
    const { run, elements } = runScenario({
      fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ error: 'misconfigured' }) }), // no message field at all
    });
    await run();
    check('a 500 with no message field still shows a friendly fallback, not "undefined" or a raw error object',
      elements.askSquareStatus.textContent.length > 0 && !elements.askSquareStatus.textContent.includes('undefined') && !elements.askSquareStatus.textContent.includes('[object'));
  }
  {
    const { run, elements } = runScenario({
      fetchImpl: async () => { const e = new Error('AbortError'); e.name = 'AbortError'; throw e; },
    });
    await run();
    check('an abort (timeout) shows a "taking longer than expected" message, not a raw exception', /taking longer than expected/.test(elements.askSquareStatus.textContent));
  }
  {
    const { run, elements } = runScenario({
      fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
    });
    await run();
    check('a network failure shows a friendly "could not reach" message, not the raw TypeError text',
      /could not reach/i.test(elements.askSquareStatus.textContent) && !elements.askSquareStatus.textContent.includes('TypeError'));
  }

  console.log('\n=== renderAskSquare() exists and is harmless (no fetch on open) ===');
  check('renderAskSquare() is defined', renderSrc.length > 0);
  check('renderAskSquare() does not itself call fetch (no data to load on open)', !renderSrc.includes('fetch('));

  console.log('\n=== the inline <script> still parses ===');
  check('new Function(fullScript) does not throw', (() => {
    try { new Function(fullScript); return true; }
    catch (e) { console.log('    parse error:', e.message); return false; }
  })());

  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
})();
