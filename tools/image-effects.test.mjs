import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeElement } from './test-helpers.mjs';

globalThis.window = globalThis;
globalThis.document = { getElementById: () => null };

await import(new URL('../src/image-controls.js', import.meta.url));
await import(new URL('../src/image-effect-records.js', import.meta.url));

function setStyle(element, property, value, important = true) {
  if (!value) element.style.removeProperty(property);
  else element.style.setProperty(property, value, important ? 'important' : '');
}

function captureInlineStyles(element, properties) {
  if (!element) return null;
  return Object.fromEntries(properties.map((property) => [property, {
    value: element.style.getPropertyValue(property),
    priority: element.style.getPropertyPriority(property)
  }]));
}

function restoreInlineStyles(element, styles) {
  if (!element || !styles) return;
  for (const [property, entry] of Object.entries(styles)) {
    if (entry.value) element.style.setProperty(property, entry.value, entry.priority);
    else element.style.removeProperty(property);
  }
}

function createHarness(styles = {}, hostStyles = null) {
  const image = new FakeElement('img', {}, styles);
  const host = hostStyles ? new FakeElement('span', { 'data-mpse-image-crop': '1' }, hostStyles) : null;
  image.dataset = {};
  image.isConnected = true;
  image.ownerDocument = {};
  image.closest = () => null;
  image.getBoundingClientRect = () => ({ width: 320, height: 180 });
  const state = { image, activePanel: null, isDragging: false };
  const reasons = [];
  const controls = globalThis.__MPSE_IMAGE_CONTROLS__.create({
    MENU_ID: 'menu',
    PANEL_ID: 'panel',
    state,
    imageGeometry: {},
    frameStyleProps: [],
    clamp: (value, min, max) => Math.min(max, Math.max(min, Number(value))),
    parsePx: (value, fallback = 0) => Number.parseFloat(value) || fallback,
    parsePercent: (value, fallback = 0) => Number.parseFloat(value) || fallback,
    getDataNumber: (target, key, fallback) => {
      const value = Number(target?.dataset?.[key]);
      return Number.isFinite(value) ? value : fallback;
    },
    getDataString: (target, key, fallback) => target?.dataset?.[key] || fallback,
    clampInt: (value, min, max, fallback) => {
      const number = Number(value);
      return Number.isFinite(number) ? Math.round(Math.min(max, Math.max(min, number))) : fallback;
    },
    normalizeCssColorToHex: (value, fallback) => value || fallback,
    parseOpacityFromCssColor: (_value, fallback) => fallback,
    escapeHtml: (value) => String(value ?? ''),
    setStyle,
    setStyles: (target, values) => Object.entries(values).forEach(([property, value]) => setStyle(target, property, value)),
    captureInlineStyles,
    restoreInlineStyles,
    getVisualCarrier: () => null,
    getCropContainer: () => host,
    getCropContentRect: () => ({ width: 320, height: 180 }),
    getLayoutHost: (target) => host || target,
    getAppearanceHost: (target) => host || target,
    detectHorizontalAlignment: () => 'left',
    readCropLayout: () => ({}),
    writeCropLayout: () => {},
    getAvailableImageWidth: () => 320,
    readCropState: () => null,
    hasCropAdjustment: () => false,
    readCropBaseWidth: () => 100,
    setCropBaseWidth: () => {},
    writeCropState: () => {},
    setCropLayoutStyle: () => {},
    setLayoutWidthPercent: () => {},
    refreshCropDecoration: () => {},
    createPanel: () => null,
    isLikelyArticleImage: () => true,
    hideTools: () => {},
    positionTools: () => {},
    schedulePositionTools: () => {},
    markChanged: (_target, reason) => reasons.push(reason)
  });
  return { image, host, controls, reasons };
}

function decodeAlphaFilter(filter) {
  const match = String(filter || '').match(/url\("data:image\/svg\+xml,([^"]+)#mpse-alpha"\)/);
  assert.ok(match, 'managed alpha effects must be encoded as one SVG filter');
  return decodeURIComponent(match[1]);
}

test('opacity reaches 100 percent and restore returns the exact pre-effect value', () => {
  const { image, controls } = createHarness({ opacity: '0.65' });

  controls.applyEffect('opacity', { value: 35 });
  assert.equal(image.style.getPropertyValue('opacity'), '0.35');
  assert.equal(image.dataset.mpseOpacityOn, '1');

  controls.applyEffect('opacity', { value: 100 });
  assert.equal(image.style.getPropertyValue('opacity'), '1');
  assert.equal(image.dataset.mpseOpacityValue, '100');

  controls.clearEffect('opacity');
  assert.equal(image.style.getPropertyValue('opacity'), '0.65');
  assert.equal(image.dataset.mpseOpacityOn, undefined);
  assert.equal(image.dataset.mpseOpacityBase, undefined);
});

