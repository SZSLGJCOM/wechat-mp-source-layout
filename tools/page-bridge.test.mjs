import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import { readText } from './test-helpers.mjs';

const source = readText('src/page-bridge.js');
const CONTENT_SOURCE = 'wechat-mp-source-layout:content';
const PAGE_SOURCE = 'wechat-mp-source-layout:page';

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createPageHarness(invoke, options = {}) {
  const windowListeners = new Set();
  const pendingResponses = new Map();
  const timers = new Map();
  let timerId = 0;
  let requestId = 0;

  const documentListeners = new Map();
  const document = {
    designMode: 'off',
    defaultView: null,
    querySelectorAll(selector) {
      if (selector === 'iframe') return [];
      if (selector.includes('contenteditable')) return options.editor ? [options.editor] : [];
      return [];
    },
    addEventListener(type, listener) {
      if (!documentListeners.has(type)) documentListeners.set(type, new Set());
      documentListeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      documentListeners.get(type)?.delete(listener);
    }
  };

  const window = {
    __MP_Editor_JSAPI__: options.withoutApi ? null : { invoke },
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    addEventListener(type, listener) {
      if (type === 'message') windowListeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === 'message') windowListeners.delete(listener);
    },
    postMessage(message) {
      if (message?.source !== PAGE_SOURCE) return;
      const resolve = pendingResponses.get(message.requestId);
      if (!resolve) return;
      pendingResponses.delete(message.requestId);
      resolve(message);
    },
    getComputedStyle() {
      return { display: 'block', visibility: 'visible' };
    }
  };
  window.window = window;
  window.top = window;
  document.defaultView = window;

  if (options.editor) {
    options.editor.ownerDocument = document;
    options.editor.nodeType = 1;
    options.editor.isContentEditable = true;
    options.editor.getAttribute ||= (name) => (name === 'contenteditable' ? 'true' : '');
    options.editor.getBoundingClientRect ||= () => ({ width: 600, height: 400 });
    options.editor.contains ||= (target) => target === options.editor;
  }

  const context = vm.createContext({
    window,
    document,
    Node: { ELEMENT_NODE: 1 },
    location: { href: options.href || 'https://mp.weixin.qq.com/cgi-bin/appmsg' },
    fetch: options.fetch || globalThis.fetch,
    URL,
    URLSearchParams,
    Blob,
    FormData,
    ArrayBuffer,
    console,
    setTimeout,
    clearTimeout
  });
  vm.runInContext(source, context, { filename: 'src/page-bridge.js' });

  function request(type, payload = {}) {
    const id = `test-${++requestId}`;
    const response = new Promise((resolve) => pendingResponses.set(id, resolve));
    const event = {
      source: window,
      data: { source: CONTENT_SOURCE, requestId: id, type, payload }
    };
    for (const listener of [...windowListeners]) listener(event);
    return response;
  }

  function fireDocumentEvent(type, target = options.editor, eventOptions = {}) {
    let prevented = false;
    let stopped = false;
    const event = {
      type,
      target,
      ...eventOptions,
      preventDefault() { prevented = true; },
      stopImmediatePropagation() { stopped = true; }
    };
    for (const listener of [...(documentListeners.get(type) || [])]) listener(event);
    return { prevented, stopped };
  }

  function runTimer(delay) {
    const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay);
    assert.ok(entry, `expected an active ${delay}ms timer`);
    timers.delete(entry[0]);
    entry[1].callback();
  }

  return { request, fireDocumentEvent, runTimer, timers, documentListeners, window };
}

test('native input events stay untouched and delay a queued SET until idle', async () => {
  const editor = { innerHTML: 'before', textContent: 'before', isConnected: true };
  const calls = [];
  let finishSet = null;
  const harness = createPageHarness((payload) => {
    calls.push(payload.apiName);
    if (payload.apiName === 'mp_editor_get_content') {
      payload.sucCb({ content: 'before' });
      return;
    }
    finishSet = payload.sucCb;
  }, { editor });

  const pending = harness.request('SET_CONTENT', {
    content: 'after',
    expectedContent: 'before',
    expectedMode: 'mp-editor-jsapi'
  });
  for (const type of ['beforeinput', 'paste', 'drop', 'cut']) {
    assert.deepEqual(harness.fireDocumentEvent(type), { prevented: false, stopped: false });
  }
  await nextTurn();

  assert.deepEqual(calls, [], 'the transaction must wait for the editor input quiet period');
  harness.runTimer(160);
  await nextTurn();
  assert.equal(typeof finishSet, 'function');
  finishSet({});
  const response = await pending;
  assert.equal(response.ok, true);
  assert.deepEqual(calls, ['mp_editor_get_content', 'mp_editor_set_content']);
});

