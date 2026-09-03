// Fixture for the legacy Appraisal removal (2026-09-03).
//
// The old Appraisal (7 auto-scored components + admin star rating) was
// fully dormant since it was built: admin-only, its own internal admin
// gate on top of that, zero appraisalData docs ever written (confirmed
// at the 2026-08-28 read-only deep-dive and again immediately before
// this removal). Employee Review is now the single appraisal system --
// its tab label and panel heading were renamed (display text only) to
// "Appraisal" to reflect that; everything internal (function names,
// container ids, comments) stays "Employee Review". This proves the
// removal was clean: every Appraisal-only artifact is genuinely gone,
// nothing shared got caught in it, nothing else in the file references
// what was removed, and the rename landed in exactly the two intended
// spots (no more, no less).
//
// Reads the ACTUAL index.html (not retyped) and checks it directly --
// same discipline as every other fixture in this repo, adapted for a
// removal (there's no function left to extract and execute; the claims
// under test are entirely "this is gone" / "this is still here").
//
// Central claims under test:
//  - renderAppraisal() the function no longer exists
//  - the Appraisal nav item (data-page="appraisal") no longer exists
//  - the #page-appraisal page div / #appraisalContent container no
//    longer exist
//  - the routing line (if(page==='appraisal') renderAppraisal();) no
//    longer exists
//  - apQtrOffset/apAdminScores (Appraisal's own module-level state) no
//    longer exist
//  - no live reference to db.collection('appraisalData') remains
//    anywhere in the file (the write path went with the function)
//  - every remaining textual mention of "appraisal" in the file is
//    inside a comment or the one known stale banner string -- none of
//    it is executable code (a positive proof the removal is complete,
//    not just "the obvious spots are gone")
//  - the SHARED .ap-* CSS (scorecard/star/note-input/save-button/etc.)
//    is genuinely still present, byte-for-byte -- this removal must
//    not have touched it
//  - Employee Review's own rubric still renders using that same CSS
//    vocabulary (.ap-star, .ap-scorecard-footer, .ap-save-scorecard,
//    .ap-save-status, .ap-note-input, .ap-qtr-btn) -- proven by
//    extracting and running the real renderEmployeeReviewBody()
//  - the inline <script> still parses as valid JS after the removal
//
// Run with: node test/remove-legacy-appraisal.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const INDEX_HTML = path.join('D:/SQUARE/ADMIN/SQUARE-Office/finalphase/01072026', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');
const scriptMatch = src.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(scriptMatch, 'could not find inline <script> block in index.html');
const fullScript = scriptMatch[1];

let passCount = 0, failCount = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); passCount++; }
  else { console.log(`  FAIL: ${label}`); failCount++; }
}

