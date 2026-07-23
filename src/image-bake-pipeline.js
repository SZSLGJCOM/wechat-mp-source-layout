(() => {
  'use strict';

  const SOURCE_ATTRIBUTES = Object.freeze([
    'src',
    'data-src',
    'data-backsrc',
    'data-croporisrc',
    'data-fileid',
    'data-mediaid',
    'data-w',
    'data-ratio'
  ]);
  const URL_SOURCE_ATTRIBUTES = new Set([
    'src',
    'data-src',
    'data-backsrc',
    'data-croporisrc'
  ]);
  const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
  const BAKE_DELAY_MS = 680;
  const ALLOWED_SOURCE_TYPES = new Set([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/avif',
    'image/bmp'
  ]);
  const WECHAT_IMAGE_HOSTS = new Set([
    'mmbiz.qpic.cn',
    'mmbiz.qlogo.cn',
    'm.qpic.cn',
    'mmsns.qpic.cn'
  ]);
  const ADVANCED_DATA_KEYS = Object.freeze([
    'mpseGlowOn', 'mpseGlowBlur', 'mpseGlowSpread', 'mpseGlowOpacity', 'mpseGlowColor',
    'mpseBrightness', 'mpseContrast', 'mpseSaturate', 'mpseGray', 'mpseColorOn',
    'mpseShadowOn', 'mpseShadowX', 'mpseShadowY', 'mpseShadowBlur', 'mpseShadowSpread',
    'mpseShadowOpacity', 'mpseShadowColor', 'mpseBaseBoxShadow',
    'mpseFilterBase', 'mpseColorBase',
    'mpseFeatherOn', 'mpseFeatherAmount', 'mpseFeatherBase',
    'mpseStrokeOn', 'mpseStrokeWidth', 'mpseStrokeColor', 'mpseStrokeOpacity', 'mpseStrokeBase',
    'mpseBaked'
  ]);

  function completeSourceAttributes(attributes, sourceUrl) {
    const completed = { ...(attributes || {}) };
    const source = String(sourceUrl || '').trim();
    if (source) {
      completed.src = source;
      completed['data-src'] = source;
    }
    return completed;
  }

  function create(dependencies) {
    const {
      state,
      records,
      bridgeClient,
      bakeEngine,
      getAttr,
      stableUrl,
      imageSignature,
      ensureImageEditId,
      managedDataFromImage,
      getCropContainer,
      markChanged,
      setBadgeText,
      finishAdvancedBake,
      schedulePositionTools
    } = dependencies;
    const jobs = new Map();
    const imageSources = new WeakMap();

    function sourceAttributes(image) {
      return SOURCE_ATTRIBUTES.reduce((attributes, name) => {
        if (image?.hasAttribute?.(name)) attributes[name] = getAttr(image, name);
        return attributes;
      }, {});
    }

    function preferredSource(attributes) {
      return stableUrl(
        attributes['data-croporisrc']
        || attributes['data-src']
        || attributes.src
        || attributes['data-backsrc']
        || ''
      );
    }

    function absoluteSourceUrl(value) {
      const raw = String(value || '').trim();
      if (raw.startsWith('//')) return `https:${raw}`;
      if (/^(?:data:image\/|blob:)/i.test(raw)) return raw;
      try {
        const hostPrefixed = [...WECHAT_IMAGE_HOSTS].some((host) => raw.toLowerCase().startsWith(`${host}/`));
        const url = new URL(hostPrefixed ? `https://${raw}` : raw, location.href);
        if (url.protocol === 'http:' && WECHAT_IMAGE_HOSTS.has(url.hostname)) url.protocol = 'https:';
        return url.href;
      } catch (_) {
        return '';
      }
    }

    function applySourceAttributes(image, attributes, sourceUrl = '') {
      const completed = completeSourceAttributes(attributes, sourceUrl || preferredSource(attributes));
      if (!preferredSource(completed)) return false;
      for (const name of SOURCE_ATTRIBUTES) {
        if (Object.prototype.hasOwnProperty.call(completed, name) && completed[name]) {
          image.setAttribute(name, completed[name]);
        } else if (!URL_SOURCE_ATTRIBUTES.has(name)) {
          image.removeAttribute(name);
        }
      }
      return true;
    }

    function applyPreviewSource(image, metadata) {
      if (!metadata?.sourceAttributes) return;
      const sourceUrl = absoluteSourceUrl(metadata.sourceUrl);
      if (!sourceUrl || !applySourceAttributes(image, metadata.sourceAttributes, sourceUrl)) return;
      image.dataset.mpseBaked = '0';
    }

    function jobKey(image) {
      return ensureImageEditId(image);
    }

    function cancel(image) {
      const key = image && getAttr(image, 'data-mpse-image-id');
      if (!key) return;
      const job = jobs.get(key);
      if (job?.timer) window.clearTimeout(job.timer);
      jobs.delete(key);
    }

    function metadataFor(image) {
      const cached = imageSources.get(image);
      if (cached) return cached;
      const identity = imageSignature(image);
      const record = records.find(identity);
      const currentAttributes = sourceAttributes(image);
      const storedAttributes = record?.asset?.sourceAttributes || {};
      const attributes = preferredSource(storedAttributes) ? storedAttributes : currentAttributes;
      const runtimeSource = stableUrl(image?.currentSrc || image?.src || '');
      const sourceUrl = record?.asset?.sourceUrl
        || preferredSource(attributes)
        || preferredSource(currentAttributes)
        || runtimeSource;
      const completedSourceAttributes = completeSourceAttributes(attributes, sourceUrl);
      const bakedUrl = record?.asset?.bakedUrl || '';
      const currentUrl = stableUrl(currentAttributes['data-src'] || currentAttributes.src);
      const metadata = {
        locatorIdentity: identity,
        sourceUrl,
        sourceAttributes: completedSourceAttributes,
        bakedUrl,
        bakedAttributes: bakedUrl && currentUrl === stableUrl(bakedUrl)
          ? completeSourceAttributes(currentAttributes, bakedUrl)
          : null,
        committedData: record?.data || managedDataFromImage(image)
      };
      imageSources.set(image, metadata);
      if (sourceUrl) {
        records.rememberAsset(identity, {
          ...(record?.asset || {}),
          sourceUrl,
          bakedUrl: metadata.bakedUrl,
          sourceAttributes: completedSourceAttributes
        });
      }
      return metadata;
    }

    function preparePreview(image) {
      if (!image?.isConnected) return null;
      jobKey(image);
      const metadata = metadataFor(image);
      const current = stableUrl(getAttr(image, 'data-src') || getAttr(image, 'src'));
      const baked = stableUrl(metadata.bakedUrl);
      if (image.dataset.mpseBaked === '1' || (baked && current === baked)) {
        applyPreviewSource(image, metadata);
      } else {
        image.dataset.mpseBaked = '0';
      }
      return metadata;
    }

    function blobToDataUrl(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('无法读取原始图片'));
        reader.readAsDataURL(blob);
      });
    }

    async function directFetchDataUrl(url) {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'force-cache' });
      if (!response.ok) throw new Error(`原图读取失败（HTTP ${response.status}）`);
      const blob = await response.blob();
      const mimeType = String(blob.type || '').toLowerCase().split(';')[0];
      if (!ALLOWED_SOURCE_TYPES.has(mimeType)) throw new Error('原始素材不是有效的光栅图片');
      if (blob.size > MAX_SOURCE_BYTES) throw new Error('原图超过 16MB，无法进行像素烘焙');
      return blobToDataUrl(blob);
    }

    function backgroundFetchDataUrl(url) {
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'MPSE_FETCH_IMAGE', url }, (response) => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            reject(new Error(runtimeError.message));
            return;
          }
          if (!response?.ok) {
            const error = new Error(response?.error?.message || '微信素材读取失败');
            error.code = response?.error?.code || 'MPSE_IMAGE_FETCH_FAILED';
            reject(error);
            return;
          }
          resolve(response.result.dataUrl);
        });
      });
    }

    async function loadSourceDataUrl(value) {
      const url = absoluteSourceUrl(value);
      if (!url) throw new Error('没有找到可烘焙的原始图片');
      if (url.startsWith('data:image/')) {
        const mimeType = url.slice(5, url.indexOf(';') > 0 ? url.indexOf(';') : url.indexOf(',')).toLowerCase();
        if (!ALLOWED_SOURCE_TYPES.has(mimeType)) throw new Error('原始素材不是有效的光栅图片');
        return url;
      }
      if (url.startsWith('blob:') || new URL(url).origin === location.origin) {
        return directFetchDataUrl(url);
      }
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        return backgroundFetchDataUrl(url);
      }
      return directFetchDataUrl(url);
    }

    function bakedAttributes(image, result, upload) {
      const attributes = sourceAttributes(image);
      attributes.src = upload.cdnUrl;
      attributes['data-src'] = upload.cdnUrl;
      if (Object.prototype.hasOwnProperty.call(attributes, 'data-backsrc')) {
        attributes['data-backsrc'] = upload.cdnUrl;
      }
      if (Object.prototype.hasOwnProperty.call(attributes, 'data-croporisrc')) {
        attributes['data-croporisrc'] = upload.cdnUrl;
      }
      if (upload.fileId) attributes['data-fileid'] = upload.fileId;
      else delete attributes['data-fileid'];
      delete attributes['data-mediaid'];
      attributes['data-w'] = String(result.width);
      attributes['data-ratio'] = String(result.width / Math.max(1, result.height));
      return attributes;
    }

    function rememberCurrent(image, asset) {
      const identity = imageSignature(image);
      records.remember(identity, managedDataFromImage(image));
      records.rememberAsset(identity, asset);
    }

    function restoreAdvancedData(image, data) {
      for (const key of ADVANCED_DATA_KEYS) {
        if (Object.prototype.hasOwnProperty.call(data || {}, key)) image.dataset[key] = data[key];
        else delete image.dataset[key];
      }
    }

    function restoreCommittedState(image, metadata) {
      const restoringBaked = Boolean(metadata.bakedUrl);
      const attributes = restoringBaked
        ? (metadata.bakedAttributes || completeSourceAttributes({}, metadata.bakedUrl))
        : metadata.sourceAttributes;
      applySourceAttributes(
        image,
        attributes,
        restoringBaked ? metadata.bakedUrl : metadata.sourceUrl
      );
      restoreAdvancedData(image, metadata.committedData);
      finishAdvancedBake(image, restoringBaked);
      schedulePositionTools();
    }

    async function restoreWithoutEffects(image, metadata, generation, key) {
      if (jobs.get(key)?.generation !== generation || !image.isConnected) return;
      applySourceAttributes(image, metadata.sourceAttributes, metadata.sourceUrl);
      finishAdvancedBake(image, false);
      delete image.dataset.mpseBaked;
      records.rememberAsset(imageSignature(image), {});
      records.remember(imageSignature(image), managedDataFromImage(image));
      metadata.bakedUrl = '';
      metadata.bakedAttributes = null;
      metadata.committedData = managedDataFromImage(image);
      markChanged(image, 'bake', true, metadata.locatorIdentity);
      jobs.delete(key);
      setBadgeText('已恢复原图');
      schedulePositionTools();
    }

    async function execute(image, key, generation) {
      const currentJob = jobs.get(key);
      if (!currentJob || currentJob.generation !== generation || !image.isConnected) return;
      if (state.isDragging) {
        currentJob.timer = window.setTimeout(() => execute(image, key, generation), 160);
        return;
      }
      const metadata = currentJob.metadata;
      const recipe = bakeEngine.recipeFromImage(image);
      if (!bakeEngine.hasEffects(recipe)) {
        await restoreWithoutEffects(image, metadata, generation, key);
        return;
      }

      let stage = '读取原图';
      setBadgeText('正在读取原图…');
      try {
        const dataUrl = await loadSourceDataUrl(metadata.sourceUrl);
        if (jobs.get(key)?.generation !== generation || !image.isConnected) return;
        stage = '像素烘焙';
        setBadgeText('正在烘焙…');
        const rect = image.getBoundingClientRect();
        const rendered = await bakeEngine.bake({
          dataUrl,
          recipe,
          displayWidth: Math.max(1, rect.width || image.naturalWidth || 800),
          preserveBounds: Boolean(getCropContainer(image))
        });
        if (jobs.get(key)?.generation !== generation || !image.isConnected) return;
        stage = '本地图片上传';
        setBadgeText('正在作为本地图片上传…');
        const upload = await bridgeClient.uploadImage(rendered.blob, `mpse-${Date.now()}.png`);
        if (jobs.get(key)?.generation !== generation || !image.isConnected) return;

        const attributes = bakedAttributes(image, rendered, upload);
        applySourceAttributes(image, attributes, upload.cdnUrl);
        image.dataset.mpseBaked = '1';
        finishAdvancedBake(image, true);
        const asset = {
          sourceUrl: metadata.sourceUrl,
          bakedUrl: upload.cdnUrl,
          sourceAttributes: metadata.sourceAttributes,
          width: rendered.width,
          height: rendered.height,
          recipeKey: bakeEngine.recipeKey(recipe)
        };
        metadata.bakedUrl = upload.cdnUrl;
        metadata.bakedAttributes = attributes;
        metadata.committedData = managedDataFromImage(image);
        rememberCurrent(image, asset);
        markChanged(image, 'bake', true, metadata.locatorIdentity);
        jobs.delete(key);
        setBadgeText('已烘焙并作为本地图片上传');
        schedulePositionTools();
      } catch (error) {
        if (jobs.get(key)?.generation !== generation) return;
        jobs.delete(key);
        if (image.isConnected) restoreCommittedState(image, metadata);
        console.warn('[公众号源码排版助手] image bake failed:', error);
        setBadgeText(error?.message ? `${stage}失败：${error.message}` : `${stage}失败`);
      }
    }

    function requestBake(image) {
      if (!image?.isConnected) return;
      const metadata = preparePreview(image);
      if (!metadata) return;
      const key = jobKey(image);
      const previous = jobs.get(key);
      if (previous?.timer) window.clearTimeout(previous.timer);
      const generation = (previous?.generation || 0) + 1;
      const job = { generation, metadata, timer: 0 };
      job.timer = window.setTimeout(() => execute(image, key, generation), BAKE_DELAY_MS);
      jobs.set(key, job);
      setBadgeText('效果预览');
    }

    function restoreOriginal(image, commit = false) {
      if (!image) return false;
      cancel(image);
      const metadata = metadataFor(image);
      if (!metadata?.sourceUrl) return false;
      applySourceAttributes(image, metadata.sourceAttributes, metadata.sourceUrl);
      finishAdvancedBake(image, false);
      delete image.dataset.mpseBaked;
      records.forget(imageSignature(image));
      if (commit) markChanged(image, 'bake', true, metadata.locatorIdentity);
      schedulePositionTools();
      return true;
    }

    return Object.freeze({ preparePreview, requestBake, restoreOriginal, cancel });
  }

  globalThis.__MPSE_IMAGE_BAKE_PIPELINE__ = Object.freeze({
    create,
    SOURCE_ATTRIBUTES,
    completeSourceAttributes
  });
})();