test('composition keeps a queued SET deferred until composition ends and becomes idle', async () => {
  const editor = { innerHTML: 'before', textContent: 'before', isConnected: true };
  const calls = [];
  const harness = createPageHarness((payload) => {
    calls.push(payload.apiName);
    if (payload.apiName === 'mp_editor_get_content') payload.sucCb({ content: 'before' });
    else payload.sucCb({});
  }, { editor });

  harness.fireDocumentEvent('compositionstart');
  const pending = harness.request('SET_CONTENT', {
    content: 'after',
    expectedContent: 'before',
    expectedMode: 'mp-editor-jsapi'
  });
  await nextTurn();
  harness.runTimer(160);
  await nextTurn();
  assert.deepEqual(calls, [], 'an expired quiet timer must not bypass active composition');

  harness.fireDocumentEvent('compositionend');
  harness.runTimer(160);
  const response = await pending;
  assert.equal(response.ok, true);
  assert.deepEqual(calls, ['mp_editor_get_content', 'mp_editor_set_content']);
});

test('an abandoned composition cannot leave the SET queue pending forever', async () => {
  const editor = { innerHTML: 'before', textContent: 'before', isConnected: true };
  let nativeCalls = 0;
  const harness = createPageHarness((payload) => {
    nativeCalls += 1;
    payload.sucCb({});
  }, { editor });

  harness.fireDocumentEvent('compositionstart');
  const pending = harness.request('SET_CONTENT', {
    content: 'after',
    expectedContent: 'before',
    expectedMode: 'mp-editor-jsapi'
  });
  await nextTurn();
  harness.runTimer(2500);

  const response = await pending;
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'MPSE_EDITOR_BUSY');
  assert.equal(nativeCalls, 0, 'a timed-out input session must fail before any native write');

  harness.runTimer(160);
  const retry = await harness.request('SET_CONTENT', { content: 'retry' });
  assert.equal(retry.ok, true);
  assert.equal(nativeCalls, 1, 'the queue must recover after abandoning stale composition state');
});

test('input during final expected-content validation becomes a retryable conflict', async () => {
  const editor = { innerHTML: 'before', textContent: 'before', isConnected: true };
  let finishGet = null;
  let setCalls = 0;
  const harness = createPageHarness((payload) => {
    if (payload.apiName === 'mp_editor_get_content') finishGet = payload.sucCb;
    else setCalls += 1;
  }, { editor });

  const pending = harness.request('SET_CONTENT', {
    content: 'after',
    expectedContent: 'before',
    expectedMode: 'mp-editor-jsapi'
  });
  await nextTurn();
  assert.equal(typeof finishGet, 'function');

  assert.deepEqual(harness.fireDocumentEvent('beforeinput'), { prevented: false, stopped: false });
  finishGet({ content: 'before' });
  const response = await pending;
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'MPSE_CONTENT_CONFLICT');
  assert.equal(setCalls, 0, 'validation invalidated by input must never reach SET');
});

test('synthetic editor events emitted by programmatic writes do not impersonate user input', async () => {
  const editor = { innerHTML: 'before', textContent: 'before', isConnected: true };
  let calls = 0;
  const harness = createPageHarness((payload) => {
    calls += 1;
    harness.fireDocumentEvent('input', editor, { isTrusted: false });
    if (payload.apiName === 'mp_editor_get_content') payload.sucCb({ content: 'before' });
    else payload.sucCb({});
  }, { editor });

  const response = await harness.request('SET_CONTENT', {
    content: 'after',
    expectedContent: 'before',
    expectedMode: 'mp-editor-jsapi'
  });
  assert.equal(response.ok, true);
  assert.equal(calls, 2);
  assert.equal(harness.timers.size, 0, 'synthetic input must not start the user-input quiet timer');
});

test('input before a confirmed SET callback reports a conflict for atomic retry', async () => {
  const editor = { innerHTML: 'before', textContent: 'before', isConnected: true };
  let finishSet = null;
  const harness = createPageHarness((payload) => {
    if (payload.apiName === 'mp_editor_get_content') payload.sucCb({ content: 'before' });
    else finishSet = payload.sucCb;
  }, { editor });

  const pending = harness.request('SET_CONTENT', {
    content: 'after',
    expectedContent: 'before',
    expectedMode: 'mp-editor-jsapi'
  });
  await nextTurn();
  assert.equal(typeof finishSet, 'function');
  harness.fireDocumentEvent('input');
  finishSet({});

  const response = await pending;
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'MPSE_CONTENT_CONFLICT');
});

