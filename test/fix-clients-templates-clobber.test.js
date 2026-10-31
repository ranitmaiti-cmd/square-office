// Fixture for V36: clients / budgetTemplates / typologies clobber fix (2026-10-31).
//
// Incident: on 2026-10-27 the shared lists in companyData/squareDB were reset
// in ONE write -- clients to the 5 demo names, budgetTemplates to [], and
// typologies to the built-in defaults -- visible in the dailyBackup_* docs.
// Cause: all three rode saveData()'s wholesale payload, and loadData()'s catch
// sets dataLoaded = true even when the load failed, so a tab whose first server
// read failed kept its INITIAL in-memory defaults and wrote them over the real
// lists on its next periodic save.
//
// Central claims under test (the REAL extracted functions, executed against a
// mock Firestore with true arrayUnion/arrayRemove semantics):
//  - the periodic-save payload no longer carries the three lists, and applying
//    the REAL payload from a stale/half-loaded tab leaves the server lists intact
//    (with a negative control proving this harness WOULD have caught the old bug)
//  - a stale tab that adds/removes a client or typology writes ONLY a single-name
//    arrayUnion/arrayRemove -- it physically cannot drop or reset the rest, even
//    when its server re-read fails
//  - "add client" is case-insensitive against the SERVER list and reuses the
//    existing spelling (any case of sugam -> SUGAM), creating nothing
//  - typologies and templates are protected from the same reset
//  - every consumer is wired to the new writers (no leftover wholesale path)
//  - isolation: pay-engine / leave / WFH code is byte-for-byte unchanged, and
//    saveData() differs from main ONLY in the dataToSave literal
//  - the restore data source (DEFAULT_BUDGET_TEMPLATES) is exactly the two
//    built-in templates Ranit confirmed
//
// Run with: node test/fix-clients-templates-clobber.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');
const assert = require('assert');

const norm = (s) => s.replace(/\r\n/g, '\n');
const REPO_ROOT = 'D:/SQUARE/ADMIN/SQUARE-Office/finalphase/01072026';
const src = norm(fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8'));
const fullScript = src.match(/<script>([\s\S]*?)<\/script>/)[1];
const mainSrc = norm(execSync('git show main:index.html', { cwd: REPO_ROOT, maxBuffer: 1024 * 1024 * 20 }).toString('utf8'));
const mainScript = mainSrc.match(/<script>([\s\S]*?)<\/script>/)[1];

let passCount = 0, failCount = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); passCount++; }
  else { console.log(`  FAIL: ${label}`); failCount++; }
}

function extractFunction(source, name) {
  let startIdx = source.indexOf(`async function ${name}(`);
  if (startIdx < 0) startIdx = source.indexOf(`function ${name}(`);
  assert.ok(startIdx >= 0, `could not find function ${name}`);
  const parenStart = source.indexOf('(', startIdx);
  let pd = 0, j = parenStart;
  for (; j < source.length; j++) {
    if (source[j] === '(') pd++;
    else if (source[j] === ')') { pd--; if (pd === 0) break; }
  }
  const braceStart = source.indexOf('{', j);
  let depth = 0, i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  return source.slice(startIdx, i + 1);
}

// ── Real data shapes ────────────────────────────────────────────────────────
const REAL_CLIENTS = ['ARPL', 'BROOKFIELD', 'DIAMOND', 'DTC', 'MERLIN', 'ORBIT', 'PS', 'SHALIMAR', 'SUGAM', 'TARUNAVA KONAR', 'AMBUJA', 'DOT & KEY', 'KOUZINA', 'Kredent'];
const DEMO_CLIENTS = ['Acme Corp', 'Tech Solutions', 'Global Industries', 'Startup Inc', 'Enterprise Co']; // the app's initial in-memory list
const evalLiteral = (re) => vm.runInNewContext('(' + fullScript.match(re)[1] + ')');
const DEFAULT_TYPOLOGIES = evalLiteral(/let typologies = (\[[\s\S]*?\n\]);/);
const DEFAULT_TEMPLATES = evalLiteral(/const DEFAULT_BUDGET_TEMPLATES = (\[[\s\S]*?\n\]);/);
const SERVER_TYPOLOGIES = [...DEFAULT_TYPOLOGIES, 'Custom Typology A']; // proves a customized list survives, not just the defaults