test('cropped opacity restores both the media and crop host baselines', () => {
  const { image, host, controls } = createHarness({ opacity: '0.8' }, { opacity: '0.75' });

  controls.applyEffect('opacity', { value: 30 });
  assert.equal(image.style.getPropertyValue('opacity'), '');
  assert.equal(host.style.getPropertyValue('opacity'), '0.3');

  controls.clearEffect('opacity');
  assert.equal(image.style.getPropertyValue('opacity'), '0.8');
  assert.equal(host.style.getPropertyValue('opacity'), '0.75');
});

test('alpha stroke composes with color filters and restores the original filter', () => {
  const { image, controls } = createHarness({ filter: 'contrast(110%)', outline: '3px solid red' });
  image.dataset.mpseStrokeBase = JSON.stringify({ outline: { value: '', priority: '' } });

  controls.applyEffect('stroke', { width: 4, opacity: 70, strokeColor: '#07c160' });
  const strokeSvg = decodeAlphaFilter(image.style.getPropertyValue('filter'));
  assert.match(image.style.getPropertyValue('filter'), /^contrast\(110%\).*data:image\/svg\+xml/);
  assert.match(strokeSvg, /<feMorphology in="SourceAlpha" operator="dilate" radius="4" result="stroke-dilate"\/>/);
  assert.match(strokeSvg, /<feComposite in="stroke-dilate" in2="SourceAlpha" operator="out" result="stroke-ring"\/>/);
  assert.match(strokeSvg, /flood-color="rgb\(7,193,96\)" flood-opacity="0.7"/);
  assert.equal(image.style.getPropertyValue('outline'), '');

  controls.applyEffect('color', { brightness: 115, contrast: 105, saturate: 90, gray: 20 });
  const composed = image.style.getPropertyValue('filter');
  assert.match(composed, /^contrast\(110%\)/);
  assert.match(composed, /brightness\(115%\).*grayscale\(20%\).*data:image\/svg\+xml/);

  controls.clearEffect('stroke');
  assert.doesNotMatch(image.style.getPropertyValue('filter'), /data:image\/svg\+xml/);
  assert.match(image.style.getPropertyValue('filter'), /brightness\(115%\)/);

  controls.clearEffect('color');
  assert.equal(image.style.getPropertyValue('filter'), 'contrast(110%)');
  assert.equal(image.dataset.mpseFilterBase, undefined);
});

test('shadow, glow, and feather share one SourceAlpha pipeline and restore independently', () => {
  const { image, host, controls } = createHarness(
    { filter: 'contrast(110%)' },
    { 'box-shadow': '1px 2px 3px rgba(1, 2, 3, 0.4)' }
  );

  controls.applyEffect('shadow', {
    x: 6, y: 9, blur: 20, spread: 3, opacity: 35, shadowColor: '#123456'
  });
  controls.applyEffect('glow', {
    blur: 16, spread: 2, opacity: 60, glowColor: '#ffd447'
  });
  controls.applyEffect('feather', { amount: 8 });

  const combinedSvg = decodeAlphaFilter(image.style.getPropertyValue('filter'));
  assert.match(combinedSvg, /in="SourceAlpha" operator="dilate" radius="3" result="shadow-spread"/);
  assert.match(combinedSvg, /<feOffset in="shadow-blur" dx="6" dy="9" result="shadow-offset"\/>/);
  assert.match(combinedSvg, /result="glow-near-layer"/);
  assert.match(combinedSvg, /result="glow-far-layer"/);
  assert.match(combinedSvg, /<feGaussianBlur in="SourceAlpha" stdDeviation="4" result="feather-alpha"\/>/);
  assert.match(combinedSvg, /<feComposite in="SourceGraphic" in2="feather-alpha" operator="in" result="feather-content"\/>/);
  assert.equal(host.style.getPropertyValue('box-shadow'), '1px 2px 3px rgba(1, 2, 3, 0.4)');

  controls.clearEffect('shadow');
  const withoutShadow = decodeAlphaFilter(image.style.getPropertyValue('filter'));
  assert.doesNotMatch(withoutShadow, /shadow-/);
  assert.match(withoutShadow, /glow-near-layer/);
  assert.match(withoutShadow, /feather-content/);

  controls.clearEffect('feather');
  const glowOnly = decodeAlphaFilter(image.style.getPropertyValue('filter'));
  assert.doesNotMatch(glowOnly, /feather-/);
  assert.match(glowOnly, /glow-near-layer/);

  controls.clearEffect('glow');
  assert.equal(image.style.getPropertyValue('filter'), 'contrast(110%)');
  assert.equal(image.dataset.mpseFilterBase, undefined);
  assert.equal(host.style.getPropertyValue('box-shadow'), '1px 2px 3px rgba(1, 2, 3, 0.4)');
});

