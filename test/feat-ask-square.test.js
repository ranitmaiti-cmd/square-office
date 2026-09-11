// Fixture for Ask Square (api/ask-square.js), OMS's first LLM integration.
//
// Unlike every other fixture in this repo, api/ask-square.js is a REAL
// standalone Node/CommonJS module (not embedded in index.html's <script>),
// so it is require()'d directly -- no brace-matching/vm extraction needed.
// To keep this fully offline (no network, no Firestore, no Anthropic
// billing), the 'firebase/app', 'firebase/firestore', and '@anthropic-ai/sdk'
// modules are swapped for tiny in-memory fakes in Node's own require.cache
// BEFORE api/ask-square.js is first required -- since ask-square.js does its
// own require() of those same modules, it picks up the fakes (Node's module
// cache guarantees a single shared object per resolved path). This is the
// standalone-Node-module equivalent of the extractFunction()+vm-sandbox
// pattern the index.html fixtures use.
//
// Central claims under test:
//  - buildFactsForUser() is a HARD FILTER: given a store with MULTIPLE
//    users' data, requesting one userId returns facts containing ONLY that
//    user's own numbers -- proven against a store that also holds a
//    different, more "interesting" user, not just an empty store
//  - the full handler, asked a cross-person question as user A, sends
//    Anthropic a payload with ZERO mention of user B's id/name/numbers --
//    because it was never fetched, not because the prompt says not to
//  - countDistinctDates() / earliestHolidayOnOrAfter() are pure and correct,
//    including edge cases (no logs this month, empty holidays list)
//  - buildPolicyFacts() replaces empty/missing fields with NOT_DOCUMENTED,
//    including leaveApplicationProcess (not yet a real field in
//    companyData/hrPolicies -- must read as not-documented today)
//  - the system prompt mandates the leave-balance caveat verbatim
//  - checkAndIncrementRateLimit() enforces the cap and the full handler
//    returns 429 WITHOUT ever calling Anthropic once over cap
//  - zero write-path beyond the one intended rate-limit counter (source-text)
//
// Run with: node test/feat-ask-square.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let passCount = 0, failCount = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); passCount++; }
  else { console.log(`  FAIL: ${label}`); failCount++; }
}

// ─────────────────────────────────────────────────────────────
// Fake Firestore (modular API surface): doc/collection/query/where/
// getDoc/getDocs/runTransaction/getFirestore, backed by a plain object.
// ─────────────────────────────────────────────────────────────
function makeStore(initial) {
  return JSON.parse(JSON.stringify(initial)); // { collectionName: { docId: data } }
}

function fakeFirestoreModule(store, callLog) {
  function doc(_db, collectionName, id) { return { __collection: collectionName, __id: id }; }
  function collection(_db, collectionName) { return { __collection: collectionName }; }
  function where(field, op, value) { return { field, op, value }; }
  function query(collRef, ...wheres) { return { __collection: collRef.__collection, __wheres: wheres }; }
  function matches(data, wheres) {
    return (wheres || []).every((w) => {
      const v = data[w.field];
      if (w.op === '==') return v === w.value;
      if (w.op === '>=') return v >= w.value;
      if (w.op === '<=') return v <= w.value;
      return false;
    });
  }
  async function getDoc(ref) {
    callLog.push({ type: 'getDoc', collection: ref.__collection, id: ref.__id });
    const coll = store[ref.__collection] || {};
    const data = coll[ref.__id];
    return { exists: () => data !== undefined, data: () => (data ? { ...data } : undefined), id: ref.__id };
  }
  async function getDocs(q) {
    callLog.push({ type: 'getDocs', collection: q.__collection, wheres: q.__wheres });
    const coll = store[q.__collection] || {};
    const docs = Object.entries(coll)
      .filter(([, data]) => matches(data, q.__wheres))
      .map(([id, data]) => ({ id, data: () => ({ ...data }) }));
    return { forEach: (fn) => docs.forEach(fn), docs };
  }
  async function runTransaction(_db, updateFn) {
    const tx = {
      get: (ref) => getDoc(ref),
      set: (ref, data, opts) => {
        const coll = (store[ref.__collection] = store[ref.__collection] || {});
        const existing = (opts && opts.merge) ? (coll[ref.__id] || {}) : {};
        coll[ref.__id] = { ...existing, ...data };
      },
    };
    return updateFn(tx);
  }
  function getFirestore() { return { __fake: true }; }
  return { doc, collection, query, where, getDoc, getDocs, runTransaction, getFirestore };
}

// FakeAnthropic: records every call, returns a scripted response.
class FakeAnthropic {
  constructor(opts) { this.opts = opts; FakeAnthropic.constructedWith.push(opts); }
  get messages() {
    return {
      create: async (params) => {
        FakeAnthropic.calls.push(params);
        return { content: [{ type: 'text', text: FakeAnthropic.scriptedReply }] };
      },
    };
  }
}
FakeAnthropic.calls = [];
FakeAnthropic.constructedWith = [];
FakeAnthropic.scriptedReply = 'stub answer';

