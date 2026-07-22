import assert from 'node:assert/strict';
import test from 'node:test';

import { closeTo, readText } from './test-helpers.mjs';

await import(new URL('../src/image-geometry.js', import.meta.url));
const imageGeometry = globalThis.__MPSE_IMAGE_GEOMETRY__;

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
  assert.match(imageTools, /if \(!interaction \|\| \(state\.image && state\.image\.isConnected\)\) return false/);
  assert.match(imageTools, /if \(rebaseInteractionAfterEditorWrite\(interaction\.identity \|\| state\.identity\)\) return false/);
  assert.match(imageTools, /interaction\.pendingFinish = \{/);
  assert.match(imageTools, /closeSelection: Boolean\(interaction\.pendingFinish\?\.closeSelection \|\| closeSelection\)/);
  assert.match(imageTools, /function finishOrDeferGeometry\(event, forceCancel = false\)/);
  assert.match(imageTools, /if \(interaction\.pendingFinish\) \{[\s\S]*?finishGeometryGesture\(/);
  assert.match(imageTools, /if \(pending\.closeSelection\) \{[\s\S]*?hideTools\(\)/);

  assert.match(imageTools, /function editorScopeKey\(image\)/);
  assert.match(imageTools, /scopeKey: editorScopeKey\(image\)/);
  assert.match(imageTools, /filter\(\(image\) => !identity\.scopeKey \|\| editorScopeKey\(image\) === identity\.scopeKey\)/);
  assert.match(imageTools, /\/\^\\\/cgi-bin\\\/appmsg\(\?:\\\/\|\$\)\//);
  assert.doesNotMatch(imageTools, /#js_content|\.rich_media_content/);
});

test('image identities stay stable while article order and sources change', () => {
  const imageTools = readText('src/image-tools.js');

  assert.match(imageTools, /function ensureImageEditId\(image\)/);
  assert.match(imageTools, /getAttr\(image, 'data-mpse-image-id'\)/);
  assert.match(imageTools, /image\.setAttribute\('data-mpse-image-id', value\)/);
  assert.match(imageTools, /ensureImageEditId\(image\);[\s\S]*?const snapshot = snapshotCurrentImage\(image, reason\)/);
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
  assert.match(imageControls, /layout\.styles\.transform = \{ value: `rotate\(\$\{angle\}deg\)`, priority: 'important' \}/);
  assert.doesNotMatch(hostStyles[1], /baseTransform/);

  assert.match(imageTools, /function applyCropDecorationScale\(host, layout, baseWidth\)/);
  assert.match(imageTools, /const factor = Math\.max\(0\.01, baseWidth\) \/ Math\.max\(0\.01, Number\(metrics\.baseWidth\) \|\| baseWidth\)/);
  assert.match(imageControls, /'box-sizing': getCropContainer\(image\) \? 'content-box' : 'border-box'/);
  assert.match(imageTools, /function getCropContentRect\(image\)/);
  assert.match(imageTools, /outer\.width - leftInset - rightInset/);
  assert.match(imageTools, /outer\.height - topInset - bottomInset/);
  assert.match(imageTools, /interaction\.contentRect = interaction\.startCrop \? getCropContentRect\(image\) : interaction\.rect/);
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

test('image appearance effects are reversible and follow the crop container', () => {
  const imageTools = readText('src/image-tools.js');
  const imageControls = readText('src/image-controls.js');

  assert.match(imageControls, /const APPEARANCE_EFFECTS = \{/);
  assert.match(imageTools, /function getAppearanceHost\(image\)/);
  assert.match(imageControls, /function renderAppearance\(image\)/);
  assert.match(imageControls, /mpseFeatherOn/);
  assert.match(imageControls, /mpseStrokeOn/);
  assert.match(imageControls, /mpseOpacityOn/);
  assert.match(imageControls, /mask-image/);
  assert.match(imageControls, /outline-offset/);
});

test('native box shadow survives clearing managed shadow or glow inside crop', () => {
  const imageControls = readText('src/image-controls.js');
  const imageTools = readText('src/image-tools.js');
  const rebuild = imageControls.match(/function rebuildManagedBoxShadow\(image\) \{[\s\S]*?\n    \}\n\n    function restoreBaseBoxShadow/);
  const restore = imageControls.match(/function restoreBaseBoxShadow\(image\) \{[\s\S]*?\n    \}\n\n    function captureCircleBase/);
  const clear = imageControls.match(/function clearEffect\(effect, commit = true\) \{[\s\S]*?\n    \}\n\n    function updateCaption/);
  const unwrap = imageTools.match(/function unwrapCropContainer\(image\) \{[\s\S]*?\n  \}\n\n  function resetCrop/);

  assert.ok(rebuild && restore && clear && unwrap, 'shadow and crop restoration lifecycles must exist');
  assert.equal((rebuild[0].match(/shadows\.push\(base\)/g) || []).length, 1, 'native shadow must be composed once');
  assert.match(rebuild[0], /setStyle\(target, 'box-shadow', shadows\.join\(', '\)\)/);
  assert.match(restore[0], /const target = getAppearanceHost\(image\)/);
  assert.match(restore[0], /setStyle\(target, 'box-shadow', image\.dataset\.mpseBaseBoxShadow \|\| ''\)/);
  const retainIndex = restore[0].indexOf('if (target !== image) return;');
  const deleteIndex = restore[0].indexOf('delete image.dataset.mpseBaseBoxShadow;');
  assert.ok(retainIndex >= 0 && deleteIndex > retainIndex, 'crop must retain the native source shadow until unwrap');
  assert.match(clear[0], /if \(image\.dataset\.mpseGlowOn === '1'\) \{[\s\S]*?rebuildManagedBoxShadow\(image\)[\s\S]*?\} else \{[\s\S]*?restoreBaseBoxShadow\(image\)/);
  assert.match(clear[0], /if \(image\.dataset\.mpseShadowOn === '1'\) \{[\s\S]*?rebuildManagedBoxShadow\(image\)[\s\S]*?\} else \{[\s\S]*?restoreBaseBoxShadow\(image\)/);
  assert.match(unwrap[0], /renderAppearance\(image\)/);
  assert.match(unwrap[0], /image\.dataset\.mpseShadowOn !== '1'[\s\S]*?image\.dataset\.mpseGlowOn !== '1'[\s\S]*?delete image\.dataset\.mpseBaseBoxShadow/);
  assert.match(imageControls, /return Object\.freeze\(\{[\s\S]*?captureBaseBoxShadow,/);
  assert.match(imageTools, /const \{[\s\S]*?captureBaseBoxShadow,[\s\S]*?\} = imageControls;/);
  assert.match(imageTools, /if \(image\.style\.getPropertyValue\('box-shadow'\)\) captureBaseBoxShadow\(image\)/);
});

test('transparent images remain selectable and opacity starts at 100%', () => {
  const imageTools = readText('src/image-tools.js');
  const imageControls = readText('src/image-controls.js');

  assert.match(imageControls, /function readOpacityPercent\(image, fallback = 100\) \{[\s\S]*?if \(!raw\) return fallback;/);
  assert.doesNotMatch(imageTools, /style\.display === 'none' \|\| style\.visibility === 'hidden' \|\| style\.opacity === '0'/);
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

test('crop layout preserves host flow and image-only positioning exactly', () => {
  const imageTools = readText('src/image-tools.js');
  const capture = imageTools.match(/function captureCropLayout\(image\) \{[\s\S]*?\n  \}\n\n  function readCropLayout/);
  const ensure = imageTools.match(/function ensureCropContainer\(image\) \{[\s\S]*?\n  \}\n\n  function unwrapCropContainer/);
  const unwrap = imageTools.match(/function unwrapCropContainer\(image\) \{[\s\S]*?\n  \}\n\n  function resetCrop/);
  assert.ok(capture && ensure && unwrap, 'crop layout lifecycle must exist');
  assert.match(capture[0], /const hostProps = \[[\s\S]*?'margin-top', 'margin-bottom', 'vertical-align', 'float', 'transform', 'transform-origin'/);
  assert.match(capture[0], /const imageOnlyProps = \['position', 'left', 'top', 'right', 'bottom', 'translate', 'scale'\]/);
  assert.match(capture[0], /const styles = captureInlineStyles\(image, props\)/);
  assert.match(capture[0], /const hostStyles = Object\.fromEntries\(hostProps\.map/);
  assert.match(ensure[0], /host\.dataset\.mpseCropLayout = JSON\.stringify\(layout\)/);
  assert.match(unwrap[0], /restoreInlineStyles\(image, layout\.styles\)/);
  assert.match(unwrap[0], /'position', 'left', 'top', 'right', 'bottom'[\s\S]*?'translate', 'scale'/);
});

test('image circle presentation suspends for crop and resumes on rollback', () => {
  const imageControls = readText('src/image-controls.js');
  const imageTools = readText('src/image-tools.js');
  const suspend = imageControls.match(/function suspendImageCirclePresentation\(image\) \{[\s\S]*?\n    \}\n\n    function resumeImageCirclePresentation/);
  const resume = imageControls.match(/function resumeImageCirclePresentation\(image, presentation\) \{[\s\S]*?\n    \}\n\n    function restoreCircleBase/);
  const exit = imageTools.match(/function exitCropMode\(\) \{[\s\S]*?\n  \}\n\n  const controlsFactory/);
  assert.ok(suspend && resume && exit, 'circle presentation lifecycle must exist');
  assert.match(suspend[0], /captureInlineStyles\(image, CIRCLE_STYLE_PROPS\)/);
  assert.match(suspend[0], /restoreImageCirclePresentationBase\(image\) \? presentation : null/);
  assert.doesNotMatch(suspend[0], /delete image\.dataset\.mpseCircle/);
  assert.match(resume[0], /restoreInlineStyles\(image, presentation\)/);
  assert.match(resume[0], /else if \(image\.dataset\.mpseCircleOn === '1'\)/);
  assert.match(resume[0], /getDataNumber\(image, 'mpseCircleDiameter', 160\)/);
  assert.match(resume[0], /else \{[\s\S]*?return false/);
  assert.match(resume[0], /rebuildFrameAppearance\(image\)/);
  assert.match(imageTools, /const circlePresentation = suspendImageCirclePresentation\(image\);[\s\S]*?const rect = image\.getBoundingClientRect\(\)/);
  assert.match(imageTools, /resumeImageCirclePresentation\(restored, interaction\.circlePresentation\)/);
  assert.match(exit[0], /resumeImageCirclePresentation\(state\.image, null\)/);
  assert.doesNotMatch(exit[0], /cropTransientCirclePresentation\)/);
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

test('presentation frame restoration keeps the opposite edge at every boundary', () => {
  const base = {
    frame: { x: 0.1, y: 0.15, width: 0.8, height: 0.7 },
    media: { x: 0.1, y: 0.15, width: 0.8, height: 0.7 },
    baseAspect: 1.5
  };
  const applied = {
    frame: { x: 0.25, y: 0.2, width: 0.5, height: 0.5 },
    media: { x: 0.25, y: 0.2, width: 0.5, height: 0.5 },
    baseAspect: 1.5
  };
  const baseRight = base.frame.x + base.frame.width;
  const baseBottom = base.frame.y + base.frame.height;
  const cases = [
    { handle: 'w', delta: -10, boundary: (frame) => closeTo(frame.x, 0), opposite: (frame) => closeTo(frame.x + frame.width, baseRight) },
    { handle: 'n', delta: -10, boundary: (frame) => closeTo(frame.y, 0), opposite: (frame) => closeTo(frame.y + frame.height, baseBottom) },
    { handle: 'e', delta: 10, boundary: (frame) => closeTo(frame.x + frame.width, 1), opposite: (frame) => closeTo(frame.x, base.frame.x) },
    { handle: 's', delta: 10, boundary: (frame) => closeTo(frame.y + frame.height, 1), opposite: (frame) => closeTo(frame.y, base.frame.y) }
  ];

  for (const { handle, delta, boundary, opposite } of cases) {
    const current = imageGeometry.resizeFrameEdge(applied, handle, delta);
    const restored = imageGeometry.restoreFrameAfterPresentation(base, applied, current);
    boundary(restored.frame);
    opposite(restored.frame);
    for (const key of ['x', 'y', 'width', 'height']) closeTo(restored.media[key], current.media[key]);
  }
});

test('standalone circles enter crop as square presentation and unwrap only before user geometry edits', () => {
  const imageTools = readText('src/image-tools.js');
  const ensure = imageTools.match(/function ensureCropContainer\(image\) \{[\s\S]*?\n  \}\n\n  function unwrapCropContainer/);
  const finish = imageTools.match(/function finishGeometryGesture\(event, forceCancel = false\) \{[\s\S]*?\n  \}\n\n  function enterCropMode/);
  const enter = imageTools.match(/function enterCropMode\(image\) \{[\s\S]*?\n  \}\n\n  function exitCropMode/);
  const exit = imageTools.match(/function exitCropMode\(\) \{[\s\S]*?\n  \}\n\n  const controlsFactory/);
  assert.ok(ensure && finish && enter && exit, 'standalone circle crop lifecycle must exist');
  assert.match(ensure[0], /circlePresentation && circleDiameter !== null && image\.dataset\.mpseCircleOn === '1'/);
  assert.match(ensure[0], /imageControls\.applyCircleCropGeometry\(image, circleDiameter, true\)/);
  assert.match(enter[0], /state\.cropSessionGeometryChanged = false/);
  assert.match(exit[0], /const shouldUnwrap = state\.cropTransientHost && image[\s\S]*?!state\.cropSessionGeometryChanged && !hasCropLayoutOffset\(image\)/);
  assert.doesNotMatch(exit[0], /!hasCropAdjustment\(image\)/);
  assert.match(exit[0], /if \(shouldUnwrap\) \{[\s\S]*?state\.image = unwrapCropContainer\(image\)/);
  assert.match(finish[0], /if \(changed && \(state\.cropMode \|\| interaction\.kind === 'crop'\)\) \{[\s\S]*?state\.cropSessionGeometryChanged = true/);
});

test('circle resize and crop zoom persist only effective in-range geometry', () => {
  const imageTools = readText('src/image-tools.js');
  const corner = imageTools.match(/function getCornerResizePreview\(interaction, point\) \{[\s\S]*?\n  \}\n\n  function updateGeometryOverlay/);
  const begin = imageTools.match(/function beginGeometryGesture\(handle, event, captureTarget\) \{[\s\S]*?\n  \}\n\n  function beginCropPan/);
  const zoom = imageTools.match(/function flushCropZoom\(\) \{[\s\S]*?\n  \}\n\n  function queueCropZoom/);

  assert.ok(corner && begin && zoom, 'bounded circle resize and guarded crop zoom must exist');
  assert.match(begin[0], /circleDiameterPx: image\.dataset\.mpseCircleOn === '1'[\s\S]*?Math\.min\(contentRect\.width, contentRect\.height\)/);
  assert.match(corner[0], /40 \/ interaction\.circleDiameterPx/);
  assert.match(corner[0], /520 \/ interaction\.circleDiameterPx/);
  assert.match(zoom[0], /const next = imageGeometry\.zoomMedia\(crop, scale, pointX, pointY\);[\s\S]*?if \(imageGeometry\.modelsMatch\(crop, next\)\) \{[\s\S]*?return;[\s\S]*?writeCropState\(image, next\)/);
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
  assert.match(imageTools, /clearFrameAppearance\(image\);[\s\S]*?renderCropAppearance\(image\)/);
});

test('interaction rebase rebuilds crop geometry and coordinate mapping', () => {
  const imageTools = readText('src/image-tools.js');
  const rebase = imageTools.match(/function rebaseInteractionAfterEditorWrite\(identity\) \{[\s\S]*?\n  \}\n\n  function revealToolElements/);
  assert.ok(rebase, 'interaction rebase must exist');
  assert.match(rebase[0], /\['pan', 'resize', 'crop'\]\.includes\(interaction\.kind\)/);
  assert.match(rebase[0], /const result = ensureCropContainer\(image\)/);
  assert.match(rebase[0], /interaction\.pointMapping = createClientPointMapping/);
  assert.match(rebase[0], /interaction\.startCrop = readCropState\(image\)/);
  assert.match(rebase[0], /interaction\.contentRect = interaction\.startCrop \? getCropContentRect\(image\) : interaction\.rect/);
  assert.match(rebase[0], /interaction\.startCropBaseWidth = interaction\.startCrop \? readCropBaseWidth\(image\) : null/);
  assert.match(rebase[0], /interaction\.baseCanvasHeight = interaction\.startCrop/);
  assert.match(rebase[0], /captureGeometryPreviewStyles\(interaction, image\)/);
});

test('iframe pointer coordinates are converted once and stay top-document based', () => {
  const imageTools = readText('src/image-tools.js');
  const mapping = imageTools.match(/function createClientPointMapping\(sourceDocument\) \{[\s\S]*?\n  \}\n\n  function getTopClientPoint/);
  const point = imageTools.match(/function getTopClientPoint\(event, mapping = null\) \{[\s\S]*?\n  \}\n\n  function schedulePositionTools/);
  assert.ok(mapping && point, 'iframe coordinate mapping must exist');
  assert.match(mapping[0], /sourceDocument,/);
  assert.match(point[0], /if \(event && event\.mpseTopCoordinates\) return \{ x, y \}/);
  assert.match(point[0], /sourceDocument === mapping\.sourceDocument/);
  assert.match(imageTools, /mpseTopCoordinates: true/);
  assert.match(imageTools, /event && event\.mpseTopCoordinates[\s\S]*?getTopClientPoint\(event, interaction\.pointMapping\)/);
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

test('crop exit rolls back queued zoom setup and Escape cancels active geometry', () => {
  const imageTools = readText('src/image-tools.js');
  const exit = imageTools.match(/function exitCropMode\(\) \{[\s\S]*?\n  \}\n\n  const controlsFactory/);
  const rollback = imageTools.match(/function rollbackCropZoomSetup\(pending\) \{[\s\S]*?\n  \}\n\n  function cancelPendingCropZoom/);
  const cancel = imageTools.match(/function cancelPendingCropZoom\(image = null\) \{[\s\S]*?\n  \}\n\n  function flushCropZoom/);
  const keydown = imageTools.match(/function onDocumentKeyDown\(event\) \{[\s\S]*?\n  \}\n\n  function bindDocuments/);
  assert.ok(exit && rollback && cancel && keydown, 'crop cancellation lifecycle must exist');
  assert.match(exit[0], /cancelPendingCropZoom\(image\)/);
  assert.match(cancel[0], /window\.cancelAnimationFrame\(state\.zoomFrame\)[\s\S]*?rollbackCropZoomSetup\(pending\)/);
  assert.match(rollback[0], /pending\.createdCrop[\s\S]*?unwrapCropContainer\(image\)[\s\S]*?resumeImageCirclePresentation/);
  assert.match(rollback[0], /discardCapturedImageBase\(image, pending\.createdImageBase\)/);
  assert.match(keydown[0], /state\.cropMode \|\| state\.interaction[\s\S]*?finishOrDeferGeometry\(undefined, true\)/);
});

test('rebasing clears cached edge constraints and replays the last top-space point', () => {
  const imageTools = readText('src/image-tools.js');
  const rebase = imageTools.match(/function rebaseInteractionAfterEditorWrite\(identity\) \{[\s\S]*?\n  \}\n\n  function revealToolElements/);
  assert.ok(rebase, 'interaction rebase must exist');
  assert.match(rebase[0], /interaction\.edgeConstraints = null/);
  assert.match(rebase[0], /if \(interaction\.lastPoint\) \{/);
  assert.match(rebase[0], /clientX: interaction\.lastPoint\.x/);
  assert.match(rebase[0], /clientY: interaction\.lastPoint\.y/);
  assert.match(rebase[0], /mpseTopCoordinates: true/);
  assert.match(rebase[0], /else if \(interaction\.lastEvent\) \{[\s\S]*?updateGeometryGesture\(interaction\.lastEvent\)/);
});

test('disconnected pointer-capture loss defers a neutral pointerup instead of canceling', () => {
  const imageTools = readText('src/image-tools.js');
  const pointerUp = imageTools.match(/function onDocumentPointerUp\(event\) \{[\s\S]*?\n  \}\n\n  function onDocumentDragStart/);
  assert.ok(pointerUp, 'pointer completion handler must exist');
  assert.match(pointerUp[0], /event\.type === 'lostpointercapture'/);
  assert.match(pointerUp[0], /if \(deferGeometryFinish\(undefined, false\)\) return/);
  assert.match(pointerUp[0], /finishGeometryGesture\(\{ type: 'pointerup', pointerId: state\.interaction\?\.pointerId, target: document \}\)/);
  const disconnectedBranch = pointerUp[0].match(/if \(disconnectedLoss\) \{([\s\S]*?)\n    \}/);
  assert.ok(disconnectedBranch, 'disconnected capture-loss branch must exist');
  assert.doesNotMatch(disconnectedBranch[1], /pointercancel|finishGeometryGesture\([^\n]+, true\)|deferGeometryFinish\([^\n]+, true\)/);
});
