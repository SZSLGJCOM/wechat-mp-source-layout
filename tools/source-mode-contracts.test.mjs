import assert from 'node:assert/strict';
import test from 'node:test';

import { readText } from './test-helpers.mjs';

const content = readText('src/content.js');
const pageBridge = readText('src/page-bridge.js');

test('source saves are conditional on the article that was loaded', () => {
  const save = content.match(/async function saveInline\(closeAfter\) \{[\s\S]*?\n  \}\n\n  function closeInline/);
  assert.ok(save, 'source save lifecycle must exist');
  assert.match(save[0], /const baselineHtml = lastLoadedHtml/);
  assert.match(save[0], /await mutateEditorContent\(\(current\) => \{/);
  assert.match(save[0], /if \(currentHtml !== baselineHtml\)/);
  assert.match(save[0], /error\.code = 'MPSE_SOURCE_SESSION_CHANGED'/);
  assert.match(save[0], /scheduleInlineSync\(0\)/);
  assert.doesNotMatch(save[0], /writeEditorContent\(html\)/);
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
  assert.match(sync[0], /if \(currentHtml === lastLoadedHtml\) return/);
  assert.match(sync[0], /rememberInlineDraft\(textarea\)/);
  assert.match(sync[0], /findEditorMountTarget\(state\.target\)/);
  assert.match(sync[0], /rebindInlineTarget\(panel, replacement\)/);
  assert.match(content, /document\.addEventListener\('click',[\s\S]*?scheduleInlineSync\(\)/);
  assert.match(content, /mutationTouchesEditorPage\(records\)[\s\S]*?scheduleInlineSync\(\)/);
});

test('editor input and composition waits are bounded before native writes', () => {
  assert.match(pageBridge, /const EDITOR_INPUT_WAIT_TIMEOUT_MS = 2500/);
  assert.match(pageBridge, /error\.code = EDITOR_BUSY_CODE/);
  assert.match(pageBridge, /await waitUntilSettled\(compositionEnd, remaining\)/);
  assert.match(pageBridge, /await waitUntilSettled\(idle, remaining\)/);
});
