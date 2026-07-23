(() => {
  'use strict';

  const CONTENT_SOURCE = 'wechat-mp-source-layout:content';
  const PAGE_SOURCE = 'wechat-mp-source-layout:page';
  const CONTENT_CONFLICT_CODE = 'MPSE_CONTENT_CONFLICT';
  const JSAPI_TIMEOUT_CODE = 'MPSE_JSAPI_TIMEOUT';
  const WRITE_UNCERTAIN_CODE = 'MPSE_WRITE_UNCERTAIN';
  const EDITOR_BUSY_CODE = 'MPSE_EDITOR_BUSY';
  const SET_CONFIRM_TIMEOUT_MS = 5000;
  const EDITOR_INPUT_IDLE_MS = 160;
  const EDITOR_INPUT_WAIT_TIMEOUT_MS = 2500;
  const MAX_PASTE_IMAGE_BYTES = 10 * 1024 * 1024;

  if (window.__MP_SOURCE_EDITOR_BRIDGE_INSTALLED__) {
    return;
  }
  window.__MP_SOURCE_EDITOR_BRIDGE_INSTALLED__ = true;

  function asErrorPayload(error) {
    if (!error) {
      return { message: '未知错误' };
    }
    const payload = {
      name: error.name || 'Error',
      message: error.message || String(error),
      stack: error.stack || ''
    };
    if (error.code) payload.code = String(error.code);
    if (error.mode) payload.mode = String(error.mode);
    if (error.pasteCandidate && typeof error.pasteCandidate === 'object') {
      payload.pasteCandidate = {
        pasteId: String(error.pasteCandidate.pasteId || ''),
        cdnUrl: String(error.pasteCandidate.cdnUrl || ''),
        articleKey: String(error.pasteCandidate.articleKey || ''),
        placement: error.pasteCandidate.placement === 'replace' ? 'replace' : 'after',
        originalAttributes: normalizedNativeAttributeRecord(error.pasteCandidate.originalAttributes)
      };
    }
    return payload;
  }

  function normalizeContentResponse(response) {
    if (typeof response === 'string') {
      return response;
    }
    if (!response || typeof response !== 'object') {
      return '';
    }
    if (typeof response.content === 'string') {
      return response.content;
    }
    if (typeof response.html === 'string') {
      return response.html;
    }
    if (typeof response.content_html === 'string') {
      return response.content_html;
    }
    return '';
  }

  function getMpEditorApi() {
    const api = window.__MP_Editor_JSAPI__;
    if (api && typeof api.invoke === 'function') {
      return api;
    }
    return null;
  }

  function invokeMpEditor(apiName, apiParam, timeoutMs = 10000, apiOverride = null) {
    const api = apiOverride || getMpEditorApi();
    if (!api) {
      return Promise.reject(new Error('页面中没有检测到 __MP_Editor_JSAPI__'));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = timeoutMs > 0 ? window.setTimeout(() => {
        if (settled) return;
        settled = true;
        const error = new Error(`${apiName} 调用超时`);
        error.code = JSAPI_TIMEOUT_CODE;
        reject(error);
      }, timeoutMs) : 0;

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timer) window.clearTimeout(timer);
        fn(value);
      };

      try {
        const payload = {
          apiName,
          sucCb: (res) => finish(resolve, res || {}),
          errCb: (err) => finish(reject, new Error(err && err.message ? err.message : JSON.stringify(err || {})))
        };

        if (apiParam !== undefined) {
          payload.apiParam = apiParam;
        }

        api.invoke(payload);
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  function isVisibleElement(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 120 && rect.height > 80;
  }

  function readFrameDocument(iframe) {
    try {
      return iframe.contentDocument || null;
    } catch (_) {
      return null;
    }
  }

  function getAccessibleDocuments() {
    const docs = [document];
    for (const iframe of document.querySelectorAll('iframe')) {
      const doc = readFrameDocument(iframe);
      if (doc) docs.push(doc);
    }
    return docs;
  }

  function findEditorElement() {
    const selectors = [
      '#ueditor_0[contenteditable="true"]',
      '#js_editorArea[contenteditable="true"]',
      '.ProseMirror[contenteditable="true"]',
      '.ql-editor[contenteditable="true"]',
      '[contenteditable="true"]',
      'body[contenteditable="true"]'
    ];

    const candidates = [];

    for (const doc of getAccessibleDocuments()) {
      for (const selector of selectors) {
        const nodes = Array.from(doc.querySelectorAll(selector));
        for (const node of nodes) {
          if (!node.isContentEditable && node.getAttribute('contenteditable') !== 'true' && doc.designMode !== 'on') continue;
          if (!isVisibleElement(node)) continue;
          const rect = node.getBoundingClientRect();
          const html = node.innerHTML || '';
          const text = node.textContent || '';
          const score = html.length * 2 + text.length + rect.width + rect.height;
          candidates.push({ node, score });
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0] ? candidates[0].node : null;
  }

  function articleKey() {
    const url = new URL(location.href);
    const keys = ['appmsgid', 'draftid', 'media_id', 'itemidx', 'type', 'action', 'sub', 'createType'];
    const parts = [`path=${url.pathname}`];
    for (const key of keys) {
      const urlValue = url.searchParams.get(key);
      const field = document.querySelector?.(`[name="${key}"], #${key}`) || null;
      const fieldValue = field && 'value' in field ? String(field.value || '') : '';
      const value = urlValue || fieldValue;
      if (value) parts.push(`${key}=${value}`);
    }
    return parts.join('&');
  }

  function fallbackGetContent(editor = findEditorElement()) {
    if (!editor) {
      throw new Error('没有找到可编辑正文区域');
    }
    return {
      content: editor.innerHTML || '',
      mode: 'dom-fallback',
      articleKey: articleKey()
    };
  }

  function dispatchEditorEvents(editor, html) {
    const view = editor.ownerDocument.defaultView || window;

    try {
      editor.dispatchEvent(new view.InputEvent('input', {
        bubbles: true,
        inputType: 'insertHTML',
        data: html
      }));
    } catch (_) {
      editor.dispatchEvent(new view.Event('input', { bubbles: true }));
    }

    editor.dispatchEvent(new view.Event('change', { bubbles: true }));
    editor.dispatchEvent(new view.KeyboardEvent('keyup', { bubbles: true }));
    editor.dispatchEvent(new view.Event('blur', { bubbles: true }));
  }

  function fallbackSetContent(content, editor = findEditorElement()) {
    if (!editor) {
      throw new Error('没有找到可编辑正文区域');
    }

    editor.focus();

    try {
      const doc = editor.ownerDocument;
      const selection = doc.getSelection();
      const range = doc.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
      const ok = doc.execCommand('insertHTML', false, content);
      if (!ok) {
        editor.innerHTML = content;
      }
    } catch (_) {
      editor.innerHTML = content;
    }

    dispatchEditorEvents(editor, content);
    return { mode: 'dom-fallback', articleKey: articleKey() };
  }

  async function getContent(options = {}) {
    const api = options.api || getMpEditorApi();
    if (api) {
      try {
        const response = await invokeMpEditor('mp_editor_get_content', undefined, options.timeoutMs || 10000, api);
        return {
          content: normalizeContentResponse(response),
          mode: 'mp-editor-jsapi',
          articleKey: articleKey()
        };
      } catch (apiError) {
        if (options.allowFallback === false) throw apiError;
        const fallback = fallbackGetContent();
        fallback.apiError = asErrorPayload(apiError);
        return fallback;
      }
    }
    return fallbackGetContent();
  }

  const trackedInputDocuments = new WeakSet();
  let editorInputEpoch = 0;
  let editorInputTimer = 0;
  let resolveEditorInputIdle = null;
  let editorInputIdle = Promise.resolve();
  let compositionActive = false;
  let resolveCompositionEnd = null;
  let compositionEnd = Promise.resolve();
  let activeNativePasteInputLock = null;

  function isEditorInputEvent(event, doc) {
    if (event && event.isTrusted === false) return false;
    let target = event && event.target;
    if (target && target.nodeType !== Node.ELEMENT_NODE) target = target.parentElement;
    if (!target) return doc.designMode === 'on';
    if (target.isContentEditable) return true;
    return Boolean(target.closest && target.closest('[contenteditable="true"], body[contenteditable="true"]'));
  }

  function nativePasteLockOwnsEvent(event, doc) {
    const editor = activeNativePasteInputLock?.editor;
    if (!editor || editor.isConnected === false || event?.isTrusted === false) return false;
    let target = event?.target;
    if (target && target.nodeType !== Node.ELEMENT_NODE) target = target.parentElement;
    if (!target) return doc === editor.ownerDocument && doc.designMode === 'on';
    return target === editor || Boolean(editor.contains?.(target));
  }

  function blockNativePasteInput(event) {
    event?.preventDefault?.();
    event?.stopImmediatePropagation?.();
  }

  function noteEditorInput() {
    editorInputEpoch += 1;
    if (editorInputTimer) window.clearTimeout(editorInputTimer);
    if (resolveEditorInputIdle) resolveEditorInputIdle();
    editorInputIdle = new Promise((resolve) => {
      resolveEditorInputIdle = resolve;
      editorInputTimer = window.setTimeout(() => {
        editorInputTimer = 0;
        resolveEditorInputIdle = null;
        resolve();
      }, EDITOR_INPUT_IDLE_MS);
    });
  }

  function beginComposition() {
    if (!compositionActive) {
      compositionActive = true;
      compositionEnd = new Promise((resolve) => {
        resolveCompositionEnd = resolve;
      });
    }
    noteEditorInput();
  }

  function endComposition() {
    if (compositionActive) {
      compositionActive = false;
      const resolve = resolveCompositionEnd;
      resolveCompositionEnd = null;
      if (resolve) resolve();
    }
    noteEditorInput();
  }

  function ensureEditorInputTracking() {
    for (const doc of getAccessibleDocuments()) {
      if (!doc || trackedInputDocuments.has(doc)) continue;
      trackedInputDocuments.add(doc);
      for (const type of ['beforeinput', 'input', 'paste', 'drop', 'cut']) {
        doc.addEventListener(type, (event) => {
          if (!isEditorInputEvent(event, doc)) return;
          if (type !== 'input' && nativePasteLockOwnsEvent(event, doc)) {
            blockNativePasteInput(event);
            return;
          }
          noteEditorInput();
        }, true);
      }
      doc.addEventListener('keydown', (event) => {
        if (!activeNativePasteInputLock || event?.isTrusted === false) return;
        if (nativePasteLockOwnsEvent(event, doc)) {
          blockNativePasteInput(event);
        } else {
          noteEditorInput();
        }
      }, true);
      doc.addEventListener('pointerdown', (event) => {
        if (!activeNativePasteInputLock || event?.isTrusted === false) return;
        if (nativePasteLockOwnsEvent(event, doc)) {
          blockNativePasteInput(event);
        } else {
          noteEditorInput();
        }
      }, true);
      doc.addEventListener('compositionstart', (event) => {
        if (!isEditorInputEvent(event, doc)) return;
        if (nativePasteLockOwnsEvent(event, doc)) {
          blockNativePasteInput(event);
          return;
        }
        beginComposition();
      }, true);
      doc.addEventListener('compositionupdate', (event) => {
        if (!isEditorInputEvent(event, doc)) return;
        if (nativePasteLockOwnsEvent(event, doc)) {
          blockNativePasteInput(event);
          return;
        }
        noteEditorInput();
      }, true);
      doc.addEventListener('compositionend', (event) => {
        if (!isEditorInputEvent(event, doc)) return;
        if (nativePasteLockOwnsEvent(event, doc)) {
          blockNativePasteInput(event);
          return;
        }
        endComposition();
      }, true);
    }
  }

  function editorBusy() {
    const error = new Error('微信编辑器仍处于输入或文章切换状态，请稍后重试');
    error.code = EDITOR_BUSY_CODE;
    return error;
  }

  function waitUntilSettled(promise, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => reject(editorBusy()), timeoutMs);
      Promise.resolve(promise).then(
        (value) => {
          window.clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          window.clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  async function waitForEditorInputIdle() {
    ensureEditorInputTracking();
    const deadline = Date.now() + EDITOR_INPUT_WAIT_TIMEOUT_MS;
    try {
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw editorBusy();
        if (compositionActive) {
          await waitUntilSettled(compositionEnd, remaining);
          continue;
        }
        const epoch = editorInputEpoch;
        const idle = editorInputIdle;
        await waitUntilSettled(idle, remaining);
        if (!compositionActive && !editorInputTimer && epoch === editorInputEpoch) return epoch;
      }
    } catch (error) {
      if (error?.code === EDITOR_BUSY_CODE && compositionActive) {
        compositionActive = false;
        const resolve = resolveCompositionEnd;
        resolveCompositionEnd = null;
        if (resolve) resolve();
      }
      throw error;
    }
  }

  function adapterConflict(mode) {
    const error = contentConflict(mode);
    error.message = '正文编辑器模式在写入前已发生变化，请重试';
    return error;
  }

  function uncertainWrite() {
    const error = new Error('微信编辑器没有确认本次写入结果，请刷新页面后再继续编辑');
    error.code = WRITE_UNCERTAIN_CODE;
    return error;
  }

  let writeStateUncertain = false;

  async function setContent(content, expectedContent = null, expectedMode = '', expectedArticleKey = '') {
    if (writeStateUncertain) throw uncertainWrite();
    await waitForEditorInputIdle();
    if (writeStateUncertain) throw uncertainWrite();
    const api = getMpEditorApi();
    const mode = expectedMode || (api ? 'mp-editor-jsapi' : 'dom-fallback');
    if (mode === 'mp-editor-jsapi' && !api) throw adapterConflict('dom-fallback');
    if (mode === 'dom-fallback' && api) throw adapterConflict('mp-editor-jsapi');

    const editor = mode === 'dom-fallback' ? findEditorElement() : null;
    if (mode === 'dom-fallback' && !editor) throw new Error('没有找到可编辑正文区域');
    const validationEpoch = editorInputEpoch;
    if (typeof expectedContent === 'string' || expectedArticleKey) {
      const current = mode === 'mp-editor-jsapi'
        ? await getContent({ api, allowFallback: false, timeoutMs: 2000 })
        : fallbackGetContent(editor);
      if ((typeof expectedContent === 'string' && current.content !== expectedContent)
        || (expectedArticleKey && current.articleKey !== expectedArticleKey)
        || validationEpoch !== editorInputEpoch
        || compositionActive || editorInputTimer) {
        throw contentConflict(current.mode);
      }
    }

    if (mode === 'dom-fallback') {
      if (editor.isConnected === false) throw contentConflict('dom-fallback');
      return fallbackSetContent(content, editor);
    }
    if (getMpEditorApi() !== api) throw adapterConflict(getMpEditorApi() ? 'mp-editor-jsapi' : 'dom-fallback');
    const setEpoch = editorInputEpoch;
    let response;
    try {
      response = await invokeMpEditor('mp_editor_set_content', { content }, SET_CONFIRM_TIMEOUT_MS, api);
    } catch (error) {
      if (error && error.code === JSAPI_TIMEOUT_CODE) {
        writeStateUncertain = true;
        throw uncertainWrite();
      }
      throw error;
    }
    if (setEpoch !== editorInputEpoch || compositionActive || editorInputTimer) {
      throw contentConflict('mp-editor-jsapi');
    }
    const nextArticleKey = articleKey();
    if (expectedArticleKey && nextArticleKey !== expectedArticleKey) {
      throw contentConflict('mp-editor-jsapi');
    }
    return {
      response,
      mode: 'mp-editor-jsapi',
      articleKey: nextArticleKey
    };
  }

  function contentConflict(mode) {
    const error = new Error('正文在写入前已发生变化，请基于最新内容重试');
    error.code = CONTENT_CONFLICT_CODE;
    error.mode = mode || 'unknown';
    return error;
  }

  let editorWriteQueue = Promise.resolve();
  let editorWriteRevision = 0;

  function enqueueEditorWrite(operation, options = {}) {
    const revision = options.invalidateRevision === false
      ? editorWriteRevision
      : ++editorWriteRevision;
    const run = () => operation(revision);
    const scheduled = editorWriteQueue.then(run, run);
    editorWriteQueue = scheduled.then(() => undefined, () => undefined);
    return scheduled;
  }

  ensureEditorInputTracking();

  function enqueueSetContent(content, expectedContent = null, expectedMode = '', expectedArticleKey = '') {
    return enqueueEditorWrite(
      () => setContent(content, expectedContent, expectedMode, expectedArticleKey)
    );
  }

  async function waitForPendingSetContent() {
    await editorWriteQueue;
    if (writeStateUncertain) throw uncertainWrite();
  }

  function validatedImagePayload(payload) {
    const bytes = payload?.bytes;
    const mimeType = String(payload?.mimeType || '');
    if (!(bytes instanceof ArrayBuffer)) throw new Error('烘焙图片数据无效');
    if (!['image/png', 'image/jpeg'].includes(mimeType)) throw new Error('只允许上传 PNG 或 JPEG 图片');
    if (!bytes.byteLength || bytes.byteLength > MAX_PASTE_IMAGE_BYTES) throw new Error('烘焙图片超过 10MB 粘贴处理限制');
    const extension = mimeType === 'image/jpeg' ? 'jpg' : 'png';
    const requestedName = String(payload?.filename || '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 80);
    const filename = requestedName && requestedName.toLowerCase().endsWith(`.${extension}`)
      ? requestedName
      : `mpse-image-${Date.now()}.${extension}`;
    return { blob: new Blob([bytes], { type: mimeType }), mimeType, filename };
  }

  function normalizedWechatCdnUrl(value) {
    try {
      const url = new URL(String(value || '').trim());
      const allowedHosts = new Set(['mmbiz.qpic.cn', 'mmbiz.qlogo.cn', 'm.qpic.cn', 'mmsns.qpic.cn']);
      if (!['http:', 'https:'].includes(url.protocol) || !allowedHosts.has(url.hostname)) return '';
      url.protocol = 'https:';
      return url.href;
    } catch (_) {
      return '';
    }
  }

  function normalizedImageUrl(value) {
    const raw = String(value || '').trim();
    if (/^(?:data:image\/|blob:)/i.test(raw)) return raw;
    try {
      const url = new URL(raw, location.href);
      return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch (_) {
      return '';
    }
  }

  const NATIVE_IMAGE_ATTRIBUTES = Object.freeze([
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

  function normalizedNativeAttributeRecord(attributes) {
    return NATIVE_IMAGE_ATTRIBUTES.reduce((result, name) => {
      if (Object.prototype.hasOwnProperty.call(attributes || {}, name)) {
        result[name] = String(attributes[name] || '');
      }
      return result;
    }, {});
  }

  function imageSource(image) {
    return normalizedWechatCdnUrl(
      image?.getAttribute?.('data-src')
      || image?.getAttribute?.('src')
      || image?.currentSrc
      || image?.src
      || ''
    );
  }

  function wechatAssetKey(value) {
    const normalized = normalizedWechatCdnUrl(value);
    if (!normalized) return '';
    const url = new URL(normalized);
    return `${url.hostname}${url.pathname}`;
  }

  function imageMatchesWechatAsset(image, value) {
    const expected = wechatAssetKey(value);
    if (!image || !expected) return false;
    const sources = [
      image.getAttribute?.('data-src'),
      image.getAttribute?.('src'),
      image.getAttribute?.('data-backsrc'),
      image.getAttribute?.('data-croporisrc'),
      image.currentSrc,
      image.src
    ];
    return sources.some((source) => wechatAssetKey(source) === expected);
  }

  function rawImageSource(image) {
    return String(
      image?.getAttribute?.('data-src')
      || image?.getAttribute?.('src')
      || image?.currentSrc
      || image?.src
      || ''
    ).trim();
  }

  function nativeImageAttributes(image) {
    return NATIVE_IMAGE_ATTRIBUTES.reduce((attributes, name) => {
      if (image?.hasAttribute?.(name)) attributes[name] = image.getAttribute(name);
      return attributes;
    }, {});
  }

  function syncNativeImageAttributes(image, attributes) {
    if (!image) return;
    for (const name of NATIVE_IMAGE_ATTRIBUTES) {
      if (Object.prototype.hasOwnProperty.call(attributes || {}, name)) {
        image.setAttribute(name, attributes[name]);
      } else {
        image.removeAttribute(name);
      }
    }
  }

  function locateImageForPaste(editor, locator = {}) {
    const images = Array.from(editor?.querySelectorAll?.('img') || []);
    const editId = String(locator.editId || '');
    if (editId) {
      const exact = images.find((image) => image.getAttribute('data-mpse-image-id') === editId);
      if (exact) return exact;
    }
    const sourceUrl = normalizedImageUrl(locator.sourceUrl);
    if (sourceUrl) {
      const matches = images.filter((image) => normalizedImageUrl(rawImageSource(image)) === sourceUrl);
      if (matches.length === 1) return matches[0];
      const index = Number(locator.index);
      if (Number.isInteger(index) && index >= 0 && matches.includes(images[index])) {
        return images[index];
      }
      return null;
    }
    const index = Number(locator.index);
    return Number.isInteger(index) && index >= 0 ? images[index] || null : null;
  }

  function pasteImageKey(image) {
    if (!image) return '';
    return [
      image.getAttribute?.('data-mpse-image-id') || '',
      imageSource(image) || rawImageSource(image)
    ].join('|');
  }

  function createNativePasteContext(editor, target, locator, revision, pasteId) {
    const images = Array.from(editor.querySelectorAll('img'));
    const targetIndex = images.indexOf(target);
    return {
      editor,
      target,
      locator,
      revision,
      pasteId,
      targetIndex,
      originalSource: imageSource(target),
      originalRawSource: rawImageSource(target),
      originalAttributes: nativeImageAttributes(target),
      nextImageKey: pasteImageKey(images[targetIndex + 1] || null),
      ownedCandidate: null,
      ownedPlacement: ''
    };
  }

  function acquireNativePasteInputLock(context) {
    activeNativePasteInputLock = {
      editor: context.editor,
      revision: context.revision
    };
  }

  function releaseNativePasteInputLock(context) {
    if (
      activeNativePasteInputLock?.editor === context.editor
      && activeNativePasteInputLock?.revision === context.revision
    ) {
      activeNativePasteInputLock = null;
    }
  }

  function currentPasteAnchor(context) {
    const { editor, target, locator } = context;
    if (target?.isConnected && editor.contains(target)) return target;
    const located = locateImageForPaste(editor, locator);
    if (located) return located;

    const images = Array.from(editor?.querySelectorAll?.('img') || []);
    const replacement = images[context.targetIndex] || null;
    if (!replacement || imageSource(replacement) === context.originalSource) return null;
    const nextImage = images[context.targetIndex + 1] || null;
    const boundaryMatches = context.nextImageKey
      ? pasteImageKey(nextImage) === context.nextImageKey
      : context.targetIndex === images.length - 1;
    return boundaryMatches ? replacement : null;
  }

  function scopedPasteCandidates(context) {
    const anchor = currentPasteAnchor(context);
    if (!anchor) return [];
    const images = Array.from(context.editor.querySelectorAll('img'));
    const anchorIndex = images.indexOf(anchor);
    if (anchorIndex < 0) return [];

    const candidates = [];
    const anchorSource = imageSource(anchor);
    const editId = String(context.locator?.editId || '');
    const boundedReplacement = anchor !== context.target && anchorIndex === context.targetIndex;
    if (
      anchorSource
      && anchorSource !== context.originalSource
      && (
        !editId
        || anchor.getAttribute('data-mpse-image-id') === editId
        || boundedReplacement
      )
    ) {
      candidates.push(anchor);
    }

    const following = images.slice(anchorIndex + 1);
    let boundary = following.length;
    if (context.nextImageKey) {
      boundary = following.findIndex((image) => pasteImageKey(image) === context.nextImageKey);
      if (boundary < 0) return candidates;
    }
    return candidates.concat(following.slice(0, Math.min(boundary, 4)));
  }

  function candidateBelongsToEditor(context, candidate) {
    if (!candidate || candidate.isConnected === false) return false;
    return typeof context.editor?.contains !== 'function' || context.editor.contains(candidate);
  }

  function ownedNativePasteCandidate(context) {
    if (candidateBelongsToEditor(context, context.ownedCandidate)) {
      return context.ownedCandidate;
    }
    const marked = Array.from(context.editor?.querySelectorAll?.('img') || []).find((image) => (
      image.getAttribute('data-mpse-native-paste-id') === context.pasteId
    )) || null;
    if (marked) context.ownedCandidate = marked;
    return marked;
  }

  function claimNativePasteCandidate(context) {
    const existing = ownedNativePasteCandidate(context);
    if (existing) return existing;

    const anchor = currentPasteAnchor(context);
    const scoped = scopedPasteCandidates(context);
    const candidates = [anchor, ...scoped].filter((image, index, entries) => (
      image && entries.indexOf(image) === index
    ));
    const candidate = candidates.find((image) => {
      if (image !== anchor) return true;
      const source = imageSource(image);
      return source
        ? source !== context.originalSource
        : rawImageSource(image) !== context.originalRawSource;
    }) || null;
    if (!candidate) return null;

    context.ownedCandidate = candidate;
    context.ownedPlacement = candidate === anchor ? 'replace' : 'after';
    if (context.ownedPlacement === 'after' && candidate.style?.setProperty) {
      candidate.style.setProperty('display', 'none', 'important');
    }
    candidate.setAttribute('data-mpse-native-paste-id', context.pasteId);
    const editId = String(context.locator?.editId || '');
    if (editId) candidate.setAttribute('data-mpse-paste-for', editId);
    releaseNativePasteInputLock(context);
    return candidate;
  }

  async function selectImageForNativePaste(image, editor) {
    const api = getMpEditorApi();
    if (api) {
      try {
        const readiness = await invokeMpEditor('mp_editor_get_isready', undefined, 3000, api);
        if (readiness?.isReady && readiness?.isNew) {
          await invokeMpEditor('mp_editor_set_selection', {
            container: image,
            selectAfter: true
          }, 3000, api);
          return 'mp-editor-jsapi';
        }
      } catch (error) {
        console.warn('[公众号源码排版助手] native selection fallback:', error);
      }
    }

    const doc = editor.ownerDocument;
    const selection = doc.getSelection();
    const range = doc.createRange();
    range.setStartAfter(image);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    editor.focus();
    return 'dom-range';
  }

  function nativePasteEvent(editor, image) {
    const view = editor.ownerDocument.defaultView || window;
    const file = new view.File([image.blob], image.filename, {
      type: image.mimeType,
      lastModified: Date.now()
    });
    const transfer = new view.DataTransfer();
    transfer.items.add(file);

    try {
      return new view.ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        composed: true,
        clipboardData: transfer
      });
    } catch (_) {
      const event = new view.Event('paste', { bubbles: true, cancelable: true, composed: true });
      Object.defineProperty(event, 'clipboardData', { configurable: true, value: transfer });
      return event;
    }
  }

  function nativePasteUnsupported(message) {
    const error = new Error(message || '当前微信编辑器没有接收图片粘贴，请刷新页面后重试');
    error.code = 'MPSE_NATIVE_IMAGE_PASTE_UNSUPPORTED';
    return error;
  }

  function waitForNativePastedImage(context, epoch, pasteEvent) {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const uploadDeadline = startedAt + 90000;
      let deadline = startedAt + 5000;
      let settled = false;
      let pollTimer = 0;

      const cleanup = () => {
        observer.disconnect();
        if (pollTimer) window.clearTimeout(pollTimer);
      };

      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };

      const inspect = () => {
        if (settled) return;
        if (
          editorInputEpoch !== epoch
          || context.revision !== editorWriteRevision
        ) {
          finish(reject, contentConflict('native-image-paste'));
          return;
        }
        const candidate = claimNativePasteCandidate(context);
        const candidateSource = imageSource(candidate);
        if (candidateSource && candidateSource !== context.originalSource) {
          finish(resolve, candidate);
          return;
        }
        const pendingPlaceholder = Boolean(
          candidate
          && !candidateSource
          && (
            context.ownedPlacement === 'after'
            || rawImageSource(candidate) !== context.originalRawSource
          )
        );
        if (pendingPlaceholder) {
          deadline = Math.max(deadline, uploadDeadline);
        }
        if (Date.now() >= deadline) {
          finish(reject, nativePasteUnsupported('微信编辑器未在等待窗口内完成图片粘贴上传'));
          return;
        }
        pollTimer = window.setTimeout(inspect, 120);
      };

      const observer = new MutationObserver(inspect);
      observer.observe(context.editor, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['src', 'data-src', 'data-fileid', 'data-mediaid']
      });
      inspect();
      try {
        const dispatched = context.editor.dispatchEvent(pasteEvent);
        if (dispatched === false || pasteEvent.defaultPrevented) {
          deadline = uploadDeadline;
        }
        inspect();
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  function contentHasImageSource(content, cdnUrl) {
    const container = document.createElement('div');
    container.innerHTML = String(content || '');
    return Array.from(container.querySelectorAll('img')).some((image) => (
      imageSource(image) === cdnUrl || imageMatchesWechatAsset(image, cdnUrl)
    ));
  }

  async function confirmPastedImageInContent(cdnUrl, epoch, baseline, context) {
    const deadline = Date.now() + 10000;
    for (;;) {
      if (
        editorInputEpoch !== epoch
        || context.revision !== editorWriteRevision
      ) throw contentConflict('native-image-paste');
      const api = baseline.mode === 'mp-editor-jsapi' ? getMpEditorApi() : null;
      const result = api
        ? await getContent({ api, allowFallback: false, timeoutMs: 3000 })
        : fallbackGetContent(context.editor);
      if (
        editorInputEpoch !== epoch
        || context.revision !== editorWriteRevision
      ) throw contentConflict(result.mode);
      if (baseline.articleKey && result.articleKey !== baseline.articleKey) {
        throw contentConflict(result.mode);
      }
      if (contentHasImageSource(result.content, cdnUrl)) return result;
      if (Date.now() >= deadline) {
        throw nativePasteUnsupported('微信编辑器已生成图片，但正文模型尚未确认该图片');
      }
      await new Promise((resolve) => window.setTimeout(resolve, 160));
    }
  }

  function removeEmptyPasteWrapper(image, editor) {
    const parent = image?.parentElement;
    image?.remove();
    if (
      parent
      && parent !== editor
      && /^(?:P|FIGURE|SECTION)$/.test(parent.tagName)
      && !parent.textContent.trim()
      && !parent.querySelector('img,svg,video,canvas')
    ) {
      parent.remove();
    }
  }

  function restoreLivePasteContext(context) {
    const anchor = currentPasteAnchor(context);
    for (const candidate of scopedPasteCandidates(context)) {
      if (candidate === anchor) continue;
      removeEmptyPasteWrapper(candidate, context.editor);
    }
    if (anchor) {
      syncNativeImageAttributes(anchor, context.originalAttributes);
      anchor.removeAttribute('data-mpse-native-paste-id');
      anchor.removeAttribute('data-mpse-paste-for');
    }
    dispatchEditorEvents(context.editor, '');
  }

  function restoreKnownPasteCandidate(context, candidate, placement = '') {
    if (!candidate || candidate.isConnected === false) return false;
    if (
      typeof context.editor?.contains === 'function'
      && !context.editor.contains(candidate)
    ) return false;

    const replacesAnchor = placement === 'replace'
      || (!placement && candidate === currentPasteAnchor(context));
    if (replacesAnchor) {
      syncNativeImageAttributes(candidate, context.originalAttributes);
      candidate.removeAttribute('data-mpse-native-paste-id');
      candidate.removeAttribute('data-mpse-paste-for');
    } else {
      removeEmptyPasteWrapper(candidate, context.editor);
    }
    dispatchEditorEvents(context.editor, '');
    return true;
  }

  async function rollbackNativePaste(baseline, context, epoch, candidate = null, placement = '') {
    if (editorInputEpoch !== epoch) {
      restoreKnownPasteCandidate(context, candidate, placement);
      return false;
    }
    try {
      restoreLivePasteContext(context);
      const api = baseline.mode === 'mp-editor-jsapi' ? getMpEditorApi() : null;
      const current = api
        ? await getContent({ api, allowFallback: false, timeoutMs: 3000 })
        : fallbackGetContent(context.editor);
      if (current.articleKey !== baseline.articleKey) return false;
      if (current.content === baseline.content) return true;
      await setContent(
        baseline.content,
        current.content,
        current.mode,
        baseline.articleKey
      );
      return true;
    } catch (error) {
      console.warn('[公众号源码排版助手] native paste rollback failed:', error);
      return false;
    }
  }

  async function pasteImageThroughEditor(payload, revision) {
    const sourceImage = validatedImagePayload(payload);
    const epoch = await waitForEditorInputIdle();
    const editor = findEditorElement();
    if (!editor) throw new Error('没有找到可接收图片粘贴的正文编辑区');
    const locator = payload?.locator || {};
    const target = locateImageForPaste(editor, locator);
    if (!target) throw new Error('原图已经变化，无法安全执行图片替换');

    const api = getMpEditorApi();
    const baseline = api
      ? await getContent({ api, allowFallback: false, timeoutMs: 3000 })
      : fallbackGetContent(editor);
    if (
      editorInputEpoch !== epoch
      || revision !== editorWriteRevision
    ) throw contentConflict(baseline.mode);
    const pasteId = `mpse-paste-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const context = createNativePasteContext(editor, target, locator, revision, pasteId);
    const selectionMode = await selectImageForNativePaste(target, editor);
    if (
      editorInputEpoch !== epoch
      || revision !== editorWriteRevision
    ) throw contentConflict('native-image-paste');
    const event = nativePasteEvent(editor, sourceImage);
    let pasted = null;
    let cdnUrl = '';
    let sourceAttributes = {};
    let placement = 'after';
    let rollbackAttempted = false;
    let rolledBack = false;
    acquireNativePasteInputLock(context);
    try {
      pasted = await waitForNativePastedImage(context, epoch, event);
      placement = context.ownedPlacement
        || (pasted === currentPasteAnchor(context) ? 'replace' : 'after');
      cdnUrl = imageSource(pasted);
      if (!cdnUrl) throw nativePasteUnsupported('微信编辑器生成的图片缺少有效 CDN 地址');
      pasted.setAttribute('data-mpse-native-paste-id', pasteId);
      const editId = String(locator.editId || '');
      if (editId) pasted.setAttribute('data-mpse-paste-for', editId);
      dispatchEditorEvents(editor, '');
      await confirmPastedImageInContent(cdnUrl, epoch, baseline, context);
      sourceAttributes = nativeImageAttributes(pasted);
      if (placement !== 'after') {
        rollbackAttempted = true;
        rolledBack = await rollbackNativePaste(baseline, context, epoch, pasted, placement);
        if (!rolledBack) {
          throw nativePasteUnsupported('微信编辑器替换了原图，且无法安全恢复原图');
        }
        throw nativePasteUnsupported('微信编辑器没有在原图后创建独立上传载体');
      }
    } catch (error) {
      if (!pasted) {
        pasted = ownedNativePasteCandidate(context);
        if (
          !pasted
          && editorInputEpoch === epoch
          && context.revision === editorWriteRevision
        ) pasted = claimNativePasteCandidate(context);
        cdnUrl = imageSource(pasted);
        if (pasted) placement = context.ownedPlacement
          || (pasted === currentPasteAnchor(context) ? 'replace' : 'after');
      }
      if (!rollbackAttempted) {
        rollbackAttempted = true;
        rolledBack = await rollbackNativePaste(baseline, context, epoch, pasted, placement);
      }
      if (!rolledBack && cdnUrl) {
        error.pasteCandidate = {
          pasteId,
          cdnUrl,
          articleKey: baseline.articleKey,
          placement,
          originalAttributes: context.originalAttributes
        };
        schedulePastedImageCleanup({
          ...error.pasteCandidate,
          expectedArticleKey: baseline.articleKey,
          locator
        });
      }
      throw error;
    } finally {
      releaseNativePasteInputLock(context);
    }

    return {
      pasteId,
      cdnUrl,
      sourceAttributes,
      mimeType: sourceImage.mimeType,
      channel: 'editor-paste',
      selectionMode,
      articleKey: baseline.articleKey,
      placement: 'after',
      cleanupPending: true
    };
  }

  function findPastedImageForDiscard(root, payload) {
    const images = Array.from(root?.querySelectorAll?.('img') || [])
      .filter((image) => image?.isConnected !== false);
    const pasteId = String(payload?.pasteId || '');
    const locator = payload?.locator || {};
    const target = locateImageForPaste(root, locator);
    const marked = pasteId
      ? images.find((image) => image.getAttribute('data-mpse-native-paste-id') === pasteId)
      : null;
    const cdnUrl = normalizedWechatCdnUrl(payload?.cdnUrl);

    if (payload?.placement === 'replace') {
      if (marked) return marked;
      if (!cdnUrl) return null;
      if (target && imageMatchesWechatAsset(target, cdnUrl)) return target;
      const index = Number(locator.index);
      const indexed = Number.isInteger(index) && index >= 0 ? images[index] || null : null;
      return indexed && imageMatchesWechatAsset(indexed, cdnUrl) ? indexed : null;
    }

    if (marked) return marked;
    if (!cdnUrl) return null;
    if (target) {
      const targetIndex = images.indexOf(target);
      const adjacent = targetIndex >= 0 ? images[targetIndex + 1] : null;
      if (adjacent && imageMatchesWechatAsset(adjacent, cdnUrl)) return adjacent;
    }

    const index = Number(locator.index);
    if (!Number.isInteger(index) || index < 0) return null;
    const indexedTarget = images[index] || null;
    const indexedCandidate = images[index + 1] || null;
    return indexedTarget && indexedCandidate && imageMatchesWechatAsset(indexedCandidate, cdnUrl)
      ? indexedCandidate
      : null;
  }

  async function discardPastedImage(payload) {
    await waitForEditorInputIdle();
    const editor = findEditorElement();
    if (!editor) throw new Error('没有找到可清理粘贴图片的正文编辑区');
    const api = getMpEditorApi();
    const current = api
      ? await getContent({ api, allowFallback: false, timeoutMs: 3000 })
      : fallbackGetContent(editor);
    const expectedArticleKey = String(payload?.expectedArticleKey || '');
    if (expectedArticleKey && current.articleKey !== expectedArticleKey) {
      throw contentConflict(current.mode);
    }
    const placement = payload?.placement === 'replace' ? 'replace' : 'after';
    const originalAttributes = normalizedNativeAttributeRecord(payload?.originalAttributes);
    const originalSource = normalizedImageUrl(
      originalAttributes['data-src'] || originalAttributes.src
    );
    if (placement === 'replace' && !originalSource) {
      return { changed: false, confirmedAbsent: false };
    }

    let liveChanged = false;
    const liveCandidate = findPastedImageForDiscard(editor, payload);
    if (liveCandidate) {
      if (placement === 'replace') {
        syncNativeImageAttributes(liveCandidate, originalAttributes);
        liveCandidate.removeAttribute('data-mpse-native-paste-id');
        liveCandidate.removeAttribute('data-mpse-paste-for');
      } else {
        removeEmptyPasteWrapper(liveCandidate, editor);
      }
      dispatchEditorEvents(editor, '');
      liveChanged = true;
    }

    const container = document.createElement('div');
    container.innerHTML = current.content;
    const candidate = findPastedImageForDiscard(container, payload);
    if (!candidate) {
      const target = locateImageForPaste(container, payload?.locator || {});
      if (payload?.placement !== 'replace' && target) {
        return { changed: liveChanged, confirmedAbsent: true };
      }
      const cdnUrl = normalizedWechatCdnUrl(payload?.cdnUrl);
      const sourceStillPresent = Boolean(cdnUrl) && Array.from(container.querySelectorAll('img'))
        .some((image) => imageMatchesWechatAsset(image, cdnUrl));
      return {
        changed: liveChanged,
        confirmedAbsent: Boolean(cdnUrl && !sourceStillPresent)
      };
    }
    if (placement === 'replace') {
      syncNativeImageAttributes(candidate, originalAttributes);
      candidate.removeAttribute('data-mpse-native-paste-id');
      candidate.removeAttribute('data-mpse-paste-for');
    } else {
      removeEmptyPasteWrapper(candidate, container);
    }
    await setContent(
      container.innerHTML,
      current.content,
      current.mode,
      current.articleKey
    );
    return { changed: true, confirmedAbsent: true };
  }

  function enqueueNativeImagePaste(payload) {
    return enqueueEditorWrite((revision) => pasteImageThroughEditor(payload, revision));
  }

  const pendingPastedImageCleanups = new Map();

  function pastedImageCleanupKey(payload) {
    return [
      String(payload?.expectedArticleKey || ''),
      String(payload?.pasteId || ''),
      normalizedWechatCdnUrl(payload?.cdnUrl)
    ].join('|');
  }

  function forgetPastedImageCleanup(key) {
    const entry = pendingPastedImageCleanups.get(key);
    if (entry?.timer) window.clearTimeout(entry.timer);
    pendingPastedImageCleanups.delete(key);
  }

  function schedulePastedImageCleanup(payload) {
    const key = pastedImageCleanupKey(payload);
    if (key === '||') return false;
    let entry = pendingPastedImageCleanups.get(key);
    if (!entry) {
      entry = {
        payload,
        attempts: 0,
        createdAt: Date.now(),
        timer: 0
      };
      pendingPastedImageCleanups.set(key, entry);
    }
    if (entry.timer) return true;
    const delay = Math.min(30000, 1000 * (2 ** Math.min(entry.attempts, 5)));
    entry.timer = window.setTimeout(async () => {
      entry.timer = 0;
      if (Date.now() - entry.createdAt > 15 * 60 * 1000) {
        console.warn('[公众号源码排版助手] pasted image cleanup expired:', entry.payload);
        forgetPastedImageCleanup(key);
        return;
      }
      entry.attempts += 1;
      try {
        const result = await enqueueEditorWrite(
          () => discardPastedImage(entry.payload),
          { invalidateRevision: false }
        );
        if (result.changed || result.confirmedAbsent) {
          forgetPastedImageCleanup(key);
          return;
        }
      } catch (error) {
        console.warn('[公众号源码排版助手] pasted image cleanup retry failed:', error);
      }
      schedulePastedImageCleanup(entry.payload);
    }, delay);
    return true;
  }

  function enqueuePastedImageDiscard(payload) {
    return enqueueEditorWrite(async () => {
      const key = pastedImageCleanupKey(payload);
      try {
        const result = await discardPastedImage(payload);
        if (result.changed || result.confirmedAbsent) {
          forgetPastedImageCleanup(key);
          return result;
        }
        return {
          ...result,
          cleanupScheduled: schedulePastedImageCleanup(payload)
        };
      } catch (error) {
        if (!schedulePastedImageCleanup(payload)) throw error;
        return {
          changed: false,
          confirmedAbsent: false,
          cleanupScheduled: true,
          error: asErrorPayload(error)
        };
      }
    }, { invalidateRevision: false });
  }

  function postResponse(requestId, type, ok, data, error) {
    window.postMessage({
      source: PAGE_SOURCE,
      requestId,
      type,
      ok,
      data: data || null,
      error: error ? asErrorPayload(error) : null
    }, '*');
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message.source !== CONTENT_SOURCE || !message.requestId) return;

    const { requestId, type, payload } = message;

    try {
      if (type === 'PING') {
        postResponse(requestId, 'PONG', true, {
          hasMpEditorApi: Boolean(getMpEditorApi()),
          url: location.href
        });
        return;
      }

      if (type === 'GET_CONTENT') {
        await waitForPendingSetContent();
        const result = await getContent();
        postResponse(requestId, 'GET_CONTENT_RESULT', true, result);
        return;
      }

      if (type === 'SET_CONTENT') {
        const html = payload && typeof payload.content === 'string' ? payload.content : '';
        const expectedContent = payload && typeof payload.expectedContent === 'string'
          ? payload.expectedContent
          : null;
        const expectedMode = payload && typeof payload.expectedMode === 'string' ? payload.expectedMode : '';
        const expectedArticleKey = payload && typeof payload.expectedArticleKey === 'string'
          ? payload.expectedArticleKey
          : '';
        const result = await enqueueSetContent(html, expectedContent, expectedMode, expectedArticleKey);
        postResponse(requestId, 'SET_CONTENT_RESULT', true, result);
        return;
      }

      if (type === 'PASTE_IMAGE') {
        const result = await enqueueNativeImagePaste(payload || {});
        postResponse(requestId, 'PASTE_IMAGE_RESULT', true, result);
        return;
      }

      if (type === 'DISCARD_PASTED_IMAGE') {
        const result = await enqueuePastedImageDiscard(payload || {});
        postResponse(requestId, 'DISCARD_PASTED_IMAGE_RESULT', true, result);
        return;
      }

      throw new Error(`未知消息类型：${type}`);
    } catch (error) {
      postResponse(requestId, `${type}_ERROR`, false, null, error);
    }
  });

  window.postMessage({
    source: PAGE_SOURCE,
    type: 'BRIDGE_READY',
    ok: true,
    data: {
      hasMpEditorApi: Boolean(getMpEditorApi()),
      url: location.href
    }
  }, '*');
})();
