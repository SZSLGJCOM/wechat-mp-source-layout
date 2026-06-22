(() => {
  'use strict';

  const INLINE_ID = 'mpse-inline-panel';
  const VERSION = 'v0.9.4';
  const TOOLBAR_BUTTON_ID = 'mpse-toolbar-button';
  const FLOATING_BUTTON_ID = 'mpse-floating-button';
  const bridgeClient = window.__MPSE_BRIDGE_CLIENT__;
  const injectBridge = bridgeClient && typeof bridgeClient.inject === 'function'
    ? bridgeClient.inject
    : () => false;
  const requestBridge = bridgeClient && typeof bridgeClient.request === 'function'
    ? bridgeClient.request
    : () => Promise.reject(new Error('扩展桥接客户端未加载，请刷新页面后重试'));

  let booted = false;
  let latestEditorMode = 'unknown';
  let lastLoadedHtml = '';

  const state = {
    target: null,
    oldDisplay: '',
    oldVisibility: '',
    lastHtml: '',
    dirty: false,
    saving: false
  };

  function isMpHost() {
    return location.hostname === 'mp.weixin.qq.com';
  }

  function isLikelyEditorPage() {
    if (!isMpHost()) return false;
    if (/\/cgi-bin\/appmsg/.test(location.pathname)) return true;
    if (document.querySelector('.edui-toolbar.edui-toolbar-primary')) return true;
    if (document.querySelector('#js_editorArea, #ueditor_0, [contenteditable="true"]')) return true;
    return false;
  }

  function htmlFormat(source) {
    const raw = String(source || '').trim();
    if (!raw) return '';

    const voidTags = new Set([
      'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
      'link', 'meta', 'param', 'source', 'track', 'wbr'
    ]);

    const tokens = raw
      .replace(/>\s+</g, '><')
      .match(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g) || [];

    const lines = [];
    let indent = 0;
    let i = 0;

    function tagName(token) {
      const match = String(token || '').match(/^<\/?\s*([a-zA-Z0-9:-]+)/);
      return match ? match[1].toLowerCase() : '';
    }

    function isClosing(token) {
      return /^<\//.test(token);
    }

    function isComment(token) {
      return /^<!--/.test(token);
    }

    function isDoctype(token) {
      return /^<!doctype/i.test(token);
    }

    function isSelfClosing(token) {
      const name = tagName(token);
      return /\/>$/.test(token) || voidTags.has(name) || isComment(token) || isDoctype(token);
    }

    function isOpening(token) {
      return /^<[^/!][^>]*>$/.test(token) && !isSelfClosing(token);
    }

    function emit(value, level = indent) {
      lines.push(`${'  '.repeat(Math.max(0, level))}${value}`);
    }

    while (i < tokens.length) {
      const token = String(tokens[i] || '').trim();
      if (!token) {
        i += 1;
        continue;
      }

      const next = String(tokens[i + 1] || '').trim();
      const afterNext = String(tokens[i + 2] || '').trim();
      const name = tagName(token);

      // 让 <span leaf=""><br></span> 这种微信占位结构保持在一行，更接近壹伴的显示。
      if (
        isOpening(token) &&
        /^<br\s*\/?>$/i.test(next) &&
        isClosing(afterNext) &&
        tagName(afterNext) === name
      ) {
        emit(`${token}${next}${afterNext}`);
        i += 3;
        continue;
      }

      if (isClosing(token)) {
        indent -= 1;
        emit(token);
        i += 1;
        continue;
      }

      emit(token);
      if (isOpening(token)) indent += 1;
      i += 1;
    }

    return lines.join('\n');
  }



  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function highlightHtml(source) {
    const raw = String(source || '');

    function emit(type, value) {
      if (!value) return '';
      return `<span class="mpse-token-${type}">${escapeHtml(value)}</span>`;
    }

    function highlightTag(token) {
      let i = 0;
      let out = '';
      const length = token.length;

      if (token.startsWith('</')) {
        out += emit('mark', '</');
        i = 2;
      } else if (token.startsWith('<')) {
        out += emit('mark', '<');
        i = 1;
      }

      while (i < length && /\s/.test(token[i])) {
        out += escapeHtml(token[i]);
        i += 1;
      }

      const nameStart = i;
      while (i < length && /[^\s/>]/.test(token[i])) i += 1;
      if (i > nameStart) out += emit('tag', token.slice(nameStart, i));

      while (i < length) {
        const ch = token[i];

        if (/\s/.test(ch)) {
          out += escapeHtml(ch);
          i += 1;
          continue;
        }

        if (ch === '/' && token[i + 1] === '>') {
          out += emit('mark', '/>');
          i += 2;
          continue;
        }

        if (ch === '>') {
          out += emit('mark', '>');
          i += 1;
          continue;
        }

        if (ch === '=') {
          out += emit('mark', '=');
          i += 1;
          continue;
        }

        if (ch === '"' || ch === "'") {
          const quote = ch;
          const valueStart = i;
          i += 1;
          while (i < length && token[i] !== quote) i += 1;
          if (i < length) i += 1;
          out += emit('string', token.slice(valueStart, i));
          continue;
        }

        const attrStart = i;
        while (i < length && /[^\s=/>]/.test(token[i])) i += 1;
        if (i > attrStart) {
          out += emit('attr', token.slice(attrStart, i));
        } else {
          out += escapeHtml(ch);
          i += 1;
        }
      }

      return out;
    }

    return raw.replace(/(<!--[\s\S]*?-->|<[^>]*>|[^<]+)/g, (token) => {
      if (token.startsWith('<!--')) return emit('comment', token);
      if (token.startsWith('<')) return highlightTag(token);
      return escapeHtml(token);
    });
  }

  function setEditorValue(textarea, html, options = {}) {
    const value = options.raw ? String(html || '') : htmlFormat(html);
    textarea.value = value;
    if (options.toStart !== false) {
      textarea.selectionStart = 0;
      textarea.selectionEnd = 0;
      textarea.scrollTop = 0;
      textarea.scrollLeft = 0;
    }
    return value;
  }

  function setToolbarActive(active) {
    const isActive = Boolean(active);
    const toolbarButton = document.getElementById(TOOLBAR_BUTTON_ID);
    if (toolbarButton) {
      toolbarButton.classList.toggle('mpse-active', isActive);
      toolbarButton.title = isActive ? '原样保存并返回富文本编辑' : '源码模式';
      toolbarButton.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    }

    const floatingButton = document.getElementById(FLOATING_BUTTON_ID);
    if (floatingButton) {
      floatingButton.classList.toggle('mpse-active', isActive);
      floatingButton.textContent = isActive ? '返回' : '源码';
      floatingButton.title = isActive ? '原样保存并返回富文本编辑' : '打开源码模式';
    }
  }
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      const temp = document.createElement('textarea');
      temp.value = text;
      temp.style.position = 'fixed';
      temp.style.opacity = '0';
      document.body.appendChild(temp);
      temp.focus();
      temp.select();
      const ok = document.execCommand('copy');
      temp.remove();
      return ok;
    }
  }

  function isExtensionElement(node) {
    if (!node || !node.closest) return false;
    return Boolean(node.closest(`#${INLINE_ID}, #${TOOLBAR_BUTTON_ID}, #${FLOATING_BUTTON_ID}`));
  }

  function isVisibleElement(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    if (isExtensionElement(element)) return false;

    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;

    const rect = element.getBoundingClientRect();
    return rect.width >= 260 && rect.height >= 120;
  }

  function findEditorMountTarget() {
    const selectors = [
      '#ueditor_0',
      'iframe[id*="ueditor"]',
      'iframe[name*="ueditor"]',
      '.edui-editor-iframeholder iframe',
      '.edui-editor-body',
      '.edui-editor-iframeholder',
      '#js_editorArea',
      '#js_content',
      '.rich_media_content',
      '.ProseMirror',
      '.ql-editor',
      '[contenteditable="true"]'
    ];

    const candidates = [];
    for (const selector of selectors) {
      const nodes = Array.from(document.querySelectorAll(selector));
      for (const node of nodes) {
        if (!isVisibleElement(node)) continue;

        const rect = node.getBoundingClientRect();
        const id = node.id || '';
        const className = typeof node.className === 'string' ? node.className : '';
        const htmlLength = node.innerHTML ? node.innerHTML.length : 0;
        const textLength = node.textContent ? node.textContent.length : 0;

        const idBoost = /ueditor|editor|js_content|js_editorArea/i.test(id) ? 4000 : 0;
        const classBoost = /edui-editor-body|iframeholder|rich_media_content|ProseMirror|ql-editor/i.test(className) ? 3000 : 0;
        const editableBoost = node.getAttribute('contenteditable') === 'true' ? 1800 : 0;
        const iframeBoost = node.tagName === 'IFRAME' ? 1800 : 0;
        const sizeScore = rect.width + rect.height;
        const contentScore = htmlLength + textLength;

        candidates.push({
          node,
          score: idBoost + classBoost + editableBoost + iframeBoost + sizeScore + contentScore
        });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0] ? candidates[0].node : null;
  }

  function getPanel() {
    return document.getElementById(INLINE_ID);
  }

  function getTextarea() {
    const panel = getPanel();
    return panel ? panel.querySelector('.mpse-inline-editor') : null;
  }

  function showStatus(text, type = '') {
    const panel = getPanel();
    if (!panel) return;

    const status = panel.querySelector('.mpse-inline-status');
    if (!status) return;

    status.textContent = text || '';
    status.classList.remove('mpse-ok', 'mpse-error');
    if (type === 'ok') status.classList.add('mpse-ok');
    if (type === 'error') status.classList.add('mpse-error');
  }

  function setBusy(isBusy, text) {
    const panel = getPanel();
    if (!panel) return;

    panel.classList.toggle('mpse-busy', Boolean(isBusy));
    const loading = panel.querySelector('.mpse-inline-loading');
    if (loading && text) loading.textContent = text;
  }

  function updateCounter() {
    const panel = getPanel();
    const textarea = getTextarea();
    if (!panel || !textarea) return;

    const counter = panel.querySelector('.mpse-inline-counter');
    if (!counter) return;

    const value = textarea.value || '';
    const lineCount = Math.max(1, value.split('\n').length);
    counter.textContent = `${lineCount} 行 · ${value.length} 字符 · ${latestEditorMode}`;
  }

  function syncLineNumbers() {
    const panel = getPanel();
    const textarea = getTextarea();
    if (!panel || !textarea) return;

    const lines = panel.querySelector('.mpse-inline-lines');
    const highlightLayer = panel.querySelector('.mpse-highlight-layer');
    const highlightCode = panel.querySelector('.mpse-highlight-code');

    const value = textarea.value || '';
    const count = Math.max(1, value.split('\n').length);
    const numbers = [];
    for (let i = 1; i <= count; i += 1) numbers.push(String(i));

    if (lines) {
      lines.textContent = numbers.join('\n');
      lines.scrollTop = textarea.scrollTop;
    }

    const wrap = panel.querySelector('.mpse-inline-code-wrap');
    if (wrap) {
      const lineHeight = 25.35;
      const minHeight = 160;
      const maxHeight = Math.max(280, Math.min(720, window.innerHeight - 260));
      const height = Math.min(Math.max(minHeight, count * lineHeight + 24), maxHeight);
      wrap.style.height = `${height}px`;
    }

    if (highlightCode) {
      highlightCode.innerHTML = highlightHtml(value) + (value.endsWith('\n') ? '\n' : '');
    }

    if (highlightLayer) {
      highlightLayer.scrollTop = textarea.scrollTop;
      highlightLayer.scrollLeft = textarea.scrollLeft;
    }

    updateCounter();
  }

  function markDirty() {
    state.dirty = true;
    const panel = getPanel();
    if (panel) panel.classList.add('mpse-dirty');
    syncLineNumbers();
  }

  function markClean(html) {
    state.lastHtml = html;
    state.dirty = false;
    const panel = getPanel();
    if (panel) panel.classList.remove('mpse-dirty');
    syncLineNumbers();
  }

  function hideTarget(target) {
    state.target = target;
    state.oldDisplay = target.style.display || '';
    state.oldVisibility = target.style.visibility || '';
    target.dataset.mpseHiddenBySourceEditor = '1';
    target.style.display = 'none';
  }

  function showTargetTemporarily() {
    const target = state.target;
    if (!target || !document.contains(target)) return null;

    const previousDisplay = target.style.display;
    const previousVisibility = target.style.visibility;

    target.style.display = state.oldDisplay || '';
    target.style.visibility = state.oldVisibility || '';

    return () => {
      if (!document.contains(target)) return;
      target.style.display = previousDisplay;
      target.style.visibility = previousVisibility;
    };
  }

  function restoreTarget() {
    const target = state.target;
    if (target && document.contains(target)) {
      target.style.display = state.oldDisplay || '';
      target.style.visibility = state.oldVisibility || '';
      delete target.dataset.mpseHiddenBySourceEditor;
    }

    state.target = null;
    state.oldDisplay = '';
    state.oldVisibility = '';
    state.lastHtml = '';
    state.dirty = false;
  }

  function createInlinePanel(target) {
    const existing = getPanel();
    if (existing) return existing;

    const panel = document.createElement('div');
    panel.id = INLINE_ID;
    panel.innerHTML = `
      <div class="mpse-inline-editor-shell">
        <div class="mpse-inline-code-wrap" title="再次点击工具栏 HTML：有修改则原样保存并返回；无修改则直接返回">
          <pre class="mpse-inline-lines" aria-hidden="true">1</pre>
          <div class="mpse-code-stage">
            <pre class="mpse-highlight-layer" aria-hidden="true"><code class="mpse-highlight-code"></code></pre>
            <textarea class="mpse-inline-editor" spellcheck="false" placeholder="正在读取微信公众号正文 HTML..." aria-label="微信公众号正文 HTML 源码"></textarea>
          </div>
          <div class="mpse-inline-loading">处理中...</div>
        </div>
      </div>
    `;

    target.insertAdjacentElement('afterend', panel);

    const textarea = panel.querySelector('.mpse-inline-editor');
    const lineBox = panel.querySelector('.mpse-inline-lines');

    textarea.addEventListener('input', markDirty);
    textarea.addEventListener('scroll', () => {
      const highlightLayer = panel.querySelector('.mpse-highlight-layer');
      if (lineBox) lineBox.scrollTop = textarea.scrollTop;
      if (highlightLayer) {
        highlightLayer.scrollTop = textarea.scrollTop;
        highlightLayer.scrollLeft = textarea.scrollLeft;
      }
    });
    textarea.addEventListener('keydown', async (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        await saveInline(false);
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        await saveInline(true);
        return;
      }

      if (event.key === 'Tab') {
        event.preventDefault();
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const value = textarea.value;
        textarea.value = `${value.slice(0, start)}  ${value.slice(end)}`;
        textarea.selectionStart = textarea.selectionEnd = start + 2;
        markDirty();
      }
    });

    panel.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-mpse-action]');
      if (!button) return;

      const action = button.dataset.mpseAction;
      if (action === 'reload') {
        await reloadInline();
        return;
      }
      if (action === 'format') {
        setEditorValue(textarea, textarea.value, { toStart: false });
        markDirty();
        showStatus('已格式化。建议再检查 section / p / span 层级。', 'ok');
        return;
      }
      if (action === 'copy') {
        const ok = await copyText(textarea.value || '');
        showStatus(ok ? '源码已复制。' : '复制失败，请手动复制。', ok ? 'ok' : 'error');
        return;
      }
      if (action === 'save') {
        await saveInline(false);
        return;
      }
      if (action === 'save-close') {
        await saveInline(true);
        return;
      }
      if (action === 'close') {
        closeInline();
      }
    });

    return panel;
  }

  async function openInline() {
    injectBridge();

    const existing = getPanel();
    if (existing) {
      if (existing.classList.contains('mpse-busy')) return;
      const textarea = getTextarea();
      if (!textarea || !state.dirty || textarea.value === state.lastHtml) {
        closeInline({ force: true });
        return;
      }
      await saveInline(true);
      return;
    }

    const target = findEditorMountTarget();
    if (!target) {
      window.alert('没有找到微信公众号正文编辑区。请等页面加载完成后再试。');
      return;
    }

    const panel = createInlinePanel(target);
    const textarea = getTextarea();
    setToolbarActive(true);

    setBusy(true, '正在读取微信公众号正文 HTML...');
    showStatus('正在读取...');

    try {
      const result = await requestBridge('GET_CONTENT');
      latestEditorMode = result.mode || 'unknown';
      lastLoadedHtml = typeof result.content === 'string' ? result.content : '';
      const visibleHtml = setEditorValue(textarea, lastLoadedHtml);
      markClean(visibleHtml);
      syncLineNumbers();
      hideTarget(target);
      panel.scrollIntoView({ block: 'center' });
      textarea.focus();

      if (result.apiError) {
        showStatus(`已用 DOM 兜底读取。原生 API 错误：${result.apiError.message}`, 'ok');
      } else {
        showStatus(`读取成功 · ${latestEditorMode} · ${VERSION}`, 'ok');
      }
    } catch (error) {
      panel.remove();
      restoreTarget();
      window.alert(`读取失败：${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function reloadInline() {
    const textarea = getTextarea();
    if (!textarea) return;

    if (state.dirty && textarea.value !== state.lastHtml) {
      const ok = window.confirm('当前源码有未保存修改，重新读取会覆盖这些修改。确定继续吗？');
      if (!ok) return;
    }

    const restore = showTargetTemporarily();
    setBusy(true, '正在重新读取微信公众号正文...');
    showStatus('正在重新读取...');

    try {
      const result = await requestBridge('GET_CONTENT');
      latestEditorMode = result.mode || 'unknown';
      lastLoadedHtml = typeof result.content === 'string' ? result.content : '';
      const visibleHtml = setEditorValue(textarea, lastLoadedHtml);
      markClean(visibleHtml);
      syncLineNumbers();
      textarea.focus();

      if (result.apiError) {
        showStatus(`已用 DOM 兜底读取。原生 API 错误：${result.apiError.message}`, 'ok');
      } else {
        showStatus(`重新读取成功，模式：${latestEditorMode} · ${VERSION}`, 'ok');
      }
    } catch (error) {
      showStatus(`读取失败：${error.message}`, 'error');
    } finally {
      if (restore) restore();
      setBusy(false);
    }
  }

  async function saveInline(closeAfter) {
    const panel = getPanel();
    const textarea = getTextarea();
    if (!panel || !textarea || state.saving || panel.classList.contains('mpse-busy')) return;

    const html = textarea.value || '';

    // 不做任何隐藏清理、不做危险标签判断、不自动改写源码。
    // 用户在源码框里看到什么，就原样写回微信公众号编辑器。
    if (!state.dirty && html === state.lastHtml) {
      if (closeAfter) closeInline({ force: true });
      return;
    }

    state.saving = true;
    const restore = showTargetTemporarily();
    let closed = false;
    setBusy(true, closeAfter ? '正在保存并返回...' : '正在保存...');
    showStatus('正在原样写回源码...');

    try {
      const result = await requestBridge('SET_CONTENT', { content: html });
      latestEditorMode = result.mode || latestEditorMode;
      lastLoadedHtml = html;
      markClean(html);
      syncLineNumbers();

      if (result.apiError) {
        showStatus(`已用 DOM 兜底保存。原生 API 错误：${result.apiError.message}`, 'ok');
      } else {
        showStatus(`保存成功：已原样写回源码。模式：${latestEditorMode}`, 'ok');
      }

      if (closeAfter) {
        closed = true;
        closeInline({ force: true });
      }
    } catch (error) {
      showStatus(`保存失败：${error.message}`, 'error');
    } finally {
      if (!closed && restore) restore();
      state.saving = false;
      setBusy(false);
    }
  }

  function closeInline(options = {}) {
    const panel = getPanel();
    const textarea = getTextarea();

    if (!options.force && panel && textarea && state.dirty && textarea.value !== state.lastHtml) {
      const ok = window.confirm('源码有未保存修改，确定退出源码模式吗？');
      if (!ok) return;
    }

    if (panel) panel.remove();
    restoreTarget();
    setToolbarActive(false);
  }

  function createToolbarButton(toolbar) {
    if (!toolbar || document.getElementById(TOOLBAR_BUTTON_ID)) return;

    const button = document.createElement('div');
    button.id = TOOLBAR_BUTTON_ID;
    button.className = 'edui-box edui-button edui-default edui-for-mpse-html';
    button.title = '源码模式';
    button.textContent = 'HTML';
    button.addEventListener('click', openInline);
    toolbar.appendChild(button);
  }

  function createFloatingButton() {
    if (document.getElementById(FLOATING_BUTTON_ID)) return;

    const button = document.createElement('button');
    button.id = FLOATING_BUTTON_ID;
    button.type = 'button';
    button.textContent = '源码';
    button.title = '打开源码模式';
    button.addEventListener('click', openInline);
    document.body.appendChild(button);
  }

  function ensureButtons() {
    if (!isLikelyEditorPage()) return;

    const toolbar = document.querySelector('.edui-toolbar.edui-toolbar-primary');
    if (toolbar) {
      const floating = document.getElementById(FLOATING_BUTTON_ID);
      if (floating) floating.remove();
      createToolbarButton(toolbar);
    } else {
      createFloatingButton();
    }
  }

  function boot() {
    if (booted || !isMpHost()) return;
    booted = true;

    injectBridge();
    ensureButtons();

    const observer = new MutationObserver(() => ensureButtons());
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    window.setInterval(ensureButtons, 2500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
