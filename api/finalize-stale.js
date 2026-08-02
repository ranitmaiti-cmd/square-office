// V14.3.42: same-day server-side stale-session finalizer.
//
// Problem this closes: a client heartbeat can't write when the office
// network drops -- no client-side fix prevents that. A dead session then
// dangles as inProgress:true until SOME client eventually notices it (login,
// interval, or next-day reload), which is why recoveries have been landing
// at 688m/689m stale instead of minutes. This function does the exact same
// finalize work as finalizeStaleHeartbeatSessionsAllUsers() in index.html,
// but runs on a Vercel Cron schedule (see vercel.json) independent of any
// tab being open, so a session that dies at 10:54 gets closed out by ~11:09
// instead of next morning.
//
// IMPORTANT -- this project is on Vercel's Hobby plan, which only allows
// once-per-day cron schedules (vercel.json's crons entry runs this once
// daily, 22:30 UTC / ~4:00 AM IST, purely as a backstop -- it does NOT
// deliver the "same-day, within minutes" goal on its own). The actual
// every-~15-minutes trigger has to come from an EXTERNAL scheduler (e.g.
// cron-job.org, GitHub Actions on a schedule, or any service that can POST
// on an interval) hitting this endpoint with the CRON_SECRET as a Bearer
// token:
//   POST/GET https://squareoffice.vercel.app/api/finalize-stale
//   Authorization: Bearer <CRON_SECRET>
// Without that external trigger configured, stale sessions still only get
// closed out once a day by the Vercel-native cron above (still much better
// than "next morning after someone opens a tab," but not "within minutes").
//
// Deliberately NOT the Admin SDK -- this app has no Firebase Auth and (by
// necessity, since the browser client writes directly with no sign-in)
// Firestore rules are already permissive under the same public web config
// embedded in index.html. Reusing that config here avoids a new
// service-account secret; the trust model is identical to what the client
// already operates under. If that ever changes, this needs the Admin SDK
// instead.
//
// Mirrors index.html exactly, on purpose, for: STALE_HEARTBEAT_MS (5 min),
// extractLastSeenMs()'s field-fallback order, capSessionDuration()/
// MAX_SESSION_HOURS, and the update() shape (inProgress/recovered/
// durationMins/endTime/desc/recoveredAt/autoCapped) -- so a session looks
// identical in reports regardless of which path finalized it, except for
// the "server-side finalizer" marker in desc.
//
// One deliberate deviation from a literal mirror: index.html's startMs
// fallback is `new Date(\`${date}T${startTime}:00\`)` with no explicit
// offset -- on a browser this is parsed in whatever timezone the browser
// runs in (usually IST for this team), which is a known, previously-flagged
// bug but tolerable there. A Vercel serverless function runs in UTC, so the
// exact same unpinned parse would be WRONG for every single session it
// touches (a consistent ~5.5h skew), not just non-IST readers. So this
// function prefers sessionStartMs (the raw-epoch field added in the
// activeTimers collapse, present on the large majority of current docs) and
// only falls back to the date+startTime string, WITH an explicit +05:30
// pin, for pre-that-change legacy docs. This does not change the staleness
// THRESHOLD or judgment at all (that's still exactly STALE_HEARTBEAT_MS /
// extractLastSeenMs, unmodified) -- only how startMs is derived for
// duration math on the fallback path.
const { initializeApp, getApps, getApp } = require('firebase/app');
const {
  getFirestore, collection, query, where, getDocs, doc, getDoc, updateDoc,
} = require('firebase/firestore');

const firebaseConfig = {
  apiKey: 'AIzaSyBi_OD42znfsYZerQ_c6RWfLIPD_GropBE',
  authDomain: 'square-office-management.firebaseapp.com',
  projectId: 'square-office-management',
  storageBucket: 'square-office-management.firebasestorage.app',
  messagingSenderId: '99247930577',
  appId: '1:99247930577:web:4f5137e9476349582319f0',
};

const STALE_HEARTBEAT_MS = 5 * 60 * 1000; // mirrors index.html's STALE_HEARTBEAT_MS exactly -- do not diverge
const MAX_SESSION_HOURS = 12; // mirrors index.html's MAX_SESSION_HOURS exactly

function extractLastSeenMs(data) {
  // Verbatim port of index.html's extractLastSeenMs().
  if (!data) return null;
  return (data.lastHeartbeat && typeof data.lastHeartbeat.seconds === 'number')
    ? data.lastHeartbeat.seconds * 1000
    : (data.ts || (data.updatedAt ? new Date(data.updatedAt).getTime() : null));
}

function capSessionDuration(sessionSecs) {
  // Verbatim port of index.html's capSessionDuration().
  const maxSecs = MAX_SESSION_HOURS * 3600;
  if (sessionSecs <= maxSecs) {
    return { durationMins: Math.max(1, Math.floor(sessionSecs / 60)), capped: false };
  }
  return { durationMins: MAX_SESSION_HOURS * 60, capped: true };
}