test('an unconfirmed SET times out into a fail-closed page state', async () => {
  const editor = { innerHTML: 'before', textContent: 'before', isConnected: true };
  let getCalls = 0;
  const harness = createPageHarness((payload) => {
    if (payload.apiName === 'mp_editor_get_content') {
      getCalls += 1;
      payload.sucCb({ content: 'before' });
    }
  }, { editor });

  const write = harness.request('SET_CONTENT', {
    content: 'after',
    expectedContent: 'before',
    expectedMode: 'mp-editor-jsapi'
  });
  await nextTurn();
  harness.runTimer(5000);
  const failedWrite = await write;
  assert.equal(failedWrite.ok, false);
  assert.equal(failedWrite.error.code, 'MPSE_WRITE_UNCERTAIN');

  const blockedRead = await harness.request('GET_CONTENT');
  assert.equal(blockedRead.ok, false);
  assert.equal(blockedRead.error.code, 'MPSE_WRITE_UNCERTAIN');
  assert.equal(getCalls, 1, 'the page must not issue more native reads after an uncertain write');
});

test('conditional JSAPI writes never fall back when the final GET fails', async () => {
  const editor = { innerHTML: 'fallback', textContent: 'fallback', isConnected: true };
  const calls = [];
  const harness = createPageHarness((payload) => {
    calls.push(payload.apiName);
    payload.errCb({ message: 'native read failed' });
  }, { editor });

  const response = await harness.request('SET_CONTENT', {
    content: 'after',
    expectedContent: 'before',
    expectedMode: 'mp-editor-jsapi'
  });

  assert.equal(response.ok, false);
  assert.match(response.error.message, /native read failed/);
  assert.deepEqual(calls, ['mp_editor_get_content']);
  assert.equal(editor.innerHTML, 'fallback');
});

test('a disconnected DOM editor is rejected instead of reporting a stale-node write', async () => {
  const editor = { innerHTML: 'before', textContent: 'before', isConnected: false };
  const harness = createPageHarness(() => {
    throw new Error('JSAPI must not be used');
  }, { editor, withoutApi: true });

  const response = await harness.request('SET_CONTENT', {
    content: 'after',
    expectedContent: 'before',
    expectedMode: 'dom-fallback'
  });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'MPSE_CONTENT_CONFLICT');
  assert.equal(editor.innerHTML, 'before');
});

test('an adapter change is reported as a conflict before any native write', async () => {
  const editor = { innerHTML: 'before', textContent: 'before', isConnected: true };
  let nativeCalls = 0;
  const harness = createPageHarness(() => {
    nativeCalls += 1;
  }, { editor });

  const response = await harness.request('SET_CONTENT', {
    content: 'after',
    expectedContent: 'before',
    expectedMode: 'dom-fallback'
  });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'MPSE_CONTENT_CONFLICT');
  assert.equal(nativeCalls, 0);
  assert.equal(editor.innerHTML, 'before');
});

test('the JSAPI adapter object stays fixed across final validation and SET', async () => {
  const editor = { innerHTML: 'before', textContent: 'before', isConnected: true };
  let finishGet = null;
  let oldAdapterSetCalls = 0;
  let newAdapterCalls = 0;
  const harness = createPageHarness((payload) => {
    if (payload.apiName === 'mp_editor_get_content') finishGet = payload.sucCb;
    else oldAdapterSetCalls += 1;
  }, { editor });

  const pending = harness.request('SET_CONTENT', {
    content: 'after',
    expectedContent: 'before',
    expectedMode: 'mp-editor-jsapi'
  });
  await nextTurn();
  harness.window.__MP_Editor_JSAPI__ = { invoke() { newAdapterCalls += 1; } };
  finishGet({ content: 'before' });

  const response = await pending;
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'MPSE_CONTENT_CONFLICT');
  assert.equal(oldAdapterSetCalls, 0);
  assert.equal(newAdapterCalls, 0);
});

test('a confirmed SET failure releases the queue for the next write', async () => {
  const editor = { innerHTML: 'before', textContent: 'before', isConnected: true };
  let setCalls = 0;
  const harness = createPageHarness((payload) => {
    assert.equal(payload.apiName, 'mp_editor_set_content');
    setCalls += 1;
    if (setCalls === 1) payload.errCb({ message: 'confirmed failure' });
    else payload.sucCb({});
  }, { editor });

  const first = await harness.request('SET_CONTENT', { content: 'one' });
  const second = await harness.request('SET_CONTENT', { content: 'two' });
  assert.equal(first.ok, false);
  assert.equal(second.ok, true);
  assert.equal(setCalls, 2);
});

