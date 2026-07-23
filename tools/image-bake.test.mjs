import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeElement, readJson, readText } from './test-helpers.mjs';

await import(new URL('../src/image-bake.js', import.meta.url));
await import(new URL('../src/image-effect-records.js', import.meta.url));
await import(new URL('../src/image-bake-pipeline.js', import.meta.url));

const bake = globalThis.__MPSE_IMAGE_BAKE__;
const bakePipeline = globalThis.__MPSE_IMAGE_BAKE_PIPELINE__;

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

test('lazy-loaded source records always retain a visible src for failure rollback', () => {
  const source = '//mmbiz.qpic.cn/mmbiz_png/source.png';
  assert.deepEqual(
    bakePipeline.completeSourceAttributes({ 'data-src': source, 'data-w': '1080' }, source),
    {
      src: source,
      'data-src': source,
      'data-w': '1080'
    }
  );
  assert.deepEqual(
    bakePipeline.completeSourceAttributes({ src: 'data:image/gif;base64,placeholder' }, source),
    {
      src: source,
      'data-src': source
    }
  );
});

test('WeChat image ratio is stored as height divided by width', () => {
  assert.equal(bakePipeline.wechatImageRatio(1200, 600), 0.5);
  assert.equal(bakePipeline.wechatImageRatio(600, 1200), 2);
  assert.equal(bakePipeline.wechatImageRatio(0, 0), 1);
});

test('pending bake jobs rebind by stable image id and settle through one commit gate', async () => {
  const previousWindow = globalThis.window;
  const scheduled = [];
  globalThis.window = {
    setTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false };
      scheduled.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    }
  };

  try {
    const original = new FakeElement('img', { src: 'https://mmbiz.qpic.cn/source.png' });
    original.dataset = {};
    original.isConnected = true;
    original.hasAttribute = (name) => original.attributeValues.has(name);
    const replacement = new FakeElement('img', { src: 'https://mmbiz.qpic.cn/source.png' });
    replacement.dataset = {};
    replacement.isConnected = true;
    replacement.hasAttribute = (name) => replacement.attributeValues.has(name);

    const events = [];
    const commits = [];
    const records = {
      find: () => null,
      remember: () => {},
      rememberAsset: () => {},
      forget: () => {}
    };
    const pipeline = bakePipeline.create({
      state: { isDragging: false },
      records,
      bridgeClient: {},
      bakeEngine: {
        recipeFromImage: () => ({ version: 1 }),
        hasEffects: () => false
      },
      getAttr: (image, name) => image.getAttribute(name) || '',
      stableUrl: (value) => String(value || ''),
      imageSignature: (image) => ({
        editId: image.getAttribute('data-mpse-image-id') || '',
        src: image.getAttribute('src') || ''
      }),
      ensureImageEditId(image) {
        if (!image.getAttribute('data-mpse-image-id')) image.setAttribute('data-mpse-image-id', 'img-stable');
        return image.getAttribute('data-mpse-image-id');
      },
      managedDataFromImage: (image) => ({ ...image.dataset }),
      getCropContainer: () => null,
      markChanged: (image, reason, schedule, identity) => commits.push({ image, reason, schedule, identity }),
      setBadgeText: () => {},
      finishAdvancedBake: () => {},
      schedulePositionTools: () => {},
      resolveImage(identity) {
        events.push(['resolve', identity.editId]);
        return replacement;
      },
      onBakePending: () => events.push(['pending']),
      onBakeSettled: (_image, _identity, outcome) => events.push(['settled', outcome])
    });

    assert.equal(pipeline.requestBake(original), true);
    assert.equal(pipeline.hasPending(), true);
    assert.deepEqual(events, [['pending']]);
    original.isConnected = false;
    await scheduled[0].callback();

    assert.equal(replacement.getAttribute('data-mpse-image-id'), 'img-stable');
    assert.equal(commits.length, 1);
    assert.equal(commits[0].image, replacement);
    assert.equal(commits[0].reason, 'bake');
    assert.equal(commits[0].schedule, false);
    assert.equal(pipeline.hasPending(), false);
    assert.deepEqual(events, [
      ['pending'],
      ['resolve', 'img-stable'],
      ['settled', 'restored']
    ]);
  } finally {
    globalThis.window = previousWindow;
  }
});