// ─────────────────────────────────────────────────────────────
// Wire the fakes into require.cache BEFORE first requiring ask-square.js.
// ─────────────────────────────────────────────────────────────
const STORE = makeStore({
  users: {
    u1: { name: 'Alice', medLeft: 4, casLeft: 3.5 },
    u2: { name: 'Bob (someone else entirely)', medLeft: 99, casLeft: 77, salary: 999999, secretNote: 'DO NOT LEAK' },
  },
  timeLogs: {
    l1: { userId: 'u1', date: '2026-09-01', durationMins: 480 },
    l2: { userId: 'u1', date: '2026-09-01', durationMins: 30 }, // same date, second session -- still one distinct day
    l3: { userId: 'u1', date: '2026-09-03', durationMins: 0 },  // zero-duration -- must NOT count as present
    l4: { userId: 'u1', date: '2026-09-05', durationMins: 200 },
    l5: { userId: 'u2', date: '2026-09-05', durationMins: 600 }, // Bob's log -- must never appear in Alice's facts
  },
  companyData: {
    squareDB: { holidays: [
      { date: '2026-08-15', name: 'Independence Day' },
      { date: '2026-10-02', name: 'Gandhi Birthday' },
      { date: '2026-12-25', name: 'Christmas' },
    ] },
    hrPolicies: {
      casualLeave: '5 CL/year, accrued 1.25/quarter, unused carries forward.',
      medicalLeave: '12 ML/year.',
      latePolicy: '', // deliberately empty -- must become NOT_DOCUMENTED
      // sandwichRule, officeTiming, etc. deliberately OMITTED entirely
    },
  },
  askSquareUsage: {},
});
const CALL_LOG = [];

// firebase/app and firebase/firestore export via read-only ESM-interop
// getters (Object.assign onto them throws), so -- same technique as
// @anthropic-ai/sdk below -- replace the whole require.cache entry rather
// than mutate individual properties.
const firestorePath = require.resolve('firebase/firestore');
require.cache[firestorePath] = { id: firestorePath, filename: firestorePath, loaded: true, exports: fakeFirestoreModule(STORE, CALL_LOG) };
const appPath = require.resolve('firebase/app');
require.cache[appPath] = { id: appPath, filename: appPath, loaded: true, exports: { getApps: () => [], getApp: () => ({}), initializeApp: () => ({}) } };

const anthropicPath = require.resolve('@anthropic-ai/sdk');
require.cache[anthropicPath] = { id: anthropicPath, filename: anthropicPath, loaded: true, exports: FakeAnthropic };

// The handler explicitly refuses to run without ANTHROPIC_API_KEY set (see
// api/ask-square.js's own guard) -- a fake value is enough for this fixture
// since the real Anthropic client is replaced by FakeAnthropic above and
// never makes a network call.
process.env.ANTHROPIC_API_KEY = 'test-fixture-key-not-real';

const ASK_SQUARE_PATH = path.join('D:/SQUARE/ADMIN/SQUARE-Office/finalphase/01072026', 'api', 'ask-square.js');
const askSquare = require(ASK_SQUARE_PATH);

// Fixed "today" for deterministic date-window fixtures: force IST today by
// overriding the pure function's dependency indirectly isn't possible (it's
// pure and reads Date.now() internally) -- instead, drive facts assertions
// off askSquare.todayIsoDateIST() itself so the fixture works on any day
// it's actually run, matching the discipline of testing against real code,
// not a frozen assumption of "today".
const TODAY = askSquare.todayIsoDateIST();

