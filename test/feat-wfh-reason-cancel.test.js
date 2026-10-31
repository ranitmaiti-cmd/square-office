// V37 fixture: WFH required Reason + Cancel/revert of an approved WFH day.
//
// Durable by design (lesson from V36): isolation is proven with PINNED source
// hashes of the untouched pay / leave / attendance / WFH-policy functions
// (computed from main at V36, `2026-10-31.1`), not a live diff against main --
// a diff-vs-main check turns false the moment the change it guards merges.
// If one of these functions is changed ON PURPOSE in a later build, update its
// pin deliberately in that build.
//
// Run with: node test/feat-wfh-reason-cancel.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const assert = require('assert');

const REPO_ROOT = path.join(__dirname, '..');
const norm = (s) => s.split('\r\n').join('\n');
const src = norm(fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8'));
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

const NOW = '2026-09-24T10:00:00';
const RealDate = Date;

function makeSandbox({ user, requests = [], timeLogs = [], dom = null }) {
  const writes = {};
  const sb = {
    currentUser: user,
    wfhRequests: requests,
    timeLogs,
    users: [],
    console,
    alert: () => {},
    genId: () => 'id' + Math.random().toString(36).slice(2, 8),
    Date: class extends RealDate { constructor(...a) { if (a.length === 0) { super(NOW); return; } super(...a); } },
    db: { collection(n) { return { doc(id) { return { async set(data) { (writes[n] = writes[n] || {})[id] = data; } }; } }; } },
    document: dom,
  };
  vm.createContext(sb);
  for (const n of ['fmt', 'saveWfhDoc', 'wfhMonthKey', 'wfhApprovedInMonth', 'requestWfh', 'wfhApprovalBlockedReason', 'approveWfhRequest',
    'wfhCanCancel', 'cancelWfhRequest', 'wfhEsc', 'wfhReasonLine', 'wfhRequestCard', 'wfhWorkedFlag', 'renderWfh', 'wfhUpdateRequestBtn']) {
    vm.runInContext(extractFunction(fullScript, n), sb);
  }
  return { sb, writes };
}
const run = (sb, expr) => vm.runInContext(expr, sb);

// Minimal fake DOM keyed by element id.
function fakeDom(values = {}) {
  const els = {};
  const get = (id) => els[id] || (els[id] = {
    id, value: values[id] || '', disabled: false, style: {}, innerHTML: '',
    querySelectorAll() { return []; },
  });
  return { getElementById: get, els };
}

const ALICE = { id: 'a1', name: 'Alice', wfhEligible: true, isAdmin: false };
const BOB = { id: 'b1', name: 'Bob', wfhEligible: true, isAdmin: false };
const ADMIN = { id: 'ad', name: 'Admin', wfhEligible: true, isAdmin: true };
const TOMORROW = '2026-09-25';

(async () => {
  console.log('=== 1. Form: reason field, button disabled until date AND reason ===');
  {
    const html = src;
    check('form has a #wfhReasonInput text field next to the date', /id="wfhReasonInput"/.test(html) && html.indexOf('id="wfhDateInput"') < html.indexOf('id="wfhReasonInput"') && html.indexOf('id="wfhReasonInput"') < html.indexOf('id="wfhRequestBtn"'));
    check('Request button is rendered disabled by default', /id="wfhRequestBtn" disabled>/.test(html));
    const cases = [['', '', true], ['2026-09-25', '', true], ['', 'doctor', true], ['2026-09-25', '   ', true], ['2026-09-25', 'plumber visit', false]];
    for (const [d, r, expectDisabled] of cases) {
      const dom = fakeDom({ wfhDateInput: d, wfhReasonInput: r });
      const { sb } = makeSandbox({ user: ALICE, dom });
      dom.getElementById('wfhRequestBtn').disabled = !expectDisabled;
      run(sb, 'wfhUpdateRequestBtn()');
      check(`date="${d}" reason="${r}" -> disabled=${expectDisabled}`, dom.getElementById('wfhRequestBtn').disabled === expectDisabled);
    }
  }

  console.log('\n=== 2. requestWfh: reason required + stored ===');
  {
    const { sb, writes } = makeSandbox({ user: ALICE });
    const none = await run(sb, `requestWfh('${TOMORROW}')`);
    check('no reason -> refused, nothing written', !none.ok && !writes.wfhRequests && sb.wfhRequests.length === 0);
    const blank = await run(sb, `requestWfh('${TOMORROW}', '   ')`);
    check('whitespace-only reason -> refused', !blank.ok && !writes.wfhRequests);
    const ok = await run(sb, `requestWfh('${TOMORROW}', '  Plumber visit  ')`);
    const saved = writes.wfhRequests && Object.values(writes.wfhRequests)[0];
    check('valid reason -> ok', ok.ok);
    check('reason stored on the wfhRequests doc (trimmed)', saved && saved.reason === 'Plumber visit');
    check('in-memory doc carries the reason', sb.wfhRequests[0].reason === 'Plumber visit');
    const past = await run(sb, `requestWfh('2026-09-01', 'x')`);
    check('existing 1-day-advance rule still applies with a reason', !past.ok && /advance/.test(past.reason));
  }

  console.log('\n=== 3. Reason displayed in all three places (and escaped) ===');
  {
    const reqs = [
      { id: 'r1', userId: 'a1', userName: 'Alice', date: '2026-09-30', status: 'pending', reason: 'Plumber visit' },
      { id: 'r2', userId: 'a1', userName: 'Alice', date: '2026-10-05', status: 'approved', reason: 'Boiler <b>repair</b> & "fix"' },
    ];
    const dom = fakeDom();
    const { sb } = makeSandbox({ user: ADMIN, requests: reqs, dom });
    run(sb, 'renderWfh()');
    const mine = dom.getElementById('wfhMyList').innerHTML; // admin is also eligible, but these are Alice's
    const { sb: sbA } = makeSandbox({ user: ALICE, requests: reqs, dom: fakeDom() });
    const domA = sbA.document; run(sbA, 'renderWfh()');
    check('(a) My WFH requests card shows the reason', domA.getElementById('wfhMyList').innerHTML.includes('Reason: Plumber visit'));
    check('(b) Pending approvals card shows the reason', dom.getElementById('wfhPendingList').innerHTML.includes('Reason: Plumber visit'));
    check('(c) Approved WFH log shows the reason', dom.getElementById('wfhApprovedList').innerHTML.includes('Reason: Boiler'));
    const approvedHtml = dom.getElementById('wfhApprovedList').innerHTML;
    check('reason is HTML-escaped (no raw <b> injected)', !approvedHtml.includes('<b>repair') && approvedHtml.includes('&lt;b&gt;repair&lt;/b&gt; &amp; &quot;fix&quot;'));
    const legacy = run(sb, `wfhRequestCard({id:'o',userName:'Old',date:'2026-01-01',status:'approved'}, {showActions:false})`);
    check('legacy doc without a reason renders cleanly (no "Reason:" line)', !legacy.includes('Reason:'));
  }

  console.log('\n=== 4. Cancel / revert ===');
  {
    const approved = (over) => ({ id: 'x1', userId: 'a1', userName: 'Alice', date: '2026-09-30', status: 'approved', reason: 'r', ...over });

    let t = makeSandbox({ user: ALICE, requests: [approved()] });
    let r = await run(t.sb, `cancelWfhRequest('x1')`);
    check('requester cancels own approved future day -> ok', r.ok && t.sb.wfhRequests[0].status === 'cancelled');
    check('cancelled doc is kept (not deleted) with who/when', t.writes.wfhRequests.x1.status === 'cancelled' && t.writes.wfhRequests.x1.cancelledBy === 'Alice' && !!t.writes.wfhRequests.x1.cancelledAt && t.writes.wfhRequests.x1.reason === 'r');

    t = makeSandbox({ user: ALICE, requests: [approved({ date: '2026-09-24' })] });
    r = await run(t.sb, `cancelWfhRequest('x1')`);
    check('requester cannot cancel on the day itself', !r.ok && t.sb.wfhRequests[0].status === 'approved');

    t = makeSandbox({ user: ALICE, requests: [approved({ date: '2026-09-10' })] });
    r = await run(t.sb, `cancelWfhRequest('x1')`);
    check('requester cannot cancel a past day', !r.ok && t.sb.wfhRequests[0].status === 'approved');

    t = makeSandbox({ user: BOB, requests: [approved()] });
    r = await run(t.sb, `cancelWfhRequest('x1')`);
    check("a different non-admin cannot cancel someone else's day", !r.ok && t.sb.wfhRequests[0].status === 'approved');

    t = makeSandbox({ user: ADMIN, requests: [approved()] });
    r = await run(t.sb, `cancelWfhRequest('x1')`);
    check('admin can revert an approved future day', r.ok && t.sb.wfhRequests[0].status === 'cancelled');
    t = makeSandbox({ user: ADMIN, requests: [approved({ date: '2026-09-10' })] });
    r = await run(t.sb, `cancelWfhRequest('x1')`);
    check('admin can revert an approved past day too', r.ok && t.sb.wfhRequests[0].status === 'cancelled');

    t = makeSandbox({ user: ADMIN, requests: [approved({ status: 'pending' })] });
    r = await run(t.sb, `cancelWfhRequest('x1')`);
    check('a pending request cannot be "cancelled" through this path', !r.ok && t.sb.wfhRequests[0].status === 'pending');

    t = makeSandbox({ user: ALICE, requests: [approved({ status: 'rejected' })] });
    check('rejected/cancelled docs are not cancellable', !run(t.sb, `wfhCanCancel(wfhRequests[0])`));

    // Frees the monthly slot (reuses wfhApprovedInMonth, unchanged).
    t = makeSandbox({ user: ALICE, requests: [approved({ date: '2026-09-28' })] });
    let blocked = await run(t.sb, `requestWfh('2026-09-30', 'again')`);
    check('BEFORE cancel: month already has an approved day -> new request blocked', !blocked.ok && /already have an approved/.test(blocked.reason));
    await run(t.sb, `cancelWfhRequest('x1')`);
    check('wfhApprovedInMonth no longer counts the cancelled day', run(t.sb, `wfhApprovedInMonth('a1','2026-09-30',null)`) === false);
    const again = await run(t.sb, `requestWfh('2026-09-30', 'again')`);
    check('AFTER cancel: a new request in the same month succeeds', again.ok);

    // Frees the 2-per-date count.
    const two = [
      { id: 'p1', userId: 'u1', userName: 'P1', date: '2026-09-30', status: 'approved' },
      { id: 'p2', userId: 'u2', userName: 'P2', date: '2026-09-30', status: 'approved' },
      { id: 'p3', userId: 'u3', userName: 'P3', date: '2026-09-30', status: 'pending' },
    ];
    t = makeSandbox({ user: ADMIN, requests: two });
    check('BEFORE cancel: 3rd person blocked on a date with 2 approved', /max per date/.test(run(t.sb, `wfhApprovalBlockedReason(wfhRequests[2])`) || ''));
    await run(t.sb, `cancelWfhRequest('p1')`);
    check('AFTER cancel: the date has a free slot again', run(t.sb, `wfhApprovalBlockedReason(wfhRequests[2])`) === null);
    const ap = await run(t.sb, `approveWfhRequest('p3')`);
    check('AFTER cancel: the waiting request can now be approved', ap.ok && t.sb.wfhRequests[2].status === 'approved');

    // UI wiring.
    const dom = fakeDom();
    t = makeSandbox({ user: ALICE, requests: [approved(), approved({ id: 'x2', date: '2026-09-10', status: 'approved' })], dom });
    const card = run(t.sb, `wfhRequestCard(wfhRequests[0], {showActions:false, showCancel:true})`);
    const pastCard = run(t.sb, `wfhRequestCard(wfhRequests[1], {showActions:false, showCancel:true})`);
    check('My-requests card shows Cancel on own future approved day', card.includes('wfh-cancel') && card.includes('data-id="x1"'));
    check('My-requests card shows NO Cancel on a past approved day', !pastCard.includes('wfh-cancel'));
    const domAdmin = fakeDom();
    const ta = makeSandbox({ user: ADMIN, requests: [approved()], dom: domAdmin });
    run(ta.sb, 'renderWfh()');
    check('Approved log has a Cancel (revert) button for the admin', domAdmin.getElementById('wfhApprovedList').innerHTML.includes('wfh-cancel'));
    const cancelledCard = run(t.sb, `wfhRequestCard({id:'c',userName:'A',date:'2026-10-01',status:'cancelled',reason:'q'}, {showActions:false, showCancel:true})`);
    check('cancelled request shows a "cancelled" badge and no Cancel button', cancelledCard.includes('>cancelled<') && !cancelledCard.includes('wfh-cancel'));
    const domC = fakeDom();
    const tc = makeSandbox({ user: ADMIN, requests: [approved({ status: 'cancelled' })], dom: domC });
    run(tc.sb, 'renderWfh()');
    check('cancelled day disappears from the Approved log', domC.getElementById('wfhApprovedList').innerHTML.includes('No approved WFH days yet'));
  }

  console.log('\n=== 5. Isolation: pay / leave / attendance / WFH-policy code untouched (pinned hashes) ===');
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
      approveWfhRequest: '44df6c6f41a82c38',
      rejectWfhRequest: '7f05f828308654fb',
      wfhApprovedInMonth: '14638160b6f0ae46',
      wfhApprovalBlockedReason: 'fdc46195ba8c37b3',
      saveWfhDoc: '7279e927735af728',
      wfhMonthKey: 'b1da52293b8bc14e',
      wfhWorkedFlag: '31f75d2c3875b889',
    };
    for (const [n, h] of Object.entries(PINS)) {
      const got = crypto.createHash('sha256').update(extractFunction(fullScript, n)).digest('hex').slice(0, 16);
      check(`${n}() unchanged (pinned)`, got === h);
    }
    for (const n of ['wfhCanCancel', 'cancelWfhRequest', 'wfhEsc', 'wfhReasonLine', 'wfhHandleCancel']) {
      const f = extractFunction(fullScript, n);
      check(`${n}() touches no leave/pay/attendance state`, !/leaveRequests|medLeft|casLeft|timeLogs|users\b|leaveBank|deduct/i.test(f.replace(/\/\/.*$/gm, '')));
    }
    const cancelSrc = extractFunction(fullScript, 'cancelWfhRequest');
    check('cancel writes only through saveWfhDoc (wfhRequests collection)', cancelSrc.includes('saveWfhDoc(') && !/db\.collection/.test(cancelSrc));
  }

  console.log('\n=== 6. Version + parse ===');
  {
    const v = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'version.json'), 'utf8')).version;
    const av = (fullScript.match(/const APP_VERSION = '([^']+)'/) || [])[1];
    check('version.json matches APP_VERSION and is well-formed', v === av && /^\d{4}-\d{2}-\d{2}\.\d+$/.test(v));
    check('inline script parses', (() => { try { new Function(fullScript); return true; } catch (e) { return false; } })());
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
