// V38 fixture: Discrepancy Log (Version A) -- log + approval workflow only.
//
// Central claim: approving/rejecting/cancelling a discrepancy records the
// decision on the discrepancy doc and writes NOTHING else (no timeLog, leave,
// user, squareDB write). Proven by running the real functions against a mock
// Firestore that records every write. Isolation of pay / leave / attendance /
// timelog code is proven with PINNED source hashes (durable: they stay true
// after merge, unlike a diff against main). Pins were computed from main at
// 2026-10-31.3.
//
// Run with: node test/feat-discrepancy-log.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const assert = require('assert');

const REPO_ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8').split('\r\n').join('\n');
const fullScript = src.match(/<script>([\s\S]*?)<\/script>/)[1];

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log('  PASS: ' + label); pass++; } else { console.log('  FAIL: ' + label); fail++; } }

function extractFunction(source, name) {
  let st = source.indexOf('async function ' + name + '(');
  if (st < 0) st = source.indexOf('function ' + name + '(');
  assert.ok(st >= 0, 'missing function ' + name);
  const ps = source.indexOf('(', st);
  let pd = 0, j = ps;
  for (; j < source.length; j++) { if (source[j] === '(') pd++; else if (source[j] === ')') { pd--; if (!pd) break; } }
  const bs = source.indexOf('{', j);
  let d = 0, i = bs;
  for (; i < source.length; i++) { if (source[i] === '{') d++; else if (source[i] === '}') { d--; if (!d) break; } }
  return source.slice(st, i + 1);
}

const FUNCS = ['saveDiscrepancyDoc', 'refreshDiscrepanciesFromServer', 'fetchDiscrepancyFresh', 'raiseDiscrepancy', 'cancelDiscrepancy',
  'reviewDiscrepancy', 'discEsc', 'discCard', 'discHandleCancel', 'discHandleReview', 'discFillProjects', 'discUpdateRaiseBtn', 'renderDiscrepancies'];

// Mock Firestore: `server` holds the discrepancies collection; EVERY write is
// recorded as {collection, id, op}. `failReads` simulates an offline server.
function makeSandbox({ user, server = {}, memory = [], dom = null, failReads = false, prompts = [], confirmAns = true, projects = [{ id: 'p1', name: 'Villa <X>' }] }) {
  const writes = [];
  const sb = {
    currentUser: user,
    discrepancies: memory,
    projectsData: projects,
    DISC_TYPES: ['Missed log', 'Extra time', 'Correction', 'Other'],
    console: { log() {}, error() {} },
    alert: () => {},
    confirm: () => confirmAns,
    prompt: () => (prompts.length ? prompts.shift() : ''),
    genId: () => 'd' + Math.random().toString(36).slice(2, 8),
    db: {
      collection(c) {
        return {
          doc(id) {
            return {
              async set(data) { writes.push({ c, id, op: 'set' }); if (c === 'discrepancies') server[id] = { ...(server[id] || {}), ...data }; },
              async update() { writes.push({ c, id, op: 'update' }); },
              async delete() { writes.push({ c, id, op: 'delete' }); },
              async get() { if (failReads) throw new Error('offline'); const v = server[id]; return { exists: !!v, id, data: () => v }; },
            };
          },
          async get() { if (failReads) throw new Error('offline'); return { forEach(cb) { Object.keys(server).forEach((k) => cb({ id: k, data: () => server[k] })); } }; },
        };
      },
    },
    document: dom,
  };
  vm.createContext(sb);
  vm.runInContext('let discrepancies = globalThis.discrepancies; let currentUser = globalThis.currentUser;', sb);
  for (const n of FUNCS) vm.runInContext(extractFunction(fullScript, n), sb);
  return { sb, writes, server };
}
const run = (sb, expr) => vm.runInContext(expr, sb);