function resolveStartMs(data, lastSeenMs) {
  if (typeof data.sessionStartMs === 'number') return data.sessionStartMs;
  if (data.date && data.startTime) return new Date(`${data.date}T${data.startTime}:00+05:30`).getTime();
  return lastSeenMs;
}

function getDb() {
  const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  return getFirestore(app);
}

module.exports = async (req, res) => {
  // Cron auth -- only Vercel's own scheduled invocation (which sends this
  // header automatically when CRON_SECRET is set in project env vars), or
  // someone holding the secret for manual testing, may trigger this.
  const authHeader = req.headers['authorization'];
  if (!process.env.CRON_SECRET) {
    return res.status(500).json({ status: 'misconfigured', error: 'CRON_SECRET is not set' });
  }
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ status: 'unauthorized' });
  }

  const startedAt = Date.now();
  const db = getDb();

  let snap;
  try {
    // Plain getDocs() -- no {source:'server'} option exists in the modular
    // SDK/this context; a serverless invocation has no local persistence
    // cache to begin with; every read here is already a fresh server read.
    snap = await getDocs(query(collection(db, 'timeLogs'), where('inProgress', '==', true)));
  } catch (e) {
    const result = { status: 'read-failed', error: e.message, scanned: 0, finalized: 0, skipped: 0, failed: 0, fresh: 0, noHeartbeat: 0, durationMs: Date.now() - startedAt };
    console.error(`[finalize-stale] read failed: ${e.message}`, result);
    return res.status(500).json(result);
  }

  const now = Date.now();
  let finalized = 0, failed = 0, fresh = 0, noHeartbeat = 0, skipped = 0;
  const failures = [];

  for (const docSnap of snap.docs) {
    const data = docSnap.data();
    const lastSeenMs = extractLastSeenMs(data);
    if (!lastSeenMs) { noHeartbeat++; continue; }
    if (now - lastSeenMs < STALE_HEARTBEAT_MS) { fresh++; continue; } // exact same threshold as the client -- never finalize a genuinely-live session

    // V14.3.30-pattern: per-document try/catch -- one failing write must not
    // abandon every remaining stale doc in this run (the sweep-loop bug).
    try {
      const docRef = doc(db, 'timeLogs', docSnap.id);
      // Idempotency: re-read the specific doc right before writing, in case
      // the client sweep (or an overlapping run) already finalized it in the
      // gap between the query snapshot above and this write. The inProgress
      // filter on the query already excludes anything finalized BEFORE the
      // query ran; this closes the race for anything finalized DURING it.
      const freshDoc = await getDoc(docRef);
      const freshData = freshDoc.data();
      if (!freshDoc.exists() || freshData.inProgress !== true) { skipped++; continue; }

      const startMs = resolveStartMs(freshData, lastSeenMs);
      const { durationMins, capped } = capSessionDuration(Math.max(0, Math.round((lastSeenMs - startMs) / 1000)));
      // endTime comes from lastSeenMs (the last real heartbeat), never "now"
      // -- this runs unattended and must not invent extra duration just
      // because of when the cron happened to catch it.
      // V14.3.44: explicit timeZone:'Asia/Kolkata' -- 'en-IN' is a LOCALE
      // (digit style, formatting conventions), it does NOT force which
      // timezone's wall-clock gets displayed. Without this, toLocaleTimeString
      // falls back to the RUNTIME's system timezone -- on Vercel that's UTC,
      // so this was silently writing a ~5.5h-wrong endTime on every real
      // finalize since this shipped. Verified directly: forcing TZ=UTC
      // locally reproduced the exact bug (same epoch rendered as the wrong
      // clock time without this option, correct with it). Found via a
      // biometric-sync dry-run surfacing an implausible 06:29 "last logged
      // end" for sessions this function had finalized.
      const endTime = new Date(lastSeenMs).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });

      const updates = {
        inProgress: false,
        recovered: true,
        durationMins,
        endTime,
        desc: `${freshData.desc || 'Work on project'} (recovered — server-side finalizer, heartbeat stale for ${Math.round((now - lastSeenMs) / 60000)}m)` + (capped ? ` (auto-capped at ${MAX_SESSION_HOURS}h — verify)` : ''),
        recoveredAt: new Date().toISOString(),
        ...(capped ? { autoCapped: true } : {}),
      };
      await updateDoc(docRef, updates);
      finalized++;
    } catch (e) {
      failed++;
      failures.push({ id: docSnap.id, userId: data.userId, userName: data.userName, error: e.message });
      console.error(`[finalize-stale] failed to finalize ${docSnap.id} (${data.userName || data.userId}): ${e.message} -- will retry next run`);
    }
  }

  const result = { status: 'ok', scanned: snap.size, finalized, skipped, failed, fresh, noHeartbeat, durationMs: Date.now() - startedAt };
  console.log(`[finalize-stale] ran -- scanned:${result.scanned} finalized:${finalized} skipped:${skipped} failed:${failed} fresh:${fresh} noHeartbeat:${noHeartbeat} (${result.durationMs}ms)`);
  if (failed > 0) console.error(`[finalize-stale] ${failed} document(s) failed this run, will retry next run:`, failures);

  return res.status(200).json(result);
};
