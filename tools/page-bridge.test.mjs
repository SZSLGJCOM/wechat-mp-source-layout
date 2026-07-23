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
    },
    createElement() {
      let html = '';
      let entries = [];
      return {
        set innerHTML(value) {
          html = String(value || '');
          entries = [];
          for (const match of html.matchAll(/<img\b([^>]*)>/gi)) {
            const attributes = {};
            for (const attribute of match[1].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
              attributes[attribute[1]] = String(attribute[2] ?? attribute[3] ?? attribute[4] ?? '')
                .replaceAll('&amp;', '&');
            }
            const entry = {
              html: match[0],
              removed: false,
              image: null
            };
            const image = fakeImage(attributes);
            image.remove = () => {
              entry.removed = true;
              image.isConnected = false;
            };
            entry.image = image;
            entries.push(entry);
          }
        },
        get innerHTML() {
          return entries.reduce((content, entry) => {
            if (entry.removed) return content.replace(entry.html, '');
            const attributes = [...entry.image.__attributes.entries()]
              .map(([name, value]) => {
                const escaped = String(value)
                  .replaceAll('&', '&amp;')
                  .replaceAll('"', '&quot;')
                  .replaceAll('<', '&lt;');
                return `${name}="${escaped}"`;
              })
              .join(' ');
            return content.replace(entry.html, `<img${attributes ? ` ${attributes}` : ''}>`);
          }, html);
        },
        querySelectorAll(selector) {
          if (selector !== 'img') return [];
          return entries.filter((entry) => !entry.removed).map((entry) => entry.image);
        }
      };
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
  window.File = options.File || globalThis.File;
  window.DataTransfer = options.DataTransfer;
  window.ClipboardEvent = options.ClipboardEvent;
  window.Event = options.Event || globalThis.Event;
  window.InputEvent = options.InputEvent || window.Event;
  window.KeyboardEvent = options.KeyboardEvent || window.Event;
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
    Date: options.Date || Date,
    Blob,
    ArrayBuffer,
    MutationObserver: options.MutationObserver || class {
      constructor() {}
      observe() {}
      disconnect() {}
    },
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
  assert.equal(response.ok, true, JSON.stringify(response.error));
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

test('conditional writes reject a different article even when the HTML is identical', async () => {
  const editor = { innerHTML: 'same', textContent: 'same', isConnected: true };
  let setCalls = 0;
  const harness = createPageHarness((payload) => {
    if (payload.apiName === 'mp_editor_get_content') {
      payload.sucCb({ content: 'same' });
    } else {
      setCalls += 1;
      payload.sucCb({});
    }
  }, {
    editor,
    href: 'https://mp.weixin.qq.com/cgi-bin/appmsg?appmsgid=2'
  });

  const response = await harness.request('SET_CONTENT', {
    content: 'replacement',
    expectedContent: 'same',
    expectedMode: 'mp-editor-jsapi',
    expectedArticleKey: 'path=/cgi-bin/appmsg&appmsgid=1'
  });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'MPSE_CONTENT_CONFLICT');
  assert.equal(setCalls, 0);
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

function fakeImage(attributes) {
  const values = new Map(Object.entries(attributes));
  const styles = new Map();
  return {
    __attributes: values,
    isConnected: true,
    currentSrc: values.get('src') || '',
    style: {
      setProperty(name, value, priority = '') {
        styles.set(name, { value: String(value), priority: String(priority) });
      },
      getPropertyValue: (name) => styles.get(name)?.value || '',
      getPropertyPriority: (name) => styles.get(name)?.priority || ''
    },
    getAttribute: (name) => values.get(name) || '',
    hasAttribute: (name) => values.has(name),
    setAttribute(name, value) {
      values.set(name, String(value));
    },
    removeAttribute(name) {
      values.delete(name);
    },
    remove() {
      this.isConnected = false;
    },
    parentElement: null
  };
}

class FakeFile extends Blob {
  constructor(parts, name, options = {}) {
    super(parts, options);
    this.name = name;
    this.lastModified = options.lastModified || 0;
  }
}

class FakeDataTransfer {
  constructor() {
    this.files = [];
    this.items = {
      add: (file) => {
        this.files.push(file);
        return file;
      }
    };
  }
}

class FakeClipboardEvent {
  constructor(type, options = {}) {
    this.type = type;
    Object.assign(this, options);
    this.isTrusted = false;
  }
}

test('image bake keeps an after-target carrier for the atomic snapshot commit', async () => {
  const original = fakeImage({
    src: 'https://mmbiz.qpic.cn/source.png',
    'data-src': 'https://mmbiz.qpic.cn/source.png',
    'data-mpse-image-id': 'image-7'
  });
  const pasted = fakeImage({
    src: 'https://mmbiz.qpic.cn/mmbiz_png/baked.png?wx_fmt=png&from=appmsg',
    'data-src': 'https://mmbiz.qpic.cn/mmbiz_png/baked.png?wx_fmt=png&from=appmsg',
    'data-fileid': '987654',
    'data-w': '900',
    'data-ratio': '0.5625',
    'data-type': 'png'
  });
  const images = [original];
  let selectionPayload = null;
  let pasteEvent = null;
  let setContentCalls = 0;
  let canonicalContent = '<p><img src="https://mmbiz.qpic.cn/source.png"></p>';
  const editor = {
    innerHTML: canonicalContent,
    textContent: '',
    isConnected: true,
    querySelectorAll(selector) {
      return selector === 'img' ? images : [];
    },
    dispatchEvent(event) {
      if (event.type === 'paste') {
        pasteEvent = event;
        images.push(pasted);
        canonicalContent += '<p><img data-src="https://mmbiz.qpic.cn/mmbiz_png/baked.png?wx_fmt=png&amp;from=appmsg"></p>';
      }
      return true;
    },
    focus() {}
  };
  const harness = createPageHarness((payload) => {
    if (payload.apiName === 'mp_editor_get_isready') {
      payload.sucCb({ isReady: true, isNew: true });
      return;
    }
    if (payload.apiName === 'mp_editor_set_selection') {
      selectionPayload = payload.apiParam;
      payload.sucCb({});
      return;
    }
    if (payload.apiName === 'mp_editor_get_content') {
      payload.sucCb({ content: canonicalContent });
      return;
    }
    if (payload.apiName === 'mp_editor_set_content') {
      setContentCalls += 1;
      canonicalContent = payload.apiParam.content;
      payload.sucCb({});
      return;
    }
    throw new Error(`unexpected API ${payload.apiName}`);
  }, {
    editor,
    File: FakeFile,
    DataTransfer: FakeDataTransfer,
    ClipboardEvent: FakeClipboardEvent
  });

  const response = await harness.request('PASTE_IMAGE', {
    bytes: new Uint8Array([137, 80, 78, 71]).buffer,
    mimeType: 'image/png',
    filename: 'article-effect.png',
    locator: {
      editId: 'image-7',
      sourceUrl: 'https://mmbiz.qpic.cn/source.png',
      index: 0
    }
  });

  assert.equal(response.ok, true, JSON.stringify(response.error));
  assert.equal(selectionPayload.container, original);
  assert.equal(selectionPayload.selectAfter, true);
  assert.equal(pasteEvent.type, 'paste');
  assert.equal(pasteEvent.clipboardData.files.length, 1);
  assert.equal(pasteEvent.clipboardData.files[0].name, 'article-effect.png');
  assert.equal(original.isConnected, true, 'the original stays until the atomic content commit');
  assert.equal(pasted.isConnected, true, 'the snapshot transaction owns the temporary carrier');
  assert.equal(pasted.style.getPropertyValue('display'), 'none', 'the upload carrier never flashes as a second article image');
  assert.equal(pasted.style.getPropertyPriority('display'), 'important');
  assert.equal((canonicalContent.match(/<img\b/g) || []).length, 2);
  assert.equal(setContentCalls, 0, 'the page bridge must not race the snapshot with a baseline rewrite');
  assert.equal(harness.timers.size, 0, 'normal carrier ownership belongs only to the snapshot transaction');
  assert.match(response.data.pasteId, /^mpse-paste-/);
  assert.deepEqual(JSON.parse(JSON.stringify({ ...response.data, pasteId: '<dynamic>' })), {
    pasteId: '<dynamic>',
    cdnUrl: 'https://mmbiz.qpic.cn/mmbiz_png/baked.png?wx_fmt=png&from=appmsg',
    sourceAttributes: {
      src: 'https://mmbiz.qpic.cn/mmbiz_png/baked.png?wx_fmt=png&from=appmsg',
      'data-src': 'https://mmbiz.qpic.cn/mmbiz_png/baked.png?wx_fmt=png&from=appmsg',
      'data-fileid': '987654',
      'data-w': '900',
      'data-ratio': '0.5625',
      'data-type': 'png'
    },
    mimeType: 'image/png',
    channel: 'editor-paste',
    selectionMode: 'mp-editor-jsapi',
    articleKey: 'path=/cgi-bin/appmsg',
    placement: 'after',
    cleanupPending: true
  });
});

test('an in-place native paste fails closed after restoring the target image', async () => {
  const target = fakeImage({
    src: 'https://mmbiz.qpic.cn/source-replace.png',
    'data-src': 'https://mmbiz.qpic.cn/source-replace.png',
    'data-mpse-image-id': 'image-replace'
  });
  const baseline = '<p><img data-mpse-image-id="image-replace" data-src="https://mmbiz.qpic.cn/source-replace.png"></p>';
  let canonicalContent = baseline;
  const editor = {
    innerHTML: baseline,
    textContent: '',
    isConnected: true,
    querySelectorAll: (selector) => (selector === 'img' ? [target] : []),
    contains: (node) => node === target,
    dispatchEvent(event) {
      if (event.type === 'paste') {
        target.setAttribute('src', 'https://mmbiz.qpic.cn/replaced.png');
        target.setAttribute('data-src', 'https://mmbiz.qpic.cn/replaced.png');
        target.setAttribute('data-fileid', 'replace-file');
        canonicalContent = '<p><img data-mpse-image-id="image-replace" data-src="https://mmbiz.qpic.cn/replaced.png"></p>';
      }
      return true;
    },
    focus() {}
  };
  const harness = createPageHarness((payload) => {
    if (payload.apiName === 'mp_editor_get_isready') {
      payload.sucCb({ isReady: true, isNew: true });
    } else if (payload.apiName === 'mp_editor_set_selection') {
      payload.sucCb({});
    } else if (payload.apiName === 'mp_editor_get_content') {
      payload.sucCb({ content: canonicalContent });
    } else if (payload.apiName === 'mp_editor_set_content') {
      canonicalContent = payload.apiParam.content;
      payload.sucCb({});
    } else {
      throw new Error(`unexpected API ${payload.apiName}`);
    }
  }, {
    editor,
    File: FakeFile,
    DataTransfer: FakeDataTransfer,
    ClipboardEvent: FakeClipboardEvent
  });

  const response = await harness.request('PASTE_IMAGE', {
    bytes: new Uint8Array([137, 80, 78, 71]).buffer,
    mimeType: 'image/png',
    locator: {
      editId: 'image-replace',
      sourceUrl: 'https://mmbiz.qpic.cn/source-replace.png',
      index: 0
    }
  });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'MPSE_NATIVE_IMAGE_PASTE_UNSUPPORTED');
  assert.equal(target.isConnected, true);
  assert.equal(target.getAttribute('data-src'), 'https://mmbiz.qpic.cn/source-replace.png');
  assert.equal(target.getAttribute('data-mpse-native-paste-id'), '');
  assert.equal(canonicalContent, baseline);
});

test('an in-place raw upload placeholder receives the bounded window before failing closed', async () => {
  let now = 0;
  class ControlledDate extends Date {
    static now() {
      return now;
    }
  }
  const target = fakeImage({
    src: 'https://mmbiz.qpic.cn/source-placeholder.png',
    'data-src': 'https://mmbiz.qpic.cn/source-placeholder.png',
    'data-mpse-image-id': 'image-placeholder'
  });
  const baseline = [
    '<p><img data-mpse-image-id="image-placeholder"',
    ' data-src="https://mmbiz.qpic.cn/source-placeholder.png"></p>'
  ].join('');
  let canonicalContent = baseline;
  const editor = {
    innerHTML: baseline,
    textContent: '',
    isConnected: true,
    querySelectorAll: (selector) => (selector === 'img' ? [target] : []),
    contains: (node) => node === target,
    dispatchEvent(event) {
      if (event.type === 'paste') {
        target.setAttribute('src', 'blob:https://mp.weixin.qq.com/pending-upload');
        target.setAttribute('data-src', 'blob:https://mp.weixin.qq.com/pending-upload');
        canonicalContent = '<p><img data-src="blob:https://mp.weixin.qq.com/pending-upload"></p>';
      }
      return true;
    },
    focus() {}
  };
  const harness = createPageHarness((payload) => {
    if (payload.apiName === 'mp_editor_get_isready') {
      payload.sucCb({ isReady: true, isNew: true });
    } else if (payload.apiName === 'mp_editor_set_selection') {
      payload.sucCb({});
    } else if (payload.apiName === 'mp_editor_get_content') {
      payload.sucCb({ content: canonicalContent });
    } else if (payload.apiName === 'mp_editor_set_content') {
      canonicalContent = payload.apiParam.content;
      payload.sucCb({});
    } else {
      throw new Error(`unexpected API ${payload.apiName}`);
    }
  }, {
    editor,
    File: FakeFile,
    DataTransfer: FakeDataTransfer,
    ClipboardEvent: FakeClipboardEvent,
    Date: ControlledDate
  });

  let settled = false;
  const pending = harness.request('PASTE_IMAGE', {
    bytes: new Uint8Array([137, 80, 78, 71]).buffer,
    mimeType: 'image/png',
    locator: {
      editId: 'image-placeholder',
      sourceUrl: 'https://mmbiz.qpic.cn/source-placeholder.png',
      index: 0
    }
  }).finally(() => {
    settled = true;
  });
  await nextTurn();

  now = 6000;
  harness.runTimer(120);
  await nextTurn();
  assert.equal(settled, false, 'the raw placeholder must extend the initial five-second deadline');

  target.setAttribute('src', 'https://mmbiz.qpic.cn/uploaded-placeholder.png');
  target.setAttribute('data-src', 'https://mmbiz.qpic.cn/uploaded-placeholder.png');
  canonicalContent = '<p><img data-src="https://mmbiz.qpic.cn/uploaded-placeholder.png"></p>';
  now = 7000;
  harness.runTimer(120);

  const response = await pending;
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'MPSE_NATIVE_IMAGE_PASTE_UNSUPPORTED');
  assert.equal(canonicalContent, baseline);
});