function fakeDom(values = {}) {
  const els = {};
  const get = (id) => els[id] || (els[id] = { id, value: values[id] || '', disabled: false, style: {}, innerHTML: '', querySelectorAll() { return []; } });
  return { getElementById: get };
}

const ALICE = { id: 'a1', name: 'Alice', isAdmin: false };
const BOB = { id: 'b1', name: 'Bob', isAdmin: false };
const HR = { id: 'hr', name: 'HR Admin', isAdmin: true };
const input = (o) => ({ date: '2026-11-20', type: 'Missed log', project: 'Villa', hours: '2h', description: 'Forgot to log site visit', ...o });
const pendingDoc = (o) => ({ id: 'q1', userId: 'a1', userName: 'Alice', date: '2026-11-20', type: 'Missed log', project: 'Villa', hours: '2h', description: 'x', status: 'pending', raisedAt: '2026-11-21T00:00:00.000Z', reviewedBy: null, reviewedAt: null, reviewNote: '', ...o });

(async () => {
  console.log('=== 1. Raise: required fields enforced, doc shape ===');
  {
    let t = makeSandbox({ user: ALICE });
    let r = await run(t.sb, `raiseDiscrepancy(${JSON.stringify(input({ date: '' }))})`);
    check('missing date -> refused, nothing written', !r.ok && t.writes.length === 0);
    r = await run(t.sb, `raiseDiscrepancy(${JSON.stringify(input({ description: '' }))})`);
    check('missing description -> refused', !r.ok && t.writes.length === 0);
    r = await run(t.sb, `raiseDiscrepancy(${JSON.stringify(input({ description: '   \n ' }))})`);
    check('whitespace-only description -> refused', !r.ok && t.writes.length === 0);
    r = await run(t.sb, `raiseDiscrepancy(${JSON.stringify(input({ type: 'Hack' }))})`);
    check('type outside the 4 allowed -> refused', !r.ok && t.writes.length === 0);
    for (const ty of ['Missed log', 'Extra time', 'Correction', 'Other']) {
      const x = makeSandbox({ user: ALICE });
      const rr = await run(x.sb, `raiseDiscrepancy(${JSON.stringify(input({ type: ty }))})`);
      check(`type "${ty}" accepted`, rr.ok);
    }
    t = makeSandbox({ user: ALICE });
    r = await run(t.sb, `raiseDiscrepancy(${JSON.stringify(input({ project: '', hours: '', description: '  Late site visit  ' }))})`);
    const d = t.server[r.doc.id];
    check('valid raise -> ok, one write, only to discrepancies', r.ok && t.writes.length === 1 && t.writes[0].c === 'discrepancies' && t.writes[0].op === 'set');
    check('doc has exactly the specified fields',
      JSON.stringify(Object.keys(d).sort()) === JSON.stringify(['date', 'description', 'hours', 'id', 'project', 'raisedAt', 'reviewNote', 'reviewedAt', 'reviewedBy', 'status', 'type', 'userId', 'userName']));
    check('status pending, requester id/name stamped, description trimmed, blank project -> "N/A"', d.status === 'pending' && d.userId === 'a1' && d.userName === 'Alice' && d.description === 'Late site visit' && d.project === 'N/A');
    check('reviewedBy / reviewedAt null, reviewNote empty at creation', d.reviewedBy === null && d.reviewedAt === null && d.reviewNote === '');
    check('in-memory list gets the new doc', t.sb.discrepancies.length === 1);
  }

  console.log('\n=== 2. Raise button disabled until date AND description ===');
  {
    for (const [d, desc, dis] of [['', '', true], ['2026-11-20', '', true], ['', 'x', true], ['2026-11-20', '   ', true], ['2026-11-20', 'x', false]]) {
      const dom = fakeDom({ discDateInput: d, discDescInput: desc });
      const t = makeSandbox({ user: ALICE, dom });
      dom.getElementById('discRaiseBtn').disabled = !dis;
      run(t.sb, 'discUpdateRaiseBtn()');
      check(`date="${d}" desc="${desc.trim()}" -> disabled=${dis}`, dom.getElementById('discRaiseBtn').disabled === dis);
    }
    check('button is rendered disabled by default; type/project/hours/description inputs exist',
      /id="discRaiseBtn" disabled>/.test(src) && ['discTypeInput', 'discProjectInput', 'discHoursInput', 'discDescInput', 'discDateInput'].every((i) => src.includes(`id="${i}"`)));
  }

  console.log('\n=== 3. Status transitions ===');
  {
    let t = makeSandbox({ user: HR, server: { q1: pendingDoc() }, memory: [pendingDoc()] });
    let r = await run(t.sb, `reviewDiscrepancy('q1', 'approved', '')`);
    check('admin approves pending -> approved, reviewedBy/At stamped', r.ok && t.server.q1.status === 'approved' && t.server.q1.reviewedBy === 'HR Admin' && !!t.server.q1.reviewedAt);
    r = await run(t.sb, `reviewDiscrepancy('q1', 'rejected', 'x')`);
    check('approved is final: cannot be rejected afterwards', !r.ok && t.server.q1.status === 'approved');

    t = makeSandbox({ user: HR, server: { q1: pendingDoc() }, memory: [pendingDoc()] });
    r = await run(t.sb, `reviewDiscrepancy('q1', 'rejected', '  Not billable  ')`);
    check('admin rejects with a note -> rejected, note stored trimmed', r.ok && t.server.q1.status === 'rejected' && t.server.q1.reviewNote === 'Not billable');
    t = makeSandbox({ user: HR, server: { q1: pendingDoc() }, memory: [pendingDoc()] });
    r = await run(t.sb, `reviewDiscrepancy('q1', 'rejected')`);
    check('reject without a note is allowed (note optional)', r.ok && t.server.q1.reviewNote === '');

    t = makeSandbox({ user: ALICE, server: { q1: pendingDoc() }, memory: [pendingDoc()] });
    r = await run(t.sb, `reviewDiscrepancy('q1', 'approved', '')`);
    check('non-admin cannot approve (even their own)', !r.ok && t.server.q1.status === 'pending' && t.writes.length === 0);

    t = makeSandbox({ user: HR, server: { q1: pendingDoc() }, memory: [pendingDoc()] });
    r = await run(t.sb, `reviewDiscrepancy('q1', 'weird', '')`);
    check('invalid decision refused', !r.ok && t.writes.length === 0);

    // Stale in-memory copy says pending, server says cancelled -> the review must not overwrite it.
    t = makeSandbox({ user: HR, server: { q1: pendingDoc({ status: 'cancelled' }) }, memory: [pendingDoc()] });
    r = await run(t.sb, `reviewDiscrepancy('q1', 'approved', '')`);
    check('stale tab: server copy is cancelled -> approve refused, nothing written (race closed)', !r.ok && t.server.q1.status === 'cancelled' && t.writes.length === 0);

    t = makeSandbox({ user: HR, server: { q1: pendingDoc() }, memory: [pendingDoc()], failReads: true });
    r = await run(t.sb, `reviewDiscrepancy('q1', 'approved', '')`);
    check('server unreachable -> refused, nothing written (never decides on unverified state)', !r.ok && t.writes.length === 0);
  }

  console.log('\n=== 4. Cancel own pending (same pattern as WFH) ===');
  {
    let t = makeSandbox({ user: ALICE, server: { q1: pendingDoc() }, memory: [pendingDoc()] });
    let r = await run(t.sb, `cancelDiscrepancy('q1')`);
    check('requester cancels own pending -> cancelled, doc kept with original fields', r.ok && t.server.q1.status === 'cancelled' && t.server.q1.description === 'x' && t.server.q1.userId === 'a1');
    check('cancel wrote exactly one doc (op set, discrepancies) -- no delete', t.writes.length === 1 && t.writes[0].c === 'discrepancies' && t.writes[0].op === 'set');
    check('in-memory copy updated to cancelled', t.sb.discrepancies[0].status === 'cancelled');

    t = makeSandbox({ user: BOB, server: { q1: pendingDoc() }, memory: [pendingDoc()] });
    r = await run(t.sb, `cancelDiscrepancy('q1')`);
    check("another member cannot cancel someone else's", !r.ok && t.server.q1.status === 'pending' && t.writes.length === 0);
    t = makeSandbox({ user: HR, server: { q1: pendingDoc() }, memory: [pendingDoc()] });
    r = await run(t.sb, `cancelDiscrepancy('q1')`);
    check("admin cannot cancel someone else's via Cancel (they Approve/Reject)", !r.ok && t.server.q1.status === 'pending');

    for (const st of ['approved', 'rejected', 'cancelled']) {
      t = makeSandbox({ user: ALICE, server: { q1: pendingDoc({ status: st }) }, memory: [pendingDoc()] });
      r = await run(t.sb, `cancelDiscrepancy('q1')`);
      check(`a ${st} discrepancy cannot be cancelled (checked against the SERVER copy)`, !r.ok && t.server.q1.status === st && t.writes.length === 0);
    }
    t = makeSandbox({ user: ALICE, server: { q1: pendingDoc() }, memory: [pendingDoc()] });
    await run(t.sb, `cancelDiscrepancy('q1')`);
    const r2 = await run(t.sb, `reviewDiscrepancy('q1','approved','')`);
    check('a cancelled discrepancy leaves the pending set (and cannot be reviewed)', t.sb.discrepancies.filter((d) => d.status === 'pending').length === 0 && !r2.ok);
  }

  console.log('\n=== 5. Cancel / approve / reject free nothing and write NO time, leave or pay data ===');
  {
    const ops = [
      ['approve', HR, `reviewDiscrepancy('q1','approved','')`],
      ['reject', HR, `reviewDiscrepancy('q1','rejected','n')`],
      ['cancel', ALICE, `cancelDiscrepancy('q1')`],
      ['raise', ALICE, `raiseDiscrepancy(${JSON.stringify(input({ type: 'Extra time', hours: '5' }))})`],
    ];
    for (const [name, user, expr] of ops) {
      const t = makeSandbox({ user, server: { q1: pendingDoc() }, memory: [pendingDoc()] });
      // Sentinels: if any function touched these globals the test would see it.
      t.sb.timeLogs = []; t.sb.leaveRequests = []; t.sb.users = [{ id: 'a1', medLeft: 12, casLeft: 5 }]; t.sb.wfhRequests = [];
      const before = JSON.stringify([t.sb.timeLogs, t.sb.leaveRequests, t.sb.users, t.sb.wfhRequests]);
      await run(t.sb, expr);
      check(`${name}: every write went to the "discrepancies" collection only`, t.writes.length >= 1 && t.writes.every((w) => w.c === 'discrepancies' && w.op === 'set'));
      check(`${name}: no timeLogs / leave / users / wfh state changed in memory`, JSON.stringify([t.sb.timeLogs, t.sb.leaveRequests, t.sb.users, t.sb.wfhRequests]) === before);
    }
    const code = FUNCS.map((n) => extractFunction(fullScript, n)).join('\n').replace(/\/\/.*$/gm, '');
    check('discrepancy code references no timeLog / leave / pay / attendance / deduction identifiers',
      !/timeLogs|saveTimeLog|upsertTimeLog|leaveRequests|saveLeaveRequest|medLeft|casLeft|runAttendanceAutoDeduction|leaveBank|saveUser|saveData|autoSave|wfhRequests/.test(code));
    check('only collection ever named by discrepancy code is "discrepancies"', [...code.matchAll(/collection\(\s*['"]([^'"]+)['"]/g)].every((m) => m[1] === 'discrepancies'));
  }

  console.log('\n=== 6. HTML-escaping of every free-text field ===');
  {
    const evil = pendingDoc({ type: 'Other', userName: '<img src=x onerror=1>', project: '"><script>1</script>', hours: '<b>3</b>', description: '<script>alert(1)</script> & \'q\'', reviewedBy: '<i>hr</i>', reviewNote: '<u>no</u>', status: 'rejected' });
    const t = makeSandbox({ user: HR });
    const html = run(t.sb, `discCard(${JSON.stringify(evil)}, {showReview:false, showCancel:false})`);
    check('no raw < from user fields survives into the card (only the template\'s own tags)',
      !/<script|<img|<b>3|<i>hr|<u>no/.test(html));
    check('description escaped incl. & and quotes', html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &#39;q&#39;'));
    check('reviewNote / reviewedBy / project / hours / userName all escaped', ['&lt;u&gt;no', '&lt;i&gt;hr', '&quot;&gt;&lt;script&gt;', '&lt;b&gt;3', '&lt;img src=x'].every((s) => html.includes(s)));
    const dom = fakeDom();
    const t2 = makeSandbox({ user: ALICE, dom, projects: [{ id: 'p', name: 'Villa <X> "Q"' }] });
    run(t2.sb, 'discFillProjects()');
    const opts = dom.getElementById('discProjectInput').innerHTML;
    check('project dropdown options are escaped too', opts.includes('Villa &lt;X&gt; &quot;Q&quot;') && !opts.includes('<X>'));
  }

  console.log('\n=== 7. Rendering: member list, admin queue, resolved log ===');
  {
    const all = [
      pendingDoc({ id: 'm1', description: 'mine pending' }),
      pendingDoc({ id: 'm2', status: 'cancelled', description: 'mine cancelled' }),
      pendingDoc({ id: 'o1', userId: 'b1', userName: 'Bob', description: 'bobs pending' }),
      pendingDoc({ id: 'o2', userId: 'b1', userName: 'Bob', status: 'approved', reviewedBy: 'HR Admin', reviewedAt: '2026-11-22T00:00:00.000Z', description: 'bobs approved' }),
      pendingDoc({ id: 'o3', userId: 'b1', userName: 'Bob', status: 'rejected', reviewedBy: 'HR Admin', reviewedAt: '2026-11-23T00:00:00.000Z', reviewNote: 'dup', description: 'bobs rejected' }),
    ];
    const server = Object.fromEntries(all.map((d) => [d.id, d]));

    const domA = fakeDom();
    const ta = makeSandbox({ user: ALICE, server, dom: domA });
    await run(ta.sb, 'renderDiscrepancies()');
    const mine = domA.getElementById('discMyList').innerHTML;
    check("member sees only their own items, with status badges", mine.includes('mine pending') && mine.includes('mine cancelled') && !mine.includes('bobs'));
    check('member gets Cancel only on their pending item', (mine.match(/disc-cancel/g) || []).length === 1);
    check('member cannot see the admin sections', domA.getElementById('discAdminSection').style.display === 'none');
    check('cancelled item shows a cancelled badge', mine.includes('>cancelled<'));

    const domH = fakeDom();
    const th = makeSandbox({ user: HR, server, dom: domH });
    await run(th.sb, 'renderDiscrepancies()');
    const pend = domH.getElementById('discPendingList').innerHTML;
    check("admin queue lists ALL members' pending items with Approve and Reject", pend.includes('mine pending') && pend.includes('bobs pending') && (pend.match(/disc-approve/g) || []).length === 2 && (pend.match(/disc-reject/g) || []).length === 2);
    check('cancelled / resolved items are not in the pending queue', !pend.includes('mine cancelled') && !pend.includes('bobs approved') && !pend.includes('bobs rejected'));
    const res = domH.getElementById('discResolvedList').innerHTML;
    check('resolved log holds approved + rejected only, with reviewer/note, newest first', res.includes('bobs approved') && res.includes('bobs rejected') && res.includes('dup') && !res.includes('pending') && res.indexOf('bobs rejected') < res.indexOf('bobs approved'));
    check('admin sections shown for admin', domH.getElementById('discAdminSection').style.display === 'block');

    const domF = fakeDom();
    const tf = makeSandbox({ user: ALICE, server: {}, memory: [pendingDoc({ id: 'keep' })], dom: domF, failReads: true });
    await run(tf.sb, 'renderDiscrepancies()');
    check('failed server read keeps the in-memory list (never blanks)', tf.sb.discrepancies.length === 1 && domF.getElementById('discMyList').innerHTML.includes('Missed log'));

    // Reject flow: prompt gives the optional note; Cancel on the prompt aborts.
    let tr = makeSandbox({ user: HR, server: { q1: pendingDoc() }, memory: [pendingDoc()], dom: fakeDom(), prompts: [null] });
    await run(tr.sb, `discHandleReview('q1','rejected')`);
    check('dismissing the reject prompt aborts (nothing written)', tr.writes.length === 0 && tr.server.q1.status === 'pending');
    tr = makeSandbox({ user: HR, server: { q1: pendingDoc() }, memory: [pendingDoc()], dom: fakeDom(), prompts: ['too late'] });
    await run(tr.sb, `discHandleReview('q1','rejected')`);
    check('reject prompt text becomes the reviewNote', tr.server.q1.status === 'rejected' && tr.server.q1.reviewNote === 'too late');
  }

  console.log('\n=== 8. Wiring ===');
  {
    check('nav item + page exist, and the nav dispatch renders the page', /data-page="discrepancies"/.test(src) && /id="page-discrepancies"/.test(src) && /if\(page==='discrepancies'\) renderDiscrepancies\(\);/.test(fullScript));
    check('loaded on page open (not via loadData / saveData payload)', !/discrepanc/i.test(extractFunction(fullScript, 'loadData')) && !/discrepanc/i.test(extractFunction(fullScript, 'saveData')));
    check('nav item is open to everyone (not admin-only)', !/data-page="discrepancies"[^>]*admin/i.test(src));
  }

  console.log('\n=== 9. Isolation: pay / leave / attendance / timelog code untouched (pinned hashes) ===');
  {
    const PINS = {
      runAttendanceAutoDeduction: '94d98ae58a6423e8',
      leaveBankStatus: '315d9aa70b61c63e',
      saveLeaveRequest: 'a247cf0906837b36',
      saveUser: '350bf8a456eba738',
      loadData: 'c6d2d9b007e1bcf3',
      renderApprovals: '93c19c8dc923005f',
      renderLeaves: '790b107ca86b7e6c',
      renderTeamLeaveBank: 'ad6068dfd80dd23f',
      saveTimeLog: 'ba7c5aa53a2cacab',
      upsertTimeLog: '102da40ec007d818',
      saveLog: '463b27f61aa2dd8c',
      saveData: 'f73f8f42dead231c',
      approveWfhRequest: '44df6c6f41a82c38',
      rejectWfhRequest: '7f05f828308654fb',
      cancelWfhRequest: 'a60a8ca0e4664672',
      saveWfhDoc: '7279e927735af728',
      requestWfh: '08d40a1709483ae4',
    };
    for (const [n, h] of Object.entries(PINS)) {
      check(`${n}() unchanged (pinned)`, crypto.createHash('sha256').update(extractFunction(fullScript, n)).digest('hex').slice(0, 16) === h);
    }
  }

  console.log('\n=== 10. Version + parse ===');
  {
    const v = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'version.json'), 'utf8')).version;
    const av = (fullScript.match(/const APP_VERSION = '([^']+)'/) || [])[1];
    check('version.json matches APP_VERSION and is well-formed', v === av && /^\d{4}-\d{2}-\d{2}\.\d+$/.test(v));
    check('inline script parses', (() => { try { new Function(fullScript); return true; } catch (e) { return false; } })());
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