test('legacy container shadow and feather migrate to alpha effects without losing native styles', () => {
  const { image, host, controls } = createHarness(
    { filter: 'saturate(90%)', 'mask-image': 'url(native-image-mask)' },
    {
      'box-shadow': '0 0 20px red, 2px 3px 4px blue',
      'mask-image': 'radial-gradient(ellipse at center, #000 0%, transparent 100%)'
    }
  );
  image.dataset.mpseBaseBoxShadow = '2px 3px 4px blue';
  image.dataset.mpseShadowOn = '1';
  image.dataset.mpseShadowX = '4';
  image.dataset.mpseShadowY = '5';
  image.dataset.mpseShadowBlur = '12';
  image.dataset.mpseShadowSpread = '1';
  image.dataset.mpseShadowOpacity = '40';
  image.dataset.mpseShadowColor = '#000000';
  image.dataset.mpseFeatherBase = JSON.stringify({
    image: { 'mask-image': { value: 'url(native-image-mask)', priority: '' } },
    host: { 'mask-image': { value: 'url(native-host-mask)', priority: '' } }
  });
  image.dataset.mpseFeatherOn = '1';
  image.dataset.mpseFeatherAmount = '10';

  controls.renderAppearance(image);
  const migratedSvg = decodeAlphaFilter(image.style.getPropertyValue('filter'));
  assert.match(migratedSvg, /shadow-layer/);
  assert.match(migratedSvg, /feather-content/);
  assert.equal(host.style.getPropertyValue('box-shadow'), '2px 3px 4px blue');
  assert.equal(image.style.getPropertyValue('mask-image'), 'url(native-image-mask)');
  assert.equal(host.style.getPropertyValue('mask-image'), 'url(native-host-mask)');
  assert.equal(image.dataset.mpseBaseBoxShadow, undefined);
  assert.equal(image.dataset.mpseFeatherBase, undefined);

  controls.clearEffect('feather');
  controls.clearEffect('shadow');
  assert.equal(image.style.getPropertyValue('filter'), 'saturate(90%)');
  assert.equal(host.style.getPropertyValue('box-shadow'), '2px 3px 4px blue');
  assert.equal(host.style.getPropertyValue('mask-image'), 'url(native-host-mask)');
});

test('alpha stroke temporarily hides and then restores a native outline', () => {
  const { image, controls } = createHarness({ outline: '2px dashed blue', 'outline-offset': '1px' });

  controls.applyEffect('stroke', { width: 2, opacity: 100, strokeColor: '#ffffff' });
  assert.equal(image.style.getPropertyValue('outline'), '');
  assert.equal(image.style.getPropertyValue('outline-offset'), '');

  controls.clearEffect('stroke');
  assert.equal(image.style.getPropertyValue('outline'), '2px dashed blue');
  assert.equal(image.style.getPropertyValue('outline-offset'), '1px');
});

test('effect records survive node replacement without storing image URLs in plain text', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value)
  };
  const identity = {
    scopeKey: 'editor:body',
    index: 2,
    editId: 'img-123',
    src: 'https://mmbiz.qpic.cn/private-image.png',
    w: '900',
    ratio: '1.5'
  };
  const records = globalThis.__MPSE_IMAGE_EFFECT_RECORDS__.create({ storage });
  records.remember(
    identity,
    { mpseOpacityOn: '1', mpseOpacityValue: '45' },
    { 'data-mpse-image-crop': '1', 'data-mpse-crop-layout': '{"alignment":"center"}' }
  );

  const reloaded = globalThis.__MPSE_IMAGE_EFFECT_RECORDS__.create({ storage });
  const restored = reloaded.find({ ...identity, editId: '' });
  assert.deepEqual(restored.data, { mpseOpacityOn: '1', mpseOpacityValue: '45' });
  assert.deepEqual(restored.hostData, {
    'data-mpse-image-crop': '1',
    'data-mpse-crop-layout': '{"alignment":"center"}'
  });
  assert.doesNotMatch(Array.from(values.values()).join(''), /private-image\.png/);

  reloaded.remember(identity, {});
  assert.equal(reloaded.find(identity), null);
});
