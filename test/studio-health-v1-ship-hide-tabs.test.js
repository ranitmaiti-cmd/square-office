// Fixture for the Studio Health v1 ship's "hide 2 tabs" commit.
//
// Project Health (Layer A) and Submission Log are held back -- dormant,
// not deleted. Only Individual Insight and Employee Review should be
// reachable/rendered from the UI, and NEITHER hidden tab's data-fetch
// should ever fire (not on page open, not on any click), even though
// their code/CSS/divs/test files all remain fully in the file.
//
// Extracts the ACTUAL markup and JS from index.html (regex/brace-
// matched, not retyped) and proves the behavior against it -- same
// discipline as every other fixture in this repo.
//
// Central claims under test:
//  - the .sh-tabs bar has exactly 2 entries: individualinsight, employeereview
//    -- projecthealth/submissionlog are NOT tab-bar entries anymore
//  - Individual Insight is the default active tab (both the .sh-tab and
//    its .sh-tabcontent carry "active"); Project Health's content div
//    does NOT
//  - the Studio Health nav-item click handler calls renderIndividualInsight(),
//    NOT renderStudioHealth() -- Layer A's fetch no longer fires on page open
//  - simulating "open Studio Health, click every visible tab" NEVER
//    invokes renderStudioHealth() or renderSubmissionLog() -- proven by
//    running the real extracted click-handler JS against a DOM built
//    from the real extracted tab-bar markup, not asserted from reading
//  - Layer A's and Submission Log's functions, CSS, and tabcontent divs
//    are still genuinely present in the file (held back, not deleted)
//
// Run with: node test/studio-health-v1-ship-hide-tabs.test.js
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

// ── Extract the real #page-studiohealth markup block ──────────────
const pageStart = src.indexOf('<div class="page admin-only" id="page-studiohealth">');
assert.ok(pageStart >= 0, 'could not find #page-studiohealth in index.html');
// Closes at the matching "</div><!-- /content -->" sibling structure --
// simpler: this page block is immediately followed by "</div><!-- /content -->"
// in the real file, so slice up to that anchor.
const pageEnd = src.indexOf('</div><!-- /content -->', pageStart);
assert.ok(pageEnd >= 0, 'could not find the end of #page-studiohealth');
const pageHTML = src.slice(pageStart, pageEnd);

// ── Extract the .sh-tabs bar specifically ──────────────────────────
// Lazy [\s\S]*?<\/div> would stop at the FIRST </div> it finds, which is
// each tab entry's own inline closing tag (e.g. "...>Individual Insight</div>"),
// not the wrapper's. The wrapper's own closing tag is the one on its own
// line at the original 8-space indent -- anchor on that specifically.
const tabsBarMatch = pageHTML.match(/<div class="sh-tabs">\r?\n([\s\S]*?)\r?\n        <\/div>/);
assert.ok(tabsBarMatch, 'could not find .sh-tabs bar');
const tabsBarHTML = tabsBarMatch[1];
const tabEntries = [...tabsBarHTML.matchAll(/<div class="sh-tab( active)?" data-shtab="(\w+)">/g)]
  .map(m => ({ shtab: m[2], active: !!m[1] }));

console.log('=== .sh-tabs bar: exactly Individual Insight + Employee Review ===');
check('exactly 2 tab-bar entries', tabEntries.length === 2);
check('projecthealth is NOT a tab-bar entry', !tabEntries.some(t => t.shtab === 'projecthealth'));
check('submissionlog is NOT a tab-bar entry', !tabEntries.some(t => t.shtab === 'submissionlog'));
check('individualinsight IS a tab-bar entry, and is the active one', tabEntries.some(t => t.shtab === 'individualinsight' && t.active));
check('employeereview IS a tab-bar entry, not active (Individual Insight leads)', tabEntries.some(t => t.shtab === 'employeereview' && !t.active));

