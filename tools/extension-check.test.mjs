import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await import(new URL('../src/image-geometry.js', import.meta.url));
const imageGeometry = globalThis.__MPSE_IMAGE_GEOMETRY__;

function closeTo(actual, expected, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} must be close to ${expected}`);
}

function readText(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

test('repository exposes one-command extension verification', () => {
  const packagePath = path.join(rootDir, 'package.json');
  const verifierPath = path.join(rootDir, 'tools', 'verify-extension.mjs');
  const packagerPath = path.join(rootDir, 'tools', 'package-extension.mjs');

  assert.equal(fs.existsSync(packagePath), true, 'package.json must exist');
  assert.equal(fs.existsSync(verifierPath), true, 'tools/verify-extension.mjs must exist');
  assert.equal(fs.existsSync(packagerPath), true, 'tools/package-extension.mjs must exist');

  const pkg = readJson('package.json');
  assert.equal(pkg.scripts?.check, 'node tools/verify-extension.mjs');
  assert.match(pkg.scripts?.test || '', /node --test tools\/extension-check\.test\.mjs/);
  assert.equal(pkg.scripts?.package, 'node tools/package-extension.mjs');

  const result = spawnSync(process.execPath, ['tools/verify-extension.mjs'], {
    cwd: rootDir,
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('release version and ASCII package folder stay consistent', () => {
  const pkg = readJson('package.json');
  const manifest = readJson('manifest.json');
  const readme = readText('README.md');
  const changelog = readText('CHANGELOG.md');
  const bridgeClient = readText('src/bridge-client.js');
  const imageTools = readText('src/image-tools.js');
  const packager = readText('tools/package-extension.mjs');

  assert.equal(pkg.version, manifest.version);
  assert.ok(readme.includes(`当前版本：\`v${manifest.version}\``));
  assert.ok(changelog.includes(`## v${manifest.version} ·`));
  assert.ok(bridgeClient.includes(`const VERSION = 'v${manifest.version}';`));
  assert.ok(imageTools.includes(`const VERSION = 'v${manifest.version}';`));
  assert.match(packager, /releaseSlug = 'gongzhonghao-yuanma-paiban-zhushou'/);
});

test('license is noncommercial and product introductions stay product-focused', () => {
  const license = readText('LICENSE');
  const readme = readText('README.md');
  const pkg = readJson('package.json');
  const manifest = readJson('manifest.json');

  assert.match(license, /PolyForm Noncommercial License 1\.0\.0/);
  assert.match(license, /Noncommercial Purposes/);
  assert.doesNotMatch(license, /MIT License/);
  assert.equal(pkg.license, 'PolyForm-Noncommercial-1.0.0');
  assert.doesNotMatch(readme, /源码公开|非商用|商业使用|开源|授权/);
  assert.doesNotMatch(manifest.description, /源码公开|非商用|开源|授权/);
});

test('content scripts load the shared bridge client before dependent modules', () => {
  const manifest = readJson('manifest.json');
  const js = manifest.content_scripts?.[0]?.js || [];

  assert.deepEqual(js, [
    'src/bridge-client.js',
    'src/content.js',
    'src/image-geometry.js',
    'src/image-tools.js',
    'src/svg-tools.js',
    'src/svg-block-tools.js'
  ]);

  const exposed = manifest.web_accessible_resources
    ?.flatMap((entry) => entry.resources || []) || [];
  assert.ok(exposed.includes('src/page-bridge.js'));
});

