(() => {
  'use strict';

  const VERSION = 'v0.9.6';
  const CONTENT_SOURCE = 'wechat-mp-source-layout:content';
  const PAGE_SOURCE = 'wechat-mp-source-layout:page';

  if (window.__MPSE_BRIDGE_CLIENT__ && window.__MPSE_BRIDGE_CLIENT__.version === VERSION) return;

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

  function requestBridge(type, payload = {}, timeoutMs = 15000) {
    if (!injectBridge()) return Promise.reject(new Error('扩展桥接脚本不可用，请刷新页面后重试'));
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new Error(`请求 ${type} 超时`));
      }, timeoutMs);

      function cleanup() {
        window.clearTimeout(timer);
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
        reject(error);
      }

      window.addEventListener('message', onMessage);
      window.postMessage({ source: CONTENT_SOURCE, requestId, type, payload }, '*');
    });
  }

  window.__MPSE_BRIDGE_CLIENT__ = Object.freeze({
    version: VERSION,
    inject: injectBridge,
    request: requestBridge,
    getResourceUrl: getExtensionResourceUrl
  });
})();
