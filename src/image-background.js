(() => {
  'use strict';

  importScripts('image-source.js');
  const imageSource = globalThis.__MPSE_IMAGE_SOURCE__;
  const MAX_SOURCE_BYTES = imageSource.MAX_SOURCE_BYTES;

  function asError(error) {
    return {
      message: error && error.message ? error.message : String(error || '图片读取失败'),
      code: error && error.code ? String(error.code) : 'MPSE_IMAGE_FETCH_FAILED'
    };
  }

  function validateUrl(value) {
    let url;
    try {
      url = new URL(String(value || ''));
    } catch (_) {
      const error = new Error('图片地址无效');
      error.code = 'MPSE_IMAGE_URL_INVALID';
      throw error;
    }
    if (url.protocol !== 'https:' || url.username || url.password) {
      const error = new Error('图片地址必须使用 HTTPS');
      error.code = 'MPSE_IMAGE_URL_NOT_ALLOWED';
      throw error;
    }
    return url.href;
  }

  function isTrustedSender(sender) {
    try {
      return new URL(String(sender?.url || sender?.origin || '')).origin === 'https://mp.weixin.qq.com';
    } catch (_) {
      return false;
    }
  }

  async function fetchImage(url) {
    const response = await fetch(validateUrl(url), {
      method: 'GET',
      credentials: 'omit',
      cache: 'force-cache',
      redirect: 'follow'
    });
    if (!response.ok) {
      const error = new Error(`微信素材读取失败（HTTP ${response.status}）`);
      error.code = 'MPSE_IMAGE_FETCH_HTTP';
      throw error;
    }
    validateUrl(response.url);
    const contentLength = Number(response.headers.get('content-length')) || 0;
    if (contentLength > MAX_SOURCE_BYTES) {
      const error = new Error('原图超过 16MB，无法进行像素烘焙');
      error.code = 'MPSE_IMAGE_SOURCE_TOO_LARGE';
      throw error;
    }
    const buffer = await response.arrayBuffer();
    const source = imageSource.validateBytes(buffer);
    return {
      dataUrl: imageSource.dataUrl(source),
      mimeType: source.mimeType,
      size: source.size
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== 'MPSE_FETCH_IMAGE') return false;
    if (!isTrustedSender(sender)) {
      sendResponse({
        ok: false,
        error: {
          message: '图片读取请求来源无效',
          code: 'MPSE_IMAGE_SENDER_NOT_ALLOWED'
        }
      });
      return false;
    }
    fetchImage(message.url).then(
      (result) => sendResponse({ ok: true, result }),
      (error) => sendResponse({ ok: false, error: asError(error) })
    );
    return true;
  });
})();
