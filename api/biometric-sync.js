// V14.3.43: biometric IN/OUT sync -- auto-fills missing timelog tails from
// eTimeOffice biometric attendance data. Companion to api/finalize-stale.js:
// that closes dead sessions same-day; this fills the resulting gap up to
// the real biometric OUT time, so morning reconciliation from biometric
// stops being a manual, next-day chore.
//
// STATUS: writes are live behind the confirm=true query param (dry-run by
// default). Lunch handling is resolved -- see LUNCH_WINDOW_START below.
// V14.3.45: now wired to a daily cron (see vercel.json) -- DRY-RUN ONLY,
// confirm=true is deliberately NOT baked into the cron path yet.
//
// Firestore auth: same public client SDK config already embedded in
// index.html, matching api/finalize-stale.js exactly (verified by reading
// that file, not assumed) -- no Admin SDK/service account here. This app
// has no Firebase Auth, so rules are already permissive under that same
// key; the trust model is identical to what the client and the finalizer
// already operate under.
//
// eTimeOffice write path has NO shipped precedent to mirror: searched this
// repo (index.html, full git log, the local backup file) for "gapfill",
// "gap-fill", "deterministic ID", "CONFIRM_WRITE" -- none of it exists as
// committed code. The July reconciliation was an ephemeral admin console
// script, never merged. The ID scheme/field names below come directly from
// the brief (gapfill-{userId}-{date}-{HHMM}, merge:true, gapfill:true,
// gapfillSource, sessionStartMs) since those WERE fully specified there.
// The lunch rule (there was no existing code for it either) was resolved
// directly by the user and is now canonical -- see LUNCH_WINDOW_START.
const { initializeApp, getApps, getApp } = require('firebase/app');
const {
  getFirestore, collection, query, where, getDocs, doc, setDoc,
} = require('firebase/firestore');

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

// V14.3.43: Empcode -> userId allow-list. Any Empcode NOT in this map is
// skipped entirely -- deliberately a closed list, not "sync everyone eTime
// returns," so a new/unmapped biometric code can never silently write to
// the wrong (or no) Firestore user.
const EMPCODE_TO_USERID = {
  '0015': 'mmllpsq6rih', // Neha
  '0018': 'mmllonwbwgp', // Tasmin
  '0019': 'mmllj7ovszm', // Suravi
  '0020': 'mmllpgkndzw', // Rai
  '0021': 'mmllp3z2o68', // Sarbani
  '0022': 'mmblf4s45us', // Ridhi
  '0023': 'mmblekn4yim', // Angana
  '0025': 'mr21gc49q81zlv', // taskiya
  '011': 'mmllimboc39', // Souvik
  // 0024 indira, 0003 Rajkumar, 010 Gayaram, 001 rm -- NOT in map, skipped
};

// V14.3.43: dates already manually reconciled from biometric -- refuse to
// write into these no matter what the caller asks for. Matches the brief's
// "Do NOT backfill dates already manually reconciled" as an enforced rule,
// not just an operator-discipline note, consistent with how the rest of
// this codebase prefers a structural guard over a remembered convention
// (e.g. the sweep's own-session exclusion, deterministic IDs generally).
const RECONCILED_DATES = new Set([
  '2026-07-24', '2026-07-25', '2026-07-26', '2026-07-27',
  '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31',
]);

function ddmmyyyy(isoDate) {
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
}

