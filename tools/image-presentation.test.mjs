import assert from 'node:assert/strict';
import test from 'node:test';

import { closeTo } from './test-helpers.mjs';

await import(new URL('../src/image-presentation.js', import.meta.url));
const presentation = globalThis.__MPSE_IMAGE_PRESENTATION__;

test('individual scale is flattened into effective image dimensions', () => {
  assert.deepEqual(presentation.parseInlineScale('0.2'), { active: true, flatten: true, x: 0.2, y: 0.2 });
  assert.deepEqual(presentation.parseInlineScale('25% 50%'), { active: true, flatten: true, x: 0.25, y: 0.5 });
  assert.equal(presentation.parseInlineScale('-1 1').flatten, false);

  const size = presentation.scaleContentSize(640, 320, '0.2');
  closeTo(size.width, 128);
  closeTo(size.height, 64);
});

test('crop layout removes flattened transforms from media and preserves unsupported scale on its host', () => {
  const flattened = {
    styles: {
      scale: { value: '0.2', priority: '' },
      translate: { value: '40px 10px', priority: '' }
    },
    hostStyles: {}
  };
  const flattenedScale = presentation.normalizeCropLayout(flattened);
  assert.equal(flattenedScale.flatten, true);
  assert.equal(flattened.styles.scale.value, '');
  assert.equal(flattened.styles.translate.value, '');
  assert.equal(flattened.hostStyles.scale.value, '');

  const mirrored = {
    styles: { scale: { value: '-1 1', priority: 'important' }, translate: { value: '', priority: '' } },
    hostStyles: {}
  };
  const mirroredScale = presentation.normalizeCropLayout(mirrored);
  assert.equal(mirroredScale.flatten, false);
  assert.deepEqual(mirrored.hostStyles.scale, { value: '-1 1', priority: 'important' });
});

test('crop host translation preserves the pre-gesture visual position', () => {
  const values = new Map();
  const host = {
    style: {
      removeProperty: (name) => values.delete(name),
      setProperty: (name, value, priority) => values.set(name, { value, priority })
    },
    getBoundingClientRect: () => ({ left: 32, top: 96, width: 128, height: 64 })
  };
  const desired = { left: 352, top: 170, width: 128, height: 64 };
  const currentTop = { left: 312, top: 160, width: 128, height: 64 };
  const value = presentation.positionCropHost(host, desired, () => currentTop);

  assert.equal(value, '40.000px 10.000px');
  assert.deepEqual(values.get('translate'), { value, priority: 'important' });
});
