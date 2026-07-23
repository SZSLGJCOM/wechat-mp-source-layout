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
  const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

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

  function fallbackGetContent(editor = findEditorElement()) {
    if (!editor) {
      throw new Error('没有找到可编辑正文区域');
    }
    return {
      content: editor.innerHTML || '',
      mode: 'dom-fallback'
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
    return { mode: 'dom-fallback' };
  }

  async function getContent(options = {}) {
    const api = options.api || getMpEditorApi();
    if (api) {
      try {
        const response = await invokeMpEditor('mp_editor_get_content', undefined, options.timeoutMs || 10000, api);
        return {
          content: normalizeContentResponse(response),
          mode: 'mp-editor-jsapi'
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

  function isEditorInputEvent(event, doc) {
    if (event && event.isTrusted === false) return false;
    let target = event && event.target;
    if (target && target.nodeType !== Node.ELEMENT_NODE) target = target.parentElement;
    if (!target) return doc.designMode === 'on';
    if (target.isContentEditable) return true;
    return Boolean(target.closest && target.closest('[contenteditable="true"], body[contenteditable="true"]'));
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
          if (isEditorInputEvent(event, doc)) noteEditorInput();
        }, true);
      }
      doc.addEventListener('compositionstart', (event) => {
        if (isEditorInputEvent(event, doc)) beginComposition();
      }, true);
      doc.addEventListener('compositionupdate', (event) => {
        if (isEditorInputEvent(event, doc)) noteEditorInput();
      }, true);
      doc.addEventListener('compositionend', (event) => {
        if (isEditorInputEvent(event, doc)) endComposition();
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

  async function setContent(content, expectedContent = null, expectedMode = '') {
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
    if (typeof expectedContent === 'string') {
      const current = mode === 'mp-editor-jsapi'
        ? await getContent({ api, allowFallback: false, timeoutMs: 2000 })
        : fallbackGetContent(editor);
      if (current.content !== expectedContent || validationEpoch !== editorInputEpoch
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
    return {
      response,
      mode: 'mp-editor-jsapi'
    };
  }

  function contentConflict(mode) {
    const error = new Error('正文在写入前已发生变化，请基于最新内容重试');
    error.code = CONTENT_CONFLICT_CODE;
    error.mode = mode || 'unknown';
    return error;
  }

  let setContentQueue = Promise.resolve();

  ensureEditorInputTracking();

  function enqueueSetContent(content, expectedContent = null, expectedMode = '') {
    const scheduled = setContentQueue.then(
      () => setContent(content, expectedContent, expectedMode),
      () => setContent(content, expectedContent, expectedMode)
    );
    setContentQueue = scheduled.then(() => undefined, () => undefined);
    return scheduled;
  }

  async function waitForPendingSetContent() {
    await setContentQueue;
    if (writeStateUncertain) throw uncertainWrite();
  }

  let uploadContextCache = null;

  function matchPageValue(source, names) {
    for (const name of names) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = String(source || '').match(new RegExp(`(?:["']?${escaped}["']?)\\s*[:=]\\s*["']([^"']+)["']`, 'i'));
      if (match && match[1]) return match[1];
    }
    return '';
  }

  async function getUploadContext() {
    const pageUrl = new URL(location.href);
    const token = pageUrl.searchParams.get('token') || '';
    if (!/^\d+$/.test(token)) throw new Error('当前编辑页面缺少有效登录令牌');
    if (uploadContextCache?.token === token && uploadContextCache.expiresAt > Date.now()) {
      return uploadContextCache;
    }

    const response = await fetch(`/cgi-bin/masssendpage?t=mass/send&token=${encodeURIComponent(token)}&lang=zh_CN`, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store'
    });
    if (!response.ok) throw new Error(`无法读取微信素材上传参数（HTTP ${response.status}）`);
    const source = await response.text();
    const ticket = matchPageValue(source, ['ticket', 'upload_ticket']);
    const ticketId = matchPageValue(source, ['user_name', 'ticket_id']);
    if (!ticket || !ticketId) throw new Error('微信素材上传参数已失效，请刷新编辑页面后重试');
    uploadContextCache = {
      token,
      ticket,
      ticketId,
      expiresAt: Date.now() + 5 * 60 * 1000
    };
    return uploadContextCache;
  }

  function validatedImagePayload(payload) {
    const bytes = payload?.bytes;
    const mimeType = String(payload?.mimeType || '');
    if (!(bytes instanceof ArrayBuffer)) throw new Error('烘焙图片数据无效');
    if (!['image/png', 'image/jpeg'].includes(mimeType)) throw new Error('只允许上传 PNG 或 JPEG 图片');
    if (!bytes.byteLength || bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error('烘焙图片超过微信 10MB 上传限制');
    const extension = mimeType === 'image/jpeg' ? 'jpg' : 'png';
    const requestedName = String(payload?.filename || '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 80);
    const filename = requestedName && requestedName.toLowerCase().endsWith(`.${extension}`)
      ? requestedName
      : `mpse-image-${Date.now()}.${extension}`;
    return { blob: new Blob([bytes], { type: mimeType }), mimeType, filename };
  }

  async function uploadImage(payload) {
    const image = validatedImagePayload(payload);
    const context = await getUploadContext();
    const query = new URLSearchParams({
      action: 'upload_material',
      f: 'json',
      scene: '1',
      writetype: 'doublewrite',
      groupid: '1',
      ticket_id: context.ticketId,
      ticket: context.ticket,
      svr_time: String(Math.floor(Date.now() / 1000)),
      seq: '1',
      token: context.token,
      lang: 'zh_CN'
    });
    const form = new FormData();
    form.append('file', image.blob, image.filename);
    const response = await fetch(`/cgi-bin/filetransfer?${query}`, {
      method: 'POST',
      credentials: 'same-origin',
      body: form
    });
    if (!response.ok) throw new Error(`微信图片上传失败（HTTP ${response.status}）`);
    const body = await response.json();
    const ret = Number(body?.base_resp?.ret ?? body?.errcode ?? -1);
    if (ret !== 0) {
      const error = new Error(body?.base_resp?.err_msg || body?.errmsg || `微信图片上传失败（${ret}）`);
      error.code = `MPSE_WECHAT_UPLOAD_${ret}`;
      throw error;
    }
    const cdnUrl = String(body?.cdn_url || body?.url || '').trim();
    if (!/^https?:\/\/(?:mmbiz\.qpic\.cn|mmbiz\.qlogo\.cn|m\.qpic\.cn)\//i.test(cdnUrl)) {
      throw new Error('微信上传成功，但没有返回可用于正文的 CDN 地址');
    }
    return {
      cdnUrl,
      fileId: String(body?.content || body?.fileid || ''),
      mimeType: image.mimeType
    };
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
        const result = await enqueueSetContent(html, expectedContent, expectedMode);
        postResponse(requestId, 'SET_CONTENT_RESULT', true, result);
        return;
      }

      if (type === 'UPLOAD_IMAGE') {
        const result = await uploadImage(payload || {});
        postResponse(requestId, 'UPLOAD_IMAGE_RESULT', true, result);
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
