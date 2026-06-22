(() => {
  'use strict';

  const VERSION = 'v0.9.4';
  const MENU_ID = 'mpse-img2-menu';
  const PANEL_ID = 'mpse-svg2-panel';
  const PICK_BUTTON_ID = 'mpse-svg2-pick-button';
  const MARK_CLASS = 'mpse-svg2-selected-mark';
  const SELECTED_BOX_CLASS = 'mpse-svg2-selected-box';
  const BOUND_FLAG = '__mpseSvgToolsV094Bound__';
  const GENERIC_BOUND_ATTR = 'data-mpse-svg-tools-bound';
  const VERSION_ATTR = 'data-mpse-svg-tools-version';
  const MAX_SELECTED_IMAGES = 9;
  const bridgeClient = window.__MPSE_BRIDGE_CLIENT__;
  const requestBridge = bridgeClient && typeof bridgeClient.request === 'function'
    ? bridgeClient.request
    : () => Promise.reject(new Error('扩展桥接客户端未加载，请刷新页面后重试'));

  const state = {
    lastImage: null,
    selected: [],
    isGenerating: false,
    lastDocCount: 0,
    pickMode: false
  };

  function isMpHost() {
    return location.hostname === 'mp.weixin.qq.com';
  }

  function isEditorLikePage() {
    if (!isMpHost()) return false;
    if (/\/cgi-bin\/appmsg/.test(location.pathname)) return true;
    if (document.querySelector('.edui-toolbar, .edui-editor, #js_editorArea, #ueditor_0, iframe[id*=ueditor], iframe[name*=ueditor], [contenteditable="true"]')) return true;
    return false;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, '&#96;');
  }

  function encodeJsonDataAttr(value) {
    try {
      return escapeAttr(btoa(unescape(encodeURIComponent(JSON.stringify(value)))));
    } catch (_) {
      try {
        return escapeAttr(encodeURIComponent(JSON.stringify(value)));
      } catch (__) {
        return '';
      }
    }
  }

  function clamp(value, min, max, fallback = min) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(n, min), max);
  }

  function stableUrl(value) {
    return String(value || '')
      .replace(/&amp;/g, '&')
      .replace(/^https?:\/\/mmbiz\.qpic\.cn\//, '//mmbiz.qpic.cn/')
      .replace(/^https?:\/\/mmbiz\.qlogo\.cn\//, '//mmbiz.qlogo.cn/')
      .trim();
  }

  function displayUrl(value) {
    const raw = stableUrl(value);
    if (raw.startsWith('//')) return `https:${raw}`;
    return raw;
  }

  function getAttr(image, name) {
    return image && image.getAttribute ? (image.getAttribute(name) || '') : '';
  }

  function getAccessibleDocuments() {
    const docs = [document];
    for (const frame of Array.from(document.querySelectorAll('iframe'))) {
      try {
        const doc = frame.contentDocument;
        if (doc && doc.documentElement && !docs.includes(doc)) docs.push(doc);
      } catch (_) {
        // ignore cross-origin frames
      }
    }
    return docs;
  }

  function getFrameByDocument(doc) {
    if (!doc || doc === document) return null;
    for (const frame of Array.from(document.querySelectorAll('iframe'))) {
      try {
        if (frame.contentDocument === doc) return frame;
      } catch (_) {
        // ignore
      }
    }
    return null;
  }

  function isExtensionElement(node) {
    if (!node || !node.closest) return false;
    return Boolean(node.closest(`#${PANEL_ID}, #${PICK_BUTTON_ID}, #mpse-svgb-menu, #mpse-svgb-panel, #mpse-svgb-box, #mpse-svgb-badge, #mpse-img2-menu, #mpse-img2-panel, #mpse-img2-box, #mpse-img2-badge, #mpse-inline-panel, #mpse-toolbar-button, #mpse-floating-button`));
  }

  function findEditableRoot(node) {
    if (!node || !node.closest) return null;
    const direct = node.closest('[contenteditable="true"], body[contenteditable="true"], #js_editorArea, #js_content, .rich_media_content, .ProseMirror, .ql-editor');
    if (direct) return direct;
    const doc = node.ownerDocument;
    const frame = getFrameByDocument(doc);
    if (frame && /ueditor|editor/i.test(`${frame.id || ''} ${frame.name || ''} ${frame.className || ''}`) && doc.body) return doc.body;
    if (frame && frame.closest && frame.closest('.edui-editor-iframeholder, .edui-editor-body, .edui-editor') && doc.body) return doc.body;
    return null;
  }

  function isVisibleImage(image) {
    if (!image || image.tagName !== 'IMG' || isExtensionElement(image)) return false;
    if (!image.isConnected) return false;
    const rect = image.getBoundingClientRect();
    if (rect.width < 24 || rect.height < 24) return false;
    const style = image.ownerDocument.defaultView.getComputedStyle(image);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    return true;
  }

  function isLikelyArticleImage(image) {
    if (!isVisibleImage(image)) return false;
    const root = findEditableRoot(image);
    if (root && root.contains(image)) return true;
    const frame = getFrameByDocument(image.ownerDocument);
    if (frame) {
      const text = `${frame.id || ''} ${frame.name || ''} ${frame.className || ''}`;
      if (/ueditor|editor/i.test(text)) return true;
      if (frame.closest && frame.closest('.edui-editor-iframeholder, .edui-editor-body, .edui-editor')) return true;
    }
    if (image.closest && image.closest('.edui-editor, .edui-editor-body, #js_editorArea, #js_content, .rich_media_content, [contenteditable="true"]')) return true;
    return false;
  }

  function getAllArticleImages() {
    const images = [];
    for (const doc of getAccessibleDocuments()) {
      for (const image of Array.from(doc.querySelectorAll('img'))) {
        if (isLikelyArticleImage(image)) images.push(image);
      }
    }
    return images;
  }

  function imageIndexInArticle(image) {
    const list = getAllArticleImages();
    const idx = list.indexOf(image);
    return idx >= 0 ? idx : 0;
  }

  function imageSignature(image) {
    let rect = { width: 0, height: 0 };
    try { rect = image.getBoundingClientRect(); } catch (_) {}
    return {
      index: imageIndexInArticle(image),
      src: stableUrl(getAttr(image, 'src') || image.currentSrc || image.src),
      dataSrc: stableUrl(getAttr(image, 'data-src')),
      dataBackSrc: stableUrl(getAttr(image, 'data-backsrc')),
      dataCropSrc: stableUrl(getAttr(image, 'data-croporisrc')),
      fileId: getAttr(image, 'data-fileid') || getAttr(image, 'data-mediaid'),
      w: getAttr(image, 'data-w') || String(Math.round(rect.width || 0)),
      ratio: getAttr(image, 'data-ratio'),
      className: getAttr(image, 'class'),
      alt: getAttr(image, 'alt'),
      url: displayUrl(getAttr(image, 'data-src') || getAttr(image, 'src') || image.currentSrc || image.src),
      domWidth: Math.round(rect.width || 0),
      domHeight: Math.round(rect.height || 0)
    };
  }

  function sameIdentity(a, b) {
    if (!a || !b) return false;
    const ai = Number(a.index);
    const bi = Number(b.index);
    if (Number.isFinite(ai) && Number.isFinite(bi)) {
      if (ai !== bi) return false;
      return true;
    }
    if (a.fileId && b.fileId && a.fileId === b.fileId) return true;
    if (a.dataSrc && b.dataSrc && a.dataSrc === b.dataSrc) return true;
    if (a.src && b.src && a.src === b.src) return true;
    return false;
  }

  function scoreImageByIdentity(candidate, identity) {
    if (!candidate || !identity) return 0;
    let score = 0;
    const src = stableUrl(candidate.getAttribute('src'));
    const dataSrc = stableUrl(candidate.getAttribute('data-src'));
    const dataBackSrc = stableUrl(candidate.getAttribute('data-backsrc'));
    const dataCropSrc = stableUrl(candidate.getAttribute('data-croporisrc'));

    if (identity.dataSrc && dataSrc && identity.dataSrc === dataSrc) score += 1200;
    if (identity.src && src && identity.src === src) score += 900;
    if (identity.dataBackSrc && dataBackSrc && identity.dataBackSrc === dataBackSrc) score += 800;
    if (identity.dataCropSrc && dataCropSrc && identity.dataCropSrc === dataCropSrc) score += 700;
    if (identity.fileId && (candidate.getAttribute('data-fileid') === identity.fileId || candidate.getAttribute('data-mediaid') === identity.fileId)) score += 600;
    if (identity.w && candidate.getAttribute('data-w') === identity.w) score += 50;
    if (identity.ratio && candidate.getAttribute('data-ratio') === identity.ratio) score += 50;
    if (identity.alt && candidate.getAttribute('alt') === identity.alt) score += 20;
    if (identity.className && candidate.getAttribute('class') === identity.className) score += 10;
    return score;
  }

  function locateImageInHtml(root, identity) {
    const images = Array.from(root.querySelectorAll('img'));
    if (!images.length) return null;

    let best = null;
    let bestScore = -1;
    for (let index = 0; index < images.length; index += 1) {
      const img = images[index];
      let score = scoreImageByIdentity(img, identity);
      if (Number.isFinite(identity && identity.index) && index === identity.index) score += 2000;
      if (score > bestScore) {
        best = img;
        bestScore = score;
      }
    }

    if (best && bestScore >= 50) return best;
    if (Number.isFinite(identity && identity.index) && images[identity.index]) return images[identity.index];
    if (images.length === 1) return images[0];
    return best;
  }

  function findImageFromEvent(event) {
    const target = event.target;
    if (!target || isExtensionElement(target)) return null;
    const candidates = [];
    if (target.tagName === 'IMG') candidates.push(target);
    if (target.closest) {
      const closest = target.closest('img');
      if (closest) candidates.push(closest);
      const wrapper = target.closest('section,p,span,div,figure,td');
      if (wrapper && wrapper.querySelector) {
        const nested = wrapper.querySelector('img');
        if (nested) candidates.push(nested);
      }
    }
    const doc = target.ownerDocument;
    if (doc && doc.elementsFromPoint && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
      for (const element of doc.elementsFromPoint(event.clientX, event.clientY)) {
        if (!element) continue;
        if (element.tagName === 'IMG') candidates.push(element);
        if (element.querySelector) {
          const nested = element.querySelector('img');
          if (nested) candidates.push(nested);
        }
      }
    }
    const seen = new Set();
    for (const image of candidates) {
      if (!image || seen.has(image)) continue;
      seen.add(image);
      if (isLikelyArticleImage(image)) return image;
    }
    return null;
  }

  function removeSelectionOverlays() {
    for (const element of Array.from(document.querySelectorAll(`.${MARK_CLASS}, .${SELECTED_BOX_CLASS}`))) element.remove();
  }

  function markSelectedImages() {
    removeSelectionOverlays();
    state.selected = state.selected.filter((item) => item.image && item.image.isConnected);
    state.selected.forEach((item, index) => {
      const rect = getTopRect(item.image);

      const box = document.createElement('div');
      box.className = SELECTED_BOX_CLASS;
      box.style.left = `${rect.left}px`;
      box.style.top = `${rect.top}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
      document.body.appendChild(box);

      const mark = document.createElement('div');
      mark.className = MARK_CLASS;
      mark.textContent = `SVG ${index + 1}`;
      mark.style.left = `${rect.left + 6}px`;
      mark.style.top = `${Math.max(8, rect.top + 6)}px`;
      document.body.appendChild(mark);
    });
    if (!state.selected.length) state.pickMode = false;
    updatePickButtonText();
  }

  function getTopRect(element) {
    const rect = element.getBoundingClientRect();
    const frame = getFrameByDocument(element.ownerDocument);
    if (!frame) return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    const frameRect = frame.getBoundingClientRect();
    return {
      left: frameRect.left + rect.left,
      top: frameRect.top + rect.top,
      right: frameRect.left + rect.right,
      bottom: frameRect.top + rect.bottom,
      width: rect.width,
      height: rect.height
    };
  }

  function updatePickButtonText() {
    const button = document.getElementById(PICK_BUTTON_ID);
    if (!button) return;
    const count = state.selected.length;
    if (count === 0) button.textContent = 'SVG';
    else if (count === 1) button.textContent = 'SVG 1';
    else button.textContent = `生成${count}`;
    button.classList.toggle('mpse-svg2-picking', state.pickMode || count > 0);
    button.title = count >= 2
      ? `已选 ${count} 张图片，点击生成 SVG 动效；继续点击图片可追加，Ctrl / Shift / Command + 点击可取消某张`
      : `SVG 多图：点一次 SVG 后进入选图模式，继续普通点击图片即可追加；最多 ${MAX_SELECTED_IMAGES} 张`;
  }

  function selectImage(image, options = {}) {
    if (!image || !isLikelyArticleImage(image)) return;
    state.pickMode = true;
    const identity = imageSignature(image);
    const existingIndex = state.selected.findIndex((item) => sameIdentity(item.identity, identity));
    if (existingIndex >= 0) {
      if (options.toggle) {
        state.selected.splice(existingIndex, 1);
        const panel = document.getElementById(PANEL_ID);
        if (state.selected.length < 2 && panel) panel.classList.remove('mpse-visible');
      } else {
        // 普通点击已选图片只聚焦它，不取消选择；取消用 Ctrl / Shift / Command + 点击，或点“重选”。
        state.selected[existingIndex].image = image;
        state.selected[existingIndex].identity = identity;
        if (state.selected.length >= 2) showDualPanel();
      }
      markSelectedImages();
      return;
    }
    if (state.selected.length >= MAX_SELECTED_IMAGES) state.selected.shift();
    state.selected.push({ image, identity });
    markSelectedImages();
    if (state.selected.length >= 2) showDualPanel();
  }

  function clearSelection() {
    state.selected = [];
    state.pickMode = false;
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.classList.remove('mpse-visible');
    markSelectedImages();
  }

  function createPickButton() {
    const menu = document.getElementById(MENU_ID);
    if (!menu || document.getElementById(PICK_BUTTON_ID)) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.id = PICK_BUTTON_ID;
    button.title = `SVG 多图：先点图，再点 SVG 加入选择；也可 Ctrl / Shift / Command + 点击多选，最多 ${MAX_SELECTED_IMAGES} 张`;
    button.textContent = 'SVG';
    button.addEventListener('pointerdown', (event) => event.stopPropagation(), true);
    button.addEventListener('mousedown', (event) => event.stopPropagation(), true);
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (state.lastImage) {
        const identity = imageSignature(state.lastImage);
        const exists = state.selected.some((item) => sameIdentity(item.identity, identity));
        if (!exists) {
          selectImage(state.lastImage);
          return;
        }
        if (state.selected.length < 2) {
          selectImage(state.lastImage, { toggle: true });
          return;
        }
      }
      if (state.selected.length >= 2) showDualPanel();
    }, true);
    menu.appendChild(button);
    updatePickButtonText();
  }

  function createPanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.addEventListener('pointerdown', (event) => event.stopPropagation(), true);
    panel.addEventListener('mousedown', (event) => event.stopPropagation(), true);
    panel.addEventListener('click', (event) => {
      const target = event.target;
      if (target.closest('[data-mpse-svg-close]')) {
        event.preventDefault();
        event.stopPropagation();
        panel.classList.remove('mpse-visible');
      }
      if (target.closest('[data-mpse-svg-clear]')) {
        event.preventDefault();
        event.stopPropagation();
        clearSelection();
      }
      if (target.closest('[data-mpse-svg-generate]')) {
        event.preventDefault();
        event.stopPropagation();
        generateDualSvgFromPanel(panel);
      }
    }, true);
    panel.addEventListener('input', () => updatePanelValueLabels(panel), true);
    panel.addEventListener('change', () => updatePanelValueLabels(panel), true);
    document.body.appendChild(panel);
    return panel;
  }

  function cleanupLegacyDom() {
    for (const id of [PANEL_ID, PICK_BUTTON_ID]) {
      const element = document.getElementById(id);
      if (element) element.remove();
    }
    document.querySelectorAll('.mpse-svg2-selected-mark, .mpse-svg2-selected-box').forEach((element) => element.remove());
  }

  function range(label, name, min, max, step, value, suffix = '') {
    return `
      <label class="mpse-svg2-control">
        <span>${escapeHtml(label)} <em data-value-for="${escapeHtml(name)}" data-suffix="${escapeHtml(suffix)}">${escapeHtml(value)}${escapeHtml(suffix)}</em></span>
        <input type="range" name="${escapeHtml(name)}" min="${min}" max="${max}" step="${step}" value="${escapeHtml(value)}">
      </label>
    `;
  }

  function select(label, name, value, options) {
    return `
      <label class="mpse-svg2-control">
        <span>${escapeHtml(label)}</span>
        <select name="${escapeHtml(name)}">
          ${options.map((item) => `<option value="${escapeHtml(item.value)}"${item.value === value ? ' selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}
        </select>
      </label>
    `;
  }

  function checkbox(label, name, checked) {
    return `
      <label class="mpse-svg2-check">
        <input type="checkbox" name="${escapeHtml(name)}"${checked ? ' checked' : ''}>
        <span>${escapeHtml(label)}</span>
      </label>
    `;
  }

  function collectPanelValues(panel) {
    const values = {};
    for (const input of Array.from(panel.querySelectorAll('input, select'))) {
      if (!input.name) continue;
      if (input.type === 'checkbox') values[input.name] = input.checked;
      else if (input.type === 'range') values[input.name] = Number(input.value);
      else values[input.name] = input.value;
    }
    return values;
  }

  function updatePanelValueLabels(panel) {
    for (const input of Array.from(panel.querySelectorAll('input[type="range"]'))) {
      const label = panel.querySelector(`[data-value-for="${input.name}"]`);
      if (label) label.textContent = `${input.value}${label.dataset.suffix || ''}`;
    }
  }

  function selectedPreviewHtml() {
    return state.selected.map((item, index) => `
      <div><span>图 ${index + 1}</span><img src="${escapeAttr(item.identity.url)}" alt=""></div>
    `).join('');
  }

  function effectOptionsForCount(count) {
    const options = [];
    if (count === 2) {
      options.push(
        { value: 'fade', label: '双图淡入淡出' },
        { value: 'wipe-x', label: '左右擦除对比' },
        { value: 'slide-left', label: '图 2 左滑进入' },
        { value: 'click-reveal', label: '点击揭晓图 2' }
      );
    }
    options.push(
      { value: 'multi-fade', label: count === 2 ? '两图轮播' : '多图淡入轮播' },
      { value: 'multi-slide', label: count === 2 ? '两图横向轮播' : '多图横向轮播' },
      { value: 'multi-stack', label: count === 2 ? '两图逐张叠入' : '多图逐张叠入' }
    );
    return options;
  }

  function showDualPanel() {
    if (state.selected.length < 2) return;
    const count = state.selected.length;
    const panel = createPanel();
    panel.innerHTML = `
      <div class="mpse-svg2-head">
        <strong>${count === 2 ? '双图 SVG 动效' : `${count} 图 SVG 动效`}</strong>
        <button type="button" data-mpse-svg-close title="收起">×</button>
      </div>
      <div class="mpse-svg2-preview mpse-svg2-preview-multi">
        ${selectedPreviewHtml()}
      </div>
      <div class="mpse-svg2-body">
        ${select('动效', 'effect', count === 2 ? 'fade' : 'multi-fade', effectOptionsForCount(count))}
        ${range('宽度', 'widthPercent', 10, 100, 1, 100, '%')}
        ${range(count > 2 ? '单图停留' : '时长', 'duration', 1, 12, 0.5, 4, 's')}
        ${range('圆角', 'radius', 0, 80, 1, 0, 'px')}
        ${checkbox(`替换原来的 ${count} 张图片`, 'replaceOriginals', true)}
      </div>
      <div class="mpse-svg2-actions">
        <button type="button" data-mpse-svg-clear>重选</button>
        <button type="button" data-mpse-svg-generate>生成 SVG</button>
      </div>
      <div class="mpse-svg2-tip">2 张图可做对比类动效；3 张以上适合轮播、逐张叠入。生成后可点 HTML 查看源码。</div>
    `;
    panel.classList.add('mpse-visible');
    updatePanelValueLabels(panel);
    positionPanel();
  }

  function positionPanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel || !panel.classList.contains('mpse-visible')) return;
    const image = state.selected.length ? state.selected[state.selected.length - 1].image : state.lastImage;
    if (!image || !image.isConnected) return;
    const rect = getTopRect(image);
    const width = 270;
    let left = rect.right + 70;
    if (left + width > window.innerWidth - 8) left = rect.left - width - 70;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    const top = Math.max(8, Math.min(rect.top + 4, window.innerHeight - 420));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  function imageDimensionsFromIdentities(identities) {
    const first = identities[0] || {};
    const widthSource = Number(first.w) || first.domWidth || 900;
    const ratioSource = Number(first.ratio) || (first.domWidth && first.domHeight ? first.domHeight / first.domWidth : 0) || 0.5625;
    const width = Math.round(Math.max(320, Math.min(1600, widthSource || 900)));
    const height = Math.round(Math.max(120, Math.min(2000, width * ratioSource)));
    return { width, height };
  }

  function animationKeyTimes(count) {
    const times = [];
    for (let i = 0; i <= count; i += 1) times.push((i / count).toFixed(4).replace(/0+$/, '').replace(/\.$/, ''));
    return times.join(';');
  }

  function buildDiscreteOpacityValues(index, count) {
    const values = [];
    for (let i = 0; i <= count; i += 1) {
      const frame = i === count ? 0 : i;
      values.push(frame === index ? '1' : '0');
    }
    return values.join(';');
  }

  function buildStackOpacity(index, count) {
    const start = Math.max(0, index / count);
    const reveal = Math.min(1, start + 0.18 / count);
    const keyTimes = `0;${start.toFixed(4)};${reveal.toFixed(4)};0.92;1`;
    const values = index === 0 ? '1;1;1;1;0' : '0;0;1;1;0';
    return { keyTimes, values };
  }

  function buildSvgMarkup(identities, values) {
    const list = identities.slice(0, MAX_SELECTED_IMAGES).filter((item) => item && item.url);
    if (list.length < 2) throw new Error('至少需要两张图片');
    const count = list.length;
    const dims = imageDimensionsFromIdentities(list);
    const w = dims.width;
    const h = dims.height;
    const perImageDur = clamp(values.duration, 1, 12, 4);
    const totalDur = Math.max(1, perImageDur * count);
    const radius = clamp(values.radius, 0, 80, 0);
    const widthPercent = clamp(values.widthPercent, 10, 100, 100);
    const id = `mpseSvg${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const common = `x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice"`;
    let effect = values.effect || (count === 2 ? 'fade' : 'multi-fade');
    if (count > 2 && ['fade', 'wipe-x', 'slide-left', 'click-reveal'].includes(effect)) effect = 'multi-fade';

    const urls = list.map((item) => escapeAttr(item.url));
    const srcData = escapeAttr(encodeURIComponent(JSON.stringify(list.map((item) => item.url))));
    let body = '';

    if (count === 2 && effect === 'wipe-x') {
      body = `
        <defs>
          <clipPath id="${id}Clip"><rect x="0" y="0" width="0" height="${h}"><animate attributeName="width" values="0;${w};${w};0" dur="${perImageDur}s" repeatCount="indefinite"></animate></rect></clipPath>
        </defs>
        <image ${common} href="${urls[0]}" xlink:href="${urls[0]}"></image>
        <image ${common} href="${urls[1]}" xlink:href="${urls[1]}" clip-path="url(#${id}Clip)"></image>
      `;
    } else if (count === 2 && effect === 'slide-left') {
      body = `
        <image ${common} href="${urls[0]}" xlink:href="${urls[0]}"></image>
        <image x="${w}" y="0" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice" href="${urls[1]}" xlink:href="${urls[1]}"><animate attributeName="x" values="${w};0;0;${w}" dur="${perImageDur}s" repeatCount="indefinite"></animate></image>
      `;
    } else if (count === 2 && effect === 'click-reveal') {
      body = `
        <image ${common} href="${urls[0]}" xlink:href="${urls[0]}"></image>
        <image id="${id}B" ${common} href="${urls[1]}" xlink:href="${urls[1]}" opacity="0" style="pointer-events:all;"><animate attributeName="opacity" begin="click" values="0;1" dur="0.25s" fill="freeze"></animate></image>
        <text x="${Math.round(w / 2)}" y="${Math.round(h - 28)}" text-anchor="middle" font-size="28" fill="rgba(255,255,255,.9)">点击查看</text>
      `;
    } else if (effect === 'multi-slide') {
      const loopUrls = urls.concat(urls[0]);
      const images = loopUrls.map((url, index) => `<image x="${index * w}" y="0" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice" href="${url}" xlink:href="${url}"></image>`).join('\n        ');
      const transforms = [];
      for (let i = 0; i <= count; i += 1) transforms.push(`${-i * w} 0`);
      body = `
        <g>
          ${images}
          <animateTransform attributeName="transform" type="translate" values="${transforms.join(';')}" dur="${totalDur}s" repeatCount="indefinite"></animateTransform>
        </g>
      `;
    } else if (effect === 'multi-stack') {
      body = urls.map((url, index) => {
        const anim = buildStackOpacity(index, count);
        return `<image ${common} href="${url}" xlink:href="${url}" opacity="${index === 0 ? '1' : '0'}"><animate attributeName="opacity" values="${anim.values}" keyTimes="${anim.keyTimes}" dur="${totalDur}s" repeatCount="indefinite"></animate></image>`;
      }).join('\n        ');
    } else {
      const keyTimes = animationKeyTimes(count);
      body = urls.map((url, index) => `<image ${common} href="${url}" xlink:href="${url}" opacity="${index === 0 ? '1' : '0'}"><animate attributeName="opacity" values="${buildDiscreteOpacityValues(index, count)}" keyTimes="${keyTimes}" dur="${totalDur}s" repeatCount="indefinite"></animate></image>`).join('\n        ');
    }

    const sectionStyle = [
      'margin: 0 auto',
      `width: ${widthPercent}%`,
      'max-width: 100%',
      'line-height: 0',
      radius > 0 ? `border-radius: ${radius}px` : '',
      radius > 0 ? 'overflow: hidden' : ''
    ].filter(Boolean).join('; ');

    const svgStyle = [
      'display: block',
      'width: 100%',
      'height: auto',
      radius > 0 ? `border-radius: ${radius}px` : '',
      radius > 0 ? 'overflow: hidden' : ''
    ].filter(Boolean).join('; ');

    return `
<section data-mpse-svg-block="1" data-mpse-svg-multi="1" data-mpse-svg-id="${escapeAttr(id)}" data-mpse-svg-count="${count}" data-mpse-svg-effect="${escapeAttr(effect)}" data-mpse-svg-width="${widthPercent}" data-mpse-svg-duration="${perImageDur}" data-mpse-svg-radius="${radius}" data-mpse-srcs="${srcData}" style="${sectionStyle}">
  <svg data-mpse-generated="1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${w} ${h}" style="${svgStyle}" role="img" aria-label="${count} 图 SVG 动效">
    ${body.trim()}
  </svg>
</section>`;
  }

  function getRemovalNode(img, root) {
    let node = img;
    let current = img.parentElement;
    while (current && current !== root) {
      const tag = current.tagName;
      if (!['SPAN', 'P', 'SECTION', 'DIV', 'FIGURE'].includes(tag)) break;
      const text = (current.textContent || '').replace(/\u200b/g, '').trim();
      const images = current.querySelectorAll ? current.querySelectorAll('img').length : 0;
      const svgs = current.querySelectorAll ? current.querySelectorAll('svg').length : 0;
      if (images === 1 && svgs === 0 && !text) {
        node = current;
        current = current.parentElement;
      } else {
        break;
      }
    }
    return node;
  }

  function insertSvgIntoHtml(content, items, values) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(`<div id="mpse-root">${content || ''}</div>`, 'text/html');
    const root = doc.getElementById('mpse-root');
    if (!root) return { html: content, changed: false, reason: 'parse-failed' };

    const located = items.map((item, index) => {
      const img = locateImageInHtml(root, item.identity);
      return { item, index, img };
    });
    const missing = located.find((entry) => !entry.img);
    if (missing) return { html: content, changed: false, reason: `image-${missing.index + 1}-not-found` };

    const svgMarkup = buildSvgMarkup(located.map((entry) => entry.item.identity), values);
    const temp = doc.createElement('div');
    temp.innerHTML = svgMarkup.trim();
    const svgBlock = temp.firstElementChild;
    if (!svgBlock) return { html: content, changed: false, reason: 'svg-build-failed' };

    const nodes = located.map((entry) => values.replaceOriginals ? getRemovalNode(entry.img, root) : entry.img);
    const uniqueNodes = [];
    for (const node of nodes) {
      if (node && !uniqueNodes.includes(node)) uniqueNodes.push(node);
    }

    const originalHtmls = uniqueNodes
      .map((node) => node && node.outerHTML ? node.outerHTML : '')
      .filter(Boolean);
    const urls = located.map((entry) => entry.item && entry.item.identity ? entry.item.identity.url : '').filter(Boolean);
    svgBlock.setAttribute('data-mpse-svg-originals', encodeJsonDataAttr(originalHtmls));
    svgBlock.setAttribute('data-mpse-svg-urls', encodeJsonDataAttr(urls));

    const firstNode = nodes[0];
    const parent = firstNode.parentNode || root;
    parent.insertBefore(svgBlock, firstNode);

    if (values.replaceOriginals) {
      for (const node of uniqueNodes) {
        if (node && node.isConnected) node.remove();
      }
    }

    return { html: root.innerHTML, changed: true, reason: 'ok' };
  }

  async function generateDualSvgFromPanel(panel) {
    if (state.isGenerating) return;
    if (state.selected.length < 2) return;
    state.isGenerating = true;
    const generateButton = panel.querySelector('[data-mpse-svg-generate]');
    if (generateButton) generateButton.textContent = '生成中…';

    try {
      const values = collectPanelValues(panel);
      const items = state.selected.slice(0, MAX_SELECTED_IMAGES);
      const current = await requestBridge('GET_CONTENT', {}, 15000);
      const content = typeof current.content === 'string' ? current.content : '';
      const result = insertSvgIntoHtml(content, items, values);
      if (!result.changed) throw new Error(`没有定位到选中的图片：${result.reason}`);
      await requestBridge('SET_CONTENT', { content: result.html }, 15000);
      if (generateButton) generateButton.textContent = '已生成';
      window.setTimeout(() => {
        clearSelection();
      }, 500);
    } catch (error) {
      console.warn('[公众号源码排版助手] multi svg generation failed:', error);
      if (generateButton) generateButton.textContent = '生成失败';
      window.alert(`生成 SVG 失败：${error.message || error}`);
    } finally {
      state.isGenerating = false;
      window.setTimeout(() => {
        if (generateButton && generateButton.textContent !== '已生成') generateButton.textContent = '生成 SVG';
      }, 900);
    }
  }

  function onDocumentPointer(event) {
    if (!event || !event.target) return;
    if (isExtensionElement(event.target)) return;
    if (document.getElementById('mpse-inline-panel')) return;

    const image = findImageFromEvent(event);
    if (!image) return;
    state.lastImage = image;

    if (event.shiftKey || event.ctrlKey || event.metaKey || state.pickMode) {
      event.preventDefault();
      event.stopPropagation();
      if (event.type !== 'pointerdown') return;
      selectImage(image, { toggle: Boolean(event.shiftKey || event.ctrlKey || event.metaKey) });
    } else {
      window.setTimeout(createPickButton, 0);
    }
  }

  function bindDocuments() {
    if (!isEditorLikePage()) return;
    const docs = getAccessibleDocuments();
    state.lastDocCount = docs.length;
    for (const doc of docs) {
      if (!doc) continue;
      const root = doc.documentElement;
      if (doc[BOUND_FLAG] || (root && root.getAttribute(GENERIC_BOUND_ATTR) === VERSION)) continue;
      try {
        Object.defineProperty(doc, BOUND_FLAG, { value: true, configurable: true });
      } catch (_) {
        doc[BOUND_FLAG] = true;
      }
      if (root) root.setAttribute(GENERIC_BOUND_ATTR, VERSION);
      doc.addEventListener('pointerdown', onDocumentPointer, true);
      doc.addEventListener('click', onDocumentPointer, true);
      doc.addEventListener('scroll', () => {
        if (state.selected.length) window.requestAnimationFrame(() => {
          markSelectedImages();
          positionPanel();
        });
      }, true);
    }
  }

  let bindTimer = 0;

  function scheduleBindDocuments() {
    if (bindTimer) return;
    bindTimer = window.setTimeout(() => {
      bindTimer = 0;
      bindDocuments();
      createPickButton();
    }, 180);
  }

  function boot() {
    if (!isMpHost()) return;
    const root = document.documentElement;
    if (root.getAttribute(VERSION_ATTR) === VERSION) return;
    root.setAttribute(VERSION_ATTR, VERSION);

    cleanupLegacyDom();
    createPanel();
    bindDocuments();
    window.setInterval(scheduleBindDocuments, 800);
    const observer = new MutationObserver(scheduleBindDocuments);
    observer.observe(document.documentElement, { childList: true, subtree: true });

    window.addEventListener('resize', () => {
      if (state.selected.length) window.requestAnimationFrame(() => {
        markSelectedImages();
        positionPanel();
      });
    });
    window.addEventListener('scroll', () => {
      if (state.selected.length) window.requestAnimationFrame(() => {
        markSelectedImages();
        positionPanel();
      });
    }, true);

    console.info(`[公众号源码排版助手] svg tools ${VERSION} loaded`);
  }

  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
      boot();
    }
  } catch (error) {
    console.warn(`[公众号源码排版助手] svg tools ${VERSION} failed:`, error);
  }
})();
