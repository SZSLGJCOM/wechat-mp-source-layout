(() => {
  'use strict';

  const MAX_SOURCE_BYTES = 16 * 1024 * 1024;

  function sourceError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function ascii(bytes, start, length) {
    let value = '';
    for (let index = start; index < Math.min(bytes.length, start + length); index += 1) {
      value += String.fromCharCode(bytes[index]);
    }
    return value;
  }

  function detectedMimeType(buffer) {
    const bytes = new Uint8Array(buffer);
    if (
      bytes.length >= 8
      && bytes[0] === 0x89
      && ascii(bytes, 1, 3) === 'PNG'
      && bytes[4] === 0x0d
      && bytes[5] === 0x0a
      && bytes[6] === 0x1a
      && bytes[7] === 0x0a
    ) return 'image/png';
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return 'image/jpeg';
    }
    if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6))) {
      return 'image/gif';
    }
    if (
      bytes.length >= 12
      && ascii(bytes, 0, 4) === 'RIFF'
      && ascii(bytes, 8, 4) === 'WEBP'
    ) return 'image/webp';
    if (bytes.length >= 2 && ascii(bytes, 0, 2) === 'BM') return 'image/bmp';
    if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') {
      const brands = ascii(bytes, 8, Math.min(bytes.length - 8, 56));
      if (brands.includes('avif') || brands.includes('avis')) return 'image/avif';
    }
    return '';
  }

  function validateBytes(buffer) {
    if (!(buffer instanceof ArrayBuffer) || !buffer.byteLength) {
      throw sourceError('原图没有返回有效字节', 'MPSE_IMAGE_EMPTY');
    }
    if (buffer.byteLength > MAX_SOURCE_BYTES) {
      throw sourceError('原图超过 16MB，无法进行像素烘焙', 'MPSE_IMAGE_SOURCE_TOO_LARGE');
    }
    const mimeType = detectedMimeType(buffer);
    if (!mimeType) {
      throw sourceError(
        '素材响应不是可解码的 PNG、JPEG、GIF、WebP、AVIF 或 BMP 图片',
        'MPSE_IMAGE_INVALID_BYTES'
      );
    }
    return { buffer, mimeType, size: buffer.byteLength };
  }

  function dataUrl(source) {
    const bytes = new Uint8Array(source.buffer);
    const chunks = [];
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
    }
    return `data:${source.mimeType};base64,${btoa(chunks.join(''))}`;
  }

  globalThis.__MPSE_IMAGE_SOURCE__ = Object.freeze({
    MAX_SOURCE_BYTES,
    detectedMimeType,
    validateBytes,
    dataUrl
  });
})();