test('an in-flight paste keeps superseded candidates for one final cleanup commit', async () => {
  const previousWindow = globalThis.window;
  const scheduled = [];
  globalThis.window = {
    setTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false };
      scheduled.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    }
  };

  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
  };
  const nextActiveBake = () => {
    const timer = scheduled.find((entry) => !entry.cleared && entry.delay === 680);
    assert.ok(timer, 'expected an active bake timer');
    timer.cleared = true;
    return timer.callback();
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  try {
    const image = new FakeElement('img', {
      src: 'data:image/png;base64,AA==',
      'data-src': 'data:image/png;base64,AA=='
    });
    image.dataset = { recipeRevision: '1' };
    image.isConnected = true;
    image.hasAttribute = (name) => image.attributeValues.has(name);
    image.getBoundingClientRect = () => ({ width: 320, height: 180 });
    image.naturalWidth = 320;

    const uploads = [deferred(), deferred()];
    let pasteCalls = 0;
    const commits = [];
    const settled = [];
    const records = {
      find: () => null,
      remember: () => {},
      rememberAsset: () => {},
      forget: () => {}
    };
    const pipeline = bakePipeline.create({
      state: { isDragging: false },
      records,
      bridgeClient: {
        pasteImage() {
          return uploads[pasteCalls++].promise;
        }
      },
      bakeEngine: {
        recipeFromImage: (target) => ({ version: Number(target.dataset.recipeRevision) }),
        hasEffects: () => true,
        bake: async () => ({
          blob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
          width: 960,
          height: 540
        }),
        recipeKey: (recipe) => String(recipe.version)
      },
      getAttr: (target, name) => target.getAttribute(name) || '',
      stableUrl: (value) => String(value || ''),
      imageSignature: (target) => ({
        editId: target.getAttribute('data-mpse-image-id') || '',
        src: target.getAttribute('src') || '',
        index: 0
      }),
      ensureImageEditId(target) {
        if (!target.getAttribute('data-mpse-image-id')) target.setAttribute('data-mpse-image-id', 'img-supersede');
        return target.getAttribute('data-mpse-image-id');
      },
      managedDataFromImage: (target) => ({ ...target.dataset }),
      getCropContainer: () => null,
      markChanged(target, reason, schedule) {
        commits.push({
          target,
          reason,
          schedule,
          candidates: JSON.parse(JSON.stringify(target.__mpseNativePasteCandidates || []))
        });
      },
      setBadgeText: () => {},
      finishAdvancedBake: () => {},
      schedulePositionTools: () => {},
      resolveImage: () => image,
      onBakePending: () => {},
      onBakeSettled: (_target, _identity, outcome) => settled.push(outcome)
    });

    pipeline.requestBake(image);
    const firstRun = nextActiveBake();
    await flush();
    assert.equal(pasteCalls, 1);

    image.dataset.recipeRevision = '2';
    pipeline.requestBake(image);
    uploads[0].resolve({
      pasteId: 'paste-1',
      cdnUrl: 'https://mmbiz.qpic.cn/first.png',
      sourceAttributes: { src: 'https://mmbiz.qpic.cn/first.png' },
      mimeType: 'image/png'
    });
    await firstRun;
    assert.equal(pipeline.hasPending(), true);
    assert.equal(commits.length, 0, 'a superseded upload must not commit an intermediate image');

    const secondRun = nextActiveBake();
    await flush();
    assert.equal(pasteCalls, 2);
    uploads[1].resolve({
      pasteId: 'paste-2',
      cdnUrl: 'https://mmbiz.qpic.cn/second.png',
      sourceAttributes: { src: 'https://mmbiz.qpic.cn/second.png' },
      mimeType: 'image/png'
    });
    await secondRun;

    assert.equal(commits.length, 1);
    assert.deepEqual(commits[0].candidates, [
      { pasteId: 'paste-1', cdnUrl: 'https://mmbiz.qpic.cn/first.png', placement: 'after' },
      { pasteId: 'paste-2', cdnUrl: 'https://mmbiz.qpic.cn/second.png', placement: 'after' }
    ]);
    assert.deepEqual(settled, ['succeeded']);
    assert.equal(pipeline.hasPending(), false);
  } finally {
    globalThis.window = previousWindow;
  }
});

