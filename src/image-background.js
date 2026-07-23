(() => {
  'use strict';

  const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
  const ALLOWED_IMAGE_TYPES = new Set([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/avif',
    'image/bmp'
  ]);

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

  function bytesToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunks = [];
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
    }
    return btoa(chunks.join(''));
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
    const blob = await response.blob();
    const mimeType = String(blob.type || '').toLowerCase().split(';')[0];
    if (!ALLOWED_IMAGE_TYPES.has(mimeType)) {
      const error = new Error('素材地址没有返回有效图片');
      error.code = 'MPSE_IMAGE_INVALID_MIME';
      throw error;
    }
    if (blob.size > MAX_SOURCE_BYTES) {
      const error = new Error('原图超过 16MB，无法进行像素烘焙');
      error.code = 'MPSE_IMAGE_SOURCE_TOO_LARGE';
      throw error;
    }
    const buffer = await blob.arrayBuffer();
    return {
      dataUrl: `data:${mimeType};base64,${bytesToBase64(buffer)}`,
      mimeType,
      size: blob.size
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
