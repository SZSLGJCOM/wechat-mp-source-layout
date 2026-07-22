import assert from 'node:assert/strict';
import test from 'node:test';

import { closeTo, readText } from './test-helpers.mjs';

await import(new URL('../src/image-geometry.js', import.meta.url));
const imageGeometry = globalThis.__MPSE_IMAGE_GEOMETRY__;

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

  const full = {
    frame: { x: 0, y: 0, width: 1, height: 1 },
    media: { x: 0, y: 0, width: 1, height: 1 },
    baseAspect: 1
  };
  assert.ok(imageGeometry.modelsMatch(full, imageGeometry.zoomMedia(full, 100, 0.5, 0.5)));
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

test('constrained circular crop edges stay square and preserve their opposite edge', () => {
  const start = {
    frame: { x: 0, y: 0, width: 1, height: 1 },
    media: { x: 0, y: 0, width: 1, height: 1 },
    baseAspect: 16 / 9
  };
  const cases = [
    { handle: 'e', delta: -0.3, fixed: (before, after) => closeTo(after.x, before.x) },
    { handle: 'w', delta: 0.3, fixed: (before, after) => closeTo(after.x + after.width, before.x + before.width) },
    { handle: 's', delta: -0.3, fixed: (before, after) => closeTo(after.y, before.y) },
    { handle: 'n', delta: 0.3, fixed: (before, after) => closeTo(after.y + after.height, before.y + before.height) }
  ];

  for (const { handle, delta, fixed } of cases) {
    const resized = imageGeometry.resizeFrameEdge(start, handle, delta);
    const constrained = imageGeometry.constrainFrameAspect(resized, handle, 1);
    closeTo(constrained.baseAspect * constrained.frame.width / constrained.frame.height, 1);
    fixed(resized.frame, constrained.frame);
    for (const key of ['x', 'y', 'width', 'height']) closeTo(constrained.media[key], constrained.frame[key]);
  }

  for (const [handle, delta] of [['e', 10], ['w', -10], ['s', 10], ['n', -10]]) {
    const expanded = imageGeometry.constrainFrameAspect(
      imageGeometry.resizeFrameEdge(start, handle, delta),
      handle,
      1
    );
    closeTo(expanded.baseAspect * expanded.frame.width / expanded.frame.height, 1);
    assert.ok(expanded.frame.x >= 0 && expanded.frame.y >= 0);
    assert.ok(expanded.frame.x + expanded.frame.width <= 1);
    assert.ok(expanded.frame.y + expanded.frame.height <= 1);
  }
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