test('an input conflict restores the known replacement and hands canonical cleanup to the page ledger', async () => {
  const target = fakeImage({
    src: 'https://mmbiz.qpic.cn/source-conflict.png',
    'data-src': 'https://mmbiz.qpic.cn/source-conflict.png',
    'data-fileid': 'source-file',
    'data-mpse-image-id': 'image-conflict'
  });
  const baseline = [
    '<p><img data-mpse-image-id="image-conflict"',
    ' src="https://mmbiz.qpic.cn/source-conflict.png"',
    ' data-src="https://mmbiz.qpic.cn/source-conflict.png"',
    ' data-fileid="source-file"></p>'
  ].join('');
  let canonicalContent = baseline;
  let getCalls = 0;
  let confirmationRequest = null;
  const editor = {
    innerHTML: baseline,
    textContent: '',
    isConnected: true,
    querySelectorAll: (selector) => (selector === 'img' ? [target] : []),
    contains: (node) => node === target,
    dispatchEvent(event) {
      if (event.type === 'paste') {
        target.setAttribute('src', 'https://mmbiz.qpic.cn/replacement-conflict.png');
        target.setAttribute('data-src', 'https://mmbiz.qpic.cn/replacement-conflict.png');
        target.setAttribute('data-fileid', 'replacement-file');
        canonicalContent = [
          '<p><img data-mpse-image-id="image-conflict"',
          ' src="https://mmbiz.qpic.cn/replacement-conflict.png"',
          ' data-src="https://mmbiz.qpic.cn/replacement-conflict.png"',
          ' data-fileid="replacement-file"></p>'
        ].join('');
      }
      return true;
    },
    focus() {}
  };
  const harness = createPageHarness((payload) => {
    if (payload.apiName === 'mp_editor_get_isready') {
      payload.sucCb({ isReady: true, isNew: true });
    } else if (payload.apiName === 'mp_editor_set_selection') {
      payload.sucCb({});
    } else if (payload.apiName === 'mp_editor_get_content') {
      getCalls += 1;
      if (getCalls === 1) payload.sucCb({ content: canonicalContent });
      else if (getCalls === 2) confirmationRequest = payload;
      else payload.sucCb({ content: canonicalContent });
    } else if (payload.apiName === 'mp_editor_set_content') {
      canonicalContent = payload.apiParam.content;
      payload.sucCb({});
    } else {
      throw new Error(`unexpected API ${payload.apiName}`);
    }
  }, {
    editor,
    File: FakeFile,
    DataTransfer: FakeDataTransfer,
    ClipboardEvent: FakeClipboardEvent
  });

  const pending = harness.request('PASTE_IMAGE', {
    bytes: new Uint8Array([137, 80, 78, 71]).buffer,
    mimeType: 'image/png',
    locator: {
      editId: 'image-conflict',
      sourceUrl: 'https://mmbiz.qpic.cn/source-conflict.png',
      index: 0
    }
  });
  await nextTurn();

  assert.ok(confirmationRequest, 'the pasted replacement must be owned before the input conflict');
  harness.fireDocumentEvent('input', editor);
  confirmationRequest.sucCb({ content: canonicalContent });

  const response = await pending;
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'MPSE_CONTENT_CONFLICT');
  assert.equal(response.error.pasteCandidate.placement, 'replace');
  assert.deepEqual(JSON.parse(JSON.stringify(response.error.pasteCandidate.originalAttributes)), {
    src: 'https://mmbiz.qpic.cn/source-conflict.png',
    'data-src': 'https://mmbiz.qpic.cn/source-conflict.png',
    'data-fileid': 'source-file'
  });
  assert.equal(target.isConnected, true);
  assert.equal(target.getAttribute('data-src'), 'https://mmbiz.qpic.cn/source-conflict.png');
  assert.equal(target.getAttribute('data-fileid'), 'source-file');

  harness.runTimer(160);
  await nextTurn();
  harness.runTimer(1000);
  await nextTurn();
  await nextTurn();

  assert.equal((canonicalContent.match(/<img\b/g) || []).length, 1);
  assert.match(canonicalContent, /source-conflict\.png/);
  assert.match(canonicalContent, /source-file/);
  assert.doesNotMatch(canonicalContent, /replacement-conflict\.png|replacement-file|data-mpse-native-paste-id/);
});

