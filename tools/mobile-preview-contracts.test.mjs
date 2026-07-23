import assert from 'node:assert/strict';
import test from 'node:test';

import { readJson, readText } from './test-helpers.mjs';

const preview = readText('src/mobile-preview.js');
const overlay = readText('src/overlay.css');

test('mobile preview is loaded after source mode and before editor effect tools', () => {
  const manifest = readJson('manifest.json');
  const scripts = manifest.content_scripts?.[0]?.js || [];
  const sourceIndex = scripts.indexOf('src/content.js');
  const previewIndex = scripts.indexOf('src/mobile-preview.js');
  const imageIndex = scripts.indexOf('src/image-geometry.js');

  assert.ok(sourceIndex >= 0);
  assert.equal(previewIndex, sourceIndex + 1);
  assert.equal(imageIndex, previewIndex + 1);
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

test('phone preview only occupies a sufficiently wide desktop gutter and can collapse', () => {
  assert.match(preview, /const MIN_VIEWPORT_WIDTH = 1580/);
  assert.match(preview, /const MIN_GUTTER_WIDTH = 394/);
  assert.match(preview, /gutter >= \(state\.collapsed \? width \+ 20 : MIN_GUTTER_WIDTH\)/);
  assert.match(preview, /state\.root\.hidden = !canShow/);
  assert.match(preview, /requestAnimationFrame\(positionPreview\)/);
  assert.match(preview, /sessionStorage\.setItem\('mpse-mobile-preview-collapsed'/);
  assert.match(overlay, /#mpse-mobile-preview\.mpse-preview-collapsed[\s\S]*?width: 132px/);
});