const FUNCS = [
  'normListName', 'findNameCaseInsensitive', 'sortedClients', 'refreshSharedListsFromServer',
  'addClientGranular', 'removeClientGranular', 'addTypologyGranular', 'removeTypologyGranular',
  'saveBudgetTemplatesGranular', 'saveSharedListsReplace',
];

// Mock squareDB with true arrayUnion / arrayRemove / replace semantics.
function makeWorld({ server, tab, failReads = false, lockout = false }) {
  const calls = [];
  const alerts = [];
  const doc = JSON.parse(JSON.stringify(server));
  const FieldValue = {
    arrayUnion: (...els) => ({ __op: 'union', els }),
    arrayRemove: (...els) => ({ __op: 'remove', els }),
  };
  const sandbox = {
    console, JSON, Array, Object,
    firebase: { firestore: { FieldValue } },
    staleVersionLockout: lockout,
    alert: (m) => alerts.push(m),
    db: {
      collection: () => ({
        doc: () => ({
          async get() {
            if (failReads) throw new Error('offline');
            return { exists: true, data: () => JSON.parse(JSON.stringify(doc)) };
          },
          async update(obj) {
            calls.push(JSON.parse(JSON.stringify(obj)));
            for (const [k, v] of Object.entries(obj)) {
              if (v && v.__op === 'union') {
                const cur = Array.isArray(doc[k]) ? doc[k] : [];
                for (const e of v.els) if (!cur.includes(e)) cur.push(e);
                doc[k] = cur;
              } else if (v && v.__op === 'remove') {
                doc[k] = (doc[k] || []).filter((x) => !v.els.includes(x));
              } else {
                doc[k] = JSON.parse(JSON.stringify(v));
              }
            }
          },
        }),
      }),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `let clients = ${JSON.stringify(tab.clients)}; let typologies = ${JSON.stringify(tab.typologies)}; let budgetTemplates = ${JSON.stringify(tab.budgetTemplates)};`,
    sandbox
  );
  for (const fn of FUNCS) vm.runInContext(extractFunction(fullScript, fn), sandbox);
  return { sandbox, doc, calls, alerts };
}
const run = (w, expr) => vm.runInContext(expr, w.sandbox);
const mem = (w, name) => JSON.parse(JSON.stringify(run(w, name)));
const SERVER_GOOD = () => ({ clients: [...REAL_CLIENTS], typologies: [...SERVER_TYPOLOGIES], budgetTemplates: JSON.parse(JSON.stringify(DEFAULT_TEMPLATES)), unrelated: 'keep-me' });
const STALE_TAB = () => ({ clients: [...DEMO_CLIENTS], typologies: [...DEFAULT_TYPOLOGIES], budgetTemplates: [] }); // a tab holding only its INITIAL in-memory values

(async () => {

// ─────────────────────────────────────────────────────────────
console.log('=== 1. The periodic-save payload can no longer wipe the lists ===');
{
  const saveDataSrc = extractFunction(fullScript, 'saveData');
  const lit = saveDataSrc.match(/const dataToSave = (\{[\s\S]*?\});/)[1];
  const ctx = vm.createContext({
    changeRequests: [], saveTimestamp: 't', instanceId: 'i', currentUser: { name: 'X' },
    projectsData: [], timeLogs: [], planEntries: [], leaveRequests: [],
  });
  const payload = vm.runInContext('(' + lit + ')', ctx);
  const keys = Object.keys(payload);
  check('the REAL dataToSave literal no longer contains clients', !keys.includes('clients'));
  check('the REAL dataToSave literal no longer contains typologies', !keys.includes('typologies'));
  check('the REAL dataToSave literal no longer contains budgetTemplates', !keys.includes('budgetTemplates'));
  check('the rest of the payload is intact (changeRequests, timestamp, instanceId, counts)', ['changeRequests', 'timestamp', 'instanceId', 'savedBy', 'projectCount', 'timeLogCount', 'planEntryCount', 'leaveRequestCount'].every((k) => keys.includes(k)));

  // Apply the REAL payload, as a stale/half-loaded tab's periodic save would, to a server holding the good lists.
  const w = makeWorld({ server: SERVER_GOOD(), tab: STALE_TAB() });
  const before = JSON.stringify({ c: w.doc.clients, t: w.doc.typologies, b: w.doc.budgetTemplates });
  await w.sandbox.db.collection('companyData').doc('squareDB').update(payload);
  const after = JSON.stringify({ c: w.doc.clients, t: w.doc.typologies, b: w.doc.budgetTemplates });
  check('applying a stale tab\'s REAL periodic-save payload leaves clients/typologies/budgetTemplates byte-identical on the server', before === after);

  // Negative control: the OLD payload shape from that same stale tab WOULD have wiped them.
  const w2 = makeWorld({ server: SERVER_GOOD(), tab: STALE_TAB() });
  const oldPayload = { ...payload, clients: DEMO_CLIENTS, typologies: DEFAULT_TYPOLOGIES, budgetTemplates: [] };
  await w2.sandbox.db.collection('companyData').doc('squareDB').update(oldPayload);
  check('NEGATIVE CONTROL: the old payload shape reproduces the 27 Oct wipe in this harness (so the checks above are meaningful)',
    JSON.stringify(w2.doc.clients) === JSON.stringify(DEMO_CLIENTS) && w2.doc.budgetTemplates.length === 0 && JSON.stringify(w2.doc.typologies) === JSON.stringify(DEFAULT_TYPOLOGIES));
}

// ─────────────────────────────────────────────────────────────
console.log('\n=== 2. A stale tab that edits a list physically cannot drop or reset the rest ===');
{
  // 2a. stale tab adds a new client; its server re-read WORKS
  let w = makeWorld({ server: SERVER_GOOD(), tab: STALE_TAB() });
  let r = await run(w, `addClientGranular('NEWCO')`);
  check('add (re-read OK): created the client', r.ok && r.created && r.name === 'NEWCO');
  check('add (re-read OK): server now has all 14 real clients PLUS NEWCO, none dropped', REAL_CLIENTS.every((c) => w.doc.clients.includes(c)) && w.doc.clients.includes('NEWCO') && w.doc.clients.length === 15);
  check('add (re-read OK): the demo names were NOT written back', !w.doc.clients.includes('Acme Corp'));

  // 2b. the HARD case: the stale tab's server re-read FAILS, so its in-memory list is the 5 demo names
  w = makeWorld({ server: SERVER_GOOD(), tab: STALE_TAB(), failReads: true });
  r = await run(w, `addClientGranular('NEWCO')`);
  check('add (re-read FAILS, in-memory = 5 demo names): still created', r.ok && r.created);
  check('the ONLY thing written is a single-name arrayUnion -- no plain array anywhere in the payload',
    w.calls.length === 1 && Object.keys(w.calls[0]).join() === 'clients' && w.calls[0].clients.__op === 'union' && w.calls[0].clients.els.length === 1 && w.calls[0].clients.els[0] === 'NEWCO');
  check('server STILL has all 14 real clients (a stale tab cannot reset them), plus NEWCO', REAL_CLIENTS.every((c) => w.doc.clients.includes(c)) && w.doc.clients.length === 15);

  // 2c. stale tab removes one client: only that name leaves
  w = makeWorld({ server: SERVER_GOOD(), tab: STALE_TAB() });
  await run(w, `removeClientGranular('PS')`);
  check('remove: payload is a single-name arrayRemove', w.calls.length === 1 && w.calls[0].clients.__op === 'remove' && w.calls[0].clients.els.join() === 'PS');
  check('remove: exactly PS left the server list, the other 13 remain', !w.doc.clients.includes('PS') && w.doc.clients.length === 13);

  // 2d. typologies: add and remove from a stale tab holding only the DEFAULT typologies
  w = makeWorld({ server: SERVER_GOOD(), tab: STALE_TAB(), failReads: true });
  await run(w, `addTypologyGranular('Brand New Typology')`);
  check('typology add: single-name arrayUnion only', w.calls.length === 1 && w.calls[0].typologies.__op === 'union' && w.calls[0].typologies.els.join() === 'Brand New Typology');
  check('typology add: the customized server list (incl. Custom Typology A) is fully preserved', SERVER_TYPOLOGIES.every((t) => w.doc.typologies.includes(t)) && w.doc.typologies.includes('Brand New Typology'));
  await run(w, `removeTypologyGranular('Brand New Typology')`);
  check('typology remove: single-name arrayRemove only, rest intact', w.calls[1].typologies.__op === 'remove' && SERVER_TYPOLOGIES.every((t) => w.doc.typologies.includes(t)) && !w.doc.typologies.includes('Brand New Typology'));

  // 2e. in-memory state follows the writes
  w = makeWorld({ server: SERVER_GOOD(), tab: STALE_TAB() });
  await run(w, `addClientGranular('NEWCO')`);
  check('in-memory clients reflects the server after an add (re-read adopted the real list)', mem(w, 'clients').includes('SUGAM') && mem(w, 'clients').includes('NEWCO'));
}

// ─────────────────────────────────────────────────────────────
console.log('\n=== 3. Case-insensitive "add client" reuses the existing spelling ===');
{
  for (const typed of ['sugam', 'Sugam', 'SUGAM', '  sugam  ', 'sUgAm']) {
    const w = makeWorld({ server: SERVER_GOOD(), tab: { clients: [...REAL_CLIENTS], typologies: [], budgetTemplates: [] } });
    const r = await run(w, `addClientGranular(${JSON.stringify(typed)})`);
    check(`typing ${JSON.stringify(typed)} -> reuses "SUGAM", creates nothing, writes nothing`,
      r.ok === true && r.created === false && r.name === 'SUGAM' && w.calls.length === 0 && w.doc.clients.filter((c) => c.toLowerCase() === 'sugam').length === 1);
  }
  // the dedup runs against the SERVER list, not a stale in-memory copy
  {
    const w = makeWorld({ server: SERVER_GOOD(), tab: STALE_TAB() }); // this tab has never heard of SUGAM
    const r = await run(w, `addClientGranular('sugam')`);
    check('a stale tab (in-memory list lacks SUGAM) typing "sugam" is still matched against the SERVER list -> SUGAM, no write', r.name === 'SUGAM' && r.created === false && w.calls.length === 0);
  }
  {
    const w = makeWorld({ server: SERVER_GOOD(), tab: { clients: [...REAL_CLIENTS], typologies: [], budgetTemplates: [] } });
    const r = await run(w, `addClientGranular('  Brand New Client  ')`);
    check('a genuinely new name is trimmed and created via arrayUnion', r.created === true && r.name === 'Brand New Client' && w.calls[0].clients.els.join() === 'Brand New Client');
    const e = makeWorld({ server: SERVER_GOOD(), tab: { clients: [...REAL_CLIENTS], typologies: [], budgetTemplates: [] } });
    const re = await run(e, `addClientGranular('   ')`);
    check('empty / whitespace-only is rejected with no write', re.ok === false && e.calls.length === 0);
    const lk = makeWorld({ server: SERVER_GOOD(), tab: { clients: [...REAL_CLIENTS], typologies: [], budgetTemplates: [] }, lockout: true });
    const rl = await run(lk, `addClientGranular('Whatever Co')`);
    check('a confirmed-stale (version-locked-out) tab writes nothing', rl.ok === false && lk.calls.length === 0);
  }
  const f = makeWorld({ server: SERVER_GOOD(), tab: STALE_TAB() });
  check('findNameCaseInsensitive: canonical spelling on a hit, null on a miss',
    run(f, `findNameCaseInsensitive(['SUGAM','Kredent'], 'kREDENT')`) === 'Kredent' && run(f, `findNameCaseInsensitive(['SUGAM'], 'nope')`) === null && run(f, `findNameCaseInsensitive(['SUGAM'], '')`) === null);
  check('sortedClients(): alphabetical copy, does not reorder the stored array',
    (() => { const g = makeWorld({ server: SERVER_GOOD(), tab: { clients: ['b', 'A', 'c'], typologies: [], budgetTemplates: [] } }); return JSON.stringify(run(g, 'sortedClients()')) === '["A","b","c"]' && JSON.stringify(mem(g, 'clients')) === '["b","A","c"]'; })());
}

// ─────────────────────────────────────────────────────────────
console.log('\n=== 4. Templates: protected, written only on explicit Save, re-read before editing ===');
{
  // The Manage Templates modal re-reads the server copy, so a stale tab's draft starts from the truth.
  let w = makeWorld({ server: SERVER_GOOD(), tab: STALE_TAB() });
  check('before the re-read, the stale tab holds no templates', mem(w, 'budgetTemplates').length === 0);
  const okRead = await run(w, 'refreshSharedListsFromServer()');
  check('refreshSharedListsFromServer() adopts the server templates (2) and clients (14)', okRead === true && mem(w, 'budgetTemplates').length === 2 && mem(w, 'clients').length === 14);
  check('refresh performs NO writes', w.calls.length === 0);

  // A failed read must never blank what the tab already has.
  w = makeWorld({ server: SERVER_GOOD(), tab: { clients: ['KEEP'], typologies: ['KEEP-T'], budgetTemplates: [{ id: 'x', name: 'Mine', pcts: {} }] }, failReads: true });
  const failed = await run(w, 'refreshSharedListsFromServer()');
  check('a FAILED re-read returns false and leaves the in-memory lists exactly as they were', failed === false && JSON.stringify(mem(w, 'clients')) === '["KEEP"]' && mem(w, 'budgetTemplates').length === 1);

  // A server doc missing a field must not replace the in-memory value with undefined.
  w = makeWorld({ server: { clients: ['ONLY'] }, tab: { clients: ['KEEP'], typologies: ['KEEP-T'], budgetTemplates: [{ id: 'x', name: 'Mine', pcts: {} }] } });
  await run(w, 'refreshSharedListsFromServer()');
  check('a server doc MISSING typologies/budgetTemplates leaves those in-memory lists untouched (never set to undefined)', JSON.stringify(mem(w, 'typologies')) === '["KEEP-T"]' && mem(w, 'budgetTemplates').length === 1 && JSON.stringify(mem(w, 'clients')) === '["ONLY"]');

  // Explicit Save writes ONLY budgetTemplates.
  w = makeWorld({ server: SERVER_GOOD(), tab: { clients: [...REAL_CLIENTS], typologies: [...SERVER_TYPOLOGIES], budgetTemplates: [{ id: 't', name: 'Edited', pcts: { 'Schematic Design': 100 } }] } });
  await run(w, 'saveBudgetTemplatesGranular()');
  check('Save Templates writes ONLY the budgetTemplates key', w.calls.length === 1 && Object.keys(w.calls[0]).join() === 'budgetTemplates');
  check('clients and typologies on the server are untouched by a templates save', JSON.stringify(w.doc.clients) === JSON.stringify(REAL_CLIENTS) && JSON.stringify(w.doc.typologies) === JSON.stringify(SERVER_TYPOLOGIES));

  // Backup-restore (deliberate REPLACE) is the only path allowed to write whole lists.
  w = makeWorld({ server: SERVER_GOOD(), tab: { clients: ['R1', 'R2'], typologies: ['RT'], budgetTemplates: [] } });
  await run(w, 'saveSharedListsReplace()');
  check('backup-restore replace writes exactly the three lists, nothing else', w.calls.length === 1 && Object.keys(w.calls[0]).sort().join() === 'budgetTemplates,clients,typologies' && w.doc.unrelated === 'keep-me');
  const replaceCalls = (fullScript.match(/saveSharedListsReplace\(/g) || []).length;
  check('saveSharedListsReplace() is used ONLY by the backup-restore handler (definition + exactly 1 call)', replaceCalls === 2);
}

// ─────────────────────────────────────────────────────────────
console.log('\n=== 5. Every consumer is wired to the new writers; no leftover wholesale path ===');
{
  const count = (re) => (fullScript.match(re) || []).length;
  check('exactly one clients.push( remains in the whole script (inside addClientGranular)', count(/\bclients\.push\(/g) === 1 && extractFunction(fullScript, 'addClientGranular').includes('clients.push('));
  check('no clients.splice( anywhere', count(/\bclients\.splice\(/g) === 0);
  check('exactly one typologies.push( remains (inside addTypologyGranular)', count(/\btypologies\.push\(/g) === 1 && extractFunction(fullScript, 'addTypologyGranular').includes('typologies.push('));
  check('no typologies.splice( anywhere', count(/\btypologies\.splice\(/g) === 0);
  const after = (anchor, len) => { const i = fullScript.indexOf(anchor); assert.ok(i >= 0, 'missing anchor ' + anchor); return fullScript.slice(i, i + len); };
  const openSrc = extractFunction(fullScript, 'openProjectModal');
  check('openProjectModal() is async and re-reads the server lists BEFORE building the dropdown', openSrc.startsWith('async function') && openSrc.indexOf('await refreshSharedListsFromServer()') > 0 && openSrc.indexOf('await refreshSharedListsFromServer()') < openSrc.indexOf('sortedClients()'));
  check('the client dropdown renders sortedClients()', openSrc.includes('sortedClients().map('));
  const saveProj = after("document.getElementById('saveProjBtn').addEventListener('click'", 1400);
  check('Save Project\'s "+ Add New Client" branch uses addClientGranular()', saveProj.includes('await addClientGranular(typedClient)') && !saveProj.includes('clients.push('));
  const addClient = after("document.getElementById('addClientBtn').addEventListener('click'", 700);
  check('Manage -> Add client uses addClientGranular(), not autoSave()', addClient.includes('await addClientGranular(v)') && !addClient.includes('autoSave('));
  const addTyp = after("document.getElementById('addTypologyBtn').addEventListener('click'", 600);
  check('Manage -> Add typology uses addTypologyGranular(), not autoSave()', addTyp.includes('await addTypologyGranular(v)') && !addTyp.includes('autoSave('));
  const manageSrc = extractFunction(fullScript, 'renderManage');
  check('Manage -> remove client uses removeClientGranular() and a case-insensitive in-use guard', manageSrc.includes('await removeClientGranular(c)') && manageSrc.includes('normListName(p.client)===normListName(c)'));
  check('Manage -> remove typology uses removeTypologyGranular()', manageSrc.includes('await removeTypologyGranular(t)'));
  check('Manage lists render sortedClients()', manageSrc.includes('sortedClients().forEach'));
  const saveTpl = after("document.getElementById('saveBudgetTemplatesBtn').addEventListener('click'", 1200);
  check('Save Templates is async and uses saveBudgetTemplatesGranular(), not autoSave()', saveTpl.includes("async () =>") && saveTpl.includes('await saveBudgetTemplatesGranular()') && !saveTpl.includes('autoSave('));
  const manageTpl = after("document.getElementById('pManageTemplatesLink').addEventListener('click'", 500);
  check('opening Manage Templates re-reads the server copy before building the draft', manageTpl.includes('await refreshSharedListsFromServer()') && manageTpl.indexOf('await refreshSharedListsFromServer()') < manageTpl.indexOf('budgetTemplatesDraft ='));
  const importSrc = after("document.getElementById('importFileInput').addEventListener('change'", 2600);
  check('backup restore persists the lists explicitly (saveSharedListsReplace) now that saveData() no longer does', importSrc.includes('await saveSharedListsReplace()'));
}

// ─────────────────────────────────────────────────────────────
console.log('\n=== 6. Isolation vs main ===');
{
  for (const name of ['loadData', 'runAttendanceAutoDeduction', 'saveUser', 'saveLeaveRequest', 'saveHolidaysGranular', 'leaveBankStatus',
    'renderApprovals', 'renderLeaves', 'renderTeamLeaveBank', 'requestWfh', 'approveWfhRequest', 'saveDailyFirebaseBackup']) {
    check(`${name}() is byte-for-byte unchanged from main`, extractFunction(fullScript, name) === extractFunction(mainScript, name));
  }
  // saveData() must differ from main ONLY in the dataToSave literal (+ its explanatory comment).
  const strip = (fn, isCur) => {
    let s = fn;
    if (isCur) s = s.replace(/\n      \/\/ V36:[\s\S]*?(?=\n      const dataToSave = \{)/, '');
    return s.replace(/const dataToSave = \{[\s\S]*?\n      \};/, 'const dataToSave = {/*P*/};');
  };
  check('saveData() differs from main ONLY in the dataToSave literal and its comment', strip(extractFunction(fullScript, 'saveData'), true) === strip(extractFunction(mainScript, 'saveData'), false));
  const lit = extractFunction(fullScript, 'saveData').match(/const dataToSave = \{([\s\S]*?)\};/)[1];
  const mainLit = extractFunction(mainScript, 'saveData').match(/const dataToSave = \{([\s\S]*?)\};/)[1];
  check('the only keys removed from the payload vs main are clients, typologies, budgetTemplates', (() => {
    const keys = (l) => l.split(/[\n,]/).map((x) => x.trim().split(':')[0].trim()).filter((x) => /^[A-Za-z]\w*$/.test(x));
    const removed = keys(mainLit).filter((k) => !keys(lit).includes(k)).sort().join();
    const added = keys(lit).filter((k) => !keys(mainLit).includes(k)).join();
    return removed === 'budgetTemplates,clients,typologies' && added === '';
  })());
  check('V36 added no write to any collection other than companyData/squareDB', ['addClientGranular', 'removeClientGranular', 'addTypologyGranular', 'removeTypologyGranular', 'saveBudgetTemplatesGranular', 'saveSharedListsReplace', 'refreshSharedListsFromServer']
    .every((n) => { const f = extractFunction(fullScript, n); const cols = [...f.matchAll(/db\.collection\('([^']+)'\)\.doc\('([^']+)'\)/g)].map((m) => m[1] + '/' + m[2]); return cols.every((c) => c === 'companyData/squareDB'); }));
  check('V36 touched no leave-bank / WFH state (no leaveRequests, medLeft, casLeft, wfhRequests in any new function)',
    FUNCS.every((n) => !/leaveRequests|medLeft|casLeft|wfhRequests/.test(extractFunction(fullScript, n))));
}

// ─────────────────────────────────────────────────────────────
console.log('\n=== 7. The restore data source is exactly what was confirmed ===');
{
  check('DEFAULT_BUDGET_TEMPLATES has exactly two templates', Array.isArray(DEFAULT_TEMPLATES) && DEFAULT_TEMPLATES.length === 2);
  const [std, heavy] = DEFAULT_TEMPLATES;
  const PH = ['Schematic Design', 'Final Design', 'Construction Documents', 'Material Selection & Coordination', 'Site Supervision', 'Project Management'];
  check('"Standard Design-Build" = 15/20/30/5/20/10', std.name === 'Standard Design-Build' && PH.map((p) => std.pcts[p]).join('/') === '15/20/30/5/20/10');
  check('"Design-Heavy" = 10/25/20/25/10/10', heavy.name === 'Design-Heavy' && PH.map((p) => heavy.pcts[p]).join('/') === '10/25/20/25/10/10');
  check('both templates sum to exactly 100%', DEFAULT_TEMPLATES.every((t) => PH.reduce((s, p) => s + t.pcts[p], 0) === 100));
  check('the 14 confirmed clients are 14 distinct names (case-insensitively)', new Set(REAL_CLIENTS.map((c) => c.toLowerCase())).size === 14);
}

// ─────────────────────────────────────────────────────────────
console.log('\n=== 8. Version ===');
{
  const bumped = /const APP_VERSION = '(\d{4}-\d{2}-\d{2}\.\d+)'/.exec(fullScript)[1];
  check(`APP_VERSION is well-formed (${bumped}) and version.json matches`, JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'version.json'), 'utf8')).version === bumped);
  check('inline <script> still parses', (() => { try { new Function(fullScript); return true; } catch (e) { console.log('    parse error:', e.message); return false; } })());
}

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);

})();