test('a replacement node without the extension image id is restored by its bounded position', async () => {
  const original = fakeImage({
    src: 'https://mmbiz.qpic.cn/source-node.png',
    'data-src': 'https://mmbiz.qpic.cn/source-node.png',
    'data-mpse-image-id': 'image-node'
  });
  const neighbor = fakeImage({
    src: 'https://mmbiz.qpic.cn/neighbor-node.png',
    'data-src': 'https://mmbiz.qpic.cn/neighbor-node.png',
    'data-mpse-image-id': 'neighbor-node'
  });
  const replacement = fakeImage({
    src: 'https://mmbiz.qpic.cn/replacement-node.png',
    'data-src': 'https://mmbiz.qpic.cn/replacement-node.png'
  });
  let images = [original, neighbor];
  const baseline = [
    '<p><img data-mpse-image-id="image-node" data-src="https://mmbiz.qpic.cn/source-node.png"></p>',
    '<p><img data-mpse-image-id="neighbor-node" data-src="https://mmbiz.qpic.cn/neighbor-node.png"></p>'
  ].join('');
  let canonicalContent = baseline;
  const editor = {
    innerHTML: baseline,
    textContent: '',
    isConnected: true,
    querySelectorAll: (selector) => (selector === 'img' ? images : []),
    contains: (node) => images.includes(node),
    dispatchEvent(event) {
      if (event.type === 'paste') {
        original.isConnected = false;
        images = [replacement, neighbor];
        canonicalContent = [
          '<p><img data-src="https://mmbiz.qpic.cn/replacement-node.png"></p>',
          '<p><img data-mpse-image-id="neighbor-node" data-src="https://mmbiz.qpic.cn/neighbor-node.png"></p>'
        ].join('');
      }
      return true;
    },
    focus() {}
  };
  const harness = createPageHarness((payload) => {
    if (payload.apiName === 'mp_editor_get_isready') {
      payload.sucCb({ isReady: true, isNew: true });
    } else if (payload.apiName === 'mp_editor_set_selection') {
      payload.sucCb({});
    } else if (payload.apiName === 'mp_editor_get_content') {
      payload.sucCb({ content: canonicalContent });
    } else if (payload.apiName === 'mp_editor_set_content') {
      canonicalContent = payload.apiParam.content;
      payload.sucCb({});
    } else {
      throw new Error(`unexpected API ${payload.apiName}`);
    }
  }, {
    editor,
    File: FakeFile,
    DataTransfer: FakeDataTransfer,
    ClipboardEvent: FakeClipboardEvent
  });

  const response = await harness.request('PASTE_IMAGE', {
    bytes: new Uint8Array([137, 80, 78, 71]).buffer,
    mimeType: 'image/png',
    locator: {
      editId: 'image-node',
      sourceUrl: 'https://mmbiz.qpic.cn/source-node.png',
      index: 0
    }
  });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'MPSE_NATIVE_IMAGE_PASTE_UNSUPPORTED');
  assert.equal(replacement.isConnected, true);
  assert.equal(replacement.getAttribute('data-src'), 'https://mmbiz.qpic.cn/source-node.png');
  assert.equal(canonicalContent, baseline);
});

