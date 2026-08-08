// V14.3.43: biometric IN/OUT sync -- auto-fills missing timelog tails from
// eTimeOffice biometric attendance data. Companion to api/finalize-stale.js:
// that FLAGS a stale-heartbeat session same-day (V16: flags, no longer
// closes it -- see that file's own header); this is what actually CLOSES a
// still-flagged session, capped at the user's real biometric OUT time
// instead of a heartbeat guess, then fills the resulting tail gap up to
// that same OUT time -- so morning reconciliation from biometric stops
// being a manual, next-day chore.
//
// V16 (flag-don't-truncate): two phases per run now, in order --
// (1) closeReconciliationNeededSessions(): resolves every still-open,
//     flagged session up to and including isoDate (with a 30-day catch-up
//     floor for a missed cron run), closed against that user's OWN day's
//     biometric OUT, or an honest estimated close if no biometric data
//     exists for them. See that function's own header for the full design.
// (2) computePlanForDate()/writeGapFillPlan(): unchanged tail gap-fill,
//     now running against a day where phase (1) has already resolved
//     anything that would otherwise block getLastLoggedEnd()'s
//     inProgress:true guard.
//
// STATUS: writes are live behind the confirm=true query param (dry-run by
// default) -- this gates BOTH phases identically. Lunch handling is
// resolved -- see LUNCH_WINDOW_START below.
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
  getFirestore, collection, query, where, getDocs, doc, setDoc, updateDoc,
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
//
// MAINTENANCE: append-only, by hand, the same day a date's manual
// reconciliation is finished -- add it here BEFORE the next cron/manual run
// of this endpoint could otherwise touch it (this file's own EOD-close
// catch-up sweep looks back up to CATCHUP_FLOOR_DAYS days, so a freshly
// reconciled date is still in that window and must be protected
// immediately, not "sometime later"). Never remove a date once added --
// there's no scenario where a manually reconciled day should become
// writable again. 2026-08-05 covers the Aug-5 mid-day reconciliation done
// by hand this session (Neha/Suravi malformed-doc repairs + all 8 staff's
// gap-fills) -- EOD-close and the tail gap-fill below must never touch it.
const RECONCILED_DATES = new Set([
  '2026-07-24', '2026-07-25', '2026-07-26', '2026-07-27',
  '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31',
  '2026-08-05',
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

// V16 (flag-don't-truncate): the real closer for a reconciliationNeeded
// session. index.html's stale sweeps and api/finalize-stale.js no longer
// close a stale-heartbeat session -- they only flag it and leave it
// inProgress:true so a tab that wakes and heartbeats again self-heals with
// no gap. A session that never comes back needs an ACTUAL close eventually,
// or it (a) never shows up in any report, and (b) permanently blocks the
// tail gap-fill below via getLastLoggedEnd()'s inProgress:true guard. This
// function is that close, capped at the user's real biometric OUT instead
// of a heartbeat guess -- and it runs FIRST, before computePlanForDate is
// called for any date, so by the time the tail gap-fill runs, every doc it
// might otherwise block on has already been resolved one way or another.
//
// MAX_SESSION_HOURS/capSessionDuration are a verbatim port of index.html's
// -- same reasoning as api/finalize-stale.js's own port: this runs as a
// separate Vercel function, no shared runtime with the client.
const MAX_SESSION_HOURS = 12;
function capSessionDuration(sessionSecs) {
  const maxSecs = MAX_SESSION_HOURS * 3600;
  if (sessionSecs <= maxSecs) {
    return { durationMins: Math.max(1, Math.floor(sessionSecs / 60)), capped: false };
  }
  return { durationMins: MAX_SESSION_HOURS * 60, capped: true };
}

// Catch-up sweep floor (hardening 2): bounds how far back a recovered/
// missed cron run will look for still-flagged, still-open sessions. Without
// a floor, a single outage lasting months would make every subsequent run
// re-scan the entire collection's history; 30 days comfortably covers any
// realistic missed-run window (this cron is meant to fire nightly) while
// keeping the query bounded. A session older than the floor that's somehow
// still reconciliationNeeded:true + inProgress:true is a sign something is
// structurally wrong (not just "cron missed a night") and belongs in manual
// review, not an ever-widening automatic sweep.
const CATCHUP_FLOOR_DAYS = 30;
function subtractDaysISO(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function resolveStartMsStrict(data) {
  // Hardening 3: unlike writer #5 in index.html (a one-off synchronous
  // admin action with no repeat backstop), this function runs repeatedly
  // (nightly, with catch-up) -- so an unresolvable start time is safe to
  // defer to a LATER, more-informed manual pass rather than guessing at a
  // number. Returns null (never a fallback timestamp) when both signals are
  // unusable; the caller must skip and report, not write a garbage duration.
  if (typeof data.sessionStartMs === 'number') return data.sessionStartMs;
  if (data.date && data.startTime) return new Date(`${data.date}T${data.startTime}:00+05:30`).getTime();
  return null;
}

// REQUIRES a Firestore composite index on timeLogs for
// (inProgress ASC, reconciliationNeeded ASC, date ASC) -- two equality
// filters plus a range filter on a third field needs one. Firestore will
// throw failed-precondition with a console link to create it the first time
// this query runs without it; see the deploy runbook for creating it ahead
// of time instead of discovering this live.
async function closeReconciliationNeededSessions(db, isoDate, confirm) {
  const startedAt = Date.now();
  const floorDate = subtractDaysISO(isoDate, CATCHUP_FLOOR_DAYS);

  let snap;
  try {
    snap = await getDocs(query(
      collection(db, 'timeLogs'),
      where('inProgress', '==', true),
      where('reconciliationNeeded', '==', true),
      where('date', '>=', floorDate),
      where('date', '<=', isoDate),
    ));
  } catch (e) {
    return {
      status: 'read-failed', error: e.message, scanned: 0,
      closedBiometric: 0, closedFallback: 0, needsManualReview: [],
      skippedReconciledDate: 0, failed: 0, durationMs: Date.now() - startedAt,
    };
  }

  const byDate = new Map();
  snap.forEach((d) => {
    const data = d.data();
    if (!byDate.has(data.date)) byDate.set(data.date, []);
    byDate.get(data.date).push({ id: d.id, data });
  });

  const userIdToEmpcode = new Map(Object.entries(EMPCODE_TO_USERID).map(([e, u]) => [u, e]));
  const nowAtJobRun = Date.now(); // one shared close-point for every fallback entry THIS run produces

  let closedBiometric = 0, closedFallback = 0, failed = 0, skippedReconciledDate = 0;
  const needsManualReview = [];

  for (const [date, docs] of byDate) {
    if (RECONCILED_DATES.has(date)) {
      skippedReconciledDate += docs.length;
      needsManualReview.push(...docs.map((d) => ({ id: d.id, userId: d.data.userId, date, reason: 'date is in RECONCILED_DATES -- never auto-write' })));
      continue;
    }

    let punchByEmpcode = null;
    try {
      const records = await fetchInOutPunchData(date);
      punchByEmpcode = new Map(records.map((r) => [r.Empcode, r]));
    } catch (e) {
      // eTimeOffice unreachable for this date -- every doc in this date's
      // group falls to the fallback path below rather than blocking the
      // whole run; the docs stay flagged (not written to at all if
      // confirm=false) and will be retried the next time this runs.
      needsManualReview.push(...docs.map((d) => ({ id: d.id, userId: d.data.userId, date, reason: `eTimeOffice fetch failed for ${date}: ${e.message} -- treated as no-biometric this run` })));
    }

    for (const { id, data } of docs) {
      const startMs = resolveStartMsStrict(data);
      if (startMs === null) {
        needsManualReview.push({ id, userId: data.userId, date, reason: 'both sessionStartMs and date+startTime are unusable -- cannot compute a duration' });
        continue;
      }

      const empcode = userIdToEmpcode.get(data.userId);
      const rec = empcode && punchByEmpcode ? punchByEmpcode.get(empcode) : null;
      const hasBiometricOut = rec && rec.OUTTime && rec.OUTTime !== '--:--';

      if (hasBiometricOut) {
        const outMs = hhmmToEpoch(date, rec.OUTTime);
        if (outMs <= startMs) {
          needsManualReview.push({ id, userId: data.userId, date, reason: `biometric OUT (${rec.OUTTime}) is at/before session start -- bad punch data` });
          continue;
        }
        const { durationMins, capped } = capSessionDuration(Math.round((outMs - startMs) / 1000));
        const updates = {
          inProgress: false,
          recovered: true,
          durationMins,
          endTime: toHHMM(outMs),
          desc: `${data.desc || 'Work on project'} (closed end-of-day — capped at biometric OUT ${rec.OUTTime})`,
          recoveredAt: new Date().toISOString(),
          reconciliationNeeded: false,
          ...(capped ? { autoCapped: true } : {}),
        };
        if (confirm) {
          try {
            await updateDoc(doc(db, 'timeLogs', id), updates);
            closedBiometric++;
          } catch (e) {
            failed++;
            needsManualReview.push({ id, userId: data.userId, date, reason: `write failed: ${e.message}` });
          }
        } else {
          closedBiometric++; // dry-run: counted as "would close," nothing written
        }
      } else {
        // Fallback-close: no biometric OUT for this user/date (unmapped
        // Empcode, or mapped but no/blank punch). Close at this job run's
        // own timestamp -- an honest real boundary, not an invented one --
        // capped by the same 12h ceiling, explicitly flagged estimatedClose
        // so it's never confused with a biometric-anchored close.
        const { durationMins, capped } = capSessionDuration(Math.max(0, Math.round((nowAtJobRun - startMs) / 1000)));
        const updates = {
          inProgress: false,
          recovered: true,
          estimatedClose: true,
          durationMins,
          endTime: toHHMM(nowAtJobRun),
          desc: `${data.desc || 'Work on project'} (closed end-of-day — no biometric data, estimated)`,
          recoveredAt: new Date().toISOString(),
          reconciliationNeeded: false,
          ...(capped ? { autoCapped: true } : {}),
        };
        if (confirm) {
          try {
            await updateDoc(doc(db, 'timeLogs', id), updates);
            closedFallback++;
          } catch (e) {
            failed++;
            needsManualReview.push({ id, userId: data.userId, date, reason: `write failed: ${e.message}` });
          }
        } else {
          closedFallback++; // dry-run: counted as "would close," nothing written
        }
      }
    }
  }

  return {
    status: 'ok',
    mode: confirm ? 'write' : 'dry-run',
    scanned: snap.size,
    closedBiometric,
    closedFallback,
    needsManualReview,
    skippedReconciledDate,
    failed,
    durationMs: Date.now() - startedAt,
  };
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

  const db = getDb();

  // V16 (flag-don't-truncate): phase 0, BEFORE the tail gap-fill below.
  // Resolves every reconciliationNeeded session up to and including
  // isoDate (with the catch-up floor) first, so getLastLoggedEnd()'s
  // inProgress:true guard is never blocking on something this run could
  // have already closed. Runs unconditionally (even in dry-run) so its
  // report is always visible; it only WRITES when confirm=true, same gate
  // as the gap-fill below.
  let eodClose;
  try {
    eodClose = await closeReconciliationNeededSessions(db, isoDate, confirm);
  } catch (e) {
    console.error('[biometric-sync] EOD-close phase failed:', e.message);
    return res.status(500).json({ status: 'eod-close-failed', error: e.message });
  }

  let punchRecords;
  try {
    punchRecords = await fetchInOutPunchData(isoDate);
  } catch (e) {
    console.error('[biometric-sync] eTimeOffice fetch failed:', e.message);
    return res.status(502).json({ status: 'etime-fetch-failed', error: e.message, eodClose });
  }

  let plan;
  try {
    plan = await computePlanForDate(db, isoDate, punchRecords);
  } catch (e) {
    console.error('[biometric-sync] plan computation failed:', e.message);
    return res.status(500).json({ status: 'plan-failed', error: e.message, eodClose });
  }

  if (!confirm) {
    return res.status(200).json({ status: 'ok', mode: 'dry-run', date: isoDate, eodClose, plan });
  }

  try {
    const results = await writeGapFillPlan(db, plan);
    return res.status(200).json({ status: 'ok', mode: 'write', date: isoDate, eodClose, results });
  } catch (e) {
    return res.status(e.httpStatus || 500).json({ status: 'write-blocked', error: e.message, eodClose });
  }
};