test('a cleanup wait cannot settle a newer bake revision', async () => {
  const previousWindow = globalThis.window;
  const scheduled = [];
  globalThis.window = {
    setTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false };
      scheduled.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    }
  };

  let resolveDiscard;
  let notifyDiscard;
  const discardStarted = new Promise((resolve) => { notifyDiscard = resolve; });
  const discardResult = new Promise((resolve) => { resolveDiscard = resolve; });
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  try {
    const createImage = () => {
      const image = new FakeElement('img', {
        src: 'data:image/png;base64,AA==',
        'data-src': 'data:image/png;base64,AA==',
        'data-mpse-image-id': 'img-cleanup-race'
      });
      image.dataset = { recipeRevision: '1' };
      image.isConnected = true;
      image.hasAttribute = (name) => image.attributeValues.has(name);
      image.getBoundingClientRect = () => ({ width: 320, height: 180 });
      image.naturalWidth = 320;
      return image;
    };
    const original = createImage();
    const replacement = createImage();
    replacement.dataset.recipeRevision = '2';

    let activeImage = original;
    const settled = [];
    const pipeline = bakePipeline.create({
      state: { isDragging: false },
      records: {
        find: () => null,
        remember: () => {},
        rememberAsset: () => {},
        forget: () => {}
      },
      bridgeClient: {
        async pasteImage() {
          original.isConnected = false;
          activeImage = null;
          return {
            pasteId: 'paste-cleanup-race',
            cdnUrl: 'https://mmbiz.qpic.cn/cleanup-race.png',
            sourceAttributes: { src: 'https://mmbiz.qpic.cn/cleanup-race.png' },
            mimeType: 'image/png',
            articleKey: 'article-cleanup-race',
            cleanupPending: true
          };
        },
        discardPastedImage() {
          notifyDiscard();
          return discardResult;
        }
      },
      bakeEngine: {
        recipeFromImage: (image) => ({ version: Number(image.dataset.recipeRevision) }),
        hasEffects: () => true,
        bake: async () => ({
          blob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
          width: 960,
          height: 540
        }),
        recipeKey: (recipe) => String(recipe.version)
      },
      getAttr: (image, name) => image.getAttribute(name) || '',
      stableUrl: (value) => String(value || ''),
      imageSignature: (image) => ({
        editId: image.getAttribute('data-mpse-image-id') || '',
        src: image.getAttribute('src') || '',
        index: 0
      }),
      ensureImageEditId: (image) => image.getAttribute('data-mpse-image-id'),
      managedDataFromImage: (image) => ({ ...image.dataset }),
      getCropContainer: () => null,
      markChanged: () => {},
      setBadgeText: () => {},
      finishAdvancedBake: () => {},
      schedulePositionTools: () => {},
      resolveImage: () => activeImage,
      onBakePending: () => {},
      onBakeSettled: (_image, _identity, outcome) => settled.push(outcome)
    });

    pipeline.requestBake(original);
    const firstTimer = scheduled.find((timer) => timer.delay === 680 && !timer.cleared);
    assert.ok(firstTimer);
    firstTimer.cleared = true;
    const firstRun = firstTimer.callback();
    await discardStarted;

    activeImage = replacement;
    pipeline.requestBake(replacement);
    resolveDiscard({ changed: true, confirmedAbsent: true });
    await firstRun;
    await flush();

    assert.equal(pipeline.hasPending(), true, 'the latest revision must remain owned by the pipeline');
    assert.deepEqual(settled, []);
    assert.ok(
      scheduled.some((timer) => timer.delay === 680 && !timer.cleared),
      'the latest revision must be scheduled after cleanup finishes'
    );
  } finally {
    globalThis.window = previousWindow;
  }
});

test('advanced controls preview locally and commit only after native paste succeeds', () => {
  const controls = readText('src/image-controls.js');
  const pipeline = readText('src/image-bake-pipeline.js');
  const snapshots = readText('src/image-snapshot-merge.js');

  assert.match(controls, /const ADVANCED_EFFECTS = new Set\(\['shadow', 'glow', 'feather', 'stroke', 'color'\]\)/);
  assert.match(controls, /requestAdvancedBake\(image, changeReason\)/);
  assert.match(controls, /if \(image\.dataset\.mpseBaked === '1'\)[\s\S]*?finishAdvancedBake\(image, true\)/);
  assert.match(pipeline, /const upload = await bridgeClient\.pasteImage\(/);
  assert.match(pipeline, /if \(upload\?\.cleanupPending === false\) return/);
  assert.match(
    pipeline,
    /const upload = await bridgeClient\.pasteImage\([\s\S]*?markChanged\(target, 'bake', false, metadata\.locatorIdentity\)/,
    'article mutation must happen only after the editor paste succeeds'
  );
  assert.match(pipeline, /catch \(error\)[\s\S]*?const target = resolveJobImage\(currentJob\)[\s\S]*?restoreCommittedState\(target, metadata\)/);
  assert.match(pipeline, /url\.protocol === 'http:'[\s\S]*?url\.protocol = 'https:'/);
  assert.doesNotMatch(pipeline, /WECHAT_IMAGE_HOSTS/);
  assert.match(pipeline, /stage = '微信编辑器粘贴上传'/);
  assert.match(pipeline, /else if \(!URL_SOURCE_ATTRIBUTES\.has\(name\)\)[\s\S]*?image\.removeAttribute\(name\)/);
  assert.match(pipeline, /runtimeSource = stableUrl\(image\?\.currentSrc \|\| image\?\.src/);
  const requestBake = pipeline.match(/function requestBake\(image\) \{[\s\S]*?\n    \}/)?.[0] || '';
  assert.doesNotMatch(requestBake, /records\.remember\(/, 'unuploaded recipes must not enter durable records');
  assert.match(snapshots, /bake: \['filter', 'box-shadow'/);
  assert.match(snapshots, /const ownsImageAttributes = reason === 'bake' \|\| reason === 'reset'/);
  assert.match(snapshots, /imgAttributeAction/);
});

test('manifest allows HTTPS image reads without a WeChat CDN allowlist', () => {
  const manifest = readJson('manifest.json');
  assert.equal(manifest.background?.service_worker, 'src/image-background.js');
  assert.deepEqual(manifest.host_permissions, ['https://*/*']);
  const background = readText('src/image-background.js');
  assert.match(background, /validateUrl\(response\.url\)/);
  assert.doesNotMatch(background, /ALLOWED_IMAGE_HOSTS|MPSE_IMAGE_HOST_NOT_ALLOWED|只允许读取微信图片域名/);
  assert.doesNotMatch(background, /ALLOWED_IMAGE_TYPES[\s\S]*image\/svg\+xml/);
});
