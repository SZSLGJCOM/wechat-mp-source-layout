(() => {
  'use strict';

  const ROOT_ID = 'mpse-mobile-preview';
  const FRAME_ID = 'mpse-mobile-preview-frame';
  const ARTICLE_WIDTH = 440;
  const RENDER_DELAY_MS = 120;
  const REBIND_INTERVAL_MS = 2500;
  const DANGEROUS_ELEMENTS = [
    'script', 'iframe', 'object', 'embed', 'frame', 'frameset',
    'form', 'input', 'button', 'textarea', 'select', 'option',
    'link', 'meta', 'base'
  ].join(',');
  const URL_ATTRIBUTES = new Set([
    'href', 'src', 'xlink:href', 'action', 'formaction', 'poster', 'background'
  ]);

  const state = {
    root: null,
    frame: null,
    renderTimer: 0,
    fingerprint: '',
    sourceFingerprint: '',
    documentObservers: new Map()
  };

  function isEditorPage() {
    return location.hostname === 'mp.weixin.qq.com'
      && /^\/cgi-bin\/appmsg(?:\/|$)/.test(location.pathname);
  }

  function readFrameDocument(frame) {
    try {
      return frame.contentDocument || null;
    } catch (_) {
      return null;
    }
  }

  function isOwnPreviewNode(node) {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    return Boolean(element?.closest?.(
      `#${ROOT_ID}, #mpse-inline-panel .mpse-highlight-layer, #mpse-inline-panel .mpse-inline-lines`
    ));
  }

  function sourceFingerprint(value) {
    const text = String(value || '');
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${text.length}:${(hash >>> 0).toString(36)}`;
  }

  function frameMarkup() {
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=${ARTICLE_WIDTH}, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http: data: blob:; media-src https: http: data: blob:; font-src https: data:; style-src 'unsafe-inline';">
  <style>
    *{box-sizing:border-box}
    html,body{width:${ARTICLE_WIDTH}px;min-height:100%;margin:0;background:#fff}
    html{scrollbar-width:none}
    html::-webkit-scrollbar{display:none}
    body{padding:30px 22px 88px;color:#333;font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue","PingFang SC","Microsoft YaHei",Arial,sans-serif;font-size:17px;line-height:1.75;word-break:break-word;overflow-wrap:anywhere;-webkit-font-smoothing:antialiased}
    header[hidden]{display:none}
    h1{margin:0 0 12px;color:#171717;font-size:24px;font-weight:600;line-height:1.4;letter-spacing:.01em}
    .meta{display:flex;gap:8px;min-height:24px;margin-bottom:28px;color:#8c8c8c;font-size:14px;line-height:1.65}
    .account{color:#576b95}
    main:empty::before{display:block;padding:72px 14px;color:#b2b2b2;font-size:15px;line-height:1.8;text-align:center;content:"开始编辑正文后，这里会实时显示手机阅读效果。"}
    main img,main svg,main video,main canvas{max-width:100%}
    main [data-mpse-image-crop]{max-width:100%}
    main [data-mpse-image-crop] img{max-width:none}
    main table{max-width:100%;border-collapse:collapse}
    main pre{max-width:100%;overflow:auto;white-space:pre-wrap}
    main a{color:#576b95;text-decoration:none}
  </style>
</head>
<body>
  <header id="mpse-preview-meta" hidden>
    <h1 id="mpse-preview-title"></h1>
    <div class="meta"><span id="mpse-preview-author" class="account"></span></div>
  </header>
  <main id="mpse-preview-content"></main>
</body>
</html>`;
  }

  function createPreview() {
    if (state.root || !document.body) return;

    const root = document.createElement('aside');
    root.id = ROOT_ID;
    root.hidden = true;
    root.setAttribute('aria-label', '微信公众号手机实时预览');
    root.innerHTML = `
      <div class="mpse-preview-device" title="拖动手机顶部可移动预览">
        <div class="mpse-preview-screen">
          <div class="mpse-preview-status">
            <span class="mpse-preview-time"></span>
            <span class="mpse-preview-island"></span>
            <span class="mpse-preview-signals" aria-hidden="true"><i></i><i></i><b></b></span>
          </div>
          <div class="mpse-preview-nav">
            <span class="mpse-preview-back" aria-hidden="true">‹</span>
            <strong>公众号文章</strong>
            <span class="mpse-preview-more" aria-hidden="true">•••</span>
          </div>
          <div class="mpse-preview-viewport">
            <iframe id="${FRAME_ID}" title="微信公众号文章手机阅读预览" sandbox="allow-same-origin"></iframe>
          </div>
          <div class="mpse-preview-home" aria-hidden="true"></div>
        </div>
      </div>
    `;

    state.root = root;
    state.frame = root.querySelector(`#${FRAME_ID}`);
    root.addEventListener('mpse-mobile-preview:show', () => {
      updateFrameGeometry();
      scheduleRender(0);
    });
    state.frame.addEventListener('load', () => {
      installFrameGuards();
      updateFrameGeometry();
      state.fingerprint = '';
      state.sourceFingerprint = '';
      scheduleRender(0);
    });
    state.frame.srcdoc = frameMarkup();
    document.body.appendChild(root);
    updateClock();
  }

  function updateClock() {
    const target = state.root?.querySelector('.mpse-preview-time');
    if (!target) return;
    target.textContent = new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date());
  }

  function sanitizeHtml(source) {
    const parsed = new DOMParser().parseFromString(String(source || ''), 'text/html');
    parsed.querySelectorAll(DANGEROUS_ELEMENTS).forEach((element) => element.remove());

    for (const element of parsed.body.querySelectorAll('*')) {
      for (const attribute of Array.from(element.attributes)) {
        const name = attribute.name.toLowerCase();
        const value = attribute.value.trim();
        if (
          name.startsWith('on')
          || name === 'srcdoc'
          || name === 'contenteditable'
          || name === 'tabindex'
        ) {
          element.removeAttribute(attribute.name);
          continue;
        }
        if (URL_ATTRIBUTES.has(name) && /^(?:javascript|vbscript|data:text\/html)\s*:/i.test(value)) {
          element.removeAttribute(attribute.name);
          continue;
        }
        if (
          name === 'style'
          && /(?:expression\s*\(|javascript\s*:|vbscript\s*:|behavior\s*:|-moz-binding\s*:)/i.test(value)
        ) {
          element.removeAttribute(attribute.name);
        }
      }
    }

    parsed.querySelectorAll('style').forEach((style) => {
      style.textContent = style.textContent
        .replace(/@import\b[^;]+;?/gi, '')
        .replace(/url\(\s*(['"]?)(?:javascript|vbscript):[\s\S]*?\1\s*\)/gi, 'none');
    });
    return parsed.body.innerHTML;
  }

  function getAccessibleDocuments() {
    const documents = [document];
    for (const frame of document.querySelectorAll('iframe')) {
      if (frame.id === FRAME_ID || frame.closest(`#${ROOT_ID}`)) continue;
      const frameDocument = readFrameDocument(frame);
      if (frameDocument?.documentElement && !documents.includes(frameDocument)) {
        documents.push(frameDocument);
      }
    }
    return documents;
  }

  function frameForDocument(targetDocument) {
    if (targetDocument === document) return null;
    for (const frame of document.querySelectorAll('iframe')) {
      if (frame.id !== FRAME_ID && readFrameDocument(frame) === targetDocument) return frame;
    }
    return null;
  }

  function findEditableCandidate() {
    const candidates = [];
    for (const targetDocument of getAccessibleDocuments()) {
      const frame = frameForDocument(targetDocument);
      const nodes = new Set(targetDocument.querySelectorAll(
        '#ueditor_0, #js_editorArea, .ProseMirror, .ql-editor, [contenteditable="true"], body[contenteditable="true"]'
      ));
      if (
        frame
        && /ueditor|editor/i.test(`${frame.id} ${frame.name} ${frame.className}`)
        && targetDocument.body
      ) {
        nodes.add(targetDocument.body);
      }

      for (const node of nodes) {
        if (!node?.isConnected || isOwnPreviewNode(node)) continue;
        const html = node.innerHTML || '';
        const rect = frame ? frame.getBoundingClientRect() : node.getBoundingClientRect();
        const style = (frame || node).ownerDocument.defaultView.getComputedStyle(frame || node);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const identity = `${node.id || ''} ${node.className || ''} ${frame?.id || ''} ${frame?.name || ''}`;
        const score = Math.min(html.length, 60000)
          + (/ueditor|editor|js_editorArea|ProseMirror|ql-editor/i.test(identity) ? 10000 : 0)
          + (node.getAttribute?.('contenteditable') === 'true' ? 6000 : 0)
          + Math.max(0, rect.width * rect.height / 100);
        candidates.push({ node, html, score });
      }
    }
    candidates.sort((left, right) => right.score - left.score);
    return candidates[0] || null;
  }

  function readField(selectors) {
    let fallback = '';
    for (const element of document.querySelectorAll(selectors)) {
      if (isOwnPreviewNode(element)) continue;
      const value = 'value' in element ? element.value : element.textContent;
      const normalized = String(value || '').trim();
      if (!normalized) continue;
      if (!fallback) fallback = normalized;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') {
        return normalized;
      }
    }
    return fallback;
  }

  function readArticleSnapshot() {
    const sourceEditor = document.querySelector('#mpse-inline-panel .mpse-inline-editor');
    const editable = sourceEditor ? null : findEditableCandidate();
    return {
      html: sourceEditor ? sourceEditor.value : (editable?.html || ''),
      title: readField('#title, [name="title"], input[placeholder*="标题"], textarea[placeholder*="标题"]'),
      author: readField('[name="author"], input[placeholder*="作者"], textarea[placeholder*="作者"]'),
      mode: sourceEditor ? 'source' : 'rich'
    };
  }

  function writeSnapshot(snapshot) {
    const frameDocument = readFrameDocument(state.frame);
    const content = frameDocument?.getElementById('mpse-preview-content');
    const meta = frameDocument?.getElementById('mpse-preview-meta');
    const title = frameDocument?.getElementById('mpse-preview-title');
    const author = frameDocument?.getElementById('mpse-preview-author');
    if (!content || !meta || !title || !author) return false;

    content.innerHTML = snapshot.html;
    normalizeMediaAspectRatios(content);
    title.textContent = snapshot.title;
    author.textContent = snapshot.author;
    author.hidden = !snapshot.author;
    meta.hidden = !snapshot.title && !snapshot.author;
    state.root.dataset.previewMode = snapshot.mode;
    return true;
  }

  function normalizeMediaAspectRatios(content) {
    for (const media of content.querySelectorAll('img, video')) {
      if (media.closest('[data-mpse-image-crop]')) continue;
      media.style.setProperty('max-width', '100%', 'important');
      const objectFit = media.ownerDocument.defaultView.getComputedStyle(media).objectFit;
      if (objectFit && objectFit !== 'fill') continue;
      media.style.setProperty('height', 'auto', 'important');
    }
  }

  function renderPreview() {
    state.renderTimer = 0;
    if (!state.root || state.root.hidden) return;
    const snapshot = readArticleSnapshot();
    const sourceKey = sourceFingerprint(`${snapshot.mode}\0${snapshot.title}\0${snapshot.author}\0${snapshot.html}`);
    if (sourceKey === state.sourceFingerprint) return;
    snapshot.html = sanitizeHtml(snapshot.html);
    const fingerprint = sourceFingerprint(`${sourceKey}\0${snapshot.html}`);
    if (fingerprint === state.fingerprint) {
      state.sourceFingerprint = sourceKey;
      return;
    }
    if (writeSnapshot(snapshot)) {
      state.sourceFingerprint = sourceKey;
      state.fingerprint = fingerprint;
    }
  }

  function scheduleRender(delay = RENDER_DELAY_MS) {
    if (state.renderTimer) window.clearTimeout(state.renderTimer);
    state.renderTimer = window.setTimeout(renderPreview, delay);
  }

  function installFrameGuards() {
    const frameDocument = readFrameDocument(state.frame);
    if (!frameDocument) return;
    frameDocument.addEventListener('click', (event) => event.preventDefault(), true);
  }

  function updateFrameGeometry() {
    const viewport = state.root?.querySelector('.mpse-preview-viewport');
    if (!viewport || !state.frame) return;
    const scale = viewport.clientWidth / ARTICLE_WIDTH;
    if (!Number.isFinite(scale) || scale <= 0) return;
    state.frame.style.transform = `scale(${scale})`;
    state.frame.style.height = `${Math.ceil(viewport.clientHeight / scale)}px`;
  }

  function bindDocuments() {
    const activeDocuments = new Set(getAccessibleDocuments());
    for (const [targetDocument, binding] of state.documentObservers) {
      if (activeDocuments.has(targetDocument)) continue;
      binding.observer.disconnect();
      for (const eventName of ['beforeinput', 'input', 'paste', 'drop', 'cut']) {
        targetDocument.removeEventListener(eventName, binding.onInput, true);
      }
      state.documentObservers.delete(targetDocument);
    }

    for (const targetDocument of activeDocuments) {
      if (state.documentObservers.has(targetDocument)) continue;
      const onInput = () => scheduleRender();
      for (const eventName of ['beforeinput', 'input', 'paste', 'drop', 'cut']) {
        targetDocument.addEventListener(eventName, onInput, true);
      }
      const observer = new MutationObserver((records) => {
        if (records.some((record) => !isOwnPreviewNode(record.target))) {
          scheduleRender();
        }
      });
      observer.observe(targetDocument.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['style', 'class', 'src', 'href', 'contenteditable']
      });
      state.documentObservers.set(targetDocument, { observer, onInput });
    }
  }

  function boot() {
    if (!isEditorPage()) return;
    createPreview();
    bindDocuments();
    scheduleRender(0);
    window.setInterval(() => {
      bindDocuments();
      updateClock();
      if (state.root && !state.root.hidden) scheduleRender(0);
    }, REBIND_INTERVAL_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
