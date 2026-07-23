import assert from 'node:assert/strict';
import test from 'node:test';

import { closeTo, readText } from './test-helpers.mjs';

await import(new URL('../src/image-geometry.js', import.meta.url));
const imageGeometry = globalThis.__MPSE_IMAGE_GEOMETRY__;

test('crop persistence keeps normalized frame and media models', () => {
  const normalized = imageGeometry.normalizeModel({
    frame: { x: -1, y: 0.2, width: 2, height: 0.5 },
    media: { x: 0.9, y: -1, width: 0.5, height: 2 },
    baseAspect: 16 / 9
  });

  assert.deepEqual(normalized.frame, { x: 0, y: 0.2, width: 1, height: 0.5 });
  assert.deepEqual(normalized.media, { x: 0.5, y: 0, width: 0.5, height: 1 });
  closeTo(normalized.baseAspect, 16 / 9);
  assert.ok(imageGeometry.modelsMatch(normalized, { ...normalized }));
});

test('stored crop alignment remains stable for the size panel', () => {
  const frame = { x: 0.2, y: 0.1, width: 0.7, height: 0.8 };

  closeTo(imageGeometry.alignedFrameOffset(frame, 'left'), -0.2);
  closeTo(imageGeometry.alignedFrameOffset(frame, 'center'), -0.05);
  closeTo(imageGeometry.alignedFrameOffset(frame, 'right'), 0.1);
  closeTo(imageGeometry.horizontalTransformPercent(frame, 'left'), 0.2 / 0.7 * 100);
  closeTo(imageGeometry.horizontalTransformPercent(frame, 'center'), 0.05 / 0.7 * 100);
  closeTo(imageGeometry.horizontalTransformPercent(frame, 'right'), -0.1 / 0.7 * 100);
});

test('presentation restoration preserves crop edits made after an effect was applied', () => {
  const base = {
    frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    media: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    baseAspect: 4 / 3
  };
  const applied = {
    ...base,
    frame: { x: 0.2, y: 0.1, width: 0.6, height: 0.8 }
  };
  const current = {
    ...applied,
    frame: { x: 0.25, y: 0.15, width: 0.55, height: 0.7 }
  };
  const restored = imageGeometry.restoreFrameAfterPresentation(base, applied, current);

  closeTo(restored.frame.x, 0.15);
  closeTo(restored.frame.y, 0.15);
  closeTo(restored.frame.width, 0.75);
  closeTo(restored.frame.height, 0.7);
  assert.deepEqual(restored.media, current.media);
});

test('direct-manipulation geometry is retired with the custom image selection layer', () => {
  const imageTools = readText('src/image-tools.js');
  const geometrySource = readText('src/image-geometry.js');

  for (const name of [
    'resizeFrameEdge',
    'panMedia',
    'zoomMedia',
    'previewFrameRect',
    'cornerResizeOrigin',
    'resizePreviewRect',
    'constrainFrameAspect'
  ]) {
    assert.equal(imageGeometry[name], undefined);
    assert.doesNotMatch(geometrySource, new RegExp(`function ${name}\\(`));
  }

  assert.match(imageTools, /function setLayoutWidthPercent\(image, width/);
  assert.doesNotMatch(imageTools, /function beginGeometryGesture\(/);
  assert.doesNotMatch(imageTools, /function beginCropPan\(/);
});