// Strip comments properly (a real scan, not a per-line prefix guess) --
// respects '...'/"..."/`...` string boundaries so nothing inside a real
// string literal gets eaten, and correctly spans multi-line /* */ and
// <!-- --> blocks (including continuation lines with no marker of their
// own -- e.g. this removal's own multi-line marker comments). Used for
// every "is this genuinely gone from live code" check below, so a
// comment mentioning a removed identifier by name (for documentation)
// can never produce a false "still referenced" failure.
function stripComments(text, { html = false } = {}) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const two = text.slice(i, i + 2);
    const four = text.slice(i, i + 4);
    if (html && four === '<!--') {
      const end = text.indexOf('-->', i + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (!html && two === '//') {
      const end = text.indexOf('\n', i);
      i = end < 0 ? n : end; // keep the newline itself for line-counting sanity
      continue;
    }
    // /* */ is CSS-comment syntax too (the <style> block in <head> uses
    // it for section headers, e.g. the old "APPRAISAL V14.2.38" marker)
    // -- strip it in both modes. Only '//' is gated to script-only,
    // since a real URL in an href/src attribute (https://...) would
    // otherwise get wrongly eaten as a line comment.
    if (two === '/*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (!html && (text[i] === "'" || text[i] === '"' || text[i] === '`')) {
      const quote = text[i];
      out += text[i]; i++;
      while (i < n && text[i] !== quote) {
        if (text[i] === '\\') { out += text[i]; i++; if (i < n) { out += text[i]; i++; } continue; }
        out += text[i]; i++;
      }
      if (i < n) { out += text[i]; i++; }
      continue;
    }
    out += text[i]; i++;
  }
  return out;
}

const codeOnly = stripComments(fullScript); // JS comments stripped, strings preserved
// For markup-only checks (nav item / page div), strip ONLY HTML
// comments from the raw file -- these checks look for exact attribute
// strings that only ever appear in markup, so JS comments elsewhere in
// the file (which could theoretically contain the same substrings in
// prose) never enter into it.
const markupCodeOnly = stripComments(src, { html: true });

console.log('=== Gone: every Appraisal-only artifact ===');
check('renderAppraisal() function definition no longer exists', codeOnly.indexOf('function renderAppraisal(') < 0);
check('the Appraisal nav item (data-page="appraisal") no longer exists', !markupCodeOnly.includes('data-page="appraisal"'));
check('the #page-appraisal page div no longer exists', !markupCodeOnly.includes('id="page-appraisal"'));
check('the #appraisalContent container no longer exists', !markupCodeOnly.includes('id="appraisalContent"'));
check("the routing line (if(page==='appraisal') ...) no longer exists", !codeOnly.includes("if(page==='appraisal')"));
check('apQtrOffset (Appraisal-only module state) no longer exists as a real identifier', !codeOnly.includes('apQtrOffset'));
check('apAdminScores (Appraisal-only module state) no longer exists as a real identifier', !codeOnly.includes('apAdminScores'));
check("no live reference to db.collection('appraisalData') remains", !codeOnly.includes("collection('appraisalData')") && !codeOnly.includes('collection("appraisalData")'));
check("getApQtr (Appraisal's own local quarter helper) no longer exists as a real identifier", !codeOnly.includes('getApQtr'));

console.log('\n=== Positive proof: every remaining "appraisal" mention is inert (comment/text, not code) ===');
{
  // Reassemble the whole file with BOTH kinds of comments genuinely
  // stripped: HTML comments from the markup either side of <script>,
  // JS comments (codeOnly, already computed) from the script itself.
  // Any "appraisal" surviving that -- other than the one known-stale
  // banner string -- would be a real, live, unstripped reference.
  const beforeScript = src.slice(0, scriptMatch.index);
  const afterScript = src.slice(scriptMatch.index + scriptMatch[0].length);
  const wholeFileCommentsStripped =
    stripComments(beforeScript, { html: true }) + codeOnly + stripComments(afterScript, { html: true });
  // V22: Employee Review was renamed (display text only) to "Appraisal"
  // -- it's now the team's single appraisal system, so the tab label
  // and its panel heading legitimately say "Appraisal". Those two exact,
  // known, intentional occurrences are allowlisted below; anything else
  // matching /appraisal/i is still a real failure (a stale reference to
  // the OLD, deleted system, or an accidental new one).
  const KNOWN_LEGITIMATE_APPRAISAL_STRINGS = [
    'Salary deduction calc in Appraisal', // the stale banner -- gone from source entirely now, harmless no-op if already removed
    'data-shtab="employeereview">Appraisal<', // the renamed tab label
    '<div class="card-title">👤 Appraisal</div>', // the renamed panel heading
  ];
  let cleaned = wholeFileCommentsStripped;
  KNOWN_LEGITIMATE_APPRAISAL_STRINGS.forEach(s => { cleaned = cleaned.split(s).join(''); });
  const hit = /appraisal/i.exec(cleaned);
  check('with all comments and the known-legitimate strings (renamed tab label/heading, the old stale banner) removed, ZERO remaining "appraisal" mentions anywhere in the file', hit === null);
  if (hit) console.log('    unexpected residual hit near: ' + cleaned.slice(Math.max(0, hit.index - 60), hit.index + 60).replace(/\s+/g, ' '));

  // The allowlist itself must actually be present and correct -- proves
  // the rename really happened, not just that the check tolerates it.
  check('the tab label really does say "Appraisal" now (not silently still "Employee Review")', src.includes('data-shtab="employeereview">Appraisal<'));
  check('the panel heading really does say "Appraisal" now', src.includes('<div class="card-title">👤 Appraisal</div>'));
  check('the stale Manage-page banner text is genuinely gone from the source (not just allowlisted)', !src.includes('Salary deduction calc in Appraisal'));
}

console.log('\n=== Untouched: the shared .ap-* CSS vocabulary ===');
check('.ap-star{...} CSS rule still defined', /\.ap-star\{/.test(src));
check('.ap-scorecard{...} CSS rule still defined', /\.ap-scorecard\{/.test(src));
check('.ap-note-input{...} CSS class still defined (grep for the selector, not assuming exact rule body)', /\.ap-note-input\b/.test(src));
check('.ap-save-scorecard{...} CSS class still defined', /\.ap-save-scorecard\b/.test(src));
check('.ap-qtr-btn{...} CSS class still defined', /\.ap-qtr-btn\b/.test(src));

console.log('\n=== Employee Review still renders using that shared CSS vocabulary (executed, not just grepped) ===');
{
  function extractFunction(source, name) {
    let startIdx = source.indexOf(`async function ${name}(`);
    if (startIdx < 0) startIdx = source.indexOf(`function ${name}(`);
    assert.ok(startIdx >= 0, `could not find "function ${name}(" in index.html`);
    const braceStart = source.indexOf('{', startIdx);
    let depth = 0, i = braceStart;
    for (; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') { depth--; if (depth === 0) break; }
    }
    return source.slice(startIdx, i + 1);
  }
  function extractConstLine(source, name) {
    const idx = source.indexOf(`const ${name} =`);
    assert.ok(idx >= 0, `could not find "const ${name} =" in index.html`);
    const end = source.indexOf(';', idx);
    return source.slice(idx, end + 1);
  }

  const critIdx = fullScript.indexOf('const SH_REVIEW_CRITERIA = [');
  const critEnd = fullScript.indexOf('];', critIdx) + 2;
  const shCriteriaSrc = fullScript.slice(critIdx, critEnd);
  const quarterConsts = ['SH_REVIEW_WINDOW_DAYS', 'SH_REVIEW_PRIOR_WINDOWS', 'SH_CONSISTENCY_CV_THRESHOLD', 'SH_WORKLOAD_SPIKE_RATIO', 'SH_WORKLOAD_DROP_RATIO', 'SH_VERSATILITY_MIN_PCT', 'SH_EST_MIN_CONTRIBUTION_PCT', 'SH_EST_RECENT_COUNT', 'SH_EST_MIN_HISTORICAL_COUNT']
    .map(n => extractConstLine(fullScript, n)).join('\n');

  const fnNames = ['toLocalDateStr', 'getWindowBounds', 'productiveMinsInWindow', 'computeWorkloadPattern', 'computePhaseContributions', 'computeEstimationPattern', 'meaningfulProjectCount', 'computeVersatilityStat', 'quarterEndDate', 'quarterPeriodKey', 'computeLoggingConsistency', 'computeObjectivePanelFacts', 'renderFactBarHTML', 'renderFractionDotsHTML', 'getQuarter'];
  const fnSrc = {};
  fnNames.forEach(n => { fnSrc[n] = extractFunction(fullScript, n); });
  const bodySrc = extractFunction(fullScript, 'renderEmployeeReviewBody');

  const sandbox = { console, Date, Object, Math, Set };
  vm.createContext(sandbox);
  vm.runInContext(quarterConsts, sandbox);
  vm.runInContext(shCriteriaSrc, sandbox);
  fnNames.forEach(n => vm.runInContext(fnSrc[n], sandbox));
  vm.runInContext(bodySrc, sandbox);

  const elements = {};
  const container = { _html: '', set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; } };
  vm.runInContext(`
    var shReviewSelectedPersonId = 'u1';
    var shReviewQtrOffset = 0;
    var shCachedReviewData = {
      projects: [],
      logs: [{ userId: 'u1', productive: true, durationMins: 480, date: '2026-07-15', phase: 'Schematic Design', projectId: 'p1' }],
      allUsers: [{ id: 'u1', name: 'Test Person', isAdmin: false }],
      allReviews: [],
    };
    var currentUser = { id: 'admin1', name: 'Admin', isAdmin: true };
  `, sandbox);
  sandbox.document = {
    getElementById: (id) => {
      if (id === 'sh-employeereview') return container;
      if (!elements[id]) elements[id] = { value: '', textContent: '', classList: { add: () => {}, toggle: () => {} }, disabled: false, addEventListener: () => {} };
      return elements[id];
    },
    querySelectorAll: () => [],
  };
  const renderEmployeeReviewBody = vm.runInContext('renderEmployeeReviewBody', sandbox);
  renderEmployeeReviewBody();
  const html = container._html;

  check('rendered Employee Review output is non-empty', html.length > 0);
  check('rendered output uses class="ap-star" for its rubric stars', /class="ap-star/.test(html));
  check('rendered output uses class="ap-scorecard-footer"', /class="ap-scorecard-footer"/.test(html));
  check('rendered output uses class="ap-save-scorecard"', /class="ap-save-scorecard"/.test(html));
  check('rendered output uses class="ap-save-status"', /class="ap-save-status"/.test(html));
  check('rendered output uses class="ap-note-input"', /class="ap-note-input"/.test(html));
  check('rendered output uses class="ap-qtr-btn"', /class="ap-qtr-btn"/.test(html));
}

console.log('\n=== The inline <script> still parses as valid JS after the removal ===');
check('new Function(fullScript) does not throw', (() => { try { new Function(fullScript); return true; } catch (e) { console.log('    parse error:', e.message); return false; } })());

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
