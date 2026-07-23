import assert from 'node:assert/strict';
import test from 'node:test';

import { readText } from './test-helpers.mjs';

const content = readText('src/content.js');
const pageBridge = readText('src/page-bridge.js');

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
  assert.match(content, /function closeInline\(options = \{\}\) \{[\s\S]*?state\.active = false;[\s\S]*?state\.session \+= 1/);
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

test('source mode preserves raw HTML and exposes explicit lifecycle controls', () => {
  const setter = content.match(/function setEditorValue\(textarea, html, options = \{\}\) \{[\s\S]*?\n  \}/)?.[0] || '';
  const panel = content.match(/function createInlinePanel\(target\) \{[\s\S]*?\n  \}\n\n  function rememberInlineDraft/)?.[0] || '';
  const reload = content.match(/async function reloadInline\(\) \{[\s\S]*?\n  \}\n\n  async function saveInline/)?.[0] || '';
  const save = content.match(/async function saveInline\(closeAfter\) \{[\s\S]*?\n  \}\n\n  function closeInline/)?.[0] || '';
  assert.match(setter, /options\.format \? htmlFormat\(html\) : String\(html \|\| ''\)/);
  assert.match(content, /const tokens = tokenizeHtml\(raw\)/);
  assert.match(panel, /data-mpse-action="save"/);
  assert.match(panel, /data-mpse-action="save-close"/);
  assert.match(panel, /data-mpse-action="close"/);
  assert.match(panel, /class="mpse-inline-status" role="status" aria-live="polite"/);
  assert.match(panel, /if \(event\.key === 'Escape'\)[\s\S]*?closeInline\(\)/);
  assert.match(panel, /setEditorValue\(textarea, textarea\.value, \{ format: true/);
  assert.match(content, /textarea\.readOnly = busy/);
  assert.match(content, /button\.disabled = busy/);
  assert.match(panel, /if \(textarea\.readOnly\) return/);
  assert.match(reload, /state\.saving[\s\S]*?state\.syncing[\s\S]*?mpse-busy/);
  assert.match(save, /state\.saving[\s\S]*?state\.syncing[\s\S]*?mpse-busy/);
  assert.match(content, /state\.saving \|\| state\.syncing \|\| panel\?\.classList\.contains\('mpse-busy'\)/);
  assert.match(content, /beforeunload/);
});

test('successful saves and confirmed closes clear the current article draft', () => {
  const save = content.match(/async function saveInline\(closeAfter\) \{[\s\S]*?\n  \}\n\n  function closeInline/)?.[0] || '';
  const close = content.match(/function closeInline\(options = \{\}\) \{[\s\S]*?\n  \}\n\n  function createToolbarButton/)?.[0] || '';
  assert.match(save, /const sourceDraftKey = draftKey\(\)/);
  assert.match(save, /state\.drafts\.delete\(sourceDraftKey\)/);
  assert.match(close, /window\.confirm\('源码有未保存修改，确定退出源码模式吗？'\)/);
  assert.match(close, /state\.drafts\.delete\(draftKey\(\)\)/);
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
