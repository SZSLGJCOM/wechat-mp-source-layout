import assert from 'node:assert/strict';
import test from 'node:test';

await import(new URL('../src/image-source.js', import.meta.url));

const imageSource = globalThis.__MPSE_IMAGE_SOURCE__;
globalThis.btoa ||= (value) => Buffer.from(value, 'binary').toString('base64');

test('image source detection uses bytes instead of the declared response type', () => {
  const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const source = imageSource.validateBytes(bytes.buffer);
  assert.equal(source.mimeType, 'image/png');
  assert.equal(source.size, 8);
  assert.match(imageSource.dataUrl(source), /^data:image\/png;base64,/);
});

test('image source detection recognizes AVIF file brands', () => {
  const bytes = Uint8Array.from([
    0x00, 0x00, 0x00, 0x18,
    0x66, 0x74, 0x79, 0x70,
    0x61, 0x76, 0x69, 0x66
  ]);
  assert.equal(imageSource.detectedMimeType(bytes.buffer), 'image/avif');
});

test('image source detection rejects HTML disguised as an image', () => {
  const bytes = new TextEncoder().encode('<!doctype html><title>blocked</title>');
  assert.throws(
    () => imageSource.validateBytes(bytes.buffer),
    (error) => error.code === 'MPSE_IMAGE_INVALID_BYTES'
  );
});
