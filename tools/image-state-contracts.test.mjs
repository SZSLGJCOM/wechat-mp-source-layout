import assert from 'node:assert/strict';
import test from 'node:test';

import { closeTo, readText } from './test-helpers.mjs';

await import(new URL('../src/image-geometry.js', import.meta.url));
await import(new URL('../src/image-snapshot-merge.js', import.meta.url));
const imageGeometry = globalThis.__MPSE_IMAGE_GEOMETRY__;
const snapshotMerge = globalThis.__MPSE_IMAGE_SNAPSHOT_MERGE__;

test('image commits cannot steal a newer native selection', () => {
  const imageTools = readText('src/image-tools.js');

  assert.match(imageTools, /reason === 'drag-end' \? 420 : 360/);
  assert.match(imageTools, /function scheduleSelectedImageReacquire\(/);
  assert.match(imageTools, /state\.selectionRevision !== selectionRevision/);
  assert.match(imageTools, /function restoreLatestSnapshotInEditor\(/);
  assert.match(imageTools, /state\.pendingSnapshots\.get\(key\) === snapshot/);
  assert.match(imageTools, /function identityHasPrimaryKey\(/);
  assert.match(imageTools, /bestScore >= 600/);
  assert.doesNotMatch(imageTools, /state\.interaction|rebaseInteractionAfterEditorWrite|finishGeometryGesture/);
});

test('image commits preserve every pending image across serialized editor writes', () => {
  const imageTools = readText('src/image-tools.js');

  assert.match(imageTools, /pendingSnapshots: new Map\(\)/);
  assert.match(imageTools, /function imageIdentityKey\(identity\)/);
  assert.match(imageTools, /state\.pendingSnapshots\.set\(imageIdentityKey\(snapshot\.identity\), snapshot\)/);
  assert.match(imageTools, /function pendingSnapshotBatch\(\)/);
  assert.match(imageTools, /\.sort\(\(first, second\) => first\.snapshot\.revision - second\.snapshot\.revision\)/);
  assert.match(imageTools, /function applySnapshotBatch\(content, batch\)/);
  assert.match(imageTools, /for \(const \{ key, snapshot \} of batch\)/);
  assert.match(imageTools, /failedKey: key, failedSnapshot: snapshot/);
  assert.match(imageTools, /function clearCommittedSnapshots\(batch\)/);
  assert.match(imageTools, /if \(state\.pendingSnapshots\.get\(key\) === snapshot\) state\.pendingSnapshots\.delete\(key\)/);
  assert.match(imageTools, /function restorePendingSnapshotsInEditor\(\)/);
  assert.match(imageTools, /const transaction = await mutateEditorContent\(\(current\) => \{/);
  assert.match(imageTools, /if \(!commitBatchIsCurrent\(batch\)\) return \{ changed: false, reason: 'stale-batch' \};/);
  assert.match(imageTools, /const result = transaction\.value \|\| \{ changed: false, reason: 'empty-transaction' \}/);
  assert.match(imageTools, /state\.commitRetryCount < 3/);
  assert.match(imageTools, /state\.needsCommit = state\.pendingSnapshots\.size > 0/);
  assert.match(imageTools, /async function handoffSnapshotCandidates\(batch\)/);
  assert.match(imageTools, /result\?\.cleanupScheduled/);
  assert.match(imageTools, /if \(!allowRetry\) await handoffSnapshotCandidates\(batch\)/);
});

test('temporary paste candidates can be cleaned after the original image disappears', () => {
  const imageTools = readText('src/image-tools.js');
  const start = imageTools.indexOf('  function removeNativePasteCandidateNode(root, target, image) {');
  const end = imageTools.indexOf('  function restoreLatestSnapshotInEditor(snapshot) {', start);
  assert.ok(start >= 0 && end > start, 'native paste cleanup functions must exist');

  const cleanupSource = imageTools.slice(start, end);
  const { removeNativePasteCandidates } = Function(
    'stableUrl',
    `${cleanupSource}\nreturn { removeNativePasteCandidates };`
  )((value) => String(value || '').trim());

  const createRoot = (attributes) => {
    const root = {
      images: [],
      querySelectorAll(selector) {
        return selector === 'img' ? this.images.filter((image) => !image.removed) : [];
      }
    };
    const image = {
      removed: false,
      parentElement: root,
      getAttribute(name) {
        return attributes[name] || '';
      },
      remove() {
        this.removed = true;
      }
    };
    root.images.push(image);
    return { root, image };
  };

  const marked = createRoot({
    'data-mpse-native-paste-id': 'paste-marked',
    'data-src': 'https://mmbiz.qpic.cn/marked.png'
  });
  const markedResult = removeNativePasteCandidates(marked.root, marked.image, [{
    pasteId: 'paste-marked',
    cdnUrl: 'https://mmbiz.qpic.cn/marked.png'
  }], { index: 0 });
  assert.equal(markedResult.changed, true);
  assert.equal(markedResult.target, null);
  assert.equal(marked.image.removed, true);
  assert.deepEqual(markedResult.unresolved, []);

  const unmarked = createRoot({
    'data-src': 'https://mmbiz.qpic.cn/unmarked.png'
  });
  const unmarkedResult = removeNativePasteCandidates(unmarked.root, null, [{
    pasteId: 'stripped-marker',
    cdnUrl: 'https://mmbiz.qpic.cn/unmarked.png'
  }], { index: 0 });
  assert.equal(unmarkedResult.changed, false);
  assert.equal(unmarkedResult.target, unmarked.image);
  assert.equal(unmarked.image.removed, false);
  assert.deepEqual(unmarkedResult.unresolved, []);

  const replacement = createRoot({
    'data-mpse-native-paste-id': 'paste-replace',
    'data-src': 'https://mmbiz.qpic.cn/replacement.png'
  });
  replacement.image.removeAttribute = () => {};
  const replacementResult = removeNativePasteCandidates(replacement.root, replacement.image, [{
    pasteId: 'paste-replace',
    cdnUrl: 'https://mmbiz.qpic.cn/replacement.png',
    placement: 'replace'
  }], { index: 0 });
  assert.equal(replacementResult.changed, true);
  assert.equal(replacementResult.target, replacement.image);
  assert.equal(replacement.image.removed, false, 'an in-place replacement must be promoted, not deleted');
  assert.deepEqual(replacementResult.unresolved, []);

  const pairRoot = {
    images: [],
    querySelectorAll(selector) {
      return selector === 'img' ? this.images.filter((image) => !image.removed) : [];
    }
  };
  const pairImage = (source) => ({
    removed: false,
    parentElement: pairRoot,
    getAttribute(name) {
      return name === 'data-src' ? source : '';
    },
    remove() {
      this.removed = true;
    }
  });
  const promotedOriginal = pairImage('https://mmbiz.qpic.cn/shared-baked.png?wx_fmt=png&from=appmsg');
  const appendedCandidate = pairImage('https://mmbiz.qpic.cn/shared-baked.png?wx_fmt=png&tp=webp&wxfrom=5');
  pairRoot.images.push(promotedOriginal, appendedCandidate);
  const pairResult = removeNativePasteCandidates(pairRoot, null, [{
    pasteId: 'stripped-appended-marker',
    cdnUrl: 'https://mmbiz.qpic.cn/shared-baked.png?wx_fmt=png&from=appmsg',
    placement: 'after'
  }], { index: 0 });
  assert.equal(pairResult.target, promotedOriginal);
  assert.equal(promotedOriginal.removed, false);
  assert.equal(appendedCandidate.removed, true);

  const markedPairRoot = {
    images: [],
    querySelectorAll(selector) {
      return selector === 'img' ? this.images.filter((image) => !image.removed) : [];
    }
  };
  const markedPairImage = (attributes) => ({
    removed: false,
    parentElement: markedPairRoot,
    getAttribute(name) {
      return attributes[name] || '';
    },
    remove() {
      this.removed = true;
    }
  });
  const markedPairOriginal = markedPairImage({
    'data-src': 'https://mmbiz.qpic.cn/marked-shared.png'
  });
  const markedPairCandidate = markedPairImage({
    'data-mpse-native-paste-id': 'marked-after',
    'data-src': 'https://mmbiz.qpic.cn/marked-shared.png'
  });
  markedPairRoot.images.push(markedPairOriginal, markedPairCandidate);
  const markedPairResult = removeNativePasteCandidates(markedPairRoot, null, [{
    pasteId: 'marked-after',
    cdnUrl: 'https://mmbiz.qpic.cn/marked-shared.png',
    placement: 'after'
  }], { index: 0 });
  assert.equal(markedPairResult.target, markedPairOriginal);
  assert.equal(markedPairOriginal.removed, false);
  assert.equal(markedPairCandidate.removed, true);
});

test('terminal image commit failures transfer candidate ownership explicitly', async () => {
  const imageTools = readText('src/image-tools.js');
  const start = imageTools.indexOf('  async function handoffSnapshotCandidates(batch) {');
  const end = imageTools.indexOf('  function restorePendingSnapshotsInEditor() {', start);
  assert.ok(start >= 0 && end > start, 'candidate handoff function must exist');

  const calls = [];
  const handoffSnapshotCandidates = Function(
    'discardPastedImage',
    `${imageTools.slice(start, end)}\nreturn handoffSnapshotCandidates;`
  )(async (candidate, locator) => {
    calls.push({ candidate, locator });
    return candidate.pasteId === 'accepted'
      ? { changed: false, cleanupScheduled: true }
      : { changed: false, confirmedAbsent: false };
  });
  const snapshot = {
    identity: {
      editId: 'image-handoff',
      src: 'https://mmbiz.qpic.cn/source-handoff.png',
      index: 3
    },
    nativePasteCandidates: [
      {
        pasteId: 'accepted',
        cdnUrl: 'https://mmbiz.qpic.cn/accepted.png',
        articleKey: 'article-handoff',
        placement: 'after'
      },
      {
        pasteId: 'unresolved',
        cdnUrl: 'https://mmbiz.qpic.cn/unresolved.png',
        articleKey: 'article-handoff',
        placement: 'replace'
      }
    ]
  };

  await handoffSnapshotCandidates([{ key: 'image-handoff', snapshot }]);

  assert.deepEqual(snapshot.nativePasteCandidates, [
    {
      pasteId: 'accepted',
      cdnUrl: 'https://mmbiz.qpic.cn/accepted.png',
      articleKey: 'article-handoff',
      placement: 'after',
      cleanupOwner: 'page-bridge'
    },
    {
      pasteId: 'unresolved',
      cdnUrl: 'https://mmbiz.qpic.cn/unresolved.png',
      articleKey: 'article-handoff',
      placement: 'replace'
    }
  ]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].locator, {
    editId: 'image-handoff',
    sourceUrl: 'https://mmbiz.qpic.cn/source-handoff.png',
    index: 3
  });
  assert.equal(calls[1].candidate.articleKey, 'article-handoff');
});

test('candidate cleanup still applies the snapshot to a promoted original image', () => {
  const imageTools = readText('src/image-tools.js');
  const start = imageTools.indexOf('  function removeNativePasteCandidateNode(root, target, image) {');
  const end = imageTools.indexOf('  function restoreLatestSnapshotInEditor(snapshot) {', start);
  const { applySnapshotToRoot } = Function(
    'stableUrl',
    'locateImageInHtml',
    'applySnapshotToTarget',
    `${imageTools.slice(start, end)}\nreturn { applySnapshotToRoot };`
  )(
    (value) => String(value || '').trim(),
    () => null,
    (target) => {
      target.applied = true;
      return target;
    }
  );

  const root = {
    images: [],
    querySelectorAll(selector) {
      return selector === 'img' ? this.images.filter((image) => !image.removed) : [];
    }
  };
  const createImage = (attributes) => ({
    applied: false,
    removed: false,
    parentElement: root,
    getAttribute(name) {
      return attributes[name] || '';
    },
    remove() {
      this.removed = true;
    }
  });
  const original = createImage({
    'data-src': 'https://mmbiz.qpic.cn/shared-promote.png'
  });
  const candidate = createImage({
    'data-mpse-native-paste-id': 'candidate-promote',
    'data-src': 'https://mmbiz.qpic.cn/shared-promote.png'
  });
  root.images.push(original, candidate);

  const result = applySnapshotToRoot(root, {
    identity: { index: 0 },
    nativePasteCandidates: [{
      pasteId: 'candidate-promote',
      cdnUrl: 'https://mmbiz.qpic.cn/shared-promote.png',
      placement: 'after'
    }]
  });

  assert.deepEqual(result, { changed: true, reason: 'ok' });
  assert.equal(original.applied, true);
  assert.equal(original.removed, false);
  assert.equal(candidate.removed, true);
});

test('one snapshot transaction removes the carrier and preserves the original presentation state', () => {
  const imageTools = readText('src/image-tools.js');
  const targetStart = imageTools.indexOf('  function copyManagedData(source, target) {');
  const targetEnd = imageTools.indexOf('  function parseContentRoot(content) {', targetStart);
  const cleanupStart = imageTools.indexOf('  function removeNativePasteCandidateNode(root, target, image) {');
  const cleanupEnd = imageTools.indexOf('  function restoreLatestSnapshotInEditor(snapshot) {', cleanupStart);
  assert.ok(targetStart >= 0 && targetEnd > targetStart && cleanupStart >= 0 && cleanupEnd > cleanupStart);

  const { applySnapshotToRoot } = Function(
    'MANAGED_DATA_KEYS',
    'snapshotMerge',
    'CROP_ATTR',
    'IMAGE_SOURCE_ATTRIBUTES',
    'getCropContainer',
    'getVisualCarrier',
    'stableUrl',
    'locateImageInHtml',
    `${imageTools.slice(targetStart, targetEnd)}
${imageTools.slice(cleanupStart, cleanupEnd)}
return { applySnapshotToRoot };`
  )(
    ['mpseGlowOn', 'mpseGlowBlur'],
    snapshotMerge,
    'data-mpse-image-crop',
    ['src', 'data-src', 'data-fileid', 'data-w', 'data-ratio'],
    (image) => image.cropHost || null,
    () => null,
    (value) => String(value || '').replaceAll('&amp;', '&').trim(),
    (root, identity) => root.images.find((image) => (
      !image.removed && image.getAttribute('data-mpse-image-id') === identity.editId
    )) || null
  );

  function createStyle(initial = {}) {
    const values = new Map(Object.entries(initial).map(([name, value]) => [
      name,
      { value: String(value), priority: '' }
    ]));
    return {
      setProperty(name, value, priority = '') {
        values.set(name, { value: String(value), priority: String(priority) });
      },
      removeProperty(name) {
        values.delete(name);
      },
      getPropertyValue: (name) => values.get(name)?.value || '',
      getPropertyPriority: (name) => values.get(name)?.priority || ''
    };
  }

  const root = {
    tagName: 'DIV',
    textContent: '',
    images: [],
    querySelectorAll(selector) {
      return selector === 'img' ? this.images.filter((image) => !image.removed) : [];
    }
  };
  const block = { style: createStyle({ 'text-align': 'center' }) };
  const cropHost = {
    style: createStyle({ width: '70%', overflow: 'hidden' }),
    getAttribute: (name) => (name === 'data-mpse-image-crop' ? '1' : ''),
    parentNode: root
  };
  const createImage = (initialAttributes, parentElement = root) => {
    const attributes = new Map(Object.entries(initialAttributes));
    return {
      removed: false,
      parentElement,
      cropHost: null,
      style: createStyle({ width: '70%', 'border-radius': '18px' }),
      get attributes() {
        return [...attributes].map(([name, value]) => ({ name, value }));
      },
      getAttribute: (name) => attributes.get(name) || '',
      setAttribute(name, value) {
        attributes.set(name, String(value));
      },
      removeAttribute(name) {
        attributes.delete(name);
      },
      closest() {
        return block;
      },
      remove() {
        this.removed = true;
      }
    };
  };

  const original = createImage({
    src: 'https://assets.example.com/original.png',
    'data-src': 'https://assets.example.com/original.png',
    'data-fileid': 'original-file',
    'data-mpse-image-id': 'stable-original',
    'data-mpse-glow-on': '1',
    'data-mpse-glow-blur': '24'
  }, cropHost);
  original.cropHost = cropHost;
  const carrier = createImage({
    src: 'https://mmbiz.qpic.cn/baked.png?wx_fmt=png&from=appmsg',
    'data-src': 'https://mmbiz.qpic.cn/baked.png?wx_fmt=png&from=appmsg',
    'data-fileid': 'baked-file',
    'data-mpse-native-paste-id': 'atomic-carrier'
  });
  const neighbor = createImage({
    src: 'https://mmbiz.qpic.cn/neighbor.png',
    'data-src': 'https://mmbiz.qpic.cn/neighbor.png',
    'data-mpse-image-id': 'neighbor'
  });
  root.images.push(original, carrier, neighbor);

  const result = applySnapshotToRoot(root, {
    identity: { editId: 'stable-original', index: 0 },
    nativePasteCandidates: [{
      pasteId: 'atomic-carrier',
      cdnUrl: 'https://mmbiz.qpic.cn/baked.png?wx_fmt=png&from=appmsg',
      placement: 'after'
    }],
    cropAction: 'preserve',
    imgAttributeAction: 'sync',
    imgAttributePatch: {
      src: 'https://mmbiz.qpic.cn/baked.png?wx_fmt=png&from=appmsg',
      'data-src': 'https://mmbiz.qpic.cn/baked.png?wx_fmt=png&from=appmsg',
      'data-fileid': 'baked-file',
      'data-w': '1200',
      'data-ratio': '0.625'
    },
    imgStylePatch: {
      width: { value: '70%', priority: '' },
      'border-radius': { value: '18px', priority: '' }
    },
    imgData: {
      mpseGlowOn: '1',
      mpseGlowBlur: '24'
    },
    carrierStylePatch: {},
    blockStylePatch: {},
    captionAction: 'none'
  });

  assert.deepEqual(result, { changed: true, reason: 'ok' });
  assert.deepEqual(root.querySelectorAll('img'), [original, neighbor]);
  assert.equal(original.removed, false);
  assert.equal(original.cropHost, cropHost);
  assert.equal(original.style.getPropertyValue('width'), '70%');
  assert.equal(original.style.getPropertyValue('border-radius'), '18px');
  assert.equal(original.getAttribute('data-mpse-glow-on'), '1');
  assert.equal(original.getAttribute('data-mpse-glow-blur'), '24');
  assert.equal(original.getAttribute('data-src'), 'https://mmbiz.qpic.cn/baked.png?wx_fmt=png&from=appmsg');
  assert.equal(original.getAttribute('data-fileid'), 'baked-file');
  assert.equal(original.getAttribute('data-w'), '1200');
  assert.equal(original.getAttribute('data-ratio'), '0.625');
  assert.equal(neighbor.removed, false);
});

test('image baking and style snapshots share one serialized content commit gate', () => {
  const imageTools = readText('src/image-tools.js');
  const bakePipeline = readText('src/image-bake-pipeline.js');

  assert.match(imageTools, /onBakePending\(\)[\s\S]*?window\.clearTimeout\(state\.commitTimer\)/);
  assert.match(imageTools, /if \(imageBakePipeline\?\.hasPending\(\)\)[\s\S]*?return;/);
  assert.match(imageTools, /onBakeSettled\(image, identity, outcome\)/);
  assert.match(imageTools, /onBakeSettled\(image, identity, outcome\)[\s\S]*?bindSelectedImage\(image, settledIdentity\)/);
  assert.match(imageTools, /if \(!imageBakePipeline\?\.hasPending\(\) && state\.needsCommit\)[\s\S]*?commitSnapshotToEditor\(/);
  assert.match(imageTools, /function resolveBakeImage\(identity\)[\s\S]*?applySnapshotToTarget\(target, root, snapshot\)/);
  assert.match(bakePipeline, /function resolveJobImage\(job\)/);
  assert.match(bakePipeline, /job\.recipe = bakeEngine\.recipeFromImage\(image\)/);
  assert.match(bakePipeline, /if \(currentJob\.revision !== revision\)[\s\S]*?scheduleExecution\(key, currentJob\)/);
  assert.match(bakePipeline, /rememberPasteCandidate\(currentJob, upload\)/);
  assert.match(imageTools, /data-mpse-native-paste-id/);
  assert.match(bakePipeline, /const target = resolveJobImage\(currentJob\)/);
  assert.match(bakePipeline, /markChanged\(target, 'bake', false, metadata\.locatorIdentity\)/);
  assert.doesNotMatch(bakePipeline, /execute\(image, key, generation\)/);
});

test('native selection reacquire remains scope-bound after editor DOM replacement', () => {
  const imageTools = readText('src/image-tools.js');
  const imageControls = readText('src/image-controls.js');

  assert.match(imageTools, /function editorScopeKey\(image\)/);
  assert.match(imageTools, /scopeKey: editorScopeKey\(image\)/);
  assert.match(imageTools, /filter\(\(image\) => !identity\.scopeKey \|\| editorScopeKey\(image\) === identity\.scopeKey\)/);
  assert.match(imageTools, /function reacquireSelectedImage\(identity = state\.identity\)/);
  assert.match(imageTools, /const REACQUIRE_RETRY_DELAYS_MS = Object\.freeze\(\[/);
  assert.match(imageTools, /const nextAttempt = attempt \+ 1;[\s\S]*?REACQUIRE_RETRY_DELAYS_MS\[nextAttempt\]/);
  assert.match(imageTools, /function bindSelectedImage\(image, expectedIdentity = state\.identity\)[\s\S]*?refreshVisiblePanel\(\)/);
  assert.match(imageControls, /\(!state\.image \|\| !state\.image\.isConnected\)[\s\S]*?reacquireSelectedImage\(\(\) => onPanelInput/);
  assert.match(imageTools, /\/\^\\\/cgi-bin\\\/appmsg\(\?:\\\/\|\$\)\//);
  assert.doesNotMatch(imageTools, /#js_content|\.rich_media_content/);
});

test('selected-image reacquire retries boundedly and stops after a newer selection', () => {
  const imageTools = readText('src/image-tools.js');
  const start = imageTools.indexOf('  function cancelScheduledReacquire(clearCallback = false) {');
  const end = imageTools.indexOf('  function copyManagedData(source, target) {', start);
  assert.ok(start >= 0 && end > start, 'reacquire scheduler source must exist');
  const schedulerSource = imageTools.slice(start, end);

  function createScheduler(resolveImage) {
    const timers = new Map();
    const delays = [];
    let timerId = 0;
    const windowMock = {
      setTimeout(callback, delay) {
        const id = ++timerId;
        timers.set(id, callback);
        delays.push(delay);
        return id;
      },
      clearTimeout(id) {
        timers.delete(id);
      }
    };
    const state = {
      reacquireTimer: null,
      selectionRevision: 1,
      lastSnapshot: null,
      commitSeq: 0,
      pendingReacquireCallback: null
    };
    const schedule = Function(
      'window',
      'state',
      'REACQUIRE_RETRY_DELAYS_MS',
      'reacquireSelectedImage',
      `${schedulerSource}\nreturn scheduleSelectedImageReacquire;`
    )(windowMock, state, [0, 50, 100, 180], resolveImage);
    const runNext = () => {
      const next = timers.entries().next().value;
      assert.ok(next, 'a retry timer must be pending');
      timers.delete(next[0]);
      next[1]();
    };
    return { schedule, state, timers, delays, runNext };
  }

  let attempts = 0;
  let rebound = null;
  const successful = createScheduler(() => {
    attempts += 1;
    return attempts === 3 ? { id: 'stable-image' } : null;
  });
  successful.schedule({ editId: 'stable-image' }, {
    onReacquired: (image) => {
      rebound = image;
    }
  });
  successful.runNext();
  successful.schedule({ editId: 'stable-image' }, { delay: 0 });
  successful.runNext();
  successful.runNext();
  assert.deepEqual(successful.delays, [0, 50, 0, 50]);
  assert.deepEqual(rebound, { id: 'stable-image' });
  assert.equal(successful.timers.size, 0);

  let staleAttempts = 0;
  const stale = createScheduler(() => {
    staleAttempts += 1;
    return null;
  });
  stale.schedule({ editId: 'old-selection' });
  stale.runNext();
  stale.state.selectionRevision += 1;
  stale.runNext();
  assert.equal(staleAttempts, 1);
  assert.equal(stale.timers.size, 0, 'an old selection must not keep retrying');
});

test('a synchronous control rebind cancels an older queued input replay', () => {
  const imageTools = readText('src/image-tools.js');
  const start = imageTools.indexOf('  function reacquireSelectedImageForControl(onReacquired = null) {');
  const end = imageTools.indexOf('  function copyManagedData(source, target) {', start);
  assert.ok(start >= 0 && end > start, 'control rebind helper must exist');

  const state = { identity: { editId: 'same-image' } };
  let pendingReplay = () => {
    throw new Error('stale panel input replayed after a synchronous rebind');
  };
  let scheduled = 0;
  const reacquireSelectedImageForControl = Function(
    'state',
    'reacquireSelectedImage',
    'cancelScheduledReacquire',
    'scheduleSelectedImageReacquire',
    `${imageTools.slice(start, end)}\nreturn reacquireSelectedImageForControl;`
  )(
    state,
    () => ({ id: 'same-image' }),
    (clearCallback) => {
      if (clearCallback) pendingReplay = null;
    },
    () => {
      scheduled += 1;
    }
  );

  assert.deepEqual(reacquireSelectedImageForControl(() => {}), { id: 'same-image' });
  assert.equal(scheduled, 0);
  assert.equal(pendingReplay, null);
});

test('image identities stay stable while article order and sources change', () => {
  const imageTools = readText('src/image-tools.js');

  assert.match(imageTools, /function ensureImageEditId\(image\)/);
  assert.match(imageTools, /getAttr\(image, 'data-mpse-image-id'\)/);
  assert.match(imageTools, /image\.setAttribute\('data-mpse-image-id', value\)/);
  assert.match(imageTools, /ensureImageEditId\(image\);[\s\S]*?const snapshot = snapshotCurrentImage\(image, reason, identityOverride\)/);
  assert.match(imageTools, /editId: getAttr\(image, 'data-mpse-image-id'\)/);
  assert.match(imageTools, /const position = identity\.editId \? 'stable'/);
  assert.match(imageTools, /const primary = identity\.editId \|\| identity\.fileId/);
  assert.match(imageTools, /identity\.editId === editId\) score \+= 5000/);
  assert.match(imageTools, /target\.setAttribute\('data-mpse-image-id', snapshot\.identity\.editId\)/);
});

test('new image edit IDs only fall back to article images that do not have an ID yet', () => {
  const imageTools = readText('src/image-tools.js');
  const start = imageTools.indexOf('  function scoreImageByIdentity(candidate, identity) {');
  const end = imageTools.indexOf('  function getTopRect(element) {', start);
  assert.ok(start >= 0 && end > start, 'image locator functions must exist');

  const locatorSource = imageTools.slice(start, end);
  const { shortlistImagesByEditId, locateImageInHtml } = Function(
    'stableUrl',
    'getAttr',
    `${locatorSource}\nreturn { shortlistImagesByEditId, locateImageInHtml };`
  )(
    (value) => String(value || '').trim(),
    (image, name) => image.getAttribute(name) || ''
  );

  const makeImage = (attributes) => ({
    getAttribute(name) {
      return attributes[name] || '';
    }
  });
  const imageA = makeImage({ 'data-mpse-image-id': 'img-a', src: 'https://example.test/shared.png' });
  const imageBWithoutId = makeImage({ src: 'https://example.test/shared.png' });
  const newIdentityB = { editId: 'img-b-new', src: 'https://example.test/shared.png', index: 1 };

  const shortlist = shortlistImagesByEditId([imageA, imageBWithoutId], newIdentityB);
  assert.equal(shortlist.exact, null);
  assert.deepEqual(shortlist.indexed, [{ image: imageBWithoutId, index: 1 }]);
  const locatedB = locateImageInHtml({ querySelectorAll: () => [imageA, imageBWithoutId] }, newIdentityB);
  assert.equal(locatedB, imageBWithoutId);
  assert.notEqual(locatedB, imageA);

  const imageBWithAnotherId = makeImage({ 'data-mpse-image-id': 'img-b-other', src: 'https://example.test/shared.png' });
  assert.equal(
    locateImageInHtml({ querySelectorAll: () => [imageA, imageBWithAnotherId] }, newIdentityB),
    null
  );
});

test('crop rotation stays on media while frame decoration scales around content', () => {
  const imageTools = readText('src/image-tools.js');
  const imageControls = readText('src/image-controls.js');
  const writeCrop = imageTools.match(/function writeCropState\(image, next\) \{[\s\S]*?\n  \}\n\n  function unwrapCropContainer/);

  assert.ok(writeCrop, 'crop state writer must exist');
  const hostStyles = writeCrop[0].match(/setStyles\(host, \{([\s\S]*?)\n    \}\);/);
  const mediaStyles = writeCrop[0].match(/setStyles\(image, \{([\s\S]*?)\n    \}\);/);
  assert.ok(hostStyles, 'crop host styles must exist');
  assert.ok(mediaStyles, 'crop media styles must exist');
  assert.match(hostStyles[1], /transform: translation/);
  assert.match(hostStyles[1], /'transform-origin': 'center center'/);
  assert.match(mediaStyles[1], /transform: baseTransform/);
  assert.match(mediaStyles[1], /'transform-origin': baseTransformOrigin/);
  assert.match(imageControls, /layout\.styles\.transform = \{ value: `rotate\(\$\{angle\}deg\)`, priority: 'important' \}/);
  assert.doesNotMatch(hostStyles[1], /baseTransform/);

  assert.match(imageTools, /function applyCropDecorationScale\(host, layout, baseWidth\)/);
  assert.match(imageTools, /const factor = Math\.max\(0\.01, baseWidth\) \/ Math\.max\(0\.01, Number\(metrics\.baseWidth\) \|\| baseWidth\)/);
  assert.match(imageControls, /'box-sizing': getCropContainer\(image\) \? 'content-box' : 'border-box'/);
  assert.match(imageTools, /function getCropContentRect\(image\)/);
  assert.match(imageTools, /outer\.width - leftInset - rightInset/);
  assert.match(imageTools, /outer\.height - topInset - bottomInset/);
});

test('only visible dialogs that overlap the editor area block image tools', () => {
  const imageTools = readText('src/image-tools.js');
  const blockingLayer = imageTools.match(/function hasBlockingEditorLayer\(\) \{[\s\S]*?\n  \}\n\n  function monitorBlockingEditorLayer/);

  assert.ok(blockingLayer, 'blocking-layer detector must exist');
  assert.match(blockingLayer[0], /const viewport = getViewportRect\(\)/);
  assert.match(blockingLayer[0], /!rectsIntersect\(viewport, rect\)\) continue/);
  assert.match(blockingLayer[0], /const editorRects = \[\]/);
  assert.match(blockingLayer[0], /querySelectorAll\('\[contenteditable="true"\], body\[contenteditable="true"\]'\)/);
  assert.match(blockingLayer[0], /if \(selectionRect\) editorRects\.push\(selectionRect\)/);
  assert.match(blockingLayer[0], /editorRects\.some\(\(editorRect\) => rectsIntersect\(editorRect, rect\)\)/);
  const globalSelectors = blockingLayer[0].match(/const globalSelector = \[([\s\S]*?)\n    \]\.join/);
  assert.ok(globalSelectors, 'global blocking selectors must be explicit');
  assert.doesNotMatch(globalSelectors[1], /\[role="dialog"\]/);
});

test('image appearance effects are reversible and alpha effects stay on the media', () => {
  const imageTools = readText('src/image-tools.js');
  const imageControls = readText('src/image-controls.js');

  assert.match(imageControls, /const APPEARANCE_EFFECTS = \{/);
  assert.match(imageTools, /function getAppearanceHost\(image\)/);
  assert.match(imageControls, /function renderAppearance\(image\)/);
  assert.match(imageControls, /const FILTER_EFFECT_MARKERS = \['mpseColorOn', 'mpseShadowOn', 'mpseGlowOn', 'mpseFeatherOn', 'mpseStrokeOn'\]/);
  assert.match(imageControls, /function alphaEffectsFilter\(image\)/);
  assert.match(imageControls, /<feMorphology in="SourceAlpha"/);
  assert.match(imageControls, /<feGaussianBlur in="SourceAlpha"[\s\S]*?result="feather-alpha"/);
  assert.match(imageControls, /<feComposite in="SourceGraphic" in2="feather-alpha" operator="in"/);
  assert.match(imageControls, /setStyle\(image, 'filter', parts\.filter\(Boolean\)\.join\(' '\)\)/);
  assert.doesNotMatch(imageControls, /radial-gradient\(ellipse at center/);
  assert.doesNotMatch(imageControls, /function rebuildManagedBoxShadow/);
  assert.doesNotMatch(imageControls, /drop-shadow\(/);
  assert.doesNotMatch(imageControls, /return \{ outline: `\$\{width\}px solid/);
});

test('legacy container effects migrate once while alpha effects preserve native box shadow', () => {
  const imageControls = readText('src/image-controls.js');
  const imageTools = readText('src/image-tools.js');
  const migrate = imageControls.match(/function migrateLegacyBoxShadow\(image\) \{[\s\S]*?\n    \}\n\n    function migrateLegacyFeather/);
  const prepare = imageControls.match(/function prepareAlphaEffect\(image\) \{[\s\S]*?\n    \}/);
  const clear = imageControls.match(/function clearEffect\(effect, commit = true\) \{[\s\S]*?\n    \}\n\n    function updateCaption/);
  const unwrap = imageTools.match(/function unwrapCropContainer\(image\) \{[\s\S]*?\n  \}\n\n  function resetCrop/);

  assert.ok(migrate && prepare && clear && unwrap, 'alpha migration and crop restoration lifecycles must exist');
  assert.match(migrate[0], /const target = getAppearanceHost\(image\)/);
  assert.match(migrate[0], /setStyle\(target, 'box-shadow', image\.dataset\.mpseBaseBoxShadow \|\| ''\)/);
  assert.match(migrate[0], /delete image\.dataset\.mpseBaseBoxShadow/);
  assert.ok(
    prepare[0].indexOf('migrateLegacyBoxShadow(image)') < prepare[0].indexOf('captureManagedFilterBase(image)'),
    'legacy container shadow must be restored before the native filter baseline is captured'
  );
  assert.match(clear[0], /if \(effect === 'shadow'\) \{[\s\S]*?migrateLegacyBoxShadow\(image\)[\s\S]*?releaseManagedFilter\(image\)/);
  assert.match(clear[0], /if \(effect === 'glow'\) \{[\s\S]*?migrateLegacyBoxShadow\(image\)[\s\S]*?releaseManagedFilter\(image\)/);
  assert.match(unwrap[0], /renderAppearance\(image\)/);
  assert.doesNotMatch(unwrap[0], /delete image\.dataset\.mpseBaseBoxShadow/);
});

test('transparent images remain selectable and opacity starts at 100%', () => {
  const imageTools = readText('src/image-tools.js');
  const imageControls = readText('src/image-controls.js');

  assert.match(imageControls, /function readOpacityPercent\(image, fallback = 100\) \{[\s\S]*?if \(!raw\) return fallback;/);
  assert.match(imageControls, /image\.dataset\.mpseOpacityOn = '1';[\s\S]*?image\.dataset\.mpseOpacityValue = String\(value\)/);
  assert.doesNotMatch(imageControls, /if \(value >= 100\)/);
  assert.doesNotMatch(imageTools, /style\.display === 'none' \|\| style\.visibility === 'hidden' \|\| style\.opacity === '0'/);
});

test('effect records are restored after the editor replaces a selected image node', () => {
  const imageTools = readText('src/image-tools.js');
  assert.match(imageTools, /effectRecords\.remember\(imageSignature\(image\), snapshot\.imgData, snapshot\.cropCreateHostData\)/);
  assert.match(imageTools, /function restoreEffectRecord\(image\) \{[\s\S]*?effectRecords\.find\(identity\)[\s\S]*?copyManagedData\(\{ imgData: record\.data \}, image\)/);
  assert.match(imageTools, /snapshotMerge\.syncAttributes\([\s\S]*?record\.hostData/);
  assert.match(imageTools, /state\.identity = restoreEffectRecord\(image\)/);
});

test('image editing core modules stay below the maintainability limit', () => {
  for (const file of ['src/image-controls.js', 'src/image-snapshot-merge.js', 'src/image-tools.js']) {
    const lineCount = readText(file).split(/\r?\n/).length;
    assert.ok(lineCount < 3000, `${file} has ${lineCount} lines`);
  }
});

test('image property ownership includes every positioned presentation property', () => {
  const imageControls = readText('src/image-controls.js');
  const baseProps = imageControls.match(/const IMAGE_BASE_STYLE_PROPS = \[([\s\S]*?)\n    \];/);
  assert.ok(baseProps, 'image base property list must exist in image-controls');
  for (const property of ['position', 'left', 'top', 'right', 'bottom', 'translate', 'scale', 'float']) {
    assert.match(baseProps[1], new RegExp(`['"]${property}['"]`), property);
  }
  assert.match(imageControls, /imageStyles: captureInlineStyles\(image, IMAGE_BASE_STYLE_PROPS\)/);
  assert.match(imageControls, /restoreInlineStyles\(image, base\.imageStyles\)/);
});

test('persisted crop layout remains reversible without a custom selection host', () => {
  const imageTools = readText('src/image-tools.js');
  const capture = imageTools.match(/function captureCropLayout\(image\) \{[\s\S]*?\n  \}\n\n  function readCropLayout/);
  const unwrap = imageTools.match(/function unwrapCropContainer\(image\) \{[\s\S]*?\n  \}\n\n  function resetCrop/);
  assert.ok(capture && unwrap, 'persisted crop layout lifecycle must exist');
  assert.match(capture[0], /const hostProps = \[[\s\S]*?'margin-top', 'margin-bottom', 'vertical-align', 'float', 'transform', 'transform-origin'/);
  assert.match(capture[0], /const imageOnlyProps = \['position', 'left', 'top', 'right', 'bottom', 'translate', 'scale'\]/);
  assert.match(capture[0], /const styles = captureInlineStyles\(image, props\)/);
  assert.match(capture[0], /const hostStyles = Object\.fromEntries\(hostProps\.map/);
  assert.doesNotMatch(imageTools, /function ensureCropContainer\(/);
  assert.match(unwrap[0], /restoreInlineStyles\(image, layout\.styles\)/);
  assert.match(unwrap[0], /'position', 'left', 'top', 'right', 'bottom'[\s\S]*?'translate', 'scale'/);
});

test('crop circle diameter uses the content box instead of decorated outer size', () => {
  const imageControls = readText('src/image-controls.js');
  const readDiameter = imageControls.match(/function readCircleDiameter\(image\) \{[\s\S]*?\n    \}\n\n    function hasNonEmptyStyle/);
  assert.ok(readDiameter, 'circle diameter reader must exist');
  assert.match(readDiameter[0], /if \(getCropContainer\(image\)\) \{/);
  assert.match(readDiameter[0], /const rect = getCropContentRect\(image\)/);
  assert.match(readDiameter[0], /Math\.min\(rect\.width \|\| 160, rect\.height \|\| rect\.width \|\| 160\)/);
  const cropBranch = readDiameter[0].match(/if \(getCropContainer\(image\)\) \{([\s\S]*?)\n      \}/);
  assert.ok(cropBranch, 'crop-specific diameter branch must exist');
  assert.doesNotMatch(cropBranch[1], /getBoundingClientRect|getLayoutHost|border|padding/);
});

test('presentation frame restoration preserves later crop edits', () => {
  const base = {
    frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.6 },
    media: { x: 0, y: 0, width: 1, height: 1 },
    baseAspect: 16 / 9
  };
  const applied = {
    frame: { x: 0.2, y: 0.2, width: 0.6, height: 0.6 },
    media: { x: 0, y: 0, width: 1, height: 1 },
    baseAspect: 16 / 9
  };
  const current = {
    frame: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    media: { x: 0.05, y: 0.1, width: 0.9, height: 0.8 },
    baseAspect: 16 / 9
  };
  const restored = imageGeometry.restoreFrameAfterPresentation(base, applied, current);
  closeTo(restored.frame.x, 0.15);
  closeTo(restored.frame.y, 0.25);
  closeTo(restored.frame.width, 0.7);
  closeTo(restored.frame.height, 0.5);
  assert.deepEqual(restored.media, current.media);
  closeTo(restored.baseAspect, base.baseAspect);

  const unchanged = imageGeometry.restoreFrameAfterPresentation(base, applied, applied);
  for (const key of ['x', 'y', 'width', 'height']) closeTo(unchanged.frame[key], base.frame[key]);
  assert.deepEqual(unchanged.media, applied.media);
});

test('crop clipping remains invariant after appearance recomposition', () => {
  const imageControls = readText('src/image-controls.js');
  const imageTools = readText('src/image-tools.js');
  const rebuild = imageControls.match(/function rebuildFrameAppearance\(image\) \{[\s\S]*?\n    \}\n\n    function captureCropTransformBase/);
  const renderCrop = imageControls.match(/function renderCropAppearance\(image\) \{[\s\S]*?\n    \}\n\n    function clearAppearanceEffect/);
  assert.ok(rebuild && renderCrop, 'crop appearance composition must exist');
  assert.match(rebuild[0], /if \(getCropContainer\(image\)\) setStyle\(target, 'overflow', 'hidden'\)/);
  assert.match(renderCrop[0], /const host = getCropContainer\(image\);[\s\S]*?setStyle\(host, 'overflow', 'hidden'\)/);
  assert.match(imageTools, /position: 'relative',[\s\S]*?overflow: 'hidden',[\s\S]*?'aspect-ratio'/);
});

test('crop frame style transfer restores the source overflow exactly', () => {
  const imageTools = readText('src/image-tools.js');
  const imageControls = readText('src/image-controls.js');
  const frameProps = imageTools.match(/const FRAME_STYLE_PROPS = \[([\s\S]*?)\n  \];/);
  const capture = imageTools.match(/function captureCropLayout\(image\) \{[\s\S]*?\n  \}\n\n  function readCropLayout/);
  const unwrap = imageTools.match(/function unwrapCropContainer\(image\) \{[\s\S]*?\n  \}\n\n  function resetCrop/);
  const captureSource = imageControls.match(/function captureFrameSourceStyles\(image\) \{[\s\S]*?\n    \}\n\n    function rebuildFrameAppearance/);
  assert.ok(frameProps && capture && unwrap && captureSource, 'crop frame style lifecycle must exist');
  assert.match(frameProps[1], /'overflow'/);
  assert.match(capture[0], /frameStyles: captureFrameSourceStyles\(image\)/);
  assert.match(captureSource[0], /const styles = captureInlineStyles\(image, frameStyleProps\)/);
  assert.match(captureSource[0], /image\.dataset\.mpseFrameBase === undefined/);
  assert.match(captureSource[0], /const base = JSON\.parse\(image\.dataset\.mpseFrameBase \|\| '\{\}'\)/);
  assert.match(captureSource[0], /for \(const property of frameStyleProps\)/);
  assert.match(captureSource[0], /styles\[property\] = \{ \.\.\.base\[property\] \}/);
  assert.match(unwrap[0], /transferInlineStyles\(host, image, FRAME_STYLE_PROPS\)/);
  assert.match(unwrap[0], /if \(layout\.frameStyles\?\.overflow\) \{[\s\S]*?restoreInlineStyles\(image, \{ overflow: layout\.frameStyles\.overflow \}\)/);
});

test('resetting an offset circular crop keeps its host and reapplies the circle', () => {
  const imageTools = readText('src/image-tools.js');
  const reset = imageTools.match(/function resetCrop\(\) \{[\s\S]*?\n  \}\n\n  function readLayoutWidthPercent/);
  assert.ok(reset, 'crop reset function must exist');
  const clearIndex = reset[0].indexOf("clearEffect('circle', false)");
  const offsetIndex = reset[0].indexOf('if (hasCropLayoutOffset(image))');
  const resetModelIndex = reset[0].indexOf('writeCropState(image, {');
  const applyIndex = reset[0].indexOf("applyEffect('circle', { diameter: circleDiameter })");
  assert.ok(clearIndex >= 0, 'circle effect must be cleared without an intermediate commit');
  assert.ok(offsetIndex > clearIndex, 'offset detection must run after clearing the presentation effect');
  assert.ok(resetModelIndex > offsetIndex, 'offset crop must reset its model while retaining the host');
  assert.ok(applyIndex > resetModelIndex, 'circle must be reapplied after the crop model reset');
  assert.match(reset[0], /const circleDiameter = image\.dataset\.mpseCircleOn === '1'[\s\S]*?\? readCircleDiameter\(image\)[\s\S]*?: null/);
  assert.doesNotMatch(reset[0], /getDataNumber\(image, 'mpseCircleDiameter'/);
  assert.match(reset[0], /if \(hasCropLayoutOffset\(image\)\) \{/);
  assert.doesNotMatch(reset[0], /circleDiameter === null && hasCropLayoutOffset/);
  assert.match(reset[0], /frame: \{ x: 0, y: 0, width: 1, height: 1 \}/);
  assert.match(reset[0], /media: \{ x: 0, y: 0, width: 1, height: 1 \}/);
  assert.match(reset[0], /else \{[\s\S]*?state\.image = unwrapCropContainer\(image\)/);
});
