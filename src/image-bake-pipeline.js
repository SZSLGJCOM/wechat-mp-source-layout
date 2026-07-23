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
    'data-ratio',
    'data-type',
    'data-s'
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

  function wechatImageRatio(width, height) {
    return Math.max(1, Number(height) || 0) / Math.max(1, Number(width) || 0);
  }

  function pasteLocator(identity, key, sourceUrl) {
    return {
      editId: key || identity?.editId || '',
      sourceUrl: sourceUrl || identity?.src || '',
      index: Number.isInteger(identity?.index) ? identity.index : -1
    };
  }

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
      schedulePositionTools,
      resolveImage,
      onBakePending,
      onBakeSettled
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
        const hostPrefixed = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(raw);
        const url = new URL(hostPrefixed ? `https://${raw}` : raw, location.href);
        if (url.protocol === 'http:') url.protocol = 'https:';
        if (url.protocol !== 'https:') return '';
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
      if (!job) return;
      job.cancelRequested = true;
      job.revision += 1;
      if (job.timer) {
        window.clearTimeout(job.timer);
        job.timer = 0;
      }
      if (!job.inFlight) {
        const target = resolveJobImage(job);
        if (target && job.pasteCandidates.length) {
          attachPasteCandidates(job, target);
          markChanged(target, 'bake', false, job.metadata.locatorIdentity);
          settleJob(key, job, target, 'cancelled');
        } else if (job.pasteCandidates.length) {
          scheduleOrphanCleanup(key, job, job.revision);
        } else {
          settleJob(key, job, target || image, 'cancelled');
        }
      }
    }

    function hasPending(image = null) {
      if (!image) return jobs.size > 0;
      const key = getAttr(image, 'data-mpse-image-id');
      return Boolean(key && jobs.has(key));
    }

    function attachPasteCandidates(job, image) {
      if (!image || !job?.pasteCandidates?.length) return;
      const combined = [
        ...(image.__mpseNativePasteCandidates || []),
        ...job.pasteCandidates
      ];
      const seen = new Set();
      image.__mpseNativePasteCandidates = combined.filter((candidate) => {
        const identity = `${candidate?.pasteId || ''}|${stableUrl(candidate?.cdnUrl || '')}`;
        if (identity === '|' || seen.has(identity)) return false;
        seen.add(identity);
        return true;
      });
    }

    function rememberPasteCandidate(job, upload) {
      if (upload?.cleanupPending === false) return;
      const candidate = {
        pasteId: String(upload?.pasteId || ''),
        cdnUrl: stableUrl(upload?.cdnUrl || '')
      };
      const articleKey = String(upload?.articleKey || '');
      if (articleKey) candidate.articleKey = articleKey;
      candidate.placement = upload?.placement === 'replace' ? 'replace' : 'after';
      if (upload?.originalAttributes && typeof upload.originalAttributes === 'object') {
        candidate.originalAttributes = { ...upload.originalAttributes };
      }
      if (!candidate.pasteId && !candidate.cdnUrl) return;
      if (!job.pasteCandidates.some((item) => (
        item.pasteId === candidate.pasteId && item.cdnUrl === candidate.cdnUrl
      ))) {
        job.pasteCandidates.push(candidate);
      }
    }

    async function discardPasteCandidates(job) {
      if (
        !job?.pasteCandidates?.length
        || typeof bridgeClient.discardPastedImage !== 'function'
      ) return false;
      const locator = pasteLocator(
        job.metadata.locatorIdentity,
        job.metadata.locatorIdentity?.editId,
        job.metadata.sourceUrl
      );
      const unresolved = [];
      for (const candidate of [...job.pasteCandidates].reverse()) {
        try {
          const result = await bridgeClient.discardPastedImage(candidate, locator);
          if (!result?.changed && !result?.confirmedAbsent && !result?.cleanupScheduled) {
            unresolved.unshift(candidate);
          }
        } catch (error) {
          unresolved.unshift(candidate);
          console.warn('[公众号源码排版助手] pasted image cleanup failed:', error);
        }
      }
      job.pasteCandidates = unresolved;
      return unresolved.length === 0;
    }

    function settleJob(key, expectedJob, image, outcome) {
      const job = jobs.get(key);
      if (!job || job !== expectedJob) return false;
      if (job.timer) window.clearTimeout(job.timer);
      jobs.delete(key);
      if (typeof onBakeSettled === 'function') {
        onBakeSettled(image || null, job.metadata.locatorIdentity, outcome);
      }
      return true;
    }

    function resolveJobImage(job) {
      if (job.image?.isConnected) return job.image;
      const resolved = typeof resolveImage === 'function'
        ? resolveImage(job.metadata.locatorIdentity)
        : null;
      if (!resolved?.isConnected) return null;
      const editId = job.metadata.locatorIdentity?.editId;
      if (editId && !getAttr(resolved, 'data-mpse-image-id')) {
        resolved.setAttribute('data-mpse-image-id', editId);
      }
      job.image = resolved;
      imageSources.set(resolved, job.metadata);
      if (!job.cancelRequested) restoreAdvancedData(resolved, job.previewData);
      attachPasteCandidates(job, resolved);
      return resolved;
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
      const attributes = {
        ...sourceAttributes(image),
        ...(upload.sourceAttributes || {})
      };
      attributes.src = upload.cdnUrl;
      attributes['data-src'] = upload.cdnUrl;
      if (Object.prototype.hasOwnProperty.call(attributes, 'data-backsrc')) {
        attributes['data-backsrc'] = upload.cdnUrl;
      }
      if (Object.prototype.hasOwnProperty.call(attributes, 'data-croporisrc')) {
        attributes['data-croporisrc'] = upload.cdnUrl;
      }
      for (const name of ['data-fileid', 'data-mediaid', 'data-type', 'data-s']) {
        if (!Object.prototype.hasOwnProperty.call(upload.sourceAttributes || {}, name)) {
          delete attributes[name];
        }
      }
      if (!attributes['data-w']) attributes['data-w'] = String(result.width);
      if (!attributes['data-ratio']) {
        attributes['data-ratio'] = String(wechatImageRatio(result.width, result.height));
      }
      if (!attributes['data-type']) attributes['data-type'] = upload.mimeType === 'image/jpeg' ? 'jpeg' : 'png';
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

    async function restoreWithoutEffects(image, metadata, job, key) {
      if (jobs.get(key) !== job || !image.isConnected) return;
      applySourceAttributes(image, metadata.sourceAttributes, metadata.sourceUrl);
      finishAdvancedBake(image, false);
      delete image.dataset.mpseBaked;
      records.rememberAsset(imageSignature(image), {});
      records.remember(imageSignature(image), managedDataFromImage(image));
      metadata.bakedUrl = '';
      metadata.bakedAttributes = null;
      metadata.committedData = managedDataFromImage(image);
      attachPasteCandidates(job, image);
      markChanged(image, 'bake', false, metadata.locatorIdentity);
      setBadgeText('已恢复原图');
      schedulePositionTools();
      job.inFlight = false;
      settleJob(key, job, image, 'restored');
    }

    function scheduleExecution(key, job, delay = BAKE_DELAY_MS) {
      if (jobs.get(key) !== job) return;
      if (job.timer) window.clearTimeout(job.timer);
      const revision = job.revision;
      job.timer = window.setTimeout(() => execute(key, job, revision), delay);
    }

    function scheduleOrphanCleanup(key, job, revision) {
      if (jobs.get(key) !== job) return;
      if (job.timer) window.clearTimeout(job.timer);
      const delay = Math.min(30000, 1000 * (2 ** Math.min(job.cleanupAttempts, 5)));
      job.timer = window.setTimeout(async () => {
        if (jobs.get(key) !== job) return;
        job.timer = 0;
        if (!job.cancelRequested && job.revision !== revision) {
          scheduleExecution(key, job);
          return;
        }
        job.inFlight = true;
        await discardPasteCandidates(job);
        if (jobs.get(key) !== job) return;
        if (!job.cancelRequested && job.revision !== revision) {
          job.inFlight = false;
          scheduleExecution(key, job);
          return;
        }
        job.inFlight = false;
        if (!job.pasteCandidates.length) {
          settleJob(key, job, null, job.cancelRequested ? 'cancelled' : 'failed');
          return;
        }
        job.cleanupAttempts += 1;
        scheduleOrphanCleanup(key, job, revision);
      }, delay);
    }

    function pauseForLatestRevision(key, job, revision) {
      if (jobs.get(key) !== job) return true;
      if (job.cancelRequested) {
        const image = resolveJobImage(job);
        job.inFlight = false;
        if (image && job.pasteCandidates.length) {
          attachPasteCandidates(job, image);
          markChanged(image, 'bake', false, job.metadata.locatorIdentity);
        }
        if (!image && job.pasteCandidates.length) {
          scheduleOrphanCleanup(key, job, job.revision);
          return true;
        }
        settleJob(key, job, image, 'cancelled');
        return true;
      }
      if (job.revision !== revision) {
        job.inFlight = false;
        scheduleExecution(key, job);
        return true;
      }
      return false;
    }

    async function execute(key, expectedJob, revision) {
      const currentJob = jobs.get(key);
      if (
        !currentJob
        || currentJob !== expectedJob
        || currentJob.revision !== revision
        || currentJob.inFlight
      ) return;
      currentJob.timer = 0;
      currentJob.inFlight = true;
      const image = resolveJobImage(currentJob);
      if (!image) {
        currentJob.inFlight = false;
        currentJob.rebindAttempts += 1;
        if (currentJob.rebindAttempts <= 4) {
          scheduleExecution(key, currentJob, 160);
          return;
        }
        if (currentJob.pasteCandidates.length) {
          scheduleOrphanCleanup(key, currentJob, revision);
          return;
        }
        settleJob(key, currentJob, null, 'failed');
        return;
      }
      if (state.isDragging) {
        currentJob.inFlight = false;
        scheduleExecution(key, currentJob, 160);
        return;
      }
      if (pauseForLatestRevision(key, currentJob, revision)) return;
      const metadata = currentJob.metadata;
      const recipe = currentJob.recipe;
      if (!bakeEngine.hasEffects(recipe)) {
        await restoreWithoutEffects(image, metadata, currentJob, key);
        return;
      }

      let stage = '读取原图';
      setBadgeText('正在读取原图…');
      try {
        const dataUrl = await loadSourceDataUrl(metadata.sourceUrl);
        if (pauseForLatestRevision(key, currentJob, revision)) return;
        const bakeImage = resolveJobImage(currentJob);
        if (!bakeImage) throw new Error('图片节点已更新，无法完成烘焙');
        stage = '像素烘焙';
        setBadgeText('正在烘焙…');
        const rect = bakeImage.getBoundingClientRect();
        const rendered = await bakeEngine.bake({
          dataUrl,
          recipe,
          displayWidth: Math.max(1, rect.width || bakeImage.naturalWidth || 800),
          preserveBounds: Boolean(getCropContainer(bakeImage))
        });
        if (pauseForLatestRevision(key, currentJob, revision)) return;
        stage = '微信编辑器粘贴上传';
        setBadgeText('正在交给微信编辑器上传…');
        const upload = await bridgeClient.pasteImage(
          rendered.blob,
          `mpse-${Date.now()}.png`,
          pasteLocator(metadata.locatorIdentity, key, metadata.sourceUrl)
        );
        rememberPasteCandidate(currentJob, upload);
        const target = resolveJobImage(currentJob);
        if (!target) throw new Error('图片节点已更新，无法写回烘焙结果');
        attachPasteCandidates(currentJob, target);
        if (currentJob.cancelRequested) {
          markChanged(target, 'bake', false, metadata.locatorIdentity);
          currentJob.inFlight = false;
          settleJob(key, currentJob, target, 'cancelled');
          return;
        }
        if (currentJob.revision !== revision) {
          currentJob.inFlight = false;
          setBadgeText('效果已更新，正在重新处理…');
          scheduleExecution(key, currentJob);
          return;
        }

        const attributes = bakedAttributes(target, rendered, upload);
        applySourceAttributes(target, attributes, upload.cdnUrl);
        target.dataset.mpseBaked = '1';
        finishAdvancedBake(target, true);
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
        metadata.committedData = managedDataFromImage(target);
        rememberCurrent(target, asset);
        markChanged(target, 'bake', false, metadata.locatorIdentity);
        currentJob.inFlight = false;
        settleJob(key, currentJob, target, 'succeeded');
        setBadgeText('已由微信编辑器上传并同步');
        schedulePositionTools();
      } catch (error) {
        if (jobs.get(key) !== currentJob) return;
        rememberPasteCandidate(currentJob, error?.detail?.pasteCandidate);
        if (!currentJob.cancelRequested && currentJob.revision !== revision) {
          const latestTarget = resolveJobImage(currentJob);
          if (latestTarget) attachPasteCandidates(currentJob, latestTarget);
          currentJob.inFlight = false;
          scheduleExecution(key, currentJob);
          return;
        }
        let target = resolveJobImage(currentJob);
        if (target) {
          if (!currentJob.cancelRequested) restoreCommittedState(target, metadata);
          attachPasteCandidates(currentJob, target);
          if (currentJob.pasteCandidates.length) {
            markChanged(target, 'bake', false, metadata.locatorIdentity);
          }
        } else {
          await discardPasteCandidates(currentJob);
        }
        if (jobs.get(key) !== currentJob) return;
        if (!currentJob.cancelRequested && currentJob.revision !== revision) {
          target = resolveJobImage(currentJob);
          if (target) attachPasteCandidates(currentJob, target);
          currentJob.inFlight = false;
          scheduleExecution(key, currentJob);
          return;
        }
        currentJob.inFlight = false;
        if (!target && currentJob.pasteCandidates.length) {
          currentJob.cleanupAttempts += 1;
          scheduleOrphanCleanup(key, currentJob, revision);
          console.warn('[公众号源码排版助手] image bake cleanup pending:', error);
          setBadgeText('正在清理粘贴图片');
          return;
        }
        settleJob(key, currentJob, target, currentJob.cancelRequested ? 'cancelled' : 'failed');
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
      const job = previous || {
        revision: 0,
        metadata,
        image,
        recipe: null,
        previewData: {},
        rebindAttempts: 0,
        timer: 0,
        inFlight: false,
        cancelRequested: false,
        cleanupAttempts: 0,
        pasteCandidates: []
      };
      job.revision += 1;
      job.metadata = metadata;
      job.image = image;
      job.recipe = bakeEngine.recipeFromImage(image);
      job.previewData = managedDataFromImage(image);
      job.rebindAttempts = 0;
      job.cleanupAttempts = 0;
      job.cancelRequested = false;
      jobs.set(key, job);
      if (!job.inFlight) scheduleExecution(key, job);
      if (!previous && typeof onBakePending === 'function') {
        onBakePending(image, metadata.locatorIdentity);
      }
      setBadgeText('效果预览');
      return true;
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

    return Object.freeze({ preparePreview, requestBake, restoreOriginal, cancel, hasPending });
  }

  globalThis.__MPSE_IMAGE_BAKE_PIPELINE__ = Object.freeze({
    create,
    SOURCE_ATTRIBUTES,
    completeSourceAttributes,
    wechatImageRatio
  });
})();