test('native paste waits for the candidate beside the target across a full editor rerender', async () => {
  const target = fakeImage({
    src: 'https://mmbiz.qpic.cn/target.png',
    'data-src': 'https://mmbiz.qpic.cn/target.png',
    'data-mpse-image-id': 'target-id'
  });
  const neighbor = fakeImage({
    src: 'https://mmbiz.qpic.cn/neighbor.png',
    'data-src': 'https://mmbiz.qpic.cn/neighbor.png',
    'data-mpse-image-id': 'neighbor-id'
  });
  const targetClone = fakeImage({
    src: 'https://mmbiz.qpic.cn/target.png',
    'data-src': 'https://mmbiz.qpic.cn/target.png',
    'data-mpse-image-id': 'target-id'
  });
  const neighborClone = fakeImage({
    src: 'https://mmbiz.qpic.cn/neighbor.png',
    'data-src': 'https://mmbiz.qpic.cn/neighbor.png',
    'data-mpse-image-id': 'neighbor-id'
  });
  const pasted = fakeImage({
    src: 'https://mmbiz.qpic.cn/pasted.png',
    'data-src': 'https://mmbiz.qpic.cn/pasted.png',
    'data-fileid': 'paste-file'
  });
  let images = [target, neighbor];
  let canonicalContent = [
    '<p><img data-mpse-image-id="target-id" data-src="https://mmbiz.qpic.cn/target.png"></p>',
    '<p><img data-mpse-image-id="neighbor-id" data-src="https://mmbiz.qpic.cn/neighbor.png"></p>'
  ].join('');
  const editor = {
    innerHTML: canonicalContent,
    textContent: '',
    isConnected: true,
    querySelectorAll: (selector) => (selector === 'img' ? images : []),
    contains: (node) => images.includes(node),
    dispatchEvent(event) {
      if (event.type === 'paste') images = [targetClone, neighborClone];
      return true;
    },
    focus() {}
  };
  const harness = createPageHarness((payload) => {
    if (payload.apiName === 'mp_editor_get_isready') {
      payload.sucCb({ isReady: true, isNew: true });
    } else if (payload.apiName === 'mp_editor_set_selection') {
      payload.sucCb({});
    } else if (payload.apiName === 'mp_editor_get_content') {
      payload.sucCb({ content: canonicalContent });
    } else if (payload.apiName === 'mp_editor_set_content') {
      canonicalContent = payload.apiParam.content;
      payload.sucCb({});
    } else {
      throw new Error(`unexpected API ${payload.apiName}`);
    }
  }, {
    editor,
    File: FakeFile,
    DataTransfer: FakeDataTransfer,
    ClipboardEvent: FakeClipboardEvent
  });

  const pending = harness.request('PASTE_IMAGE', {
    bytes: new Uint8Array([137, 80, 78, 71]).buffer,
    mimeType: 'image/png',
    locator: {
      editId: 'target-id',
      sourceUrl: 'https://mmbiz.qpic.cn/target.png',
      index: 0
    }
  });
  await nextTurn();

  images = [targetClone, pasted, neighborClone];
  canonicalContent = [
    '<p><img data-mpse-image-id="target-id" data-src="https://mmbiz.qpic.cn/target.png"></p>',
    '<p><img data-src="https://mmbiz.qpic.cn/pasted.png"></p>',
    '<p><img data-mpse-image-id="neighbor-id" data-src="https://mmbiz.qpic.cn/neighbor.png"></p>'
  ].join('');
  harness.runTimer(120);

  const response = await pending;
  assert.equal(response.ok, true, JSON.stringify(response.error));
  assert.equal(response.data.cdnUrl, 'https://mmbiz.qpic.cn/pasted.png');
  assert.notEqual(response.data.cdnUrl, 'https://mmbiz.qpic.cn/neighbor.png');
});