// ═══════════════════════════════════════════════════════
// V14.3.45: default date for cron invocations (Vercel Cron hits the bare
// path, no query string -- a required `date` param with no fallback would
// 400 on EVERY scheduled run and silently do nothing, forever).
//
// !!! COUPLING WARNING !!! This default is "today in IST," which is only
// correct because vercel.json's cron for this endpoint is scheduled for
// 16:30 UTC == 22:00 IST -- i.e. LATE ENOUGH in the IST evening that
// "today" already IS the just-completed workday. If that schedule EVER
// moves to fire after midnight IST, "today" will have already rolled over
// to the NEXT calendar day and this default MUST change to "yesterday in
// IST" instead, or every automated run will silently sync the wrong
// (empty, not-yet-started) day. These two things -- this function and the
// cron schedule's time-of-day -- must be changed together. Never one
// without the other.
function todayIsoDateIST() {
  // en-CA formats as YYYY-MM-DD directly. Timezone-aware -- deliberately
  // NOT new Date().toISOString().slice(0,10), which gives UTC's current
  // date and would drift a day off right around the IST/UTC day boundary.
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function hhmmToEpoch(isoDate, hhmm) {
  // Pinned +05:30 explicitly -- this runs in a Vercel function (UTC), and
  // eTimeOffice times are IST with no timezone shift (per the brief's
  // confirmed API contract), so an unpinned parse would be a guaranteed
  // ~5.5h skew here, the same reasoning applied in finalize-stale.js.
  return new Date(`${isoDate}T${hhmm}:00+05:30`).getTime();
}

function toHHMM(epochMs) {
  // V14.3.44: explicit timeZone:'Asia/Kolkata' -- 'en-IN' is a LOCALE (digit
  // style, formatting conventions), it does NOT force which timezone's
  // wall-clock gets displayed. Without this, toLocaleTimeString falls back
  // to the RUNTIME's system timezone -- on Vercel that's UTC, so this was
  // silently producing a ~5.5h-wrong clock time on every real deploy.
  // Verified directly: forcing TZ=UTC locally reproduced the bug (same
  // epoch rendered as the wrong clock time without this option, correct
  // with it) -- this exact same unpinned pattern is what's already live and
  // corrupting endTime in api/finalize-stale.js; see that file's own fix.
  return new Date(epochMs).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
}

async function fetchInOutPunchData(isoDate) {
  const corp = process.env.ETIME_CORP;
  const user = process.env.ETIME_USER;
  const pass = process.env.ETIME_PASS;
  if (!corp || !user || !pass) {
    throw new Error('ETIME_CORP/ETIME_USER/ETIME_PASS env vars are not fully set');
  }
  // Confirmed live 2 Aug 2026: username-half is colon-packed, password-half
  // empty, trailing colon included.
  const authRaw = `${corp}:${user}:${pass}:true:`;
  const auth = Buffer.from(authRaw, 'utf8').toString('base64');
  const dmy = ddmmyyyy(isoDate);
  const url = `https://api.etimeoffice.com/api/DownloadInOutPunchData?Empcode=ALL&FromDate=${dmy}&ToDate=${dmy}`;

  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) throw new Error(`eTimeOffice HTTP ${res.status}`);
  const body = await res.json();
  if (body.Error) throw new Error(`eTimeOffice API error: ${body.Msg || 'unknown'}`);
  return body.InOutPunchData || [];
}

// ═══════════════════════════════════════════════════════
// LUNCH HANDLING -- canonical rule, resolved directly by the user (no
// shipped precedent existed anywhere in this repo to mirror). Flat 15-min
// NON-PRODUCTIVE deduction from the single filled entry's durationMins --
// deliberately NOT a separate lunch doc with invented start/end times.
// Applied only when BOTH:
//   (a) the computed gap overlaps the 13:00-15:00 IST lunch window by at
//       least 15 minutes, AND
//   (b) there is no EXISTING productive:false entry already overlapping
//       13:00-15:00 for that userId/date (would double-deduct otherwise).
// If either is false, deduct nothing. The deduction only ever touches the
// reported durationMins -- startTime/endTime stay exactly where they were
// (endTime always OUTTime, never shifted), and durationMins is floored at
// 0, so it can never go negative or imply time past OUTTime.
// ═══════════════════════════════════════════════════════
const LUNCH_WINDOW_START = '13:00';
const LUNCH_WINDOW_END = '15:00';
const LUNCH_DEDUCT_MINS = 15;
const LUNCH_OVERLAP_THRESHOLD_MS = LUNCH_DEDUCT_MINS * 60 * 1000;

function lunchOverlapMs(isoDate, startMs, endMs) {
  const lunchStartMs = hhmmToEpoch(isoDate, LUNCH_WINDOW_START);
  const lunchEndMs = hhmmToEpoch(isoDate, LUNCH_WINDOW_END);
  return Math.max(0, Math.min(endMs, lunchEndMs) - Math.max(startMs, lunchStartMs));
}

// Reads existing timeLogs for one user+date and returns the latest endTime
// (as an epoch), or null if nothing finished yet, plus whether an existing
// productive:false entry already overlaps the lunch window (condition (b)
// above). Returns { blocked: true } instead if ANY entry for that
// user+date is still inProgress:true -- gap-filling around a live/
// unresolved session is api/finalize-stale.js's job, not this one's;
// colliding with it isn't this endpoint's call to make.
async function getLastLoggedEnd(db, userId, isoDate) {
  const snap = await getDocs(query(
    collection(db, 'timeLogs'),
    where('userId', '==', userId),
    where('date', '==', isoDate),
  ));
  let latestEndMs = null;
  let hasLunchEntry = false;
  for (const d of snap.docs) {
    const data = d.data();
    if (data.inProgress === true) return { blocked: true, reason: 'has an inProgress entry for this date -- leave it to the finalizer' };
    if (!data.endTime) continue;
    const endMs = hhmmToEpoch(isoDate, data.endTime);
    if (latestEndMs === null || endMs > latestEndMs) latestEndMs = endMs;
    if (data.productive === false && data.startTime) {
      const startMs = hhmmToEpoch(isoDate, data.startTime);
      if (lunchOverlapMs(isoDate, startMs, endMs) > 0) hasLunchEntry = true;
    }
  }
  return { blocked: false, latestEndMs, hasLunchEntry, lastDoc: snap.docs.length ? snap.docs[snap.docs.length - 1].data() : null };
}

