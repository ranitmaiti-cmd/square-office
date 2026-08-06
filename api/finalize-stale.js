// V14.3.42: same-day server-side stale-session finalizer.
// V16 (flag-don't-truncate): this function no longer CLOSES a stale session.
// Truncating endTime to the last heartbeat was itself the bug -- a tab
// frozen/backgrounded for hours (Chrome tab-freezing, not a network drop)
// looks identical to a genuinely-dead session from the heartbeat's point of
// view, and closing it at lastSeenMs silently ate every minute past that
// point even though the person was still working. This function now only
// FLAGS a stale session (reconciliationNeeded:true + reconciliationNeededSince)
// and leaves it inProgress:true -- if the tab wakes and heartbeats again,
// the session self-heals with no gap (see index.html's wake-verification
// guard). A session that never comes back gets actually closed later by
// api/biometric-sync.js's EOD-close phase, capped at that user's real
// biometric OUT time, not an arbitrary last-heartbeat guess.
//
// Problem this closes: a client heartbeat can't write when the office
// network drops, or the tab is frozen/backgrounded -- no client-side fix
// prevents that. A dead-or-frozen session then dangles as inProgress:true
// with no flag until SOME client eventually notices it (login, interval, or
// next-day reload). This function does the exact same flagging work as
// finalizeStaleHeartbeatSessionsAllUsers() in index.html, but runs on a
// Vercel Cron schedule (see vercel.json) independent of any tab being open,
// so a session that goes stale at 10:54 gets flagged by ~11:09 instead of
// next morning -- flagged for review, not truncated.
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
// flagged once a day by the Vercel-native cron above.
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
// extractLastSeenMs()'s field-fallback order, and the flag-write shape
// (reconciliationNeeded/reconciliationNeededSince) -- so a session looks
// identical regardless of which path flagged it.
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

function extractLastSeenMs(data) {
  // Verbatim port of index.html's extractLastSeenMs().
  if (!data) return null;
  return (data.lastHeartbeat && typeof data.lastHeartbeat.seconds === 'number')
    ? data.lastHeartbeat.seconds * 1000
    : (data.ts || (data.updatedAt ? new Date(data.updatedAt).getTime() : null));
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
  let flagged = 0, failed = 0, fresh = 0, noHeartbeat = 0, skipped = 0, alreadyFlagged = 0;
  const failures = [];

  for (const docSnap of snap.docs) {
    const data = docSnap.data();
    if (data.reconciliationNeeded === true) { alreadyFlagged++; continue; } // one-time transition -- don't rewrite reconciliationNeededSince on every run
    const lastSeenMs = extractLastSeenMs(data);
    if (!lastSeenMs) { noHeartbeat++; continue; }
    if (now - lastSeenMs < STALE_HEARTBEAT_MS) { fresh++; continue; } // exact same threshold as the client -- never flag a genuinely-live session

    // V14.3.30-pattern: per-document try/catch -- one failing write must not
    // abandon every remaining stale doc in this run (the sweep-loop bug).
    try {
      const docRef = doc(db, 'timeLogs', docSnap.id);
      // Idempotency: re-read the specific doc right before writing, in case
      // the client sweep (or an overlapping run) already flagged/closed it
      // in the gap between the query snapshot above and this write. The
      // inProgress filter on the query already excludes anything closed
      // BEFORE the query ran; this closes the race for anything
      // flagged/closed DURING it.
      const freshDoc = await getDoc(docRef);
      const freshData = freshDoc.data();
      if (!freshDoc.exists() || freshData.inProgress !== true || freshData.reconciliationNeeded === true) { skipped++; continue; }

      // V16 (flag-don't-truncate): flag only -- inProgress, endTime,
      // durationMins are all left exactly as the last successful heartbeat
      // wrote them. They are not authoritative anymore; the true final
      // duration is only ever computed at an actual close (a wake that
      // resumes heartbeating, or api/biometric-sync.js's EOD-close phase
      // capped at biometric OUT).
      await updateDoc(docRef, {
        reconciliationNeeded: true,
        reconciliationNeededSince: new Date().toISOString(),
      });
      flagged++;
    } catch (e) {
      failed++;
      failures.push({ id: docSnap.id, userId: data.userId, userName: data.userName, error: e.message });
      console.error(`[finalize-stale] failed to flag ${docSnap.id} (${data.userName || data.userId}): ${e.message} -- will retry next run`);
    }
  }

  const result = { status: 'ok', scanned: snap.size, flagged, alreadyFlagged, skipped, failed, fresh, noHeartbeat, durationMs: Date.now() - startedAt };
  console.log(`[finalize-stale] ran -- scanned:${result.scanned} flagged:${flagged} alreadyFlagged:${alreadyFlagged} skipped:${skipped} failed:${failed} fresh:${fresh} noHeartbeat:${noHeartbeat} (${result.durationMs}ms)`);
  if (failed > 0) console.error(`[finalize-stale] ${failed} document(s) failed this run, will retry next run:`, failures);

  return res.status(200).json(result);
};