console.log('\n=== .sh-tabcontent divs: default-active state matches the tab bar ===');
function contentDivClass(id) {
  const m = pageHTML.match(new RegExp(`<div class="(sh-tabcontent[^"]*)" id="${id}">`));
  return m ? m[1] : null;
}
check('#sh-individualinsight carries "active"', (contentDivClass('sh-individualinsight') || '').includes('active'));
check('#sh-projecthealth does NOT carry "active" (Layer A no longer the default)', !(contentDivClass('sh-projecthealth') || '').includes('active'));
check('#sh-submissionlog does NOT carry "active"', !(contentDivClass('sh-submissionlog') || '').includes('active'));
check('#sh-employeereview does NOT carry "active" (Individual Insight leads, not Employee Review)', !(contentDivClass('sh-employeereview') || '').includes('active'));

console.log('\n=== Held back, not deleted: Layer A + Submission Log code/CSS/divs still fully present ===');
check('renderStudioHealth() function definition still exists', /function renderStudioHealth\(/.test(fullScript));
check('sumHoursByProjectPhase()/computeEstimationBias() (Layer A logic) still exist', /function sumHoursByProjectPhase\(/.test(fullScript) && /function computeEstimationBias\(/.test(fullScript));
check('renderSubmissionLog()/saveSubmission() still exist', /function renderSubmissionLog\(/.test(fullScript) && /function saveSubmission\(/.test(fullScript));
check('#sh-projecthealth content div still exists in the page (just not in the tab bar)', /id="sh-projecthealth"/.test(pageHTML));
check('#sh-submissionlog content div still exists in the page', /id="sh-submissionlog"/.test(pageHTML));
check('.sh-table/.sh-flag CSS (shared vocabulary, originally Layer A\'s) still defined', /\.sh-table\{/.test(src) && /\.sh-flag\{/.test(src));

// ── Extract the nav-item click handler and the .sh-tab click handler ──
function extractBlockFrom(source, anchor) {
  const idx = source.indexOf(anchor);
  assert.ok(idx >= 0, `could not find anchor: ${anchor}`);
  const braceStart = source.indexOf('{', idx);
  let depth = 0, i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  // i now sits on the arrow function body's closing "}" -- the anchor
  // itself is `....forEach(x => { ... })`, so the statement's real end
  // is the ");" immediately after that brace, not the brace itself.
  const semiIdx = source.indexOf(';', i);
  assert.ok(semiIdx >= 0, 'could not find terminating ; after the matched block');
  return source.slice(idx, semiIdx + 1);
}
const navHandlerSrc = extractBlockFrom(fullScript, `document.querySelectorAll('.nav-item[data-page]').forEach(item=>{`);
const tabHandlerSrc = extractBlockFrom(fullScript, `document.querySelectorAll('.sh-tab').forEach(tab => {`);

console.log('\n=== Source-text: the Studio Health nav trigger calls renderIndividualInsight(), not renderStudioHealth() ===');
check('nav handler still branches on studiohealth', /if\(page==='studiohealth'\)/.test(navHandlerSrc));
check('that branch calls renderIndividualInsight()', /if\(page==='studiohealth'\) renderIndividualInsight\(\);/.test(navHandlerSrc));
check('that branch does NOT call renderStudioHealth() -- Layer A\'s fetch no longer fires on page open', !/if\(page==='studiohealth'\) renderStudioHealth\(\);/.test(navHandlerSrc));

// ═══════════════════════════════════════════════════════════════════
// BEHAVIORAL: simulate "open Studio Health, click every visible tab"
// against a lightweight DOM built from the REAL extracted tab-bar
// markup, running the REAL extracted click-handler JS, with every
// render function replaced by a spy -- proves the hidden tabs' fetches
// genuinely never fire, not just that the source text looks right.
// ═══════════════════════════════════════════════════════════════════
console.log('\n=== BEHAVIORAL: simulated page-open + click-every-tab never invokes renderStudioHealth()/renderSubmissionLog() ===');
{
  const calls = [];
  function makeSpy(name) { return () => calls.push(name); }

  // Build a minimal fake DOM from the REAL tabEntries parsed above --
  // not hand-typed, so this fixture breaks honestly if the real markup
  // ever changes shape without the fixture being updated to match.
  const tabEls = tabEntries.map(t => {
    const classes = new Set(['sh-tab', ...(t.active ? ['active'] : [])]);
    return {
      dataset: { shtab: t.shtab },
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
      _listeners: [],
      addEventListener(evt, fn) { this._listeners.push(fn); },
      click() { this._listeners.forEach(fn => fn()); },
    };
  });
  const contentEls = {};
  ['sh-projecthealth', 'sh-submissionlog', 'sh-individualinsight', 'sh-employeereview'].forEach(id => {
    const classes = new Set(['sh-tabcontent', ...(id === 'sh-individualinsight' ? ['active'] : [])]);
    contentEls[id] = { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) } };
  });

  const sandbox = {
    console,
    renderStudioHealth: makeSpy('renderStudioHealth'),
    renderSubmissionLog: makeSpy('renderSubmissionLog'),
    renderIndividualInsight: makeSpy('renderIndividualInsight'),
    renderEmployeeReview: makeSpy('renderEmployeeReview'),
    document: {
      querySelectorAll: (sel) => {
        if (sel === '.sh-tab') return tabEls;
        if (sel === '.sh-tabcontent') return Object.values(contentEls);
        return [];
      },
      getElementById: (id) => contentEls[id] || { classList: { add: () => {}, remove: () => {}, contains: () => false } },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(tabHandlerSrc, sandbox);

  // Simulate clicking every visible tab (exactly what a user CAN do --
  // there is no way to click a tab that doesn't exist in tabEls).
  tabEls.forEach(el => el.click());

  check('exactly 2 clickable tabs exist to simulate (individualinsight, employeereview)', tabEls.length === 2);
  check('renderStudioHealth() was NEVER invoked by clicking any visible tab', !calls.includes('renderStudioHealth'));
  check('renderSubmissionLog() was NEVER invoked by clicking any visible tab', !calls.includes('renderSubmissionLog'));
  check('renderIndividualInsight() WAS invoked (clicking its own tab)', calls.includes('renderIndividualInsight'));
  check('renderEmployeeReview() WAS invoked (clicking its own tab)', calls.includes('renderEmployeeReview'));
}

console.log('\n=== BEHAVIORAL: simulated Studio Health nav-item open fires Individual Insight\'s fetch, never Layer A\'s ===');
{
  const calls = [];
  function makeSpy(name) { return () => calls.push(name); }
  const classes = new Set();
  const pageEl = { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) } };
  const navItemEl = {
    dataset: { page: 'studiohealth' },
    classList: { add: () => {}, remove: () => {} },
    _listeners: [],
    addEventListener(evt, fn) { this._listeners.push(fn); },
    click() { this._listeners.forEach(fn => fn.call(this)); },
  };
  const sandbox = {
    console,
    renderStudioHealth: makeSpy('renderStudioHealth'),
    renderIndividualInsight: makeSpy('renderIndividualInsight'),
    stopLiveTimerUpdates: () => {},
    document: {
      querySelectorAll: (sel) => (sel === '.nav-item[data-page]' ? [navItemEl] : sel === '.nav-item' ? [navItemEl] : sel === '.page' ? [pageEl] : []),
      getElementById: (id) => (id === 'page-studiohealth' ? pageEl : { classList: { add: () => {}, remove: () => {} } }),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(navHandlerSrc, sandbox);
  navItemEl.click();

  check('opening the Studio Health nav item calls renderIndividualInsight()', calls.includes('renderIndividualInsight'));
  check('opening the Studio Health nav item NEVER calls renderStudioHealth() -- Layer A\'s fetch does not fire silently in the background', !calls.includes('renderStudioHealth'));
}

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
