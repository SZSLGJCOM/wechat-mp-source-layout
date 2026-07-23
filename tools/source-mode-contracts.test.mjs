import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import { readText } from './test-helpers.mjs';

const content = readText('src/content.js');
const pageBridge = readText('src/page-bridge.js');

test('source formatter expands compact article HTML into vertical lines', () => {
  const start = content.indexOf('function tokenizeHtml(source)');
  const end = content.indexOf('function escapeHtml(value)');
  assert.ok(start >= 0 && end > start, 'source formatter must remain available');
  const context = {
    source: '<section><p>正文</p><img src="https://assets.example.com/a.png"></section>',
    formatted: ''
  };
  vm.runInNewContext(
    `${content.slice(start, end)}\nformatted = htmlFormat(source);`,
    context
  );
  assert.equal(
    context.formatted,
    [
      '<section>',
      '  <p>',
      '    正文',
      '  </p>',
      '  <img src="https://assets.example.com/a.png">',
      '</section>'
    ].join('\n')
  );
});

test('source saves are conditional on the article that was loaded', () => {
  const save = content.match(/async function saveInline\(closeAfter\) \{[\s\S]*?\n  \}\n\n  function closeInline/);
  assert.ok(save, 'source save lifecycle must exist');
  assert.match(save[0], /const baselineHtml = lastLoadedHtml/);
  assert.match(save[0], /const baselineArticleKey = state\.bridgeArticleKey/);
  assert.match(save[0], /const sourceDraftKey = draftKey\(\)/);
  assert.match(save[0], /await mutateEditorContent\(\(current\) => \{/);
  assert.match(save[0], /currentHtml !== baselineHtml/);
  assert.match(save[0], /currentArticleKey !== baselineArticleKey/);
  assert.match(save[0], /error\.code = 'MPSE_SOURCE_SESSION_CHANGED'/);
  assert.match(save[0], /scheduleInlineSync\(0\)/);
  assert.match(save[0], /state\.drafts\.delete\(sourceDraftKey\)/);
  assert.doesNotMatch(save[0], /writeEditorContent\(html\)/);
  assert.match(pageBridge, /expectedArticleKey/);
  assert.match(pageBridge, /current\.articleKey !== expectedArticleKey/);
  assert.doesNotMatch(pageBridge, /editor=\$\{/);
});

test('stale source operations cannot mutate or close a newer article session', () => {
  assert.match(content, /function isCurrentSession\(panel, session\)/);
  assert.match(content, /state\.session \+= 1/);
  assert.match(content, /if \(!isCurrentSession\(panel, session\)\) return/);
  assert.match(content, /function closeInline\(\) \{[\s\S]*?state\.active = false;[\s\S]*?state\.session \+= 1/);
});

test('source mode follows external article switches and restores matching drafts', () => {
  const sync = content.match(/async function syncInlineArticle\(\) \{[\s\S]*?\n  \}\n\n  async function openInline/);
  assert.ok(sync, 'article synchronization lifecycle must exist');
  assert.match(sync[0], /await readEditorContent\(5000\)/);
  assert.match(sync[0], /currentHtml === lastLoadedHtml && nextArticleKey === state\.articleKey/);
  assert.match(sync[0], /rememberInlineDraft\(textarea\)/);
  assert.match(sync[0], /findEditorMountTarget\(state\.target\)/);
  assert.match(sync[0], /rebindInlineTarget\(panel, replacement\)/);
  assert.match(content, /mutationTouchesEditorPage\(records\)[\s\S]*?scheduleInlineSync\(\)/);
  assert.match(content, /state\.locationKey !== location\.href[\s\S]*?scheduleInlineSync\(0\)/);
  assert.doesNotMatch(content, /targetIds|targetIdentity/);
});

test('source mode formats vertically and uses one toolbar toggle to save and exit', () => {
  const setter = content.match(/function setEditorValue\(textarea, html, options = \{\}\) \{[\s\S]*?\n  \}/)?.[0] || '';
  const panel = content.match(/function createInlinePanel\(target\) \{[\s\S]*?\n  \}\n\n  function rememberInlineDraft/)?.[0] || '';
  const save = content.match(/async function saveInline\(closeAfter\) \{[\s\S]*?\n  \}\n\n  function closeInline/)?.[0] || '';
  const open = content.match(/async function openInline\(options = \{\}\) \{[\s\S]*?\n  \}\n\n  async function saveInline/)?.[0] || '';
  assert.match(setter, /options\.format \? htmlFormat\(html\) : String\(html \|\| ''\)/);
  assert.match(content, /const tokens = tokenizeHtml\(raw\)/);
  assert.match(content, /setEditorValue\(textarea, lastLoadedHtml, \{ format: true \}\)/);
  assert.doesNotMatch(panel, /mpse-inline-toolbar|mpse-inline-footer|data-mpse-action|<button/);
  assert.doesNotMatch(panel, /event\.key === 'Escape'/);
  assert.match(open, /const existing = getPanel\(\)[\s\S]*?await saveInline\(true\)/);
  assert.match(content, /textarea\.readOnly = busy/);
  assert.match(panel, /if \(textarea\.readOnly\) return/);
  assert.match(save, /state\.saving[\s\S]*?state\.syncing[\s\S]*?mpse-busy/);
  assert.match(content, /beforeunload/);
});

test('successful saves and automatic exits clear the current article draft', () => {
  const save = content.match(/async function saveInline\(closeAfter\) \{[\s\S]*?\n  \}\n\n  function closeInline/)?.[0] || '';
  const close = content.match(/function closeInline\(\) \{[\s\S]*?\n  \}\n\n  function createToolbarButton/)?.[0] || '';
  assert.match(save, /const sourceDraftKey = draftKey\(\)/);
  assert.match(save, /state\.drafts\.delete\(sourceDraftKey\)/);
  assert.match(save, /if \(closeAfter\) closeInline\(\)/);
  assert.match(close, /state\.drafts\.delete\(draftKey\(\)\)/);
  assert.doesNotMatch(close, /window\.confirm/);
});

test('source highlighting is deferred and deduplicated away from the input handler', () => {
  const dirty = content.match(/function markDirty\(\) \{[\s\S]*?\n  \}/)?.[0] || '';
  const renderer = content.match(/function renderHighlight\(\) \{[\s\S]*?\n  \}/)?.[0] || '';
  assert.doesNotMatch(dirty, /highlightHtml|innerHTML/);
  assert.match(content, /requestAnimationFrame\(renderEditorChrome\)/);
  assert.match(content, /window\.setTimeout\(renderHighlight, options\.immediate \? 0 : 120\)/);
  assert.match(renderer, /fingerprint === state\.highlightFingerprint/);
  assert.match(content, /state\.renderedLineCount !== count/);
});

test('editor input and composition waits are bounded before native writes', () => {
  assert.match(pageBridge, /const EDITOR_INPUT_WAIT_TIMEOUT_MS = 2500/);
  assert.match(pageBridge, /error\.code = EDITOR_BUSY_CODE/);
  assert.match(pageBridge, /await waitUntilSettled\(compositionEnd, remaining\)/);
  assert.match(pageBridge, /await waitUntilSettled\(idle, remaining\)/);
});