async function computePlanForDate(db, isoDate, punchRecords) {
  const plan = [];
  const byEmpcode = new Map(punchRecords.map((r) => [r.Empcode, r]));

  for (const [empcode, userId] of Object.entries(EMPCODE_TO_USERID)) {
    const rec = byEmpcode.get(empcode);
    if (!rec) { plan.push({ empcode, userId, skipped: true, reason: 'no punch record for this date' }); continue; }
    if (!rec.INTime || rec.INTime === '--:--' || !rec.OUTTime || rec.OUTTime === '--:--') {
      plan.push({ empcode, userId, name: rec.Name, skipped: true, reason: 'INTime or OUTTime absent (--:--)' });
      continue;
    }

    const outMs = hhmmToEpoch(isoDate, rec.OUTTime);
    const last = await getLastLoggedEnd(db, userId, isoDate);
    if (last.blocked) { plan.push({ empcode, userId, name: rec.Name, skipped: true, reason: last.reason }); continue; }

    const startMs = last.latestEndMs !== null ? last.latestEndMs : hhmmToEpoch(isoDate, rec.INTime);
    if (startMs >= outMs) { plan.push({ empcode, userId, name: rec.Name, skipped: true, reason: 'already logged through OUTTime, nothing to fill' }); continue; }

    const rawDurationMins = Math.max(1, Math.round((outMs - startMs) / 60000));
    const overlapMs = lunchOverlapMs(isoDate, startMs, outMs);
    const shouldDeductLunch = overlapMs >= LUNCH_OVERLAP_THRESHOLD_MS && !last.hasLunchEntry;
    const durationMins = shouldDeductLunch ? Math.max(0, rawDurationMins - LUNCH_DEDUCT_MINS) : rawDurationMins;

    const carryForward = last.lastDoc || {};
    const entry = {
      id: `gapfill-${userId}-${isoDate}-${toHHMM(startMs).replace(':', '')}`,
      userId,
      date: isoDate,
      projectId: carryForward.projectId ?? null,
      projectName: carryForward.projectName || 'Unlogged',
      phase: carryForward.phase || '',
      typology: carryForward.typology || '',
      activity: '',
      productive: true,
      inProgress: false,
      sessionStartMs: startMs,
      ts: startMs,
      startTime: toHHMM(startMs),
      endTime: toHHMM(outMs), // always OUTTime, unaffected by the lunch deduction
      durationMins,
      desc: `${carryForward.desc || carryForward.projectName || 'Work on project'} (auto-filled from biometric OUT ${rec.OUTTime})`,
      gapfill: true,
      gapfillSource: `biometric-${isoDate}`,
      ...(shouldDeductLunch ? { lunchDeducted: true, lunchDeductedMins: LUNCH_DEDUCT_MINS } : {}),
    };

    plan.push({ empcode, userId, name: rec.Name, skipped: false, outTime: rec.OUTTime, entries: [entry] });
  }

  return plan;
}

async function writeGapFillPlan(db, plan) {
  const results = [];
  for (const item of plan) {
    if (item.skipped) continue;
    for (const entry of item.entries) {
      try {
        // merge:true + deterministic id -- re-running the same date is a
        // no-op update to the same doc(s), not a duplicate.
        await setDoc(doc(db, 'timeLogs', entry.id), entry, { merge: true });
        results.push({ id: entry.id, userId: entry.userId, status: 'written' });
      } catch (e) {
        results.push({ id: entry.id, userId: entry.userId, status: 'failed', error: e.message });
      }
    }
  }
  return results;
}

module.exports = async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (!process.env.CRON_SECRET) {
    return res.status(500).json({ status: 'misconfigured', error: 'CRON_SECRET is not set' });
  }
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ status: 'unauthorized' });
  }

  // No date param (a cron invocation) falls back to todayIsoDateIST() --
  // see that function's coupling warning re: the cron schedule's time.
  const isoDate = req.query?.date || todayIsoDateIST();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    return res.status(400).json({ status: 'bad-request', error: 'date must be format YYYY-MM-DD' });
  }
  const confirm = req.query?.confirm === 'true';

  if (confirm && RECONCILED_DATES.has(isoDate)) {
    return res.status(409).json({ status: 'refused', error: `${isoDate} is already manually reconciled -- refusing to write` });
  }

  let punchRecords;
  try {
    punchRecords = await fetchInOutPunchData(isoDate);
  } catch (e) {
    console.error('[biometric-sync] eTimeOffice fetch failed:', e.message);
    return res.status(502).json({ status: 'etime-fetch-failed', error: e.message });
  }

  const db = getDb();
  let plan;
  try {
    plan = await computePlanForDate(db, isoDate, punchRecords);
  } catch (e) {
    console.error('[biometric-sync] plan computation failed:', e.message);
    return res.status(500).json({ status: 'plan-failed', error: e.message });
  }

  if (!confirm) {
    return res.status(200).json({ status: 'ok', mode: 'dry-run', date: isoDate, plan });
  }

  try {
    const results = await writeGapFillPlan(db, plan);
    return res.status(200).json({ status: 'ok', mode: 'write', date: isoDate, results });
  } catch (e) {
    return res.status(e.httpStatus || 500).json({ status: 'write-blocked', error: e.message });
  }
};