test('trusted input leaves a later unowned image untouched', async () => {
  const target = fakeImage({
    src: 'https://mmbiz.qpic.cn/source.png',
    'data-src': 'https://mmbiz.qpic.cn/source.png',
    'data-mpse-image-id': 'image-delayed'
  });
  const pasted = fakeImage({
    src: 'https://mmbiz.qpic.cn/delayed.png',
    'data-src': 'https://mmbiz.qpic.cn/delayed.png'
  });
  let images = [target];
  let canonicalContent = '<p><img data-mpse-image-id="image-delayed" data-src="https://mmbiz.qpic.cn/source.png"></p>';
  const editor = {
    innerHTML: canonicalContent,
    textContent: '',
    isConnected: true,
    querySelectorAll: (selector) => (selector === 'img' ? images : []),
    contains: (node) => images.includes(node),
    dispatchEvent() {
      return true;
    },
    focus() {}
  };
  const harness = createPageHarness((payload) => {
    if (payload.apiName === 'mp_editor_get_isready') {
      payload.sucCb({ isReady: true, isNew: true });
    } else if (payload.apiName === 'mp_editor_set_selection') {
      payload.sucCb({});
    } else if (payload.apiName === 'mp_editor_get_content') {
      payload.sucCb({ content: canonicalContent });
    } else if (payload.apiName === 'mp_editor_set_content') {
      canonicalContent = payload.apiParam.content;
      payload.sucCb({});
    } else {
      throw new Error(`unexpected API ${payload.apiName}`);
    }
  }, {
    editor,
    File: FakeFile,
    DataTransfer: FakeDataTransfer,
    ClipboardEvent: FakeClipboardEvent
  });

  const pending = harness.request('PASTE_IMAGE', {
    bytes: new Uint8Array([137, 80, 78, 71]).buffer,
    mimeType: 'image/png',
    locator: {
      editId: 'image-delayed',
      sourceUrl: 'https://mmbiz.qpic.cn/source.png',
      index: 0
    }
  });
  await nextTurn();

  harness.fireDocumentEvent('input', editor);
  images = [target, pasted];
  canonicalContent += '<p><img data-src="https://mmbiz.qpic.cn/delayed.png"></p>';
  harness.runTimer(120);

  const response = await pending;
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'MPSE_CONTENT_CONFLICT');
  assert.equal(response.error.pasteCandidate, undefined);
  assert.equal(pasted.isConnected, true);
  assert.deepEqual(images, [target, pasted]);
  assert.match(canonicalContent, /delayed\.png/);
});

test('native paste blocks editor input only until it owns a placeholder', async () => {
  const target = fakeImage({
    src: 'https://mmbiz.qpic.cn/source-lock.png',
    'data-src': 'https://mmbiz.qpic.cn/source-lock.png',
    'data-mpse-image-id': 'image-lock'
  });
  const pasted = fakeImage({
    src: 'https://mmbiz.qpic.cn/pasted-lock.png',
    'data-src': 'https://mmbiz.qpic.cn/pasted-lock.png'
  });
  const baseline = '<p><img data-mpse-image-id="image-lock" data-src="https://mmbiz.qpic.cn/source-lock.png"></p>';
  let images = [target];
  let canonicalContent = baseline;
  const editor = {
    innerHTML: canonicalContent,
    textContent: '',
    isConnected: true,
    querySelectorAll: (selector) => (selector === 'img' ? images : []),
    contains: (node) => images.includes(node),
    dispatchEvent() {
      return true;
    },
    focus() {}
  };
  const harness = createPageHarness((payload) => {
    if (payload.apiName === 'mp_editor_get_isready') {
      payload.sucCb({ isReady: true, isNew: true });
    } else if (payload.apiName === 'mp_editor_set_selection') {
      payload.sucCb({});
    } else if (payload.apiName === 'mp_editor_get_content') {
      payload.sucCb({ content: canonicalContent });
    } else if (payload.apiName === 'mp_editor_set_content') {
      canonicalContent = payload.apiParam.content;
      payload.sucCb({});
    } else {
      throw new Error(`unexpected API ${payload.apiName}`);
    }
  }, {
    editor,
    File: FakeFile,
    DataTransfer: FakeDataTransfer,
    ClipboardEvent: FakeClipboardEvent
  });

  const pending = harness.request('PASTE_IMAGE', {
    bytes: new Uint8Array([137, 80, 78, 71]).buffer,
    mimeType: 'image/png',
    locator: {
      editId: 'image-lock',
      sourceUrl: 'https://mmbiz.qpic.cn/source-lock.png',
      index: 0
    }
  });
  await nextTurn();

  const blocked = harness.fireDocumentEvent('beforeinput', editor, {
    inputType: 'insertText',
    data: 'x'
  });
  assert.equal(blocked.prevented, true);
  assert.equal(blocked.stopped, true);

  images = [target, pasted];
  canonicalContent += '<p><img data-src="https://mmbiz.qpic.cn/pasted-lock.png"></p>';
  harness.runTimer(120);

  const response = await pending;
  assert.equal(response.ok, true, JSON.stringify(response.error));
  assert.equal(response.data.cdnUrl, 'https://mmbiz.qpic.cn/pasted-lock.png');
  assert.equal((canonicalContent.match(/<img\b/g) || []).length, 2);
  assert.match(canonicalContent, /source-lock\.png/);
  assert.match(canonicalContent, /pasted-lock\.png/);
});

