// V14.3.41: serves the current version from a serverless function instead
// of the static version.json file. Confirmed via repeated live probes that
// Vercel's static-asset edge cache serves /version.json by path only --
// it ignores query-string cache-busting entirely and kept returning
// X-Vercel-Cache: HIT with Age climbing for hours even after Cache-Control
// was strengthened to no-store. Serverless functions execute per request
// and aren't subject to that static-file edge cache, so this is a
// structural fix, not another header attempt.
//
// Deliberately fs.readFileSync() INSIDE the handler, not a top-level
// require('../version.json') -- Node caches require() results in the
// module cache for the lifetime of the process, and Vercel reuses warm
// function instances across invocations, so a top-level require would
// keep serving whatever version.json held at that instance's cold start
// rather than the current file. Reading fresh per request removes that
// doubt entirely. version.json itself stays the single source of truth,
// bumped alongside APP_VERSION -- this just can't go stale mid-instance.
const fs = require('fs');
const path = require('path');

module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'version.json'), 'utf8');
    res.status(200).json(JSON.parse(raw));
  } catch (e) {
    // Client-side checkForNewVersion()/checkVersionBeforeInit() both treat
    // !res.ok as fail-open -- never gate on a check that itself failed.
    res.status(500).json({ error: 'version read failed' });
  }
};