(async () => {
  // ─────────────────────────────────────────────────────────────
  console.log('=== Pure functions: countDistinctDates() ===');
  check('counts distinct dates with productive time, ignores a second same-day session',
    askSquare.countDistinctDates([
      { date: '2026-09-01', durationMins: 480 },
      { date: '2026-09-01', durationMins: 30 },
      { date: '2026-09-05', durationMins: 200 },
    ]) === 2);
  check('a zero-duration log does NOT count as present', askSquare.countDistinctDates([{ date: '2026-09-03', durationMins: 0 }]) === 0);
  check('empty/undefined input -> 0, not a crash', askSquare.countDistinctDates([]) === 0 && askSquare.countDistinctDates(undefined) === 0);

  console.log('\n=== Pure functions: earliestHolidayOnOrAfter() ===');
  const hols = [{ date: '2026-01-01', name: 'A' }, { date: '2026-12-25', name: 'B' }, { date: '2026-06-01', name: 'C' }];
  check('finds the earliest holiday ON OR AFTER the given date, sorted correctly regardless of input order',
    JSON.stringify(askSquare.earliestHolidayOnOrAfter(hols, '2026-02-01')) === JSON.stringify({ date: '2026-06-01', name: 'C' }));
  check('a holiday ON today counts (>=, not >)',
    JSON.stringify(askSquare.earliestHolidayOnOrAfter(hols, '2026-01-01')) === JSON.stringify({ date: '2026-01-01', name: 'A' }));
  check('no upcoming holiday -> null, not a crash', askSquare.earliestHolidayOnOrAfter(hols, '2027-01-01') === null);
  check('empty holidays array -> null', askSquare.earliestHolidayOnOrAfter([], '2026-01-01') === null);

  console.log('\n=== Pure functions: buildPolicyFacts() -- NOT_DOCUMENTED fallback ===');
  const pf = askSquare.buildPolicyFacts({ casualLeave: '5 CL/year', latePolicy: '' });
  check('a populated field is passed through unchanged', pf.casualLeave === '5 CL/year');
  check('an empty-string field becomes NOT_DOCUMENTED', pf.latePolicy === askSquare.NOT_DOCUMENTED);
  check('a field entirely absent from the doc becomes NOT_DOCUMENTED', pf.sandwichRule === askSquare.NOT_DOCUMENTED);
  check('leaveApplicationProcess (not yet a real hrPolicies field) reads as NOT_DOCUMENTED today',
    pf.leaveApplicationProcess === askSquare.NOT_DOCUMENTED);
  check('every field in POLICY_FIELDS is present in the output', askSquare.POLICY_FIELDS.every((f) => f in pf));

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== buildFactsForUser(): HARD FILTER, proven against a store holding ANOTHER user ===');
  CALL_LOG.length = 0;
  const facts = await askSquare.buildFactsForUser({}, 'u1');
  check('facts.name is the REQUESTED user (Alice), not the other one', facts.name === 'Alice');
  check('facts.leaveBalance is Alice\'s own numbers (4 / 3.5)', facts.leaveBalance.medLeft === 4 && facts.leaveBalance.casLeft === 3.5);
  check('facts.daysPresentThisMonth counts only Alice\'s logs (2 distinct productive days, not Bob\'s)', facts.daysPresentThisMonth === 2);
  const factsJSON = JSON.stringify(facts);
  check('facts contains ZERO mention of the other user\'s name', !factsJSON.includes('Bob'));
  check('facts contains ZERO mention of the other user\'s balances (99 / 77)', !factsJSON.includes('99') && !factsJSON.includes('77'));
  check('facts contains ZERO mention of the other user\'s salary field', !factsJSON.includes('999999') && !factsJSON.toLowerCase().includes('secretnote'));
  check('every getDoc/getDocs call in building these facts used userId "u1", never any other id',
    CALL_LOG.filter((c) => c.wheres).every((c) => c.wheres.every((w) => w.field !== 'userId' || w.value === 'u1')));
  check('the getDoc(users/...) call fetched exactly u1, not u2', CALL_LOG.some((c) => c.type === 'getDoc' && c.collection === 'users' && c.id === 'u1')
    && !CALL_LOG.some((c) => c.type === 'getDoc' && c.collection === 'users' && c.id === 'u2'));

  console.log('\n=== buildFactsForUser(): unknown user ===');
  let threw = null;
  try { await askSquare.buildFactsForUser({}, 'does-not-exist'); } catch (e) { threw = e; }
  check('throws a user_not_found error for an unknown userId', threw && threw.code === 'user_not_found');

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== System prompt mandates the leave-balance caveat verbatim ===');
  const sys = askSquare.buildSystemPrompt();
  check('system prompt includes the exact LEAVE_BALANCE_CAVEAT string', sys.includes(askSquare.LEAVE_BALANCE_CAVEAT));
  check('system prompt instructs never inventing a number', /never invent/i.test(sys));
  check('system prompt instructs "ask HR" as the explicit default for missing info', /ask hr/i.test(sys));
  check('system prompt scopes the model to exactly ONE person', /exactly one person/i.test(sys));

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== Full handler: cross-person question sends Anthropic a payload with ZERO of the other user\'s data ===');
  FakeAnthropic.calls.length = 0;
  FakeAnthropic.scriptedReply = 'I can only answer about your own data.';
  {
    const req = { method: 'POST', body: { question: "What is Bob's casual leave balance?", userId: 'u1' } };
    const res = makeMockRes();
    await askSquare(req, res);
    check('handler returned 200', res.statusCode === 200);
    check('Anthropic was called exactly once', FakeAnthropic.calls.length === 1);
    const sentContent = FakeAnthropic.calls[0].messages[0].content;
    // The question text naturally contains "Bob" -- the person typed it, and
    // that's fine (it's their own question, not leaked data). What must be
    // absent is the FACTS block -- the part built from Firestore -- ever
    // containing Bob's real numbers, proving the hard filter, not a prompt
    // asking the model to politely ignore data it was actually given.
    const factsOnly = sentContent.slice(0, sentContent.indexOf('\n\nQuestion:'));
    check('the FACTS block (not the user\'s own question text) contains ZERO mention of "Bob"', !factsOnly.includes('Bob'));
    check('the FACTS block contains ZERO mention of the other user\'s numbers (99/77)', !factsOnly.includes('99') && !factsOnly.includes('77'));
    check('the raw question text is passed through as typed (proves the filter is about DATA fetched, not text scrubbing)',
      sentContent.includes("What is Bob's casual leave balance?"));
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== Rate limit: over cap -> 429, Anthropic NEVER called ===');
  {
    const capUserId = 'rate-limited-user';
    STORE.users[capUserId] = { name: 'CapTest', medLeft: 1, casLeft: 1 };
    const cap = askSquare.getDailyCap();
    // Pre-fill today's usage doc to exactly the cap.
    STORE.askSquareUsage[`${capUserId}_${TODAY}`] = { userId: capUserId, date: TODAY, count: cap };
    FakeAnthropic.calls.length = 0;
    const req = { method: 'POST', body: { question: 'How many CL do I have?', userId: capUserId } };
    const res = makeMockRes();
    await askSquare(req, res);
    check('handler returned 429 once over cap', res.statusCode === 429);
    check('Anthropic was NOT called when over cap', FakeAnthropic.calls.length === 0);
    check('429 body names the configured cap', res.body && res.body.message && res.body.message.includes(String(cap)));
  }
  console.log('\n=== Rate limit: under cap -> allowed, count increments ===');
  {
    const freshUserId = 'fresh-user';
    STORE.users[freshUserId] = { name: 'FreshTest', medLeft: 2, casLeft: 2 };
    FakeAnthropic.calls.length = 0;
    const req = { method: 'POST', body: { question: 'When is the next holiday?', userId: freshUserId } };
    const res = makeMockRes();
    await askSquare(req, res);
    check('handler returned 200 under cap', res.statusCode === 200);
    check('Anthropic WAS called under cap', FakeAnthropic.calls.length === 1);
    check('usage doc now shows count 1', STORE.askSquareUsage[`${freshUserId}_${TODAY}`].count === 1);
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== Input validation / method guard ===');
  {
    const res1 = makeMockRes();
    await askSquare({ method: 'GET', body: {} }, res1);
    check('non-POST method rejected with 405', res1.statusCode === 405);

    const res2 = makeMockRes();
    await askSquare({ method: 'POST', body: { userId: 'u1' } }, res2); // missing question
    check('missing question rejected with 400', res2.statusCode === 400);

    const res3 = makeMockRes();
    await askSquare({ method: 'POST', body: { question: 'hi' } }, res3); // missing userId
    check('missing userId rejected with 400', res3.statusCode === 400);

    const res4 = makeMockRes();
    await askSquare({ method: 'POST', body: { question: 'x'.repeat(501), userId: 'u1' } }, res4);
    check('an over-length question is rejected with 400', res4.statusCode === 400);
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n=== Zero write-path beyond the one intended rate-limit counter (source-text) ===');
  const src = fs.readFileSync(ASK_SQUARE_PATH, 'utf8');
  const writeCallsOutsideRateLimit = [];
  // Every real Firestore write call in the file must be tx.set(...) inside
  // checkAndIncrementRateLimit -- scan for any OTHER write-shaped call.
  const rateLimitFnSrc = src.slice(src.indexOf('async function checkAndIncrementRateLimit'), src.indexOf('// ═', src.indexOf('async function checkAndIncrementRateLimit') + 10));
  const restOfFile = src.replace(rateLimitFnSrc, '');
  for (const pattern of [/\bsetDoc\(/, /\bupdateDoc\(/, /\baddDoc\(/, /\bdeleteDoc\(/, /\.batch\(/, /tx\.set\(/, /tx\.update\(/, /tx\.delete\(/]) {
    if (pattern.test(restOfFile)) writeCallsOutsideRateLimit.push(pattern.toString());
  }
  check('no Firestore write call anywhere OUTSIDE checkAndIncrementRateLimit()', writeCallsOutsideRateLimit.length === 0);
  check('checkAndIncrementRateLimit() itself does write via tx.set (the one intended write)', /tx\.set\(/.test(rateLimitFnSrc));
  check('the rate-limit write targets the dedicated RATE_LIMIT_COLLECTION constant, not any OMS data collection',
    rateLimitFnSrc.includes('RATE_LIMIT_COLLECTION') && askSquare.RATE_LIMIT_COLLECTION === 'askSquareUsage');

  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
})();

function makeMockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}