test('image upload uses the editor local-file channel without material-library credentials', async () => {
  const requests = [];
  const harness = createPageHarness(() => {
    throw new Error('editor JSAPI must not be used for uploads');
  }, {
    href: 'https://mp.weixin.qq.com/cgi-bin/appmsg?token=123456&lang=zh_CN',
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            base_resp: { ret: 0 },
            content: '987654',
            cdn_url: 'https://mmbiz.qpic.cn/mmbiz_png/baked.png'
          };
        }
      };
    }
  });

  const bytes = new Uint8Array([137, 80, 78, 71]).buffer;
  const response = await harness.request('UPLOAD_IMAGE', {
    bytes,
    mimeType: 'image/png',
    filename: 'article-effect.png'
  });

  assert.equal(response.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(response.data)), {
    cdnUrl: 'https://mmbiz.qpic.cn/mmbiz_png/baked.png',
    fileId: '987654',
    mimeType: 'image/png',
    channel: 'editor-local'
  });
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /^\/cgi-bin\/filetransfer\?/);
  const query = new URL(requests[0].url, 'https://mp.weixin.qq.com').searchParams;
  assert.equal(query.get('action'), 'upload_material');
  assert.equal(query.get('scene'), '8');
  assert.equal(query.get('writetype'), 'doublewrite');
  assert.equal(query.get('ticket_id'), '');
  assert.equal(query.get('ticket'), '');
  assert.equal(query.get('svr_time'), '');
  assert.equal(query.get('token'), '123456');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.credentials, 'same-origin');
  const form = requests[0].init.body;
  const file = form.get('file');
  assert.equal(file.name, 'article-effect.png');
  assert.equal(file.type, 'image/png');
  assert.equal(file.size, bytes.byteLength);
  assert.equal(form.get('type'), 'image/png');
  assert.equal(form.get('name'), 'article-effect.png');
  assert.equal(form.get('size'), String(bytes.byteLength));
  assert.ok(form.get('id'));
  assert.ok(form.get('lastModifiedDate'));
});

test('local image upload retries with a fresh ticket only when the token-only channel rejects it', async () => {
  const requests = [];
  const harness = createPageHarness(() => {}, {
    href: 'https://mp.weixin.qq.com/cgi-bin/appmsg?token=123456',
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      if (requests.length === 1) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { base_resp: { ret: 200002, err_msg: 'invalid args' } };
          }
        };
      }
      if (requests.length === 2) {
        return {
          ok: true,
          status: 200,
          async text() {
            return 'ticket:"upload-ticket", user_name:"gh_material_owner"';
          }
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            base_resp: { ret: 0, err_msg: 'ok' },
            content: '987654',
            cdn_url: 'http://mmbiz.qpic.cn/mmbiz_png/baked.png'
          };
        }
      };
    }
  });

  const response = await harness.request('UPLOAD_IMAGE', {
    bytes: new Uint8Array([137, 80, 78, 71]).buffer,
    mimeType: 'image/png'
  });
  assert.equal(response.ok, true);
  assert.equal(response.data.cdnUrl, 'https://mmbiz.qpic.cn/mmbiz_png/baked.png');
  assert.equal(requests.length, 3);
  assert.equal(requests[1].url, '/cgi-bin/masssendpage?t=mass/send&token=123456&lang=zh_CN');
  const retryQuery = new URL(requests[2].url, 'https://mp.weixin.qq.com').searchParams;
  assert.equal(retryQuery.get('scene'), '8');
  assert.equal(retryQuery.get('ticket_id'), 'gh_material_owner');
  assert.equal(retryQuery.get('ticket'), 'upload-ticket');
  assert.ok(retryQuery.get('svr_time'));
});

test('image upload rejects invalid payloads before touching the network', async () => {
  let fetchCalls = 0;
  const harness = createPageHarness(() => {}, {
    href: 'https://mp.weixin.qq.com/cgi-bin/appmsg?token=123456',
    fetch: async () => {
      fetchCalls += 1;
      throw new Error('network must not be reached');
    }
  });

  const invalidMime = await harness.request('UPLOAD_IMAGE', {
    bytes: new Uint8Array([1]).buffer,
    mimeType: 'image/webp'
  });
  assert.equal(invalidMime.ok, false);
  assert.match(invalidMime.error.message, /PNG 或 JPEG/);

  const oversized = await harness.request('UPLOAD_IMAGE', {
    bytes: new ArrayBuffer((10 * 1024 * 1024) + 1),
    mimeType: 'image/png'
  });
  assert.equal(oversized.ok, false);
  assert.match(oversized.error.message, /10MB/);
  assert.equal(fetchCalls, 0);
});

test('image upload never accepts a non-WeChat URL as a successful article asset', async () => {
  const harness = createPageHarness(() => {}, {
    href: 'https://mp.weixin.qq.com/cgi-bin/appmsg?token=123456',
    fetch: async () => {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            base_resp: { ret: 0 },
            cdn_url: 'https://untrusted.example/baked.png'
          };
        }
      };
    }
  });

  const response = await harness.request('UPLOAD_IMAGE', {
    bytes: new Uint8Array([1]).buffer,
    mimeType: 'image/png'
  });
  assert.equal(response.ok, false);
  assert.match(response.error.message, /CDN 地址/);
});
