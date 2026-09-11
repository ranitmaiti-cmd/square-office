// Ask Square: OMS's first LLM integration. A read-only HR chatbot that
// answers routine questions ("how much leave do I have?", "when's the next
// holiday?", "how do I apply for leave?") from OMS's OWN structured data --
// never from the model's general knowledge, never about anyone but the
// asking person.
//
// SAFE ARCHITECTURE (scoped 2026-09-11, FINDINGS-2026-08-10.md):
//
// 1. Server-side only. ANTHROPIC_API_KEY lives in process.env (a Vercel
//    project env var), read only here, never sent to or readable by the
//    browser. Same secret-handling discipline as CRON_SECRET in
//    finalize-stale.js/biometric-sync.js -- the difference is this endpoint
//    is user-triggered, not cron-triggered, so there is no shared bearer
//    secret to gate it (every staff member needs to call it for their own
//    data); the protection here is #2 and the rate limit below, not a token.
//
// 2. Own-data HARD FILTER, enforced in code, not by asking the model
//    nicely. buildFactsForUser() below is the ONLY place this file reads
//    Firestore, and every read is parameterized by the caller's own userId
//    or has no identity dimension at all (holidays/policies are public).
//    There is no free-text-driven query anywhere, and the model is never
//    given a tool to fetch more data -- it only ever sees the small facts
//    object this function returns. A question about another named person
//    cannot be answered with real data about them, because that data was
//    never fetched in the first place. See test/feat-ask-square.test.js
//    for the fixture proving this with a mock holding multiple users.
//
// 3. Grounded. Every NUMBER in `facts` comes from a pure, independently
//    unit-tested function (countDistinctDates, earliestHolidayOnOrAfter) --
//    never from the model. Policy text is passed through as-is from
//    companyData/hrPolicies, one field per topic; a field that is empty or
//    missing is replaced with an explicit "(not documented...)" marker
//    BEFORE the model ever sees it, so "I don't know, ask HR" is a
//    code-driven signal the model is instructed to act on, not something
//    left to the model's own judgement about what it does or doesn't know.
//    The leave-balance caveat (leave bank is mid-correction, see FINDINGS)
//    is a mandatory, verbatim-checked instruction -- see LEAVE_BALANCE_CAVEAT.
//
// 4. Rate limited. One Firestore doc per user per day
//    (askSquareUsage/{userId}_{date}), incremented via a transaction BEFORE
//    the Anthropic call. Over cap -> 429, Anthropic is never called. This
//    is the one write this endpoint makes -- a dedicated usage-counter
//    collection, never leave/time/user data.
'use strict';

const { initializeApp, getApps, getApp } = require('firebase/app');
const {
  getFirestore, collection, query, where, getDocs, doc, getDoc, runTransaction,
} = require('firebase/firestore');
const Anthropic = require('@anthropic-ai/sdk');

const firebaseConfig = {
  apiKey: 'AIzaSyBi_OD42znfsYZerQ_c6RWfLIPD_GropBE',
  authDomain: 'square-office-management.firebaseapp.com',
  projectId: 'square-office-management',
  storageBucket: 'square-office-management.firebasestorage.app',
  messagingSenderId: '99247930577',
  appId: '1:99247930577:web:4f5137e9476349582319f0',
};

function getDb() {
  const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  return getFirestore(app);
}

// ═══════════════════════════════════════════════════════════════
// PURE FUNCTIONS -- every number the model sees comes from one of these.
// Each is independently unit-tested in test/feat-ask-square.test.js with
// no network/Firestore/Anthropic involved.
// ═══════════════════════════════════════════════════════════════

