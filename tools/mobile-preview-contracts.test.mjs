import assert from 'node:assert/strict';
import test from 'node:test';

import { readJson, readText } from './test-helpers.mjs';

const preview = readText('src/mobile-preview.js');
const controls = readText('src/mobile-preview-controls.js');
const overlay = readText('src/overlay.css');

test('mobile preview is loaded after source mode and before editor effect tools', () => {
  const manifest = readJson('manifest.json');
  const scripts = manifest.content_scripts?.[0]?.js || [];
  const sourceIndex = scripts.indexOf('src/content.js');
  const previewIndex = scripts.indexOf('src/mobile-preview.js');
  const controlsIndex = scripts.indexOf('src/mobile-preview-controls.js');
  const imageIndex = scripts.indexOf('src/image-geometry.js');

  assert.ok(sourceIndex >= 0);
  assert.equal(previewIndex, sourceIndex + 1);
  assert.equal(controlsIndex, previewIndex + 1);
  assert.equal(imageIndex, controlsIndex + 1);
  assert.ok(preview.split(/\r?\n/).length < 500);
  assert.ok(controls.split(/\r?\n/).length < 300);
});

test('preview uses an isolated script-free 375 pixel article document', () => {
  assert.match(preview, /const ARTICLE_WIDTH = 375/);
  assert.match(preview, /sandbox="allow-same-origin"/);
  assert.doesNotMatch(preview, /allow-scripts/);
  assert.match(preview, /Content-Security-Policy/);
  assert.match(preview, /default-src 'none'/);
  assert.match(preview, /width=\$\{ARTICLE_WIDTH\}/);
  assert.match(overlay, /#mpse-mobile-preview-frame[\s\S]*?width: 375px/);
});

test('preview sanitizer removes active content while preserving article markup', () => {
  assert.match(preview, /const DANGEROUS_ELEMENTS = \[[\s\S]*?'script'[\s\S]*?'iframe'[\s\S]*?'form'/);
  assert.match(preview, /parsed\.querySelectorAll\(DANGEROUS_ELEMENTS\).*?element\.remove\(\)/);
  assert.match(preview, /name\.startsWith\('on'\)/);
  assert.match(preview, /\^\(\?:javascript\|vbscript\|data:text\\\/html\)/);
  assert.match(preview, /name === 'srcdoc'/);
  assert.match(preview, /@import\\b/);
  assert.match(preview, /frameDocument\.addEventListener\('click', \(event\) => event\.preventDefault\(\), true\)/);
});

test('unsaved HTML source is the first-class live preview source', () => {
  const reader = preview.match(/function readArticleSnapshot\(\) \{[\s\S]*?\n  \}/);
  assert.ok(reader);
  assert.match(reader[0], /document\.querySelector\('#mpse-inline-panel \.mpse-inline-editor'\)/);
  assert.match(reader[0], /const editable = sourceEditor \? null : findEditableCandidate\(\)/);
  assert.match(reader[0], /html: sourceEditor \? sourceEditor\.value : \(editable\?\.html \|\| ''\)/);
  assert.match(reader[0], /mode: sourceEditor \? 'source' : 'rich'/);
});

test('editor replacements and direct style changes share one debounced refresh lifecycle', () => {
  assert.match(preview, /const RENDER_DELAY_MS = 120/);
  assert.match(preview, /for \(const eventName of \['beforeinput', 'input', 'paste', 'drop', 'cut'\]\)/);
  assert.match(preview, /new MutationObserver\(\(records\) =>/);
  assert.match(preview, /characterData: true/);
  assert.match(preview, /attributeFilter: \['style', 'class', 'src', 'href', 'contenteditable'\]/);
  assert.match(preview, /window\.setInterval\(\(\) => \{[\s\S]*?bindDocuments\(\)[\s\S]*?scheduleRender\(\)/);
  assert.match(preview, /if \(fingerprint === state\.fingerprint\) return/);
});

test('mobile preview switch follows HTML in the native toolbar', () => {
  assert.match(controls, /const HTML_BUTTON_ID = 'mpse-toolbar-button'/);
  assert.match(controls, /button\.textContent = '手机预览'/);
  assert.match(controls, /htmlButton\.insertAdjacentElement\('afterend', button\)/);
  assert.match(controls, /button\.setAttribute\('aria-pressed', state\.enabled \? 'true' : 'false'\)/);
  assert.match(controls, /sessionStorage\.setItem\('mpse-mobile-preview-enabled'/);
  assert.match(overlay, /#mpse-mobile-preview-button\.mpse-active/);
});

test('smaller phone defaults to the right edge and preserves bounded drag position', () => {
  assert.match(controls, /const PANEL_WIDTH = 250/);
  assert.match(controls, /const PREVIEW_MAX_HEIGHT = 570/);
  assert.match(controls, /left: innerWidth - RESERVED_RIGHT - PANEL_WIDTH/);
  assert.match(controls, /event\.target\.closest\?\.\('\.mpse-preview-viewport'\)/);
  assert.match(controls, /device\.setPointerCapture\(event\.pointerId\)/);
  assert.match(controls, /state\.userPosition = applyPosition/);
  assert.match(controls, /sessionStorage\.setItem\('mpse-mobile-preview-position'/);
  assert.match(controls, /Math\.min\(Math\.max\(left, VIEWPORT_MARGIN\), maxLeft\)/);
  assert.match(overlay, /#mpse-mobile-preview \{[\s\S]*?width: 250px/);
  assert.match(overlay, /height: min\(570px, calc\(100vh - 180px\)\)/);
  assert.doesNotMatch(preview, /mpse-preview-toolbar|mpse-preview-collapsed/);
});