test('a queued SET invalidates an unresolved paste before writing new HTML', async () => {
  const target = fakeImage({
    src: 'https://mmbiz.qpic.cn/source-write.png',
    'data-src': 'https://mmbiz.qpic.cn/source-write.png',
    'data-mpse-image-id': 'image-write'
  });
  const baseline = '<p><img data-mpse-image-id="image-write" data-src="https://mmbiz.qpic.cn/source-write.png"></p>';
  const saved = '<p>saved after paste</p>';
  let canonicalContent = baseline;
  const editor = {
    innerHTML: canonicalContent,
    textContent: '',
    isConnected: true,
    querySelectorAll: (selector) => (selector === 'img' ? [target] : []),
    contains: (node) => node === target,
    dispatchEvent() {
      return true;
    },
    focus() {}
  };
  const harness = createPageHarness((payload) => {
    if (payload.apiName === 'mp_editor_get_isready') {
      payload.sucCb({ isReady: true, isNew: true });
    } else if (payload.apiName === 'mp_editor_set_selection') {
      payload.sucCb({});
    } else if (payload.apiName === 'mp_editor_get_content') {
      payload.sucCb({ content: canonicalContent });
    } else if (payload.apiName === 'mp_editor_set_content') {
      canonicalContent = payload.apiParam.content;
      payload.sucCb({});
    } else {
      throw new Error(`unexpected API ${payload.apiName}`);
    }
  }, {
    editor,
    File: FakeFile,
    DataTransfer: FakeDataTransfer,
    ClipboardEvent: FakeClipboardEvent
  });

  const pastePending = harness.request('PASTE_IMAGE', {
    bytes: new Uint8Array([137, 80, 78, 71]).buffer,
    mimeType: 'image/png',
    locator: {
      editId: 'image-write',
      sourceUrl: 'https://mmbiz.qpic.cn/source-write.png',
      index: 0
    }
  });
  await nextTurn();
  const setPending = harness.request('SET_CONTENT', {
    content: saved,
    expectedContent: baseline,
    expectedMode: 'mp-editor-jsapi',
    expectedArticleKey: 'path=/cgi-bin/appmsg'
  });
  harness.runTimer(120);

  const pasteResponse = await pastePending;
  const setResponse = await setPending;
  assert.equal(pasteResponse.ok, false);
  assert.equal(pasteResponse.error.code, 'MPSE_CONTENT_CONFLICT');
  assert.equal(setResponse.ok, true, JSON.stringify(setResponse.error));
  assert.equal(canonicalContent, saved);
});

test('a timed-out paste leaves a later user image untouched', async () => {
  let now = 0;
  class ControlledDate extends Date {
    static now() {
      return now;
    }
  }
  const target = fakeImage({
    src: 'https://mmbiz.qpic.cn/source-timeout.png',
    'data-src': 'https://mmbiz.qpic.cn/source-timeout.png',
    'data-mpse-image-id': 'image-timeout'
  });
  const userImage = fakeImage({
    src: 'https://mmbiz.qpic.cn/user-image.png',
    'data-src': 'https://mmbiz.qpic.cn/user-image.png'
  });
  let images = [target];
  let canonicalContent = '<p><img data-mpse-image-id="image-timeout" data-src="https://mmbiz.qpic.cn/source-timeout.png"></p>';
  const editor = {
    innerHTML: canonicalContent,
    textContent: '',
    isConnected: true,
    querySelectorAll: (selector) => (selector === 'img' ? images : []),
    contains: (node) => images.includes(node),
    dispatchEvent() {
      return true;
    },
    focus() {}
  };
  const harness = createPageHarness((payload) => {
    if (payload.apiName === 'mp_editor_get_isready') {
      payload.sucCb({ isReady: true, isNew: true });
    } else if (payload.apiName === 'mp_editor_set_selection') {
      payload.sucCb({});
    } else if (payload.apiName === 'mp_editor_get_content') {
      payload.sucCb({ content: canonicalContent });
    } else if (payload.apiName === 'mp_editor_set_content') {
      canonicalContent = payload.apiParam.content;
      payload.sucCb({});
    } else {
      throw new Error(`unexpected API ${payload.apiName}`);
    }
  }, {
    editor,
    File: FakeFile,
    DataTransfer: FakeDataTransfer,
    ClipboardEvent: FakeClipboardEvent,
    Date: ControlledDate
  });

  const pending = harness.request('PASTE_IMAGE', {
    bytes: new Uint8Array([137, 80, 78, 71]).buffer,
    mimeType: 'image/png',
    locator: {
      editId: 'image-timeout',
      sourceUrl: 'https://mmbiz.qpic.cn/source-timeout.png',
      index: 0
    }
  });
  await nextTurn();

  now = 6000;
  harness.runTimer(120);
  const response = await pending;
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'MPSE_NATIVE_IMAGE_PASTE_UNSUPPORTED');

  harness.fireDocumentEvent('input', editor);
  images = [target, userImage];
  canonicalContent += '<p><img data-src="https://mmbiz.qpic.cn/user-image.png"></p>';
  await nextTurn();

  assert.equal(userImage.isConnected, true);
  assert.equal(userImage.getAttribute('data-mpse-native-paste-id'), '');
  assert.deepEqual(images, [target, userImage]);
  assert.match(canonicalContent, /user-image\.png/);
});

test('native paste rejects invalid image payloads before touching the editor', async () => {
  const harness = createPageHarness(() => {
    throw new Error('editor API must not be reached');
  });
  const invalidMime = await harness.request('PASTE_IMAGE', {
    bytes: new Uint8Array([1]).buffer,
    mimeType: 'image/webp'
  });
  assert.equal(invalidMime.ok, false);
  assert.match(invalidMime.error.message, /PNG 或 JPEG/);

  const oversized = await harness.request('PASTE_IMAGE', {
    bytes: new ArrayBuffer((10 * 1024 * 1024) + 1),
    mimeType: 'image/png'
  });
  assert.equal(oversized.ok, false);
  assert.match(oversized.error.message, /10MB/);
});

test('discard removes a marked candidate even when the original target is already gone', async () => {
  let canonicalContent = [
    '<p><img data-mpse-native-paste-id="paste-orphan-1"',
    ' data-src="https://mmbiz.qpic.cn/orphan.png"></p>',
    '<p><img data-src="https://mmbiz.qpic.cn/neighbor.png"></p>'
  ].join('');
  let setContent = '';
  const editor = { innerHTML: canonicalContent, textContent: '', isConnected: true };
  const harness = createPageHarness((payload) => {
    if (payload.apiName === 'mp_editor_get_content') {
      payload.sucCb({ content: canonicalContent });
      return;
    }
    if (payload.apiName === 'mp_editor_set_content') {
      setContent = payload.apiParam.content;
      canonicalContent = setContent;
      payload.sucCb({});
      return;
    }
    throw new Error(`unexpected API ${payload.apiName}`);
  }, { editor });

  const response = await harness.request('DISCARD_PASTED_IMAGE', {
    pasteId: 'paste-orphan-1',
    cdnUrl: 'https://mmbiz.qpic.cn/orphan.png',
    expectedArticleKey: 'path=/cgi-bin/appmsg',
    locator: {
      editId: 'deleted-target',
      sourceUrl: 'https://mmbiz.qpic.cn/source.png',
      index: 0
    }
  });

  assert.equal(response.ok, true, JSON.stringify(response.error));
  assert.equal(response.data.changed, true);
  assert.equal(response.data.confirmedAbsent, true);
  assert.doesNotMatch(setContent, /orphan\.png|paste-orphan-1/);
  assert.match(setContent, /neighbor\.png/);
});

