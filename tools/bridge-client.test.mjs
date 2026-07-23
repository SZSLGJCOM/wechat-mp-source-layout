import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import { readText } from './test-helpers.mjs';

const source = readText('src/bridge-client.js');
const PAGE_SOURCE = 'wechat-mp-source-layout:page';

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createBridgeHarness(handleRequest) {
  const messageListeners = new Set();
  const scheduledTimeouts = [];
  const window = {
    setTimeout(callback, delay) {
      scheduledTimeouts.push(delay);
      return setTimeout(callback, delay);
    },
    clearTimeout,
    addEventListener(type, listener) {
      if (type === 'message') messageListeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === 'message') messageListeners.delete(listener);
    },
    postMessage(message) {
      queueMicrotask(() => handleRequest(message, (response = {}) => {
        const data = {
          source: PAGE_SOURCE,
          requestId: message.requestId,
          type: `${message.type}_RESULT`,
          ok: response.ok !== false,
          data: response.data || null,
          error: response.error || null
        };
        queueMicrotask(() => {
          for (const listener of [...messageListeners]) listener({ source: window, data });
        });
      }));
    }
  };
  window.window = window;

  const context = vm.createContext({
    window,
    document: {
      documentElement: { dataset: { mpseBridgeInjected: '1' } }
    },
    console,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    URL,
    Blob,
    ArrayBuffer
  });
  vm.runInContext(source, context, { filename: 'src/bridge-client.js' });

  return {
    client: window.__MPSE_BRIDGE_CLIENT__,
    scheduledTimeouts
  };
}

test('confirmed writes stay pending without a client-side timeout', async () => {
  let pendingResponse = null;
  const { client, scheduledTimeouts } = createBridgeHarness((message, respond) => {
    assert.equal(message.type, 'SET_CONTENT');
    pendingResponse = respond;
  });

  let settled = false;
  const write = client.writeContent('<p>one</p>').finally(() => {
    settled = true;
  });
  await nextTurn();

  assert.equal(settled, false);
  assert.deepEqual(scheduledTimeouts, []);
  pendingResponse({ data: { mode: 'mp-editor-jsapi' } });
  await write;
});

test('content writes are serialized until the previous native callback resolves', async () => {
  const requests = [];
  const responders = [];
  const { client } = createBridgeHarness((message, respond) => {
    requests.push(message);
    responders.push(respond);
  });

  const first = client.writeContent('first');
  const second = client.writeContent('second');
  await nextTurn();
  assert.deepEqual(requests.map((request) => request.payload.content), ['first']);

  responders[0]({ data: { mode: 'mp-editor-jsapi' } });
  await first;
  await nextTurn();
  assert.deepEqual(requests.map((request) => request.payload.content), ['first', 'second']);

  responders[1]({ data: { mode: 'mp-editor-jsapi' } });
  await second;
});

test('atomic mutations retry conflicts against the latest content and fixed adapter', async () => {
  let content = '<p>A</p>';
  let getCount = 0;
  let setCount = 0;
  const writes = [];
  const { client } = createBridgeHarness((message, respond) => {
    if (message.type === 'GET_CONTENT') {
      getCount += 1;
      respond({ data: { content, mode: 'mp-editor-jsapi' } });
      return;
    }

    setCount += 1;
    writes.push(message.payload);
    if (setCount === 1) {
      content = '<p>B</p>';
      respond({
        ok: false,
        error: { code: 'MPSE_CONTENT_CONFLICT', message: 'content changed' }
      });
      return;
    }
    content = message.payload.content;
    respond({ data: { mode: 'mp-editor-jsapi' } });
  });

  const seen = [];
  const result = await client.mutateContent((read) => {
    seen.push(read.content);
    return `${read.content}!`;
  });

  assert.deepEqual(seen, ['<p>A</p>', '<p>B</p>']);
  assert.equal(getCount, 2);
  assert.equal(setCount, 2);
  assert.equal(result.conflictRetries, 1);
  assert.deepEqual(writes.map(({ expectedContent, expectedMode }) => ({ expectedContent, expectedMode })), [
    { expectedContent: '<p>A</p>', expectedMode: 'mp-editor-jsapi' },
    { expectedContent: '<p>B</p>', expectedMode: 'mp-editor-jsapi' }
  ]);
  assert.equal(content, '<p>B</p>!');
});

test('non-conflict write failures are not replayed', async () => {
  let getCount = 0;
  let setCount = 0;
  let failWrites = true;
  const { client } = createBridgeHarness((message, respond) => {
    if (message.type === 'GET_CONTENT') {
      getCount += 1;
      respond({ data: { content: 'source', mode: 'mp-editor-jsapi' } });
      return;
    }
    setCount += 1;
    if (failWrites) respond({ ok: false, error: { code: 'MPSE_WRITE_FAILED', message: 'write failed' } });
    else respond({ data: { mode: 'mp-editor-jsapi' } });
  });

  await assert.rejects(client.mutateContent(() => 'changed'), /write failed/);
  assert.equal(getCount, 1);
  assert.equal(setCount, 1);

  failWrites = false;
  const read = await client.readContent();
  assert.equal(read.content, 'source', 'a confirmed rejection must not poison later operations');
  assert.equal(getCount, 2);
});

test('content conflicts stop after two retries without an unconditional write', async () => {
  let getCount = 0;
  let setCount = 0;
  const { client } = createBridgeHarness((message, respond) => {
    if (message.type === 'GET_CONTENT') {
      getCount += 1;
      respond({ data: { content: `version-${getCount}`, mode: 'mp-editor-jsapi' } });
      return;
    }
    setCount += 1;
    respond({
      ok: false,
      error: { code: 'MPSE_CONTENT_CONFLICT', message: 'content changed again' }
    });
  });

  await assert.rejects(client.mutateContent((read) => `${read.content}!`), /content changed again/);
  assert.equal(getCount, 3);
  assert.equal(setCount, 3);
});

test('image uploads transfer binary data with a bounded long-running timeout', async () => {
  let captured = null;
  const { client, scheduledTimeouts } = createBridgeHarness((message, respond) => {
    captured = message;
    respond({
      data: {
        cdnUrl: 'https://mmbiz.qpic.cn/mmbiz_png/baked.png',
        fileId: '123',
        mimeType: 'image/png'
      }
    });
  });

  const blob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
  const result = await client.uploadImage(blob, 'baked.png');

  assert.equal(captured.type, 'UPLOAD_IMAGE');
  assert.ok(captured.payload.bytes instanceof ArrayBuffer);
  assert.equal(captured.payload.bytes.byteLength, blob.size);
  assert.equal(captured.payload.mimeType, 'image/png');
  assert.equal(captured.payload.filename, 'baked.png');
  assert.ok(scheduledTimeouts.includes(90000));
  assert.equal(result.cdnUrl, 'https://mmbiz.qpic.cn/mmbiz_png/baked.png');
});

test('image uploads reject empty input before posting to the page bridge', async () => {
  let requestCalls = 0;
  const { client } = createBridgeHarness(() => {
    requestCalls += 1;
  });

  await assert.rejects(client.uploadImage(new Blob([], { type: 'image/png' })), /Image blob is required/);
  assert.equal(requestCalls, 0);
});