test('bridge request implementation is centralized in bridge-client', () => {
  const bridgeClient = readText('src/bridge-client.js');
  assert.match(bridgeClient, /window\.__MPSE_BRIDGE_CLIENT__/);
  assert.match(bridgeClient, /function requestBridge\(/);
  assert.match(bridgeClient, /function injectBridge\(/);

  for (const file of [
    'src/content.js',
    'src/image-tools.js',
    'src/svg-tools.js',
    'src/svg-block-tools.js'
  ]) {
    const source = readText(file);
    assert.match(source, /__MPSE_BRIDGE_CLIENT__/, `${file} must use shared bridge client`);
    assert.doesNotMatch(source, /function getExtensionResourceUrl\(/, `${file} must not duplicate resource lookup`);
    assert.doesNotMatch(source, /function injectBridge\(/, `${file} must not duplicate bridge injection`);
    assert.doesNotMatch(source, /function requestBridge\(/, `${file} must not duplicate bridge requests`);
  }
});

test('editor writes are serialized and uncertain JSAPI writes never fall back concurrently', () => {
  const pageBridge = readText('src/page-bridge.js');

  assert.match(pageBridge, /let setContentQueue = Promise\.resolve\(\)/);
  assert.match(pageBridge, /function enqueueSetContent\(/);
  assert.match(pageBridge, /invokeMpEditor\('mp_editor_set_content', \{ content \}, 0\)/);
  assert.match(pageBridge, /await enqueueSetContent\(html\)/);
});

test('all editor tools share one atomic content mutation queue', () => {
  const bridgeClient = readText('src/bridge-client.js');
  const mutate = bridgeClient.match(/function mutateContent\(mutator, timeoutMs = 15000\) \{[\s\S]*?\n  \}\n\n  window\.__MPSE_BRIDGE_CLIENT__/);

  assert.ok(mutate, 'shared content mutation function must exist');
  assert.match(bridgeClient, /let contentOperationQueue = Promise\.resolve\(\)/);
  assert.match(bridgeClient, /function enqueueContentOperation\(operation\)/);
  assert.match(bridgeClient, /function readContent\(timeoutMs = 15000\) \{[\s\S]*?return enqueueContentOperation/);
  assert.match(bridgeClient, /function writeContent\(content, timeoutMs = 15000\) \{[\s\S]*?return enqueueContentOperation/);
  assert.match(mutate[0], /return enqueueContentOperation\(async \(\) => \{/);
  assert.match(mutate[0], /requestBridge\('GET_CONTENT'/);
  assert.match(mutate[0], /normalizeMutationResult\(await mutator\(read\), currentContent\)/);
  assert.match(mutate[0], /requestBridge\('SET_CONTENT'/);

  for (const file of ['src/image-tools.js', 'src/svg-tools.js', 'src/svg-block-tools.js']) {
    const source = readText(file);
    assert.match(source, /bridgeClient\.mutateContent/, `${file} must use atomic content mutations`);
    assert.match(source, /mutateEditorContent\(\(current\) => \{/, `${file} must mutate the latest editor content`);
    assert.doesNotMatch(source, /requestBridge\('(?:GET|SET)_CONTENT'/, `${file} must not bypass the shared queue`);
  }

  const content = readText('src/content.js');
  assert.match(content, /bridgeClient\.writeContent/);
  assert.doesNotMatch(content, /requestBridge\('(?:GET|SET)_CONTENT'/);
});

test('README presents product updates without internal development wording', () => {
  const readme = readText('README.md');
  const css = readText('src/overlay.css');

  assert.match(readme, /\[查看更新日志\]\(CHANGELOG\.md\)/);
  assert.doesNotMatch(readme, /自检|旧版|开发阶段/);
  assert.doesNotMatch(css, /\/\*\s*v\d+\.\d+\.\d+/i);
});

test('public release files avoid internal release-log wording', () => {
  const publicFiles = [
    'README.md',
    'CHANGELOG.md',
    'docs/wechat-interface-notes.md',
    'src/content.js',
    'src/image-geometry.js',
    'src/image-tools.js',
    'src/svg-tools.js',
    'src/svg-block-tools.js',
    'src/overlay.css'
  ];

  for (const file of publicFiles) {
    const source = readText(file);
    assert.doesNotMatch(source, /自检|旧版|开发阶段|v\d+\.\d+\.\d+ 生成|旧 SVG/, file);
  }

  assert.equal(fs.existsSync(path.join(rootDir, 'docs', 'self-check-v0.9.4.md')), false);
});

test('production comments are concise and professional', () => {
  for (const file of [
    'src/content.js',
    'src/image-geometry.js',
    'src/image-tools.js',
    'src/page-bridge.js',
    'src/svg-tools.js',
    'src/svg-block-tools.js',
    'src/overlay.css'
  ]) {
    const source = readText(file);
    assert.doesNotMatch(source, /\/\/\s*(ignore|fall through)\b/i, file);
    assert.doesNotMatch(source, /catch\s*\([^)]*\)\s*\{\s*\}/, file);
    assert.doesNotMatch(source, /壹伴|临时|随便|凑合|低级|垃圾|屎山|忽略/i, file);
  }
});

test('media tools only activate from direct media hits', () => {
  const imageTools = readText('src/image-tools.js');
  const svgTools = readText('src/svg-tools.js');
  const svgBlockTools = readText('src/svg-block-tools.js');

  for (const source of [imageTools, svgTools]) {
    assert.match(source, /const image = target\.closest \? target\.closest\('img'\) : null;/);
    assert.doesNotMatch(source, /wrapper\.querySelector\('img'\)/);
  }

  assert.match(svgBlockTools, /if \(!svg\) return null;/);
  assert.doesNotMatch(svgBlockTools, /wrapper\.querySelector\('svg'\)/);
  assert.doesNotMatch(svgBlockTools, /doc\.elementsFromPoint\(event\.clientX, event\.clientY\)/);
});

test('image controls separate panel state from persisted edits', () => {
  const imageTools = readText('src/image-tools.js');
  const css = readText('src/overlay.css');

  assert.match(imageTools, /activePanel: null/);
  assert.doesNotMatch(imageTools, /effectMemory/);
  assert.doesNotMatch(imageTools, /showPanel\(effect, true\)/);
  assert.doesNotMatch(imageTools, /doc\.addEventListener\('click', onDocumentPointer/);
  assert.match(imageTools, /function beginGeometryGesture\(/);
  assert.match(imageTools, /function enterCropMode\(/);
  assert.match(imageTools, /function applyCropSnapshot\(/);
  assert.match(imageTools, /data-mpse-image-crop/);
  assert.match(css, /\.mpse-img2-handle-nw/);
  assert.match(css, /#mpse-img2-box\.mpse-crop-mode/);
  assert.doesNotMatch(css, /mpse-active::after/);
});

test('image geometry previews defer editor writes until the gesture ends', () => {
  const imageTools = readText('src/image-tools.js');
  const css = readText('src/overlay.css');
  const geometry = imageTools.match(/function updateGeometryGesture\(event\) \{[\s\S]*?\n  \}\n\n  function zoomCrop/);
  const flush = imageTools.match(/function flushGeometryPreview\(interaction = state\.interaction\) \{[\s\S]*?\n  \}\n\n  function hasGeometryChanged/);

  assert.ok(geometry, 'geometry update function must exist');
  assert.ok(flush, 'geometry preview flush must exist');
  assert.match(imageTools, /function getTopClientPoint\(event\)/);
  assert.match(imageTools, /function queueGeometryPreview\(interaction\)/);
  assert.doesNotMatch(geometry[0], /markChanged\(|scheduleContentCommit\(/);
  assert.doesNotMatch(flush[0], /setLayoutWidthPercent\(|writeCropState\(|getTopRect\(/);
  assert.match(imageTools, /scale\(\$\{preview\.scale\}\)/);
  assert.match(imageTools, /setStyle\(target, 'clip-path'/);
  assert.match(imageTools, /setStyle\(image, 'translate'/);
  assert.doesNotMatch(imageTools, /requestAnimationFrame\(positionTools\)/);
  assert.match(imageTools, /addEventListener\('pointercancel', onDocumentPointerUp, true\)/);
  assert.match(imageTools, /capturePointer\(image, event\.pointerId\)/);
  assert.match(imageTools, /function updateGeometryOverlay\(image = state\.image\)/);
  assert.match(imageTools, /const rect = getTopRect\(getSelectionElement\(image\)\);/);
  assert.doesNotMatch(imageTools, /function getResizePreviewRect\(/);
  assert.match(css, /\.mpse-img2-handle\.mpse-visible/);
  assert.match(css, /width: 38px !important/);
});

test('image geometry owns the drag session and blocks stale editor writes', () => {
  const imageTools = readText('src/image-tools.js');
  const css = readText('src/overlay.css');
  const beginGesture = imageTools.match(/function beginGeometryGesture\(handle, event, captureTarget\) \{[\s\S]*?\n  \}\n\n  function beginCropPan/);

  assert.ok(beginGesture, 'geometry start function must exist');
  assert.doesNotMatch(beginGesture[0], /ensureCropContainer\(/);
  assert.match(imageTools, /GEOMETRY_DRAG_THRESHOLD = 4/);
  assert.match(imageTools, /function initializeCropGesture\(/);
  assert.match(imageTools, /function initializeResizeGesture\(/);
  assert.match(imageTools, /function applyCropLayoutOffset\(/);
  assert.match(imageTools, /function showDragShield\(/);
  assert.match(imageTools, /addEventListener\('dragstart', onDocumentDragStart, true\)/);
  assert.match(imageTools, /function commitBatchIsCurrent\(/);
  assert.doesNotMatch(imageTools, /function dispatchEditorEvent\(/);
  assert.match(css, /#mpse-img2-drag-shield\.mpse-visible/);
  assert.match(css, /cursor: nwse-resize !important/);
  assert.match(imageTools, /scheduleContentCommit\('gesture-cancel'\)/);
});

test('image selection follows the visible editor area and crop entry has native fallback', () => {
  const imageTools = readText('src/image-tools.js');
  const css = readText('src/overlay.css');

  assert.match(imageTools, /function isSelectionVisible\(image, rect\)/);
  assert.match(imageTools, /function getFrameContentRect\(frame\)/);
  assert.match(imageTools, /function isRepeatedImagePress\(image, event\)/);
  assert.match(imageTools, /function onDocumentDoubleClick\(event\)/);
  assert.match(imageTools, /addEventListener\('dblclick', onDocumentDoubleClick, true\)/);
  assert.match(imageTools, /doc\.defaultView\.addEventListener\('scroll'/);
  assert.match(imageTools, /function toggleCropMode\(image\)/);
  assert.match(imageTools, /setToolElementsOffscreen\(true\)/);
  assert.match(css, /#mpse-img2-menu\.mpse-offscreen/);
});

test('crop edges preserve physical container dimensions and gesture commits are deferred', () => {
  const imageTools = readText('src/image-tools.js');

  assert.match(imageTools, /dataset\.mpseCropBaseWidth/);
  assert.match(imageTools, /dataset\.mpseCropFrameWidth/);
  assert.match(imageTools, /horizontalTransformPercent\(frame, layout\.alignment\)/);
  assert.match(imageTools, /function setLayoutWidthPercent\(image, width/);
  assert.match(imageTools, /width: `\$\{\(baseWidth \* frame\.width\)/);
  assert.match(imageTools, /function deferContentCommitForGesture\(\)/);
  assert.match(imageTools, /if \(state\.isDragging\) return;/);
});

test('crop geometry keeps opposite edges fixed and separates frame from media', () => {
  const start = {
    frame: { x: 0, y: 0, width: 1, height: 1 },
    media: { x: 0, y: 0, width: 1, height: 1 },
    baseAspect: 5 / 3
  };

  const west = imageGeometry.resizeFrameEdge(start, 'w', 0.25);
  closeTo(west.frame.x, 0.25);
  closeTo(west.frame.x + west.frame.width, 1);
  closeTo(west.media.x + west.media.width, 1);

  const north = imageGeometry.resizeFrameEdge(start, 'n', 0.4);
  closeTo(north.frame.y, 0.4);
  closeTo(north.frame.y + north.frame.height, 1);
  closeTo(north.media.y + north.media.height, 1);

  const eastLimit = imageGeometry.resizeFrameEdge(west, 'e', 10);
  closeTo(eastLimit.frame.x, west.frame.x);
  closeTo(eastLimit.frame.x + eastLimit.frame.width, 1);

  const zoomed = imageGeometry.zoomMedia(west, 0.8, 0.5, 0.5);
  assert.deepEqual(zoomed.frame, west.frame);
  assert.ok(zoomed.media.width < west.media.width);

  const panned = imageGeometry.panMedia(zoomed, 0.1, -0.1);
  assert.deepEqual(panned.frame, zoomed.frame);
  assert.notDeepEqual(panned.media, zoomed.media);

  const rect = imageGeometry.previewFrameRect(
    { left: 100, top: 40, right: 500, bottom: 280, width: 400, height: 240 },
    start.frame,
    west.frame
  );
  closeTo(rect.left, 200);
  closeTo(rect.right, 500);
});

test('crop zoom preserves media proportions at both zoom limits', () => {
  const start = {
    frame: { x: 0.1, y: 0.05, width: 0.8, height: 0.9 },
    media: { x: 0.2, y: 0.05, width: 0.5, height: 0.9 },
    baseAspect: 16 / 9
  };
  const startRatio = start.media.width / start.media.height;

  const zoomedOut = imageGeometry.zoomMedia(start, 100, 0.35, 0.6);
  closeTo(zoomedOut.media.width / zoomedOut.media.height, startRatio);
  closeTo(zoomedOut.media.height, 1);
  assert.ok(zoomedOut.media.x >= 0 && zoomedOut.media.x + zoomedOut.media.width <= 1);
  assert.ok(zoomedOut.media.y >= 0 && zoomedOut.media.y + zoomedOut.media.height <= 1);

  const zoomedIn = imageGeometry.zoomMedia(start, 0, 0.65, 0.4);
  closeTo(zoomedIn.media.width / zoomedIn.media.height, startRatio);
  closeTo(zoomedIn.media.width, imageGeometry.MIN_MEDIA_FRACTION);
  assert.ok(zoomedIn.media.height >= imageGeometry.MIN_MEDIA_FRACTION);
});

test('crop edges obey physical minimum and maximum frame constraints', () => {
  const start = {
    frame: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 },
    media: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 },
    baseAspect: 4 / 3
  };

  const westMaximum = imageGeometry.resizeFrameEdge(start, 'w', -10, { maxWidth: 0.6 });
  closeTo(westMaximum.frame.width, 0.6);
  closeTo(westMaximum.frame.x + westMaximum.frame.width, start.frame.x + start.frame.width);
  closeTo(westMaximum.media.width, 0.6);

  const eastMinimum = imageGeometry.resizeFrameEdge(start, 'e', -10, { minWidth: 0.24 });
  closeTo(eastMinimum.frame.width, 0.24);
  closeTo(eastMinimum.frame.x, start.frame.x);
  closeTo(eastMinimum.media.width, 0.24);

  const northMaximum = imageGeometry.resizeFrameEdge(start, 'n', -10, { maxHeight: 0.65 });
  closeTo(northMaximum.frame.height, 0.65);
  closeTo(northMaximum.frame.y + northMaximum.frame.height, start.frame.y + start.frame.height);

  const southMinimum = imageGeometry.resizeFrameEdge(start, 's', -10, { minHeight: 0.22 });
  closeTo(southMinimum.frame.height, 0.22);
  closeTo(southMinimum.frame.y, start.frame.y);
});

test('resize previews expose article and opposite-corner anchors', () => {
  const rect = { left: 100, top: 40, right: 500, bottom: 280, width: 400, height: 240 };
  const fullFrame = { x: 0, y: 0, width: 1, height: 1 };

  const left = imageGeometry.resizePreviewRect(rect, 0.75, imageGeometry.layoutResizeOrigin(fullFrame, 'left'));
  closeTo(left.left, rect.left);
  closeTo(left.top, rect.top);

  const center = imageGeometry.resizePreviewRect(rect, 0.75, imageGeometry.layoutResizeOrigin(fullFrame, 'center'));
  closeTo(center.left + center.width / 2, rect.left + rect.width / 2);
  closeTo(center.top, rect.top);

  const right = imageGeometry.resizePreviewRect(rect, 0.75, imageGeometry.layoutResizeOrigin(fullFrame, 'right'));
  closeTo(right.right, rect.right);
  closeTo(right.top, rect.top);

  const croppedFrame = { x: 0.2, y: 0.1, width: 0.7, height: 0.8 };
  const cropped = imageGeometry.resizePreviewRect(
    rect,
    1.2,
    imageGeometry.layoutResizeOrigin(croppedFrame, 'center')
  );
  const originalCanvasAnchorX = rect.left + rect.width * (0.5 - croppedFrame.x) / croppedFrame.width;
  const originalCanvasTop = rect.top - rect.height * croppedFrame.y / croppedFrame.height;
  closeTo(cropped.left + cropped.width * (0.5 - croppedFrame.x) / croppedFrame.width, originalCanvasAnchorX);
  closeTo(cropped.top - cropped.height * croppedFrame.y / croppedFrame.height, originalCanvasTop);

  const northWest = imageGeometry.resizePreviewRect(rect, 0.75, imageGeometry.cornerResizeOrigin('nw'));
  closeTo(northWest.right, rect.right);
  closeTo(northWest.bottom, rect.bottom);
  closeTo(imageGeometry.alignedFrameOffset(croppedFrame, 'left'), -0.2);
  closeTo(imageGeometry.alignedFrameOffset(croppedFrame, 'center'), -0.05);
  closeTo(imageGeometry.alignedFrameOffset(croppedFrame, 'right'), 0.1);
});

test('image commits debounce gestures and cannot steal a newer selection', () => {
  const imageTools = readText('src/image-tools.js');

  assert.match(imageTools, /reason === 'drag-end' \? 420 : 360/);
  assert.match(imageTools, /function scheduleSelectedImageReacquire\(/);
  assert.match(imageTools, /state\.selectionRevision !== selectionRevision/);
  assert.match(imageTools, /function rebaseInteractionAfterEditorWrite\(/);
  assert.match(imageTools, /function restoreLatestSnapshotInEditor\(/);
  assert.match(imageTools, /function recoverDisconnectedInteraction\(/);
  assert.match(imageTools, /state\.pendingSnapshots\.get\(key\) === snapshot/);
  assert.match(imageTools, /function identityHasPrimaryKey\(/);
  assert.match(imageTools, /bestScore >= 600/);
  assert.match(imageTools, /state\.interaction && !rebaseInteractionAfterEditorWrite/);
  assert.match(imageTools, /if \(state\.interaction\) finishGeometryGesture\(undefined, true\);[\s\S]*?hasBlockingEditorLayer/);
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
});

test('geometry completion survives editor DOM replacement and remains scope-bound', () => {
  const imageTools = readText('src/image-tools.js');

  assert.match(imageTools, /function deferGeometryFinish\(event, forceCancel = false, closeSelection = false\)/);
  assert.match(imageTools, /!state\.commitInFlight \|\| \(state\.image && state\.image\.isConnected\)/);
  assert.match(imageTools, /interaction\.pendingFinish = \{/);
  assert.match(imageTools, /closeSelection: Boolean\(interaction\.pendingFinish\?\.closeSelection \|\| closeSelection\)/);
  assert.match(imageTools, /function finishOrDeferGeometry\(event, forceCancel = false\)/);
  assert.match(imageTools, /if \(interaction\.pendingFinish\) \{[\s\S]*?finishGeometryGesture\(/);
  assert.match(imageTools, /if \(pending\.closeSelection\) \{[\s\S]*?hideTools\(\)/);

  assert.match(imageTools, /function editorScopeKey\(image\)/);
  assert.match(imageTools, /scopeKey: editorScopeKey\(image\)/);
  assert.match(imageTools, /if \(first\.scopeKey && second\.scopeKey && first\.scopeKey !== second\.scopeKey\) return false/);
  assert.match(imageTools, /filter\(\(image\) => !identity\.scopeKey \|\| editorScopeKey\(image\) === identity\.scopeKey\)/);
  assert.match(imageTools, /\/\^\\\/cgi-bin\\\/appmsg\(\?:\\\/\|\$\)\//);
  assert.doesNotMatch(imageTools, /#js_content|\.rich_media_content/);
});

test('image identities stay stable while article order and sources change', () => {
  const imageTools = readText('src/image-tools.js');

  assert.match(imageTools, /function ensureImageEditId\(image\)/);
  assert.match(imageTools, /getAttr\(image, 'data-mpse-image-id'\)/);
  assert.match(imageTools, /image\.setAttribute\('data-mpse-image-id', value\)/);
  assert.match(imageTools, /ensureImageEditId\(image\);[\s\S]*?const snapshot = snapshotCurrentImage\(image\)/);
  assert.match(imageTools, /editId: getAttr\(image, 'data-mpse-image-id'\)/);
  assert.match(imageTools, /const position = identity\.editId \? 'stable'/);
  assert.match(imageTools, /if \(first\.editId && second\.editId\) return first\.editId === second\.editId/);
  assert.match(imageTools, /identity\.editId === editId\) score \+= 5000/);
  assert.match(imageTools, /target\.setAttribute\('data-mpse-image-id', snapshot\.identity\.editId\)/);
});

test('crop rotation stays on media while frame decoration scales around content', () => {
  const imageTools = readText('src/image-tools.js');
  const writeCrop = imageTools.match(/function writeCropState\(image, next\) \{[\s\S]*?\n  \}\n\n  function ensureCropContainer/);

  assert.ok(writeCrop, 'crop state writer must exist');
  const hostStyles = writeCrop[0].match(/setStyles\(host, \{([\s\S]*?)\n    \}\);/);
  const mediaStyles = writeCrop[0].match(/setStyles\(image, \{([\s\S]*?)\n    \}\);/);
  assert.ok(hostStyles, 'crop host styles must exist');
  assert.ok(mediaStyles, 'crop media styles must exist');
  assert.match(hostStyles[1], /transform: translation/);
  assert.match(hostStyles[1], /'transform-origin': 'center center'/);
  assert.match(mediaStyles[1], /transform: baseTransform/);
  assert.match(mediaStyles[1], /'transform-origin': baseTransformOrigin/);
  assert.match(imageTools, /layout\.styles\.transform = \{ value: `rotate\(\$\{angle\}deg\)`, priority: 'important' \}/);
  assert.doesNotMatch(hostStyles[1], /baseTransform/);

  assert.match(imageTools, /function applyCropDecorationScale\(host, layout, baseWidth\)/);
  assert.match(imageTools, /const factor = Math\.max\(0\.01, baseWidth\) \/ Math\.max\(0\.01, Number\(metrics\.baseWidth\) \|\| baseWidth\)/);
  assert.match(imageTools, /'box-sizing': 'content-box'/);
  assert.match(imageTools, /function getCropContentRect\(image\)/);
  assert.match(imageTools, /outer\.width - leftInset - rightInset/);
  assert.match(imageTools, /outer\.height - topInset - bottomInset/);
  assert.match(imageTools, /interaction\.contentRect = interaction\.startCrop \? getCropContentRect\(image\) : interaction\.rect/);
});

test('only visible dialogs that cover the selected image block image tools', () => {
  const imageTools = readText('src/image-tools.js');
  const blockingLayer = imageTools.match(/function hasBlockingEditorLayer\(\) \{[\s\S]*?\n  \}\n\n  function monitorBlockingEditorLayer/);

  assert.ok(blockingLayer, 'blocking-layer detector must exist');
  assert.match(blockingLayer[0], /const viewport = getViewportRect\(\)/);
  assert.match(blockingLayer[0], /!rectsIntersect\(viewport, rect\)\) continue/);
  assert.match(blockingLayer[0], /selectionRect && rectsIntersect\(selectionRect, rect\)/);
  const globalSelectors = blockingLayer[0].match(/const globalSelector = \[([\s\S]*?)\n    \]\.join/);
  assert.ok(globalSelectors, 'global blocking selectors must be explicit');
  assert.doesNotMatch(globalSelectors[1], /\[role="dialog"\]/);
});

test('image appearance effects are reversible and follow the crop container', () => {
  const imageTools = readText('src/image-tools.js');

  assert.match(imageTools, /const APPEARANCE_EFFECTS = \{/);
  assert.match(imageTools, /function getAppearanceHost\(image\)/);
  assert.match(imageTools, /function renderAppearance\(image\)/);
  assert.match(imageTools, /mpseFeatherOn/);
  assert.match(imageTools, /mpseStrokeOn/);
  assert.match(imageTools, /mpseOpacityOn/);
  assert.match(imageTools, /mask-image/);
  assert.match(imageTools, /outline-offset/);
});

test('transparent images remain selectable and opacity starts at 100%', () => {
  const imageTools = readText('src/image-tools.js');

  assert.match(imageTools, /function readOpacityPercent\(image, fallback = 100\) \{[\s\S]*?if \(!raw\) return fallback;/);
  assert.doesNotMatch(imageTools, /style\.display === 'none' \|\| style\.visibility === 'hidden' \|\| style\.opacity === '0'/);
});