test('discard removes a marker-stripped adjacent duplicate after the target source changes', async () => {
  let canonicalContent = [
    '<p><img data-mpse-glow-on="1" style="width:70%"',
    ' data-src="https://mmbiz.qpic.cn/baked-shared.png?wx_fmt=png&amp;from=appmsg"></p>',
    '<p><img src="https://mmbiz.qpic.cn/baked-shared.png?wx_fmt=png&amp;tp=webp&amp;wxfrom=5"></p>'
  ].join('');
  let setContent = '';
  const editor = { innerHTML: canonicalContent, textContent: '', isConnected: true };
  const harness = createPageHarness((payload) => {
    if (payload.apiName === 'mp_editor_get_content') {
      payload.sucCb({ content: canonicalContent });
      return;
    }
    if (payload.apiName === 'mp_editor_set_content') {
      setContent = payload.apiParam.content;
      canonicalContent = setContent;
      payload.sucCb({});
      return;
    }
    throw new Error(`unexpected API ${payload.apiName}`);
  }, { editor });

  const response = await harness.request('DISCARD_PASTED_IMAGE', {
    pasteId: 'stripped-after-candidate',
    cdnUrl: 'https://mmbiz.qpic.cn/baked-shared.png?wx_fmt=png&from=appmsg',
    placement: 'after',
    expectedArticleKey: 'path=/cgi-bin/appmsg',
    locator: {
      editId: 'sanitized-image-id',
      sourceUrl: 'https://mmbiz.qpic.cn/source-before-bake.png',
      index: 0
    }
  });

  assert.equal(response.ok, true, JSON.stringify(response.error));
  assert.equal(response.data.changed, true);
  assert.equal((setContent.match(/<img\b/g) || []).length, 1);
  assert.match(setContent, /data-mpse-glow-on="1"/);
  assert.match(setContent, /style="width:70%"/);
  assert.doesNotMatch(setContent, /tp=webp|wxfrom=5/);
});

test('discard removes a late duplicate from live DOM even before the canonical model receives it', async () => {
  const bakedUrl = 'https://mmbiz.qpic.cn/live-only.png?wx_fmt=png&from=appmsg';
  const target = fakeImage({
    'data-src': bakedUrl,
    'data-mpse-shadow-on': '1',
    style: 'width:66%'
  });
  const duplicate = fakeImage({
    src: 'https://mmbiz.qpic.cn/live-only.png?wx_fmt=png&tp=webp&wxfrom=5'
  });
  const liveImages = [target, duplicate];
  const canonicalContent = [
    '<p><img data-mpse-shadow-on="1" style="width:66%"',
    ` data-src="${bakedUrl.replaceAll('&', '&amp;')}"></p>`
  ].join('');
  let setCalls = 0;
  const editor = {
    innerHTML: canonicalContent,
    textContent: '',
    isConnected: true,
    querySelectorAll(selector) {
      return selector === 'img' ? liveImages.filter((image) => image.isConnected !== false) : [];
    },
    dispatchEvent() {
      return true;
    }
  };
  const harness = createPageHarness((payload) => {
    if (payload.apiName === 'mp_editor_get_content') {
      payload.sucCb({ content: canonicalContent });
      return;
    }
    if (payload.apiName === 'mp_editor_set_content') {
      setCalls += 1;
      payload.sucCb({});
      return;
    }
    throw new Error(`unexpected API ${payload.apiName}`);
  }, { editor });

  const response = await harness.request('DISCARD_PASTED_IMAGE', {
    pasteId: 'live-only-duplicate',
    cdnUrl: bakedUrl,
    placement: 'after',
    expectedArticleKey: 'path=/cgi-bin/appmsg',
    locator: {
      editId: 'sanitized-live-id',
      sourceUrl: 'https://mmbiz.qpic.cn/live-source.png',
      index: 0
    }
  });

  assert.equal(response.ok, true, JSON.stringify(response.error));
  assert.equal(response.data.changed, true);
  assert.equal(duplicate.isConnected, false);
  assert.equal(target.isConnected, true);
  assert.equal(target.getAttribute('data-mpse-shadow-on'), '1');
  assert.equal(target.getAttribute('style'), 'width:66%');
  assert.equal(setCalls, 0);
});

test('discard restores a marked replacement instead of deleting the only image', async () => {
  let canonicalContent = [
    '<p><img data-mpse-native-paste-id="replace-cleanup-1"',
    ' data-mpse-paste-for="image-1"',
    ' src="https://mmbiz.qpic.cn/replacement.png"',
    ' data-src="https://mmbiz.qpic.cn/replacement.png"',
    ' data-fileid="replacement-file" data-w="900"></p>'
  ].join('');
  let setContent = '';
  const editor = { innerHTML: canonicalContent, textContent: '', isConnected: true };
  const harness = createPageHarness((payload) => {
    if (payload.apiName === 'mp_editor_get_content') {
      payload.sucCb({ content: canonicalContent });
      return;
    }
    if (payload.apiName === 'mp_editor_set_content') {
      setContent = payload.apiParam.content;
      canonicalContent = setContent;
      payload.sucCb({});
      return;
    }
    throw new Error(`unexpected API ${payload.apiName}`);
  }, { editor });

  const response = await harness.request('DISCARD_PASTED_IMAGE', {
    pasteId: 'replace-cleanup-1',
    cdnUrl: 'https://mmbiz.qpic.cn/replacement.png',
    placement: 'replace',
    originalAttributes: {
      src: 'https://assets.example.com/source.png',
      'data-src': 'https://assets.example.com/source.png',
      'data-fileid': 'source-file',
      'data-w': '640',
      'data-ratio': '0.75',
      'data-type': 'jpeg'
    },
    expectedArticleKey: 'path=/cgi-bin/appmsg',
    locator: {
      editId: 'image-1',
      sourceUrl: 'https://assets.example.com/source.png',
      index: 0
    }
  });

  assert.equal(response.ok, true, JSON.stringify(response.error));
  assert.deepEqual(JSON.parse(JSON.stringify(response.data)), {
    changed: true,
    confirmedAbsent: true
  });
  assert.equal((setContent.match(/<img\b/g) || []).length, 1);
  assert.match(setContent, /src="https:\/\/assets\.example\.com\/source\.png"/);
  assert.match(setContent, /data-src="https:\/\/assets\.example\.com\/source\.png"/);
  assert.match(setContent, /data-fileid="source-file"/);
  assert.match(setContent, /data-w="640"/);
  assert.doesNotMatch(setContent, /replacement\.png|replacement-file|data-mpse-native-paste-id|data-mpse-paste-for/);
});

