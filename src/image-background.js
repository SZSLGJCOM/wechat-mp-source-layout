(() => {
  'use strict';

  const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
  const ALLOWED_IMAGE_HOSTS = new Set([
    'mmbiz.qpic.cn',
    'mmbiz.qlogo.cn',
    'm.qpic.cn',
    'mmsns.qpic.cn'
  ]);
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
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || !ALLOWED_IMAGE_HOSTS.has(url.hostname)) {
      const error = new Error('只允许读取微信图片域名中的素材');
      error.code = 'MPSE_IMAGE_HOST_NOT_ALLOWED';
      throw error;
    }
    return url.href;
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

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== 'MPSE_FETCH_IMAGE') return false;
    fetchImage(message.url).then(
      (result) => sendResponse({ ok: true, result }),
      (error) => sendResponse({ ok: false, error: asError(error) })
    );
    return true;
  });
})();
