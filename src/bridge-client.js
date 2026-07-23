(() => {
  'use strict';

  const VERSION = 'v0.12.0';
  const CONTENT_SOURCE = 'wechat-mp-source-layout:content';
  const PAGE_SOURCE = 'wechat-mp-source-layout:page';
  const CONTENT_CONFLICT_CODE = 'MPSE_CONTENT_CONFLICT';
  const MAX_CONTENT_CONFLICT_RETRIES = 2;
  const BRIDGE_READY_TIMEOUT_MS = 5000;

  if (window.__MPSE_BRIDGE_CLIENT__
    && window.__MPSE_BRIDGE_CLIENT__.version === VERSION
    && typeof window.__MPSE_BRIDGE_CLIENT__.mutateContent === 'function'
    && typeof window.__MPSE_BRIDGE_CLIENT__.pasteImage === 'function'
    && typeof window.__MPSE_BRIDGE_CLIENT__.discardPastedImage === 'function') return;

  function getExtensionResourceUrl(path) {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id || typeof chrome.runtime.getURL !== 'function') return '';
      const url = chrome.runtime.getURL(path);
      if (!url || /chrome-extension:\/\/invalid\/?/i.test(url)) return '';
      return url;
    } catch (_) {
      return '';
    }
  }

  function injectBridge() {
    if (document.documentElement.dataset.mpseBridgeInjected === '1') return true;

    const bridgeUrl = getExtensionResourceUrl('src/page-bridge.js');
    if (!bridgeUrl) return false;

    document.documentElement.dataset.mpseBridgeInjected = '1';
    const script = document.createElement('script');
    script.src = bridgeUrl;
    script.async = false;
    script.dataset.mpse = 'page-bridge';
    script.onload = () => script.remove();
    script.onerror = () => {
      delete document.documentElement.dataset.mpseBridgeInjected;
      script.remove();
    };
    (document.head || document.documentElement).appendChild(script);
    return true;
  }

  let bridgeReady = false;
  let bridgeReadyPromise = null;

  function waitForBridgeReady() {
    if (bridgeReady) return Promise.resolve();
    if (bridgeReadyPromise) return bridgeReadyPromise;

    bridgeReadyPromise = new Promise((resolve, reject) => {
      const probeId = `bridge-ready-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      let probeTimer = 0;
      const timeout = window.setTimeout(() => {
        cleanup();
        bridgeReadyPromise = null;
        reject(new Error('扩展桥接脚本未就绪，请刷新页面后重试'));
      }, BRIDGE_READY_TIMEOUT_MS);

      function cleanup() {
        window.clearTimeout(timeout);
        if (probeTimer) window.clearTimeout(probeTimer);
        window.removeEventListener('message', onMessage);
      }

      function finish() {
        if (bridgeReady) return;
        bridgeReady = true;
        cleanup();
        resolve();
      }

      function onMessage(event) {
        if (event.source !== window) return;
        const message = event.data;
        if (!message || message.source !== PAGE_SOURCE) return;
        if (message.type === 'BRIDGE_READY' || (message.requestId === probeId && message.ok)) finish();
      }

      function probe() {
        if (bridgeReady) return;
        window.postMessage({
          source: CONTENT_SOURCE,
          requestId: probeId,
          type: 'PING',
          payload: {}
        }, '*');
        probeTimer = window.setTimeout(probe, 160);
      }

      window.addEventListener('message', onMessage);
      if (!injectBridge()) {
        cleanup();
        bridgeReadyPromise = null;
        reject(new Error('扩展桥接脚本不可用，请刷新页面后重试'));
        return;
      }
      probe();
    });

    return bridgeReadyPromise;
  }

  function dispatchBridgeRequest(type, payload = {}, timeoutMs = 15000) {
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? window.setTimeout(() => {
        cleanup();
        reject(new Error(`请求 ${type} 超时`));
      }, timeoutMs) : 0;

      function cleanup() {
        if (timer) window.clearTimeout(timer);
        window.removeEventListener('message', onMessage);
      }

      function onMessage(event) {
        if (event.source !== window) return;
        const message = event.data;
        if (!message || message.source !== PAGE_SOURCE || message.requestId !== requestId) return;

        cleanup();
        if (message.ok) {
          resolve(message.data || {});
          return;
        }

        const errorMessage = message.error && message.error.message ? message.error.message : '页面桥接脚本返回错误';
        const error = new Error(errorMessage);
        error.detail = message.error || null;
        error.code = message.error && message.error.code ? message.error.code : '';
        reject(error);
      }

      window.addEventListener('message', onMessage);
      window.postMessage({ source: CONTENT_SOURCE, requestId, type, payload }, '*');
    });
  }

  async function requestBridge(type, payload = {}, timeoutMs = 15000) {
    await waitForBridgeReady();
    return dispatchBridgeRequest(type, payload, timeoutMs);
  }

  let contentOperationQueue = Promise.resolve();

  function enqueueContentOperation(operation) {
    const scheduled = contentOperationQueue.then(operation, operation);
    contentOperationQueue = scheduled.then(() => undefined, () => undefined);
    return scheduled;
  }

  function readContent(timeoutMs = 15000) {
    return enqueueContentOperation(() => requestBridge('GET_CONTENT', {}, timeoutMs));
  }

  function writeContent(content) {
    const html = typeof content === 'string' ? content : '';
    return enqueueContentOperation(() => requestBridge('SET_CONTENT', { content: html }, 0));
  }

  function normalizeMutationResult(result, currentContent) {
    if (result == null || (typeof result === 'object' && result.changed === false)) {
      return { changed: false, content: currentContent, value: result };
    }
    if (typeof result === 'string') {
      return { changed: result !== currentContent, content: result, value: result };
    }
    if (typeof result === 'object') {
      const content = typeof result.content === 'string'
        ? result.content
        : (typeof result.html === 'string' ? result.html : null);
      if (content === null) throw new TypeError('Content mutation result must include content');
      return { changed: content !== currentContent, content, value: result };
    }
    throw new TypeError('Content mutator must return a string or an object containing content');
  }

  function isContentConflict(error) {
    return Boolean(error && (error.code === CONTENT_CONFLICT_CODE || error.detail?.code === CONTENT_CONFLICT_CODE));
  }

  function mutateContent(mutator, timeoutMs = 15000) {
    if (typeof mutator !== 'function') return Promise.reject(new TypeError('Content mutator must be a function'));
    return enqueueContentOperation(async () => {
      let conflictRetries = 0;
      while (true) {
        const read = await requestBridge('GET_CONTENT', {}, timeoutMs);
        const currentContent = typeof read.content === 'string' ? read.content : '';
        const mutation = normalizeMutationResult(await mutator(read), currentContent);
        if (!mutation.changed) {
          return { changed: false, content: currentContent, read, write: null, value: mutation.value, conflictRetries };
        }

        try {
          const write = await requestBridge('SET_CONTENT', {
            content: mutation.content,
            expectedContent: currentContent,
            expectedMode: read.mode || '',
            expectedArticleKey: read.articleKey || ''
          }, 0);
          return { changed: true, content: mutation.content, read, write, value: mutation.value, conflictRetries };
        } catch (error) {
          if (!isContentConflict(error) || conflictRetries >= MAX_CONTENT_CONFLICT_RETRIES) throw error;
          conflictRetries += 1;
        }
      }
    });
  }

  function pasteImage(blob, filename = 'mpse-image.png', locator = {}) {
    if (!(blob instanceof Blob) || !blob.size) return Promise.reject(new TypeError('Image blob is required'));
    return enqueueContentOperation(async () => {
      const bytes = await blob.arrayBuffer();
      return requestBridge('PASTE_IMAGE', {
        bytes,
        mimeType: blob.type || 'image/png',
        filename,
        locator: {
          editId: String(locator.editId || ''),
          sourceUrl: String(locator.sourceUrl || ''),
          index: Number.isInteger(locator.index) ? locator.index : -1
        }
      }, 0);
    });
  }

  function discardPastedImage(candidate, locator = {}) {
    const pasteId = String(candidate?.pasteId || '');
    const cdnUrl = String(candidate?.cdnUrl || '');
    const expectedArticleKey = String(candidate?.articleKey || '');
    const placement = candidate?.placement === 'replace' ? 'replace' : 'after';
    const originalAttributes = candidate?.originalAttributes && typeof candidate.originalAttributes === 'object'
      ? { ...candidate.originalAttributes }
      : {};
    if (!pasteId && !cdnUrl) return Promise.resolve({ changed: false });
    return enqueueContentOperation(() => requestBridge('DISCARD_PASTED_IMAGE', {
      pasteId,
      cdnUrl,
      expectedArticleKey,
      placement,
      originalAttributes,
      locator: {
        editId: String(locator.editId || ''),
        sourceUrl: String(locator.sourceUrl || ''),
        index: Number.isInteger(locator.index) ? locator.index : -1
      }
    }, 0));
  }

  window.__MPSE_BRIDGE_CLIENT__ = Object.freeze({
    version: VERSION,
    inject: injectBridge,
    request: requestBridge,
    readContent,
    writeContent,
    mutateContent,
    pasteImage,
    discardPastedImage,
    getResourceUrl: getExtensionResourceUrl
  });
})();