test('discard restores a marker-stripped replacement by exact index and CDN', async () => {
  let canonicalContent = [
    '<p><img src="https://mmbiz.qpic.cn/replacement-stripped.png"',
    ' data-src="https://mmbiz.qpic.cn/replacement-stripped.png"',
    ' data-fileid="replacement-file"></p>',
    '<p><img data-src="https://mmbiz.qpic.cn/neighbor.png"></p>'
  ].join('');
  let setContent = '';
  const editor = { innerHTML: canonicalContent, textContent: '', isConnected: true };
  const harness = createPageHarness((payload) => {
    if (payload.apiName === 'mp_editor_get_content') {
      payload.sucCb({ content: canonicalContent });
      return;
    }
    if (payload.apiName === 'mp_editor_set_content') {
      setContent = payload.apiParam.content;
      canonicalContent = setContent;
      payload.sucCb({});
      return;
    }
    throw new Error(`unexpected API ${payload.apiName}`);
  }, { editor });

  const response = await harness.request('DISCARD_PASTED_IMAGE', {
    pasteId: 'stripped-replace-cleanup',
    cdnUrl: 'https://mmbiz.qpic.cn/replacement-stripped.png',
    placement: 'replace',
    originalAttributes: {
      src: 'https://mmbiz.qpic.cn/source-stripped.png',
      'data-src': 'https://mmbiz.qpic.cn/source-stripped.png',
      'data-fileid': 'source-file'
    },
    expectedArticleKey: 'path=/cgi-bin/appmsg',
    locator: {
      editId: 'stripped-image',
      sourceUrl: 'https://mmbiz.qpic.cn/source-stripped.png',
      index: 0
    }
  });

  assert.equal(response.ok, true, JSON.stringify(response.error));
  assert.equal(response.data.changed, true);
  assert.equal(response.data.confirmedAbsent, true);
  assert.equal((setContent.match(/<img\b/g) || []).length, 2);
  assert.match(setContent, /source-stripped\.png/);
  assert.match(setContent, /source-file/);
  assert.match(setContent, /neighbor\.png/);
  assert.doesNotMatch(setContent, /replacement-stripped\.png|replacement-file/);
});

test('replacement cleanup fails closed when original native attributes are invalid', async () => {
  const canonicalContent = [
    '<p><img data-mpse-native-paste-id="replace-cleanup-invalid"',
    ' data-src="https://mmbiz.qpic.cn/replacement-invalid.png"></p>'
  ].join('');
  let setCalls = 0;
  const editor = { innerHTML: canonicalContent, textContent: '', isConnected: true };
  const harness = createPageHarness((payload) => {
    if (payload.apiName === 'mp_editor_get_content') {
      payload.sucCb({ content: canonicalContent });
      return;
    }
    if (payload.apiName === 'mp_editor_set_content') {
      setCalls += 1;
      payload.sucCb({});
      return;
    }
    throw new Error(`unexpected API ${payload.apiName}`);
  }, { editor });

  const response = await harness.request('DISCARD_PASTED_IMAGE', {
    pasteId: 'replace-cleanup-invalid',
    cdnUrl: 'https://mmbiz.qpic.cn/replacement-invalid.png',
    placement: 'replace',
    originalAttributes: {
      src: 'javascript:alert(1)'
    },
    expectedArticleKey: 'path=/cgi-bin/appmsg',
    locator: {
      sourceUrl: 'https://mmbiz.qpic.cn/source-invalid.png',
      index: 0
    }
  });

  assert.equal(response.ok, true);
  assert.equal(response.data.changed, false);
  assert.equal(response.data.confirmedAbsent, false);
  assert.equal(response.data.cleanupScheduled, true);
  assert.equal(setCalls, 0);
  assert.ok([...harness.timers.values()].some((timer) => timer.delay === 1000));
});

test('ambiguous cleanup is retained by the page bridge retry owner', async () => {
  const canonicalContent = '<p><img data-src="https://mmbiz.qpic.cn/orphan.png"></p>';
  const editor = { innerHTML: canonicalContent, textContent: '', isConnected: true };
  const harness = createPageHarness((payload) => {
    assert.equal(payload.apiName, 'mp_editor_get_content');
    payload.sucCb({ content: canonicalContent });
  }, { editor });

  const response = await harness.request('DISCARD_PASTED_IMAGE', {
    pasteId: 'marker-was-stripped',
    cdnUrl: 'https://mmbiz.qpic.cn/orphan.png',
    expectedArticleKey: 'path=/cgi-bin/appmsg',
    locator: {
      editId: 'deleted-target',
      sourceUrl: 'https://mmbiz.qpic.cn/source.png',
      index: 0
    }
  });

  assert.equal(response.ok, true);
  assert.equal(response.data.changed, false);
  assert.equal(response.data.confirmedAbsent, false);
  assert.equal(response.data.cleanupScheduled, true);
  assert.ok([...harness.timers.values()].some((timer) => timer.delay === 1000));
});

test('the page bridge no longer calls the private image upload endpoint', () => {
  assert.doesNotMatch(source, /\/cgi-bin\/filetransfer|ticket_id|writetype|scene:\s*['"]8['"]/);
  assert.match(source, /mp_editor_set_selection/);
  assert.match(source, /selectAfter:\s*true/);
  assert.match(source, /range\.setStartAfter\(image\)/);
  assert.match(source, /new view\.ClipboardEvent\('paste'/);
  assert.match(source, /channel:\s*'editor-paste'/);
  assert.match(
    source,
    /discardPastedImage\(entry\.payload\),\s*\{ invalidateRevision: false \}/,
    'maintenance cleanup must not invalidate a newer paste revision'
  );
  assert.match(source, /let editorWriteRevision = 0/);
  assert.match(source, /\+\+editorWriteRevision/);
  assert.match(source, /editorInputEpoch !== epoch[\s\S]*?context\.revision !== editorWriteRevision/);
});