function todayIsoDateIST() {
  // Matches api/biometric-sync.js's todayIsoDateIST() exactly -- do not diverge.
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function countDistinctDates(timeLogs) {
  const dates = new Set();
  for (const log of timeLogs || []) {
    if (log.date && (log.durationMins || 0) > 0) dates.add(log.date);
  }
  return dates.size;
}

function earliestHolidayOnOrAfter(holidays, todayStr) {
  const upcoming = (holidays || [])
    .filter((h) => h && h.date >= todayStr)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return upcoming.length ? { date: upcoming[0].date, name: upcoming[0].name } : null;
}

// The 13 fields actually populated in companyData/hrPolicies
// (see FINDINGS-2026-08-10.md, "HR policy externalised to Firestore"),
// plus leaveApplicationProcess -- NOT currently a field in that doc (the
// owner never dictated this content), included here so the code picks it
// up automatically once it's added; until then it always falls back to
// NOT_DOCUMENTED, which is the correct, honest behaviour, not a bug.
const POLICY_FIELDS = [
  'casualLeave', 'medicalLeave', 'attendancePolicy', 'sandwichRule',
  'officeTiming', 'halfDay', 'latePolicy', 'wfh', 'newJoiners',
  'extraLeave', 'additionalHours', 'financialYear', 'leaveApplicationProcess',
];
const NOT_DOCUMENTED = '(not documented -- say you do not have this information and to ask HR/the founder)';

function buildPolicyFacts(hrPolicies) {
  const out = {};
  for (const field of POLICY_FIELDS) {
    const val = hrPolicies && hrPolicies[field];
    out[field] = (typeof val === 'string' && val.trim()) ? val : NOT_DOCUMENTED;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
// OWN-DATA HARD FILTER -- the only Firestore reads in this file.
// ═══════════════════════════════════════════════════════════════

async function buildFactsForUser(db, userId) {
  const todayStr = todayIsoDateIST();

  // Own user doc ONLY -- userId comes from the request, never from question text.
  const userSnap = await getDoc(doc(db, 'users', userId));
  if (!userSnap.exists()) {
    const err = new Error('user not found');
    err.code = 'user_not_found';
    throw err;
  }
  const user = userSnap.data();

  // Own timeLogs ONLY, this-month-so-far -- same userId, same source.
  const firstOfMonth = `${todayStr.slice(0, 7)}-01`;
  const logsSnap = await getDocs(query(
    collection(db, 'timeLogs'),
    where('userId', '==', userId),
    where('date', '>=', firstOfMonth),
  ));
  const timeLogs = [];
  logsSnap.forEach((d) => timeLogs.push(d.data()));

  // Public, no identity dimension.
  const companySnap = await getDoc(doc(db, 'companyData', 'squareDB'));
  const holidays = (companySnap.exists() ? companySnap.data().holidays : null) || [];

  // Public, no identity dimension.
  const policiesSnap = await getDoc(doc(db, 'companyData', 'hrPolicies'));
  const hrPolicies = policiesSnap.exists() ? policiesSnap.data() : {};

  return {
    today: todayStr,
    name: user.name || 'there',
    leaveBalance: {
      medLeft: typeof user.medLeft === 'number' ? user.medLeft : null,
      casLeft: typeof user.casLeft === 'number' ? user.casLeft : null,
    },
    daysPresentThisMonth: countDistinctDates(timeLogs),
    nextHoliday: earliestHolidayOnOrAfter(holidays, todayStr),
    policies: buildPolicyFacts(hrPolicies),
  };
}

// ═══════════════════════════════════════════════════════════════
// RATE LIMIT -- one doc per user per day, transaction-incremented BEFORE
// the Anthropic call. This is the one write this endpoint makes.
// ═══════════════════════════════════════════════════════════════

const RATE_LIMIT_COLLECTION = 'askSquareUsage';
const DEFAULT_DAILY_CAP = 20;

function getDailyCap() {
  const envVal = parseInt(process.env.ASK_SQUARE_DAILY_CAP, 10);
  return Number.isFinite(envVal) && envVal > 0 ? envVal : DEFAULT_DAILY_CAP;
}

async function checkAndIncrementRateLimit(db, userId, todayStr) {
  const cap = getDailyCap();
  const ref = doc(db, RATE_LIMIT_COLLECTION, `${userId}_${todayStr}`);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists() ? (snap.data().count || 0) : 0;
    if (current >= cap) {
      return { allowed: false, count: current, cap };
    }
    tx.set(ref, {
      userId, date: todayStr, count: current + 1, updatedAt: new Date().toISOString(),
    }, { merge: true });
    return { allowed: true, count: current + 1, cap };
  });
}

// ═══════════════════════════════════════════════════════════════
// GROUNDING -- the model phrases; it never computes.
// ═══════════════════════════════════════════════════════════════

// Checked verbatim by both the fixture and the adversarial smoke test --
// do not reword without updating both.
const LEAVE_BALANCE_CAVEAT = 'leave balances are being reconciled — please confirm with HR before relying on this';

function buildSystemPrompt() {
  return [
    'You are "Ask Square", a read-only HR assistant built into the SQUARE Office Management System.',
    'You answer ONLY using the FACTS block in the user message. You are given one specific person\'s own data and the company\'s public policy text -- nothing else exists for you to know.',
    '',
    'Hard rules, in order of importance:',
    '1. NEVER invent, estimate, or guess a number. Every number in your answer must come directly from the FACTS block, unchanged.',
    '2. If the FACTS block does not contain what is needed to answer -- a policy field reads "(not documented...)", or the question is about something not present in FACTS at all -- say plainly that you do not have that information and the person should ask HR or the founder. One short sentence is enough; do not guess, do not apologize at length.',
    '3. You know about exactly ONE person: the one described in FACTS. You have no information about any other employee, ever, under any name or role. If asked about anyone else, say you can only answer about the asking person\'s own data.',
    `4. Whenever your answer states a leaveBalance number (casual or medical leave remaining), you MUST include this exact phrase somewhere in the answer, unedited: "${LEAVE_BALANCE_CAVEAT}"`,
    '5. Never discuss salary, compensation, or anything not present in FACTS.',
    '6. Keep answers short: 1 to 4 sentences. No preamble like "Based on the information provided".',
  ].join('\n');
}

function buildUserMessage(facts, question) {
  return [
    'FACTS (about the asking person only, plus public company info -- this is ALL you know):',
    JSON.stringify(facts, null, 2),
    '',
    `Question: ${question}`,
  ].join('\n');
}

async function askAnthropic(anthropic, model, facts, question) {
  const response = await anthropic.messages.create({
    model,
    max_tokens: 500,
    system: buildSystemPrompt(),
    messages: [{ role: 'user', content: buildUserMessage(facts, question) }],
  });
  const textBlock = (response.content || []).find((b) => b.type === 'text');
  return textBlock ? textBlock.text : '';
}

// ═══════════════════════════════════════════════════════════════
// HANDLER
// ═══════════════════════════════════════════════════════════════

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // No existing endpoint in this repo reads a JSON body (finalize-stale.js/
  // biometric-sync.js are query-param-only) -- Vercel's Node runtime
  // auto-parses application/json into req.body, but this is new territory
  // for this repo, so fall back to a manual parse if it ever arrives as a
  // raw string instead.
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};
  const { question, userId } = body;
  if (typeof question !== 'string' || !question.trim() || typeof userId !== 'string' || !userId.trim()) {
    return res.status(400).json({ error: 'invalid_request', message: 'question and userId are required' });
  }
  if (question.length > 500) {
    return res.status(400).json({ error: 'question_too_long', message: 'Please keep questions under 500 characters.' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[ask-square] ANTHROPIC_API_KEY is not set');
    return res.status(500).json({ error: 'misconfigured' });
  }

  const db = getDb();
  const todayStr = todayIsoDateIST();

  let rl;
  try {
    rl = await checkAndIncrementRateLimit(db, userId, todayStr);
  } catch (e) {
    console.error('[ask-square] rate limit check failed:', e);
    return res.status(500).json({ error: 'rate_limit_check_failed' });
  }
  if (!rl.allowed) {
    return res.status(429).json({
      error: 'rate_limited',
      message: `You've reached today's limit of ${rl.cap} questions. Try again tomorrow, or ask HR directly.`,
    });
  }

  let facts;
  try {
    facts = await buildFactsForUser(db, userId);
  } catch (e) {
    if (e.code === 'user_not_found') {
      return res.status(404).json({ error: 'user_not_found' });
    }
    console.error('[ask-square] failed to build facts:', e);
    return res.status(500).json({ error: 'facts_failed' });
  }

  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const model = process.env.ASK_SQUARE_MODEL || 'claude-haiku-4-5';
    const answer = await askAnthropic(anthropic, model, facts, question.trim());
    return res.status(200).json({ answer });
  } catch (e) {
    console.error('[ask-square] Anthropic call failed:', e);
    return res.status(502).json({
      error: 'answer_failed',
      message: 'Could not get an answer right now — try again or ask HR directly.',
    });
  }
};

// Exported for fixtures -- same pattern as api/biometric-sync.js.
module.exports.todayIsoDateIST = todayIsoDateIST;
module.exports.countDistinctDates = countDistinctDates;
module.exports.earliestHolidayOnOrAfter = earliestHolidayOnOrAfter;
module.exports.buildPolicyFacts = buildPolicyFacts;
module.exports.buildFactsForUser = buildFactsForUser;
module.exports.checkAndIncrementRateLimit = checkAndIncrementRateLimit;
module.exports.getDailyCap = getDailyCap;
module.exports.buildSystemPrompt = buildSystemPrompt;
module.exports.buildUserMessage = buildUserMessage;
module.exports.askAnthropic = askAnthropic;
module.exports.LEAVE_BALANCE_CAVEAT = LEAVE_BALANCE_CAVEAT;
module.exports.POLICY_FIELDS = POLICY_FIELDS;
module.exports.NOT_DOCUMENTED = NOT_DOCUMENTED;
module.exports.RATE_LIMIT_COLLECTION = RATE_LIMIT_COLLECTION;
