import assert from 'node:assert/strict';
import test from 'node:test';

import { readJson, readText } from './test-helpers.mjs';

await import(new URL('../src/image-bake.js', import.meta.url));
await import(new URL('../src/image-effect-records.js', import.meta.url));

const bake = globalThis.__MPSE_IMAGE_BAKE__;

function completeRecipe() {
  return {
    version: 1,
    color: { brightness: 112, contrast: 105, saturate: 90, gray: 15 },
    stroke: { width: 4, opacity: 75, color: '#07c160' },
    shadow: { x: -6, y: 10, blur: 24, spread: 3, opacity: 35, color: '#123456' },
    glow: { blur: 18, spread: 2, opacity: 55, color: '#ffd447' },
    feather: { amount: 8 }
  };
}

test('advanced recipes are read independently from safe CSS effects', () => {
  const image = {
    dataset: {
      mpseColorOn: '1',
      mpseBrightness: '112',
      mpseContrast: '105',
      mpseSaturate: '90',
      mpseGray: '15',
      mpseStrokeOn: '1',
      mpseStrokeWidth: '4',
      mpseStrokeOpacity: '75',
      mpseStrokeColor: '#07c160'
    }
  };
  const recipe = bake.recipeFromImage(image);
  assert.deepEqual(recipe.color, completeRecipe().color);
  assert.deepEqual(recipe.stroke, completeRecipe().stroke);
  assert.equal(recipe.shadow, null);
  assert.equal(bake.hasEffects(recipe), true);
  assert.equal(bake.hasEffects(bake.recipeFromImage({ dataset: {} })), false);
});

test('alpha effects reserve transparent pixels on every affected edge', () => {
  const padding = bake.computePadding(completeRecipe(), 2);
  assert.ok(padding.left > 80, `left padding ${padding.left} must contain glow and shadow`);
  assert.ok(padding.right > 80, `right padding ${padding.right} must contain glow and shadow`);
  assert.ok(padding.top > 80, `top padding ${padding.top} must contain glow and shadow`);
  assert.ok(padding.bottom > padding.top, 'positive shadow Y offset must reserve more bottom space');
});

test('bake SVG is self-contained and composites every contour effect from SourceAlpha', () => {
  const recipe = completeRecipe();
  const padding = bake.computePadding(recipe, 2);
  const svg = bake.buildSvg({
    dataUrl: 'data:image/png;base64,AA==',
    recipe,
    contentWidth: 640,
    contentHeight: 360,
    scale: 2,
    padding
  });
  assert.match(svg, /filterUnits="userSpaceOnUse"/);
  assert.match(svg, /<feMorphology in="SourceAlpha" operator="dilate"/);
  assert.match(svg, /<feGaussianBlur in="SourceAlpha"/);
  assert.match(svg, /<feComposite in="stroke-dilate" in2="SourceAlpha" operator="out"/);
  assert.match(svg, /<feComposite in="color-gray" in2="feather-alpha" operator="in"/);
  assert.match(svg, /<feMergeNode in="shadow-layer"\/>/);
  assert.match(svg, /<feMergeNode in="glow-near-layer"\/>/);
  assert.match(svg, /<feMergeNode in="glow-far-layer"\/>/);
  assert.match(svg, /href="data:image\/png;base64,AA=="/);
  assert.doesNotMatch(svg, /<script|foreignObject|href="https?:\/\//i);
});

test('baked assets persist original and derivative identities without plain-text image URLs', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value)
  };
  const identity = {
    pageKey: '/cgi-bin/appmsg?appmsgid=77',
    scopeKey: 'editor:body',
    editId: 'img-bake-1',
    src: 'https://mmbiz.qpic.cn/source.png'
  };
  const records = globalThis.__MPSE_IMAGE_EFFECT_RECORDS__.create({ storage });
  records.remember(identity, { mpseStrokeOn: '1', mpseStrokeWidth: '4' });
  records.rememberAsset(identity, {
    sourceUrl: 'https://mmbiz.qpic.cn/source.png',
    bakedUrl: 'https://mmbiz.qpic.cn/baked.png',
    sourceAttributes: { src: 'https://mmbiz.qpic.cn/source.png' },
    width: 960,
    height: 540,
    recipeKey: 'recipe-1'
  });

  const restored = globalThis.__MPSE_IMAGE_EFFECT_RECORDS__.create({ storage }).find(identity);
  assert.equal(restored.asset.sourceUrl, 'https://mmbiz.qpic.cn/source.png');
  assert.equal(restored.asset.bakedUrl, 'https://mmbiz.qpic.cn/baked.png');
  assert.equal(restored.asset.width, 960);
  assert.doesNotMatch(Array.from(values.values()).join(''), /source\.png|baked\.png/);
});

test('advanced controls preview locally and commit only after bake upload succeeds', () => {
  const controls = readText('src/image-controls.js');
  const pipeline = readText('src/image-bake-pipeline.js');
  const snapshots = readText('src/image-snapshot-merge.js');

  assert.match(controls, /const ADVANCED_EFFECTS = new Set\(\['shadow', 'glow', 'feather', 'stroke', 'color'\]\)/);
  assert.match(controls, /requestAdvancedBake\(image, changeReason\)/);
  assert.match(controls, /if \(image\.dataset\.mpseBaked === '1'\)[\s\S]*?finishAdvancedBake\(image, true\)/);
  assert.match(pipeline, /const upload = await bridgeClient\.uploadImage\(rendered\.blob/);
  assert.match(
    pipeline,
    /const upload = await bridgeClient\.uploadImage\(rendered\.blob[\s\S]*?markChanged\(image, 'bake', true, metadata\.locatorIdentity\)/,
    'article mutation must happen only after the CDN upload succeeds'
  );
  assert.match(pipeline, /catch \(error\)[\s\S]*?restoreCommittedState\(image, metadata\)/);
  const requestBake = pipeline.match(/function requestBake\(image\) \{[\s\S]*?\n    \}/)?.[0] || '';
  assert.doesNotMatch(requestBake, /records\.remember\(/, 'unuploaded recipes must not enter durable records');
  assert.match(snapshots, /bake: \['filter', 'box-shadow'/);
  assert.match(snapshots, /imgAttributePatch: reason === 'bake' \|\| reason === 'reset'/);
});

test('manifest restricts image reads to explicit WeChat CDN hosts', () => {
  const manifest = readJson('manifest.json');
  assert.equal(manifest.background?.service_worker, 'src/image-background.js');
  assert.deepEqual(manifest.host_permissions, [
    'https://mp.weixin.qq.com/*',
    'https://mmbiz.qpic.cn/*',
    'https://mmbiz.qlogo.cn/*',
    'https://m.qpic.cn/*',
    'https://mmsns.qpic.cn/*'
  ]);
  assert.doesNotMatch(JSON.stringify(manifest.host_permissions), /<all_urls>|\*:\/\//);
  const background = readText('src/image-background.js');
  assert.match(background, /validateUrl\(response\.url\)/);
  assert.doesNotMatch(background, /ALLOWED_IMAGE_TYPES[\s\S]*image\/svg\+xml/);
});
