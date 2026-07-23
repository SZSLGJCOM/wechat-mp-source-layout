import assert from 'node:assert/strict';
import vm from 'node:vm';
import test from 'node:test';

import { readText } from './test-helpers.mjs';

function createWorker(fetchImage) {
  let listener = null;
  const context = {
    URL,
    Uint8Array,
    fetch: fetchImage,
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    chrome: {
      runtime: {
        onMessage: {
          addListener(callback) {
            listener = callback;
          }
        }
      }
    }
  };
  vm.runInNewContext(readText('src/image-background.js'), context);
  assert.equal(typeof listener, 'function');
  return listener;
}

function requestImage(listener, url, sender = { url: 'https://mp.weixin.qq.com/cgi-bin/appmsg' }) {
  return new Promise((resolve) => {
    listener({ type: 'MPSE_FETCH_IMAGE', url }, sender, resolve);
  });
}

test('background reads HTTPS article images from non-WeChat origins', async () => {
  const requested = [];
  const listener = createWorker(async (url, options) => {
    requested.push({ url, options });
    return {
      ok: true,
      url,
      headers: { get: () => null },
      blob: async () => new Blob([Uint8Array.of(1, 2, 3)], { type: 'image/png' })
    };
  });

  const response = await requestImage(listener, 'https://assets.example.com/article/cover.png');

  assert.equal(response.ok, true);
  assert.match(response.result.dataUrl, /^data:image\/png;base64,/);
  assert.equal(requested[0].url, 'https://assets.example.com/article/cover.png');
  assert.equal(requested[0].options.credentials, 'omit');
});

test('background rejects non-HTTPS sources before network access', async () => {
  let fetchCount = 0;
  const listener = createWorker(async () => {
    fetchCount += 1;
    throw new Error('unexpected fetch');
  });

  const response = await requestImage(listener, 'http://assets.example.com/article/cover.png');

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'MPSE_IMAGE_URL_NOT_ALLOWED');
  assert.equal(fetchCount, 0);
});

test('background accepts image requests only from the WeChat editor', async () => {
  let fetchCount = 0;
  const listener = createWorker(async () => {
    fetchCount += 1;
    throw new Error('unexpected fetch');
  });

  const response = await requestImage(
    listener,
    'https://assets.example.com/article/cover.png',
    { url: 'https://example.com/' }
  );

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'MPSE_IMAGE_SENDER_NOT_ALLOWED');
  assert.equal(fetchCount, 0);
});
