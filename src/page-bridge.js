(() => {
  'use strict';

  const CONTENT_SOURCE = 'wechat-mp-source-layout:content';
  const PAGE_SOURCE = 'wechat-mp-source-layout:page';

  if (window.__MP_SOURCE_EDITOR_BRIDGE_INSTALLED__) {
    return;
  }
  window.__MP_SOURCE_EDITOR_BRIDGE_INSTALLED__ = true;

  function asErrorPayload(error) {
    if (!error) {
      return { message: '未知错误' };
    }
    return {
      name: error.name || 'Error',
      message: error.message || String(error),
      stack: error.stack || ''
    };
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

  function invokeMpEditor(apiName, apiParam) {
    const api = getMpEditorApi();
    if (!api) {
      return Promise.reject(new Error('页面中没有检测到 __MP_Editor_JSAPI__'));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`${apiName} 调用超时`));
      }, 10000);

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
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
      '#ueditor_0',
      '#js_editorArea',
      '#js_content',
      '.rich_media_content',
      '.ProseMirror',
      '.ql-editor',
      '[contenteditable="true"]',
      'body[contenteditable="true"]'
    ];

    const candidates = [];

    for (const doc of getAccessibleDocuments()) {
      for (const selector of selectors) {
        const nodes = Array.from(doc.querySelectorAll(selector));
        for (const node of nodes) {
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

  function fallbackGetContent() {
    const editor = findEditorElement();
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

  function fallbackSetContent(content) {
    const editor = findEditorElement();
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

  async function getContent() {
    try {
      const response = await invokeMpEditor('mp_editor_get_content');
      return {
        content: normalizeContentResponse(response),
        mode: 'mp-editor-jsapi'
      };
    } catch (apiError) {
      const fallback = fallbackGetContent();
      fallback.apiError = asErrorPayload(apiError);
      return fallback;
    }
  }

  async function setContent(content) {
    try {
      const response = await invokeMpEditor('mp_editor_set_content', { content });
      return {
        response,
        mode: 'mp-editor-jsapi'
      };
    } catch (apiError) {
      const fallback = fallbackSetContent(content);
      fallback.apiError = asErrorPayload(apiError);
      return fallback;
    }
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
        const result = await getContent();
        postResponse(requestId, 'GET_CONTENT_RESULT', true, result);
        return;
      }

      if (type === 'SET_CONTENT') {
        const html = payload && typeof payload.content === 'string' ? payload.content : '';
        const result = await setContent(html);
        postResponse(requestId, 'SET_CONTENT_RESULT', true, result);
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
