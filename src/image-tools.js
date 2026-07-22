(() => {
  'use strict';

  const VERSION = 'v0.9.5';
  const MENU_ID = 'mpse-img2-menu';
  const PANEL_ID = 'mpse-img2-panel';
  const BOX_ID = 'mpse-img2-box';
  const BADGE_ID = 'mpse-img2-badge';
  const CROP_ATTR = 'data-mpse-image-crop';
  const BOUND_FLAG = '__mpseImageToolsV094Bound__';
  const GENERIC_BOUND_ATTR = 'data-mpse-image-tools-bound';
  const VERSION_ATTR = 'data-mpse-image-tools-version';
  const bridgeClient = window.__MPSE_BRIDGE_CLIENT__;
  const injectBridge = bridgeClient && typeof bridgeClient.inject === 'function'
    ? bridgeClient.inject
    : () => false;
  const requestBridge = bridgeClient && typeof bridgeClient.request === 'function'
    ? bridgeClient.request
    : () => Promise.reject(new Error('扩展桥接客户端未加载，请刷新页面后重试'));

  const MANAGED_STYLE_PROPS = [
    'border-radius', 'overflow', 'width', 'max-width', 'height', 'display',
    'margin-left', 'margin-right', 'margin-top', 'margin-bottom', 'box-shadow',
    'filter', 'border', 'padding', 'background-color', 'box-sizing', 'object-fit',
    'transform', 'transform-origin', 'vertical-align'
  ];

  const MANAGED_DATA_KEYS = [
    'mpseGlowOn', 'mpseGlowBlur', 'mpseGlowSpread', 'mpseGlowOpacity', 'mpseGlowColor',
    'mpseBrightness', 'mpseContrast', 'mpseSaturate', 'mpseGray', 'mpseRotate',
    'mpseShadowOn', 'mpseShadowX', 'mpseShadowY', 'mpseShadowBlur', 'mpseShadowSpread', 'mpseShadowOpacity', 'mpseShadowColor',
    'mpseBaseBoxShadow', 'mpseCircleOn', 'mpseCircleBase', 'mpseColorBase', 'mpseRotateBase', 'mpseFrameBase'
  ];

  const DEBUG = false;

  const state = {
    image: null,
    identity: null,
    activePanel: null,
    lastDocCount: 0,
    commitTimer: null,
    commitSeq: 0,
    commitInFlight: false,
    queuedCommit: false,
    pendingCommitReason: '',
    isDragging: false,
    interaction: null,
    cropMode: false,
    cropTransientHost: false,
    needsCommit: false,
    lastSnapshot: null
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

  function clamp(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.min(Math.max(n, min), max);
  }

  function parsePx(value, fallback = 0) {
    const match = String(value || '').match(/(-?\d+(?:\.\d+)?)px/);
    return match ? Number(match[1]) : fallback;
  }

  function parsePercent(value, fallback = 100) {
    const match = String(value || '').match(/(-?\d+(?:\.\d+)?)%/);
    return match ? Number(match[1]) : fallback;
  }

  function cssNumber(image, name, fallback) {
    const style = image ? image.style.getPropertyValue(name) : '';
    return parsePx(style, fallback);
  }

  function getDataNumber(image, name, fallback) {
    const n = image && image.dataset ? Number(image.dataset[name]) : NaN;
    return Number.isFinite(n) ? n : fallback;
  }

  function getDataString(image, name, fallback) {
    return image && image.dataset && image.dataset[name] ? image.dataset[name] : fallback;
  }


  function clampInt(value, min, max, fallback = min) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.round(Math.min(Math.max(n, min), max));
  }

  function normalizeCssColorToHex(value, fallback = '#ffd447') {
    const raw = String(value || '').trim();
    if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(raw)) {
      return `#${raw.slice(1).split('').map((ch) => ch + ch).join('')}`.toLowerCase();
    }
    const match = raw.match(/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (!match) return fallback;
    const toHex = (n) => clampInt(n, 0, 255, 0).toString(16).padStart(2, '0');
    return `#${toHex(match[1])}${toHex(match[2])}${toHex(match[3])}`;
  }

  function parseOpacityFromCssColor(value, fallback = 0.16) {
    const rgba = String(value || '').match(/rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\s*\)/i);
    if (rgba) return clamp(Number(rgba[1]), 0, 1);
    if (/rgb\(/i.test(String(value || ''))) return 1;
    return fallback;
  }

  function readStyleNumber(image, prop, fallback = 0) {
    return parsePx(image && image.style ? image.style.getPropertyValue(prop) : '', fallback);
  }

  function readBorderWidth(image, fallback = 1) {
    if (!image || !image.style) return fallback;
    return parsePx(image.style.getPropertyValue('border-width') || image.style.getPropertyValue('border'), fallback);
  }

  function readBorderColor(image, fallback = '#e6e8eb') {
    if (!image || !image.style) return fallback;
    const direct = image.style.getPropertyValue('border-color');
    if (direct) return normalizeCssColorToHex(direct, fallback);
    const border = image.style.getPropertyValue('border');
    const color = border.match(/(#[0-9a-f]{3,6}|rgba?\([^)]*\))/i);
    return color ? normalizeCssColorToHex(color[1], fallback) : fallback;
  }

  function readBackgroundColor(image, fallback = '#ffffff') {
    return normalizeCssColorToHex(image && image.style ? image.style.getPropertyValue('background-color') : '', fallback);
  }

  function readBoxShadow(image) {
    const value = image && image.style ? image.style.getPropertyValue('box-shadow') : '';
    const px = Array.from(String(value).matchAll(/(-?\d+(?:\.\d+)?)px/g)).map((m) => Number(m[1]));
    const color = String(value).match(/(rgba?\([^)]*\)|#[0-9a-f]{3,6})/i);
    return {
      raw: value,
      x: px[0] ?? 0,
      y: px[1] ?? 8,
      blur: px[2] ?? 24,
      spread: px[3] ?? 0,
      opacity: color ? parseOpacityFromCssColor(color[1], 0.16) : 0.16,
      color: color ? normalizeCssColorToHex(color[1], '#ffd447') : '#ffd447'
    };
  }

  function readFilterValues(image) {
    const raw = image && image.style ? image.style.getPropertyValue('filter') : '';
    function percent(name, fallback) {
      const match = raw.match(new RegExp(`${name}\\(([-\\d.]+)%\\)`, 'i'));
      return match ? clampInt(match[1], 0, 300, fallback) : fallback;
    }
    return {
      brightness: getDataNumber(image, 'mpseBrightness', percent('brightness', 100)),
      contrast: getDataNumber(image, 'mpseContrast', percent('contrast', 100)),
      saturate: getDataNumber(image, 'mpseSaturate', percent('saturate', 100)),
      gray: getDataNumber(image, 'mpseGray', percent('grayscale', 0))
    };
  }

  function readRotateAngle(image) {
    const fromData = getDataNumber(image, 'mpseRotate', NaN);
    if (Number.isFinite(fromData)) return fromData;
    const raw = image && image.style ? image.style.getPropertyValue('transform') : '';
    const match = String(raw).match(/rotate\((-?\d+(?:\.\d+)?)deg\)/i);
    return match ? clampInt(match[1], -180, 180, 0) : 0;
  }

  function readCircleDiameter(image) {
    const widthPx = readStyleNumber(image, 'width', NaN);
    const heightPx = readStyleNumber(image, 'height', NaN);
    if (Number.isFinite(widthPx) && widthPx > 0) return widthPx;
    if (Number.isFinite(heightPx) && heightPx > 0) return heightPx;
    try {
      const rect = image.getBoundingClientRect();
      const d = Math.round(Math.min(rect.width || 160, rect.height || rect.width || 160));
      return clamp(d, 40, 520);
    } catch (_) {
      return 160;
    }
  }

  function readFrameDocument(frame) {
    try {
      return frame.contentDocument || null;
    } catch (_) {
      return null;
    }
  }

  function hasNonEmptyStyle(image, prop) {
    return Boolean(image && image.style && String(image.style.getPropertyValue(prop) || '').trim());
  }

  function getAppliedEffects(image) {
    const applied = new Set();
    if (!image || !image.style) return applied;

    const radius = readStyleNumber(image, 'border-radius', 0);
    const width = image.style.getPropertyValue('width');
    const top = readStyleNumber(image, 'margin-top', 0);
    const bottom = readStyleNumber(image, 'margin-bottom', 0);
    const shadow = image.style.getPropertyValue('box-shadow');
    const filter = image.style.getPropertyValue('filter');
    const transform = image.style.getPropertyValue('transform');
    const border = image.style.getPropertyValue('border') || image.style.getPropertyValue('border-width');
    const padding = readStyleNumber(image, 'padding', 0);
    const bg = image.style.getPropertyValue('background-color');
    const objectFit = image.style.getPropertyValue('object-fit');

    if (radius > 0 && !/999/.test(image.style.getPropertyValue('border-radius'))) applied.add('radius');
    if (width || hasNonEmptyStyle(image, 'max-width') || hasNonEmptyStyle(image, 'margin-left') || hasNonEmptyStyle(image, 'margin-right') || getCropContainer(image)) applied.add('size');
    if (top > 0 || bottom > 0) applied.add('spacing');
    if (image.dataset.mpseShadowOn === '1') applied.add('shadow');
    if (image.dataset.mpseGlowOn === '1') applied.add('glow');
    if (shadow && image.dataset.mpseShadowOn !== '1' && image.dataset.mpseGlowOn !== '1') applied.add('shadow');
    if (filter && !/^brightness\(100%\)\s+contrast\(100%\)\s+saturate\(100%\)$/i.test(filter.trim())) applied.add('color');
    if (readRotateAngle(image) !== 0) applied.add('rotate');
    if (border || padding > 0 || bg) applied.add('frame');
    if (getCaptionNode(image)) applied.add('caption');
    if (image.dataset.mpseCircleOn === '1' || ((radius >= 120 || /999/.test(image.style.getPropertyValue('border-radius')) || objectFit === 'cover') && hasNonEmptyStyle(image, 'height'))) applied.add('circle');
    return applied;
  }

  function getAccessibleDocuments() {
    const docs = [document];
    const frames = Array.from(document.querySelectorAll('iframe'));
    for (const frame of frames) {
      const doc = readFrameDocument(frame);
      if (doc && doc.documentElement && !docs.includes(doc)) docs.push(doc);
    }
    return docs;
  }

  function getFrameByDocument(doc) {
    if (!doc || doc === document) return null;
    for (const frame of Array.from(document.querySelectorAll('iframe'))) {
      if (readFrameDocument(frame) === doc) return frame;
    }
    return null;
  }

  function isExtensionElement(node) {
    if (!node || !node.closest) return false;
    return Boolean(node.closest(`#${MENU_ID}, #${PANEL_ID}, #${BOX_ID}, #${BADGE_ID}, #mpse-svg2-panel, #mpse-svg2-pick-button, #mpse-svgb-menu, #mpse-svgb-panel, #mpse-svgb-box, #mpse-svgb-badge, #mpse-inline-panel, #mpse-toolbar-button, #mpse-floating-button`));
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

  function stableUrl(value) {
    return String(value || '')
      .replace(/&amp;/g, '&')
      .replace(/^https?:\/\/mmbiz\.qpic\.cn\//, '//mmbiz.qpic.cn/')
      .replace(/^https?:\/\/mmbiz\.qlogo\.cn\//, '//mmbiz.qlogo.cn/')
      .trim();
  }

  function getAttr(image, name) {
    return image && image.getAttribute ? (image.getAttribute(name) || '') : '';
  }

  function imageIndexInArticle(image) {
    const list = getAllArticleImages();
    const idx = list.indexOf(image);
    return idx >= 0 ? idx : 0;
  }

  function imageSignature(image) {
    return {
      index: imageIndexInArticle(image),
      src: stableUrl(getAttr(image, 'src') || image.currentSrc || image.src),
      dataSrc: stableUrl(getAttr(image, 'data-src')),
      dataBackSrc: stableUrl(getAttr(image, 'data-backsrc')),
      dataCropSrc: stableUrl(getAttr(image, 'data-croporisrc')),
      fileId: getAttr(image, 'data-fileid') || getAttr(image, 'data-mediaid'),
      w: getAttr(image, 'data-w'),
      ratio: getAttr(image, 'data-ratio'),
      className: getAttr(image, 'class'),
      alt: getAttr(image, 'alt')
    };
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
    for (const img of images) {
      const score = scoreImageByIdentity(img, identity);
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

  function getTopRect(element) {
    const rect = element.getBoundingClientRect();
    const frame = getFrameByDocument(element.ownerDocument);
    if (!frame) {
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    }
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

  function createMenu() {
    let menu = document.getElementById(MENU_ID);
    if (menu) return menu;
    menu = document.createElement('div');
    menu.id = MENU_ID;
    menu.innerHTML = `
      <button type="button" data-effect="radius" title="圆角">圆角</button>
      <button type="button" data-effect="size" title="尺寸和对齐">尺寸</button>
      <button type="button" data-effect="spacing" title="上下间距">间距</button>
      <button type="button" data-effect="shadow" title="图片阴影">阴影</button>
      <button type="button" data-effect="glow" title="图片本体发光">发光</button>
      <button type="button" data-effect="color" title="亮度/对比/饱和">色彩</button>
      <button type="button" data-effect="rotate" title="旋转">旋转</button>
      <button type="button" data-effect="frame" title="相框">相框</button>
      <button type="button" data-effect="caption" title="图注">图注</button>
      <button type="button" data-effect="circle" title="圆形头像">圆形</button>
      <button type="button" data-effect="reset" title="清除本工具样式">复位</button>
    `;
    menu.addEventListener('pointerdown', absorbUiEvent, true);
    menu.addEventListener('mousedown', absorbUiEvent, true);
    menu.addEventListener('click', (event) => {
      const button = event.target.closest('[data-effect]');
      if (!button) return;
      stopUiEvent(event);
      const effect = button.dataset.effect;
      if (effect === 'reset') {
        resetImage();
        return;
      }
      if (state.activePanel === effect) {
        closePanel();
        return;
      }
      showPanel(effect);
      if (isToggleEffect(effect) && !isEffectEnabled(state.image, effect)) {
        const panel = document.getElementById(PANEL_ID);
        if (panel) {
          applyEffect(effect, collectValues(panel));
          showPanel(effect);
        }
      }
    }, true);
    document.body.appendChild(menu);
    return menu;
  }

  function createPanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.addEventListener('pointerdown', (event) => {
      absorbUiEvent(event);
      if (event.target && event.target.matches('input[type="range"]')) state.isDragging = true;
    }, true);
    panel.addEventListener('mousedown', absorbUiEvent, true);
    panel.addEventListener('click', (event) => {
      if (event.target.closest('[data-close-panel]')) {
        stopUiEvent(event);
        closePanel();
        return;
      }
      const toggle = event.target.closest('[data-toggle-effect]');
      if (toggle) {
        stopUiEvent(event);
        const effect = panel.dataset.effect;
        if (isEffectEnabled(state.image, effect)) {
          clearEffect(effect);
        } else {
          applyEffect(effect, collectValues(panel));
        }
        showPanel(effect);
        return;
      }
      const clear = event.target.closest('[data-clear-effect]');
      if (clear) {
        stopUiEvent(event);
        const effect = panel.dataset.effect;
        clearEffect(effect);
        showPanel(effect);
        return;
      }
      if (event.target.closest('[data-reset-crop]')) {
        stopUiEvent(event);
        resetCrop();
        showPanel('size');
      }
    }, true);
    panel.addEventListener('input', onPanelInput, true);
    panel.addEventListener('change', onPanelInput, true);
    document.body.appendChild(panel);
    return panel;
  }

  function createBox() {
    let box = document.getElementById(BOX_ID);
    if (box) return box;
    box = document.createElement('div');
    box.id = BOX_ID;
    box.innerHTML = [
      'nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'
    ].map((handle) => `<button type="button" class="mpse-img2-handle mpse-img2-handle-${handle}" data-mpse-image-handle="${handle}" aria-label="${handle}"></button>`).join('');
    box.addEventListener('pointerdown', (event) => {
      const handle = event.target.closest('[data-mpse-image-handle]');
      if (!handle) return;
      stopUiEvent(event);
      beginGeometryGesture(handle.dataset.mpseImageHandle, event);
    }, true);
    document.body.appendChild(box);
    return box;
  }

  function createBadge() {
    let badge = document.getElementById(BADGE_ID);
    if (badge) return badge;
    badge = document.createElement('div');
    badge.id = BADGE_ID;
    document.body.appendChild(badge);
    return badge;
  }

  function cleanupLegacyDom() {
    for (const id of [MENU_ID, PANEL_ID, BOX_ID, BADGE_ID]) {
      const element = document.getElementById(id);
      if (element) element.remove();
    }
  }

  function absorbUiEvent(event) {
    event.stopPropagation();
  }

  function stopUiEvent(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  function setStyle(element, prop, value, important = true) {
    if (!element || !element.style) return;
    if (value === null || value === undefined || value === '') {
      element.style.removeProperty(prop);
      return;
    }
    element.style.setProperty(prop, String(value), important ? 'important' : '');
  }

  function setStyles(element, styles) {
    for (const [prop, value] of Object.entries(styles)) setStyle(element, prop, value);
  }

  function getVisualCarrier(image) {
    if (!image || !image.parentElement) return null;
    const parent = image.parentElement;
    const tag = parent.tagName ? parent.tagName.toLowerCase() : '';
    if (!['span', 'figure', 'div'].includes(tag)) return null;
    const images = parent.querySelectorAll ? parent.querySelectorAll('img') : [];
    const text = (parent.textContent || '').replace(/\u200b/g, '').trim();
    if (images.length === 1 && !text) return parent;
    return null;
  }

  function getCropContainer(image) {
    const parent = image && image.parentElement;
    return parent && parent.getAttribute(CROP_ATTR) === '1' ? parent : null;
  }

  function getLayoutHost(image) {
    return getCropContainer(image) || image;
  }

  function getSelectionElement(image) {
    return getCropContainer(image) || image;
  }

  function getAvailableImageWidth(image) {
    const root = findEditableRoot(image);
    const rootRect = root && root.getBoundingClientRect ? root.getBoundingClientRect() : null;
    if (rootRect && rootRect.width > 1) return rootRect.width;
    const parent = image && image.parentElement;
    const parentRect = parent && parent.getBoundingClientRect ? parent.getBoundingClientRect() : null;
    return parentRect && parentRect.width > 1 ? parentRect.width : 1;
  }

  function readCropState(image) {
    const host = getCropContainer(image);
    if (!host) return null;
    const rawAspect = Number(host.dataset.mpseCropAspect);
    const rawWidth = Number(host.dataset.mpseCropWidth);
    const rawHeight = Number(host.dataset.mpseCropHeight);
    const width = Number.isFinite(rawWidth) ? clamp(rawWidth, 0.04, 1) : 1;
    const height = Number.isFinite(rawHeight) ? clamp(rawHeight, 0.04, 1) : 1;
    const x = Number(host.dataset.mpseCropX);
    const y = Number(host.dataset.mpseCropY);
    return {
      x: Number.isFinite(x) ? clamp(x, 0, Math.max(0, 1 - width)) : 0,
      y: Number.isFinite(y) ? clamp(y, 0, Math.max(0, 1 - height)) : 0,
      width,
      height,
      sourceAspect: Number.isFinite(rawAspect) ? clamp(rawAspect, 0.05, 40) : 1
    };
  }

  function normalizeCropState(next) {
    const width = clamp(next.width, 0.04, 1);
    const height = clamp(next.height, 0.04, 1);
    return {
      x: clamp(next.x, 0, Math.max(0, 1 - width)),
      y: clamp(next.y, 0, Math.max(0, 1 - height)),
      width,
      height,
      sourceAspect: clamp(next.sourceAspect, 0.05, 40)
    };
  }

  function writeCropState(image, next) {
    const host = getCropContainer(image);
    if (!host) return null;
    const crop = normalizeCropState(next);
    host.dataset.mpseCropX = crop.x.toFixed(6);
    host.dataset.mpseCropY = crop.y.toFixed(6);
    host.dataset.mpseCropWidth = crop.width.toFixed(6);
    host.dataset.mpseCropHeight = crop.height.toFixed(6);
    host.dataset.mpseCropAspect = crop.sourceAspect.toFixed(6);

    const aspect = crop.sourceAspect * crop.width / crop.height;
    setStyles(host, {
      display: 'block',
      position: 'relative',
      overflow: 'hidden',
      'aspect-ratio': aspect.toFixed(6),
      'line-height': '0'
    });
    setStyles(image, {
      position: 'absolute',
      left: `${(-crop.x / crop.width * 100).toFixed(5)}%`,
      top: `${(-crop.y / crop.height * 100).toFixed(5)}%`,
      width: `${(100 / crop.width).toFixed(5)}%`,
      height: 'auto',
      'max-width': 'none',
      display: 'block',
      'margin-left': '0',
      'margin-right': '0',
      'margin-top': '0',
      'margin-bottom': '0'
    });
    return crop;
  }

  function copyLayoutStyles(source, target) {
    for (const prop of ['width', 'max-width', 'display', 'margin-left', 'margin-right', 'margin-top', 'margin-bottom', 'vertical-align']) {
      const value = source.style.getPropertyValue(prop);
      if (value) setStyle(target, prop, value);
    }
  }

  function ensureCropContainer(image) {
    const existing = getCropContainer(image);
    if (existing) return { host: existing, created: false };
    if (!image || !image.parentNode) return { host: null, created: false };

    const rect = image.getBoundingClientRect();
    const availableWidth = getAvailableImageWidth(image);
    const sourceAspect = image.naturalWidth && image.naturalHeight
      ? image.naturalWidth / image.naturalHeight
      : Math.max(0.05, rect.width / Math.max(1, rect.height));
    const declaredWidth = image.style.getPropertyValue('width');
    const width = /%\s*$/.test(declaredWidth)
      ? declaredWidth
      : `${clamp(rect.width / Math.max(1, availableWidth) * 100, 4, 100)}%`;
    const host = image.ownerDocument.createElement('span');
    host.setAttribute(CROP_ATTR, '1');
    copyLayoutStyles(image, host);
    image.parentNode.insertBefore(host, image);
    host.appendChild(image);

    for (const prop of ['width', 'max-width', 'display', 'margin-left', 'margin-right', 'margin-top', 'margin-bottom', 'vertical-align', 'position', 'left', 'top', 'height']) {
      image.style.removeProperty(prop);
    }
    setStyles(host, {
      width,
      'max-width': '100%',
      display: 'block',
      position: 'relative',
      overflow: 'hidden',
      'line-height': '0'
    });
    const radius = image.style.getPropertyValue('border-radius');
    if (radius) setStyle(host, 'border-radius', radius);
    writeCropState(image, { x: 0, y: 0, width: 1, height: 1, sourceAspect });
    return { host, created: true };
  }

  function unwrapCropContainer(image) {
    const host = getCropContainer(image);
    if (!host || !host.parentNode) return image;
    const parent = host.parentNode;
    for (const prop of ['position', 'left', 'top', 'height', 'max-width', 'display', 'margin-left', 'margin-right', 'margin-top', 'margin-bottom', 'width', 'vertical-align']) {
      image.style.removeProperty(prop);
    }
    copyLayoutStyles(host, image);
    parent.insertBefore(image, host);
    host.remove();
    return image;
  }

  function resetCrop() {
    const image = state.image;
    if (!image || !getCropContainer(image)) return;
    state.image = unwrapCropContainer(image);
    state.cropMode = false;
    state.cropTransientHost = false;
    const box = document.getElementById(BOX_ID);
    if (box) box.classList.remove('mpse-crop-mode');
    markChanged(state.image, 'crop-reset');
    window.requestAnimationFrame(positionTools);
  }

  function setLayoutWidthFromPixels(image, widthPx) {
    const host = getLayoutHost(image);
    if (!host) return;
    const available = getAvailableImageWidth(image);
    const width = clamp(widthPx / Math.max(1, available) * 100, 4, 100);
    setStyles(host, { width: `${width.toFixed(3)}%`, 'max-width': '100%', display: 'block' });
  }

  function beginGeometryGesture(handle, event) {
    const image = state.image;
    if (!image || !image.isConnected) return;
    const isCorner = ['nw', 'ne', 'se', 'sw'].includes(handle);
    let createdCrop = false;
    if (!isCorner) {
      const result = ensureCropContainer(image);
      if (!result.host) return;
      createdCrop = result.created;
    }
    const target = getSelectionElement(image);
    const rect = getTopRect(target);
    state.interaction = {
      kind: isCorner ? 'resize' : 'crop',
      handle,
      sourceDocument: document,
      startX: event.clientX,
      startY: event.clientY,
      rect,
      startCrop: readCropState(image),
      createdCrop,
      changed: false
    };
    state.isDragging = true;
    if (event.currentTarget && event.currentTarget.setPointerCapture) {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch (_) {
        // Pointer capture is optional across editor iframes.
      }
    }
  }

  function beginCropPan(image, event) {
    const result = ensureCropContainer(image);
    if (!result.host) return;
    const rect = result.host.getBoundingClientRect();
    state.interaction = {
      kind: 'pan',
      sourceDocument: image.ownerDocument,
      startX: event.clientX,
      startY: event.clientY,
      rect,
      startCrop: readCropState(image),
      createdCrop: result.created,
      changed: false
    };
    state.isDragging = true;
  }

  function updateGeometryGesture(event) {
    const interaction = state.interaction;
    const image = state.image;
    if (!interaction || !image || !image.isConnected || event.target.ownerDocument !== interaction.sourceDocument) return;
    const rect = interaction.rect;
    if (rect.width < 1 || rect.height < 1) return;
    const dx = (event.clientX - interaction.startX) / rect.width;
    const dy = (event.clientY - interaction.startY) / rect.height;

    if (interaction.kind === 'resize') {
      const horizontalDirection = interaction.handle.includes('w') ? -1 : 1;
      const nextWidth = Math.max(40, rect.width + horizontalDirection * (event.clientX - interaction.startX));
      setLayoutWidthFromPixels(image, nextWidth);
      interaction.changed = true;
      markChanged(image, 'resize');
      window.requestAnimationFrame(positionTools);
      return;
    }

    const start = interaction.startCrop;
    if (!start) return;
    const next = { ...start };
    if (interaction.kind === 'pan') {
      next.x = start.x - dx * start.width;
      next.y = start.y - dy * start.height;
    } else if (interaction.handle === 'e') {
      next.width = start.width + dx;
    } else if (interaction.handle === 'w') {
      next.x = start.x + dx;
      next.width = start.width - dx;
    } else if (interaction.handle === 's') {
      next.height = start.height + dy;
    } else if (interaction.handle === 'n') {
      next.y = start.y + dy;
      next.height = start.height - dy;
    }
    writeCropState(image, next);
    interaction.changed = true;
    markChanged(image, interaction.kind === 'pan' ? 'crop-pan' : 'crop');
    window.requestAnimationFrame(positionTools);
  }

  function zoomCrop(image, event) {
    const host = getCropContainer(image);
    const crop = readCropState(image);
    if (!host || !crop) return;
    const rect = host.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const pointX = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const pointY = clamp((event.clientY - rect.top) / rect.height, 0, 1);
    const scale = event.deltaY < 0 ? 0.9 : 1.1;
    const width = clamp(crop.width * scale, 0.04, 1);
    const height = clamp(crop.height * scale, 0.04, 1);
    writeCropState(image, {
      ...crop,
      width,
      height,
      x: crop.x + crop.width * pointX - width * pointX,
      y: crop.y + crop.height * pointY - height * pointY
    });
    markChanged(image, 'crop-zoom');
    window.requestAnimationFrame(positionTools);
  }

  function finishGeometryGesture(event) {
    const interaction = state.interaction;
    if (!interaction) return false;
    if (event && event.target && event.target.ownerDocument !== interaction.sourceDocument) return false;
    state.interaction = null;
    state.isDragging = false;
    if (interaction.createdCrop && !interaction.changed && !state.cropMode) unwrapCropContainer(state.image);
    if (interaction.changed && state.needsCommit) scheduleContentCommit('drag-end');
    return true;
  }

  function enterCropMode(image) {
    const result = ensureCropContainer(image);
    if (!result.host) return;
    state.cropMode = true;
    state.cropTransientHost = result.created;
    createBox().classList.add('mpse-crop-mode');
    setBadgeText('裁切模式：拖动图片，Ctrl + 滚轮缩放');
    window.requestAnimationFrame(positionTools);
  }

  function exitCropMode() {
    if (state.cropTransientHost && !state.needsCommit && state.image) unwrapCropContainer(state.image);
    state.cropMode = false;
    state.cropTransientHost = false;
    const box = document.getElementById(BOX_ID);
    if (box) box.classList.remove('mpse-crop-mode');
    const badge = document.getElementById(BADGE_ID);
    if (badge && /裁切/.test(badge.textContent || '')) badge.textContent = '';
    window.requestAnimationFrame(positionTools);
  }

  function setCarrierStyles(image, styles) {
    const carrier = getVisualCarrier(image);
    if (!carrier) return;
    setStyles(carrier, styles);
  }

  function hexToRgb(hex) {
    const clean = String(hex || '#ffd447').replace('#', '').trim();
    const full = clean.length === 3 ? clean.split('').map((ch) => ch + ch).join('') : clean;
    const int = Number.parseInt(full, 16);
    if (!Number.isFinite(int)) return { r: 255, g: 212, b: 71 };
    return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
  }

  function hexToRgba(hex, opacity, fallback = '#0f2337') {
    const color = hexToRgb(hex || fallback);
    return `rgba(${color.r}, ${color.g}, ${color.b}, ${clamp(opacity, 0, 1)})`;
  }

  function rebuildFilter(image) {
    const brightness = getDataNumber(image, 'mpseBrightness', 100);
    const contrast = getDataNumber(image, 'mpseContrast', 100);
    const saturate = getDataNumber(image, 'mpseSaturate', 100);
    const gray = getDataNumber(image, 'mpseGray', 0);
    const parts = [`brightness(${brightness}%)`, `contrast(${contrast}%)`, `saturate(${saturate}%)`];
    if (gray > 0) parts.push(`grayscale(${gray}%)`);
    setStyle(image, 'filter', parts.join(' '));
  }

  function applyGlowBoxShadow(image, values) {
    image.dataset.mpseGlowOn = '1';
    image.dataset.mpseGlowBlur = String(clamp(values.blur, 0, 120));
    image.dataset.mpseGlowSpread = String(clamp(values.spread, 0, 40));
    image.dataset.mpseGlowOpacity = String(clamp(values.opacity, 0, 100));
    image.dataset.mpseGlowColor = values.glowColor || '#ffd447';
    rebuildManagedBoxShadow(image);
  }

  function captureBaseBoxShadow(image) {
    if (!image || image.dataset.mpseBaseBoxShadow !== undefined) return;
    image.dataset.mpseBaseBoxShadow = image.style.getPropertyValue('box-shadow') || '';
  }

  function rebuildManagedBoxShadow(image) {
    if (!image) return;
    const shadows = [];
    const base = image.dataset.mpseBaseBoxShadow;
    if (base) shadows.push(base);

    if (image.dataset.mpseShadowOn === '1') {
      const x = getDataNumber(image, 'mpseShadowX', 0);
      const y = getDataNumber(image, 'mpseShadowY', 8);
      const blur = getDataNumber(image, 'mpseShadowBlur', 24);
      const spread = getDataNumber(image, 'mpseShadowSpread', 0);
      const opacity = getDataNumber(image, 'mpseShadowOpacity', 16) / 100;
      const color = getDataString(image, 'mpseShadowColor', '#0f2337');
      shadows.push(`${x}px ${y}px ${blur}px ${spread}px ${hexToRgba(color, opacity, '#0f2337')}`);
    }

    if (image.dataset.mpseGlowOn === '1') {
      const blur = getDataNumber(image, 'mpseGlowBlur', 22);
      const spread = getDataNumber(image, 'mpseGlowSpread', 0);
      const opacity = getDataNumber(image, 'mpseGlowOpacity', 55) / 100;
      const color = hexToRgb(getDataString(image, 'mpseGlowColor', '#ffd447'));
      const rgba1 = `rgba(${color.r}, ${color.g}, ${color.b}, ${opacity})`;
      const rgba2 = `rgba(${color.r}, ${color.g}, ${color.b}, ${Math.max(0, opacity * 0.42)})`;
      const secondBlur = Math.round(blur * 1.65);
      shadows.push(`0 0 ${blur}px ${spread}px ${rgba1}`);
      shadows.push(`0 0 ${secondBlur}px ${Math.max(0, Math.round(spread / 2))}px ${rgba2}`);
    }

    setStyle(image, 'box-shadow', shadows.join(', '));
  }

  function captureCircleBase(image) {
    if (!image || image.dataset.mpseCircleBase) return;
    const values = {};
    for (const prop of ['width', 'height', 'max-width', 'border-radius', 'object-fit', 'display', 'margin-left', 'margin-right']) {
      values[prop] = image.style.getPropertyValue(prop) || '';
    }
    image.dataset.mpseCircleBase = JSON.stringify(values);
  }

  function restoreCircleBase(image) {
    if (!image) return;
    try {
      const values = JSON.parse(image.dataset.mpseCircleBase || '{}');
      for (const prop of ['width', 'height', 'max-width', 'border-radius', 'object-fit', 'display', 'margin-left', 'margin-right']) {
        setStyle(image, prop, values[prop] || '');
      }
    } catch (_) {
      setStyles(image, { height: '', 'object-fit': '', 'border-radius': '' });
    }
    delete image.dataset.mpseCircleBase;
    delete image.dataset.mpseCircleOn;
  }

  function captureStyleBase(image, key, props) {
    if (!image || image.dataset[key]) return;
    const values = {};
    for (const prop of props) values[prop] = image.style.getPropertyValue(prop) || '';
    image.dataset[key] = JSON.stringify(values);
  }

  function restoreStyleBase(image, key, props) {
    if (!image) return;
    try {
      const values = JSON.parse(image.dataset[key] || '{}');
      for (const prop of props) setStyle(image, prop, values[prop] || '');
    } catch (_) {
      for (const prop of props) setStyle(image, prop, '');
    }
    delete image.dataset[key];
  }

  function range(label, name, min, max, step, value, suffix = '') {
    return `
      <label class="mpse-img2-control">
        <span>${escapeHtml(label)} <em data-value-for="${escapeHtml(name)}" data-suffix="${escapeHtml(suffix)}">${escapeHtml(value)}${escapeHtml(suffix)}</em></span>
        <input type="range" name="${escapeHtml(name)}" min="${min}" max="${max}" step="${step}" value="${escapeHtml(value)}">
      </label>
    `;
  }

  function color(label, name, value) {
    return `
      <label class="mpse-img2-control mpse-img2-inline">
        <span>${escapeHtml(label)}</span>
        <input type="color" name="${escapeHtml(name)}" value="${escapeHtml(value)}">
      </label>
    `;
  }

  function text(label, name, value, placeholder = '') {
    return `
      <label class="mpse-img2-control">
        <span>${escapeHtml(label)}</span>
        <input type="text" name="${escapeHtml(name)}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}">
      </label>
    `;
  }

  function select(label, name, value) {
    const options = [
      { value: 'left', label: '左对齐' },
      { value: 'center', label: '居中' },
      { value: 'right', label: '右对齐' }
    ];
    return `
      <label class="mpse-img2-control">
        <span>${escapeHtml(label)}</span>
        <select name="${escapeHtml(name)}">
          ${options.map((item) => `<option value="${item.value}"${item.value === value ? ' selected' : ''}>${item.label}</option>`).join('')}
        </select>
      </label>
    `;
  }

  function getCaptionAnchor(image) {
    if (!image || !image.closest) return image;
    return image.closest('section,p,figure,div') || image;
  }

  function getCaptionNode(image) {
    if (!image) return null;
    const anchor = getCaptionAnchor(image);
    const next = anchor && anchor.nextElementSibling;
    if (next && next.getAttribute('data-mpse-image-caption') === '1') return next;
    return null;
  }

  function buildPanelBody(effect, image) {
    const layoutHost = getLayoutHost(image);
    const radius = readStyleNumber(image, 'border-radius', 12);
    const layoutRect = layoutHost.getBoundingClientRect();
    const width = parsePercent(layoutHost.style.getPropertyValue('width'), clamp(layoutRect.width / Math.max(1, getAvailableImageWidth(image)) * 100, 4, 100));
    const top = readStyleNumber(layoutHost, 'margin-top', 0);
    const bottom = readStyleNumber(layoutHost, 'margin-bottom', 0);
    const shadowDefaults = readBoxShadow(image);
    const colorDefaults = readFilterValues(image);

    if (effect === 'radius') return range('圆角半径', 'radius', 0, 80, 1, radius, 'px');
    if (effect === 'size') {
      let align = 'center';
      if (layoutHost.style.getPropertyValue('margin-left') === '0px' || layoutHost.style.getPropertyValue('margin-left') === '0') align = 'left';
      if (layoutHost.style.getPropertyValue('margin-right') === '0px' || layoutHost.style.getPropertyValue('margin-right') === '0') align = 'right';
      const cropAction = getCropContainer(image)
        ? '<button type="button" class="mpse-img2-reset-crop" data-reset-crop>恢复裁切</button>'
        : '';
      return `${range('宽度', 'width', 10, 100, 1, width, '%')}${select('对齐', 'align', align)}${cropAction}`;
    }
    if (effect === 'spacing') return `${range('上间距', 'top', 0, 120, 1, top, 'px')}${range('下间距', 'bottom', 0, 120, 1, bottom, 'px')}`;
    if (effect === 'shadow') return `${range('水平', 'x', -80, 80, 1, getDataNumber(image, 'mpseShadowX', clampInt(shadowDefaults.x, -80, 80, 0)), 'px')}${range('下移', 'y', -80, 80, 1, getDataNumber(image, 'mpseShadowY', clampInt(shadowDefaults.y, -80, 80, 8)), 'px')}${range('模糊', 'blur', 0, 120, 1, getDataNumber(image, 'mpseShadowBlur', clampInt(shadowDefaults.blur, 0, 120, 24)), 'px')}${range('扩散', 'spread', -40, 40, 1, getDataNumber(image, 'mpseShadowSpread', clampInt(shadowDefaults.spread, -40, 40, 0)), 'px')}${range('透明度', 'opacity', 0, 100, 1, getDataNumber(image, 'mpseShadowOpacity', clampInt(shadowDefaults.opacity * 100, 0, 100, 16)), '%')}${color('阴影颜色', 'shadowColor', getDataString(image, 'mpseShadowColor', shadowDefaults.color || '#0f2337'))}`;
    if (effect === 'glow') return `${range('发光半径', 'blur', 0, 120, 1, getDataNumber(image, 'mpseGlowBlur', clampInt(shadowDefaults.blur, 0, 120, 22)), 'px')}${range('扩散', 'spread', 0, 40, 1, getDataNumber(image, 'mpseGlowSpread', clampInt(shadowDefaults.spread, 0, 40, 0)), 'px')}${range('发光强度', 'opacity', 0, 100, 1, getDataNumber(image, 'mpseGlowOpacity', clampInt(shadowDefaults.opacity * 100, 0, 100, 55)), '%')}${color('发光颜色', 'glowColor', getDataString(image, 'mpseGlowColor', shadowDefaults.color || '#ffd447'))}`;
    if (effect === 'color') return `${range('亮度', 'brightness', 40, 180, 1, colorDefaults.brightness, '%')}${range('对比度', 'contrast', 40, 180, 1, colorDefaults.contrast, '%')}${range('饱和度', 'saturate', 0, 240, 1, colorDefaults.saturate, '%')}${range('灰度', 'gray', 0, 100, 1, colorDefaults.gray, '%')}`;
    if (effect === 'rotate') return range('角度', 'angle', -180, 180, 1, readRotateAngle(image), '°');
    if (effect === 'frame') return `${range('边框宽度', 'borderWidth', 0, 20, 1, readBorderWidth(image, 1), 'px')}${range('内边距', 'padding', 0, 40, 1, readStyleNumber(image, 'padding', 4), 'px')}${range('框圆角', 'radius', 0, 80, 1, radius, 'px')}${color('边框颜色', 'borderColor', readBorderColor(image, '#e6e8eb'))}${color('底色', 'backgroundColor', readBackgroundColor(image, '#ffffff'))}`;
    if (effect === 'caption') {
      const caption = getCaptionNode(image);
      const textNode = caption ? caption.querySelector('[data-mpse-caption-text="1"]') : null;
      return `${text('说明文字', 'caption', textNode ? textNode.textContent : '图片说明', '输入图片说明')}${range('字号', 'fontSize', 10, 24, 1, textNode ? parsePx(textNode.style.getPropertyValue('font-size'), 12) : 12, 'px')}${range('上间距', 'marginTop', 0, 40, 1, textNode ? parsePx(textNode.style.getPropertyValue('margin-top'), 6) : 6, 'px')}${color('文字颜色', 'captionColor', '#8a8f99')}`;
    }
    if (effect === 'circle') return range('直径', 'diameter', 40, 520, 1, readCircleDiameter(image), 'px');
    return '';
  }

  function collectValues(panel) {
    const values = {};
    for (const input of Array.from(panel.querySelectorAll('input, select'))) {
      if (!input.name) continue;
      values[input.name] = input.type === 'range' ? Number(input.value) : input.value;
    }
    return values;
  }

  function updateValueLabels(panel) {
    for (const input of Array.from(panel.querySelectorAll('input[type="range"]'))) {
      const label = panel.querySelector(`[data-value-for="${input.name}"]`);
      if (label) label.textContent = `${input.value}${label.dataset.suffix || ''}`;
    }
  }

  function panelTipForEffect(effect) {
    if (effect === 'size') return '角点等比缩放，边中点裁切；双击图片进入裁切模式，拖动图片并用 Ctrl + 滚轮缩放。';
    if (effect === 'shadow' || effect === 'glow') return '阴影/发光的边角跟随图片圆角；需要圆角请单独调“圆角”。';
    return '只有实际调整后才会同步到正文 HTML';
  }

  function isToggleEffect(effect) {
    return effect === 'shadow' || effect === 'glow';
  }

  function isEffectEnabled(image, effect) {
    if (!image) return false;
    if (effect === 'shadow') return image.dataset.mpseShadowOn === '1';
    if (effect === 'glow') return image.dataset.mpseGlowOn === '1';
    return getAppliedEffects(image).has(effect);
  }

  function closePanel() {
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.classList.remove('mpse-visible');
    state.activePanel = null;
    setButtonStates();
  }

  function showPanel(effect) {
    const image = state.image;
    if (!image || !image.isConnected || !isLikelyArticleImage(image)) {
      hideTools();
      return;
    }

    state.activePanel = effect;
    const titles = { radius: '圆角', size: '尺寸', spacing: '间距', shadow: '阴影', glow: '发光', color: '色彩', rotate: '旋转', frame: '相框', caption: '图注', circle: '圆形' };
    const panel = createPanel();
    const supportsToggle = isToggleEffect(effect);
    const enabled = isEffectEnabled(image, effect);
    const supportsClear = effect !== 'size';
    panel.dataset.effect = effect;
    panel.innerHTML = `
      <div class="mpse-img2-panel-head">
        <strong>${escapeHtml(titles[effect] || '图片参数')}</strong>
        <span class="mpse-img2-panel-actions">
          ${supportsToggle ? `<button type="button" data-toggle-effect title="${enabled ? '关闭效果' : '启用效果'}">${enabled ? '关闭' : '启用'}</button>` : ''}
          ${supportsClear ? '<button type="button" data-clear-effect title="恢复此项">恢复</button>' : ''}
          <button type="button" data-close-panel title="收起">×</button>
        </span>
      </div>
      <div class="mpse-img2-panel-body">${buildPanelBody(effect, image)}</div>
      <div class="mpse-img2-tip">${escapeHtml(panelTipForEffect(effect))}</div>
    `;
    panel.classList.add('mpse-visible');
    setButtonStates();
    updateValueLabels(panel);
    positionTools();
  }

  function setButtonStates() {
    const menu = document.getElementById(MENU_ID);
    if (!menu) return;
    const applied = getAppliedEffects(state.image);
    const panel = document.getElementById(PANEL_ID);
    const activeEffect = panel && panel.classList.contains('mpse-visible') ? state.activePanel : null;
    for (const button of Array.from(menu.querySelectorAll('[data-effect]'))) {
      const effect = button.dataset.effect;
      const isCurrent = effect === activeEffect && effect !== 'size';
      const isApplied = applied.has(effect);
      const showApplied = effect !== 'size' && effect !== 'reset' && isApplied;
      button.classList.toggle('mpse-active', isCurrent);
      button.classList.toggle('mpse-applied', showApplied);
      button.setAttribute('aria-pressed', showApplied ? 'true' : 'false');
      button.title = `${button.textContent || effect}${showApplied ? '：已应用' : ''}${isCurrent ? '（正在调整）' : ''}`;
    }
  }

  function refreshVisiblePanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel || !panel.classList.contains('mpse-visible')) return;
    if (!state.image || !state.image.isConnected) return;
    if (state.isDragging) return;
    showPanel(state.activePanel || panel.dataset.effect || 'radius');
  }

  function onPanelInput(event) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel || !panel.classList.contains('mpse-visible')) return;
    if (!event.target || !event.target.closest(`#${PANEL_ID}`)) return;
    updateValueLabels(panel);
    applyEffect(panel.dataset.effect, collectValues(panel));
  }

  function applyEffect(effect, values) {
    const image = state.image;
    if (!image || !image.isConnected) return;
    const layoutHost = getLayoutHost(image);

    if (effect === 'radius') {
      const r = clamp(values.radius, 0, 80);
      setStyles(image, { 'border-radius': `${r}px`, overflow: r > 0 ? 'hidden' : '', 'vertical-align': 'middle' });
      setCarrierStyles(image, getCropContainer(image)
        ? { 'border-radius': `${r}px`, overflow: 'hidden' }
        : { 'border-radius': `${r}px`, overflow: r > 0 ? 'hidden' : '', display: 'inline-block' });
    }

    if (effect === 'size') {
      const width = clamp(values.width, 10, 100);
      const align = values.align || 'center';
      setStyles(layoutHost, { width: `${width}%`, 'max-width': '100%', display: 'block' });
      if (!getCropContainer(image)) setStyle(image, 'height', 'auto');
      if (align === 'left') setStyles(layoutHost, { 'margin-left': '0', 'margin-right': 'auto' });
      if (align === 'center') setStyles(layoutHost, { 'margin-left': 'auto', 'margin-right': 'auto' });
      if (align === 'right') setStyles(layoutHost, { 'margin-left': 'auto', 'margin-right': '0' });
      const block = layoutHost.closest && layoutHost.closest('p,section,div,figure');
      if (block) setStyle(block, 'text-align', align);
    }

    if (effect === 'spacing') {
      setStyles(layoutHost, { display: 'block', 'margin-top': `${clamp(values.top, 0, 120)}px`, 'margin-bottom': `${clamp(values.bottom, 0, 120)}px` });
    }

    if (effect === 'shadow') {
      const x = clamp(values.x, -80, 80);
      const y = clamp(values.y, -80, 80);
      const blur = clamp(values.blur, 0, 120);
      const spread = clamp(values.spread, -40, 40);
      const shadowColor = values.shadowColor || '#0f2337';
      captureBaseBoxShadow(image);
      image.dataset.mpseShadowOn = '1';
      image.dataset.mpseShadowX = String(x);
      image.dataset.mpseShadowY = String(y);
      image.dataset.mpseShadowBlur = String(blur);
      image.dataset.mpseShadowSpread = String(spread);
      image.dataset.mpseShadowOpacity = String(clamp(values.opacity, 0, 100));
      image.dataset.mpseShadowColor = shadowColor;
      rebuildManagedBoxShadow(image);
    }

    if (effect === 'glow') {
      captureBaseBoxShadow(image);
      applyGlowBoxShadow(image, values);
    }

    if (effect === 'color') {
      captureStyleBase(image, 'mpseColorBase', ['filter']);
      image.dataset.mpseBrightness = String(clamp(values.brightness, 40, 180));
      image.dataset.mpseContrast = String(clamp(values.contrast, 40, 180));
      image.dataset.mpseSaturate = String(clamp(values.saturate, 0, 240));
      image.dataset.mpseGray = String(clamp(values.gray, 0, 100));
      rebuildFilter(image);
    }

    if (effect === 'rotate') {
      const angle = clamp(values.angle, -180, 180);
      captureStyleBase(image, 'mpseRotateBase', ['transform', 'transform-origin']);
      image.dataset.mpseRotate = String(angle);
      setStyles(image, { transform: `rotate(${angle}deg)`, 'transform-origin': 'center center' });
    }

    if (effect === 'frame') {
      const borderWidth = clamp(values.borderWidth, 0, 20);
      captureStyleBase(image, 'mpseFrameBase', ['border', 'padding', 'background-color', 'border-radius', 'box-sizing']);
      setStyles(image, {
        border: borderWidth > 0 ? `${borderWidth}px solid ${values.borderColor || '#e6e8eb'}` : '',
        padding: `${clamp(values.padding, 0, 40)}px`,
        'background-color': values.backgroundColor || '#ffffff',
        'border-radius': `${clamp(values.radius, 0, 80)}px`,
        'box-sizing': 'border-box'
      });
    }

    if (effect === 'caption') updateCaption(image, values);

    if (effect === 'circle') {
      const d = clamp(values.diameter, 40, 520);
      captureCircleBase(image);
      image.dataset.mpseCircleOn = '1';
      setStyles(image, {
        width: `${d}px`, height: `${d}px`, 'max-width': '100%', 'border-radius': '999px',
        'object-fit': 'cover', display: 'block', 'margin-left': 'auto', 'margin-right': 'auto'
      });
    }

    markChanged(image, effect);
    setButtonStates();
    window.requestAnimationFrame(positionTools);
  }

  function clearEffect(effect) {
    const image = state.image;
    if (!image || !image.isConnected || effect === 'size') return;

    if (effect === 'radius') {
      setStyles(image, { 'border-radius': '', overflow: '', 'vertical-align': '' });
      setCarrierStyles(image, getCropContainer(image)
        ? { 'border-radius': '' }
        : { 'border-radius': '', overflow: '' });
    }
    if (effect === 'spacing') {
      setStyles(getLayoutHost(image), { 'margin-top': '', 'margin-bottom': '' });
    }
    if (effect === 'shadow') {
      for (const key of ['mpseShadowOn', 'mpseShadowX', 'mpseShadowY', 'mpseShadowBlur', 'mpseShadowSpread', 'mpseShadowOpacity', 'mpseShadowColor']) delete image.dataset[key];
      if (image.dataset.mpseGlowOn === '1') {
        rebuildManagedBoxShadow(image);
      } else {
        setStyle(image, 'box-shadow', image.dataset.mpseBaseBoxShadow || '');
        delete image.dataset.mpseBaseBoxShadow;
      }
    }
    if (effect === 'glow') {
      for (const key of ['mpseGlowOn', 'mpseGlowBlur', 'mpseGlowSpread', 'mpseGlowOpacity', 'mpseGlowColor']) delete image.dataset[key];
      if (image.dataset.mpseShadowOn === '1') {
        rebuildManagedBoxShadow(image);
      } else {
        setStyle(image, 'box-shadow', image.dataset.mpseBaseBoxShadow || '');
        delete image.dataset.mpseBaseBoxShadow;
      }
    }
    if (effect === 'color') {
      for (const key of ['mpseBrightness', 'mpseContrast', 'mpseSaturate', 'mpseGray']) delete image.dataset[key];
      restoreStyleBase(image, 'mpseColorBase', ['filter']);
    }
    if (effect === 'rotate') {
      delete image.dataset.mpseRotate;
      restoreStyleBase(image, 'mpseRotateBase', ['transform', 'transform-origin']);
    }
    if (effect === 'frame') {
      restoreStyleBase(image, 'mpseFrameBase', ['border', 'padding', 'background-color', 'border-radius', 'box-sizing']);
    }
    if (effect === 'caption') {
      const caption = getCaptionNode(image);
      if (caption) caption.remove();
    }
    if (effect === 'circle') {
      restoreCircleBase(image);
    }

    markChanged(image, `clear-${effect}`);
    setButtonStates();
    window.requestAnimationFrame(positionTools);
  }

  function updateCaption(image, values) {
    const anchor = getCaptionAnchor(image);
    if (!anchor || !anchor.parentNode) return;
    let caption = getCaptionNode(image);
    if (!caption) {
      caption = image.ownerDocument.createElement('section');
      caption.setAttribute('data-mpse-image-caption', '1');
      caption.innerHTML = '<span data-mpse-caption-text="1"></span>';
      anchor.parentNode.insertBefore(caption, anchor.nextSibling);
    }
    const textNode = caption.querySelector('[data-mpse-caption-text="1"]') || caption;
    textNode.textContent = values.caption || '图片说明';
    setStyles(caption, { 'text-align': 'center', margin: '0', padding: '0' });
    setStyles(textNode, { display: 'inline-block', 'font-size': `${clamp(values.fontSize, 10, 24)}px`, 'line-height': '1.6', 'margin-top': `${clamp(values.marginTop, 0, 40)}px`, color: values.captionColor || '#8a8f99' });
  }

  function resetImage() {
    const image = unwrapCropContainer(state.image);
    if (!image || !image.isConnected) return;
    state.image = image;
    exitCropMode();
    for (const prop of MANAGED_STYLE_PROPS) image.style.removeProperty(prop);
    for (const key of MANAGED_DATA_KEYS) delete image.dataset[key];
    const carrier = getVisualCarrier(image);
    if (carrier) {
      for (const prop of ['border-radius', 'overflow', 'display']) carrier.style.removeProperty(prop);
    }
    const caption = getCaptionNode(image);
    if (caption) caption.remove();
    markChanged(image, 'reset');
    closePanel();
    setButtonStates();
    positionTools();
  }

  function snapshotCurrentImage() {
    const image = state.image;
    if (!image || !image.isConnected) return null;
    const cropHost = getCropContainer(image);
    const carrier = cropHost ? null : getVisualCarrier(image);
    const block = image.closest && image.closest('p,section,div,figure');
    const caption = getCaptionNode(image);
    return {
      identity: state.identity || imageSignature(image),
      imgStyle: image.getAttribute('style') || '',
      imgData: MANAGED_DATA_KEYS.reduce((acc, key) => {
        if (image.dataset && image.dataset[key] !== undefined) acc[key] = image.dataset[key];
        return acc;
      }, {}),
      carrierStyle: carrier ? (carrier.getAttribute('style') || '') : '',
      blockStyle: block ? (block.getAttribute('style') || '') : '',
      cropHtml: cropHost ? cropHost.outerHTML : '',
      captionHtml: caption ? caption.outerHTML : '',
      captionAction: caption ? 'upsert' : 'none'
    };
  }

  function dispatchEditorEvent(target, type) {
    try {
      return target.dispatchEvent(new Event(type, { bubbles: true }));
    } catch (_) {
      return false;
    }
  }

  function markChanged(image, reason) {
    if (!image || !image.ownerDocument) return;
    image.setAttribute('data-mpse-image-edited', '1');
    state.lastSnapshot = snapshotCurrentImage();
    state.needsCommit = true;

    const doc = image.ownerDocument;
    const root = findEditableRoot(image) || doc.body;
    for (const target of [image, root, doc.body].filter(Boolean)) {
      dispatchEditorEvent(target, 'input');
      dispatchEditorEvent(target, 'change');
    }

    if (DEBUG) console.info('[公众号源码排版助手] image style applied', reason || '', image.getAttribute('style') || '');
    scheduleContentCommit(reason);
  }

  function setBadgeText(text) {
    const badge = createBadge();
    if (badge && text) badge.textContent = text;
  }

  function scheduleContentCommit(reason) {
    if (state.commitTimer) window.clearTimeout(state.commitTimer);
    state.pendingCommitReason = reason || state.pendingCommitReason;

    if (state.isDragging) {
      setBadgeText('待同步');
      return;
    }

    const delay = reason === 'drag-end' ? 260 : 520;
    state.commitTimer = window.setTimeout(() => commitSnapshotToEditor(state.pendingCommitReason), delay);
  }

  function copyManagedData(source, target) {
    for (const key of MANAGED_DATA_KEYS) {
      const attr = `data-${key.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}`;
      if (source.imgData && Object.prototype.hasOwnProperty.call(source.imgData, key)) {
        target.setAttribute(attr, source.imgData[key]);
      } else {
        target.removeAttribute(attr);
      }
    }
  }

  function replaceOrRemoveCaption(targetImage, root, snapshot) {
    const targetAnchor = targetImage.closest('section,p,figure,div') || targetImage;
    const next = targetAnchor.nextElementSibling;
    if (next && next.getAttribute('data-mpse-image-caption') === '1') next.remove();
    if (!snapshot.captionHtml) return;
    const temp = root.ownerDocument.createElement('div');
    temp.innerHTML = snapshot.captionHtml;
    const caption = temp.firstElementChild;
    if (caption && targetAnchor.parentNode) targetAnchor.parentNode.insertBefore(caption, targetAnchor.nextSibling);
  }

  function applyCropSnapshot(target, root, snapshot) {
    const currentHost = getCropContainer(target);
    if (!snapshot.cropHtml) return currentHost ? unwrapCropContainer(target) : target;

    const holder = root.ownerDocument.createElement('div');
    holder.innerHTML = snapshot.cropHtml;
    const replacement = holder.firstElementChild;
    const replacementImage = replacement && replacement.querySelector ? replacement.querySelector('img') : null;
    const replaceTarget = currentHost || target;
    if (!replacement || !replacementImage || !replaceTarget.parentNode) return target;
    replaceTarget.parentNode.replaceChild(replacement, replaceTarget);
    return replacementImage;
  }

  function applySnapshotToHtml(content, snapshot) {
    if (!snapshot || !snapshot.identity) return { html: content, changed: false, reason: 'no-snapshot' };
    const parser = new DOMParser();
    const doc = parser.parseFromString(`<div id="mpse-root">${content || ''}</div>`, 'text/html');
    const root = doc.getElementById('mpse-root');
    if (!root) return { html: content, changed: false, reason: 'parse-failed' };

    let target = locateImageInHtml(root, snapshot.identity);
    if (!target) return { html: content, changed: false, reason: 'image-not-found' };

    target = applyCropSnapshot(target, root, snapshot);

    if (snapshot.imgStyle) target.setAttribute('style', snapshot.imgStyle);
    else target.removeAttribute('style');
    target.setAttribute('data-mpse-image-edited', '1');
    copyManagedData(snapshot, target);

    const carrier = snapshot.cropHtml ? null : target.parentElement;
    const carrierImages = carrier && carrier.querySelectorAll ? carrier.querySelectorAll('img') : [];
    const carrierText = carrier ? (carrier.textContent || '').replace(/\u200b/g, '').trim() : '';
    if (carrier && ['SPAN', 'FIGURE', 'DIV'].includes(carrier.tagName) && carrierImages.length === 1 && !carrierText) {
      if (snapshot.carrierStyle) carrier.setAttribute('style', snapshot.carrierStyle);
      else if (carrier.hasAttribute('style')) carrier.removeAttribute('style');
    }

    const block = target.closest('p,section,div,figure');
    if (block && snapshot.blockStyle) block.setAttribute('style', snapshot.blockStyle);

    replaceOrRemoveCaption(target, root, snapshot);
    return { html: root.innerHTML, changed: true, reason: 'ok' };
  }

  function cropWasPersisted(content, identity) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(`<div id="mpse-root">${content || ''}</div>`, 'text/html');
    const root = doc.getElementById('mpse-root');
    const target = root && locateImageInHtml(root, identity);
    return Boolean(target && getCropContainer(target));
  }

  async function commitSnapshotToEditor(reason) {
    if (state.commitInFlight) {
      state.queuedCommit = true;
      return;
    }
    if (!state.needsCommit || !state.lastSnapshot) return;
    const snapshot = state.lastSnapshot;
    state.needsCommit = false;
    const seq = ++state.commitSeq;
    state.commitInFlight = true;
    state.pendingCommitReason = '';
    let failed = false;
    setBadgeText('同步中…');

    try {
      const current = await requestBridge('GET_CONTENT', {}, 15000);
      const content = typeof current.content === 'string' ? current.content : '';
      const result = applySnapshotToHtml(content, snapshot);
      if (!result.changed) {
        console.warn('[公众号源码排版助手] image html sync skipped:', result.reason);
        setBadgeText('仅预览');
        return;
      }
      await requestBridge('SET_CONTENT', { content: result.html }, 15000);
      let cropPersisted = true;
      if (snapshot.cropHtml) {
        try {
          const verification = await requestBridge('GET_CONTENT', {}, 15000);
          cropPersisted = cropWasPersisted(verification.content, snapshot.identity);
        } catch (error) {
          console.warn('[公众号源码排版助手] image crop verification failed:', error);
        }
      }
      if (seq === state.commitSeq) {
        if (DEBUG) console.info('[公众号源码排版助手] image html synced', reason || '', current.mode || 'unknown');
        setBadgeText(cropPersisted ? '已同步' : '裁切未保留');
        window.setTimeout(() => reacquireSelectedImage(snapshot.identity), 180);
      }
    } catch (error) {
      failed = true;
      state.needsCommit = true;
      console.warn('[公众号源码排版助手] image html sync failed:', error);
      setBadgeText('同步失败');
    } finally {
      state.commitInFlight = false;
      if (state.queuedCommit || (!failed && state.needsCommit && state.lastSnapshot !== snapshot)) {
        state.queuedCommit = false;
        scheduleContentCommit('queued');
      }
    }
  }

  function reacquireSelectedImage(identity = state.identity) {
    if (!identity) return;
    let best = null;
    let bestScore = -1;
    const list = getAllArticleImages();
    for (const image of list) {
      const asDom = {
        getAttribute: (name) => {
          if (name === 'src') return getAttr(image, 'src') || image.currentSrc || image.src || '';
          return getAttr(image, name);
        }
      };
      const score = scoreImageByIdentity(asDom, identity);
      if (score > bestScore) {
        best = image;
        bestScore = score;
      }
    }
    if (!best && list[identity.index]) best = list[identity.index];
    if (best) {
      state.image = best;
      state.identity = imageSignature(best);
      if (state.cropMode && !getCropContainer(best)) exitCropMode();
      setButtonStates();
      refreshVisiblePanel();
      window.requestAnimationFrame(positionTools);
    }
  }

  function showToolsForImage(image) {
    if (state.cropMode && state.image && state.image !== image) exitCropMode();
    state.image = image;
    state.identity = imageSignature(image);
    createMenu().classList.add('mpse-visible');
    createBox().classList.add('mpse-visible');
    createBadge().classList.add('mpse-visible');
    setButtonStates();
    refreshVisiblePanel();
    positionTools();
  }

  function hideToolElements() {
    for (const id of [MENU_ID, PANEL_ID, BOX_ID, BADGE_ID]) {
      const element = document.getElementById(id);
      if (element) element.classList.remove('mpse-visible');
    }
  }

  function hideTools() {
    exitCropMode();
    state.image = null;
    state.identity = null;
    state.activePanel = null;
    state.interaction = null;
    hideToolElements();
  }

  function positionTools() {
    const image = state.image;
    const menu = document.getElementById(MENU_ID);
    const panel = document.getElementById(PANEL_ID);
    const box = document.getElementById(BOX_ID);
    const badge = document.getElementById(BADGE_ID);
    if (!image || !menu || !box || !badge) {
      hideToolElements();
      return;
    }
    if (!image.isConnected) {
      hideToolElements();
      if (state.identity) window.setTimeout(() => reacquireSelectedImage(state.identity), 0);
      return;
    }
    const rect = getTopRect(getSelectionElement(image));
    if (rect.width < 1 || rect.height < 1) {
      hideToolElements();
      return;
    }

    setStyles(box, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    box.classList.toggle('mpse-crop-mode', state.cropMode);

    const menuWidth = 54;
    const panelWidth = 238;
    const gap = 8;
    let menuLeft = rect.right + gap;
    if (menuLeft + menuWidth > window.innerWidth - 8) menuLeft = rect.left - menuWidth - gap;
    menuLeft = Math.max(8, Math.min(menuLeft, window.innerWidth - menuWidth - 8));
    const menuTop = Math.max(8, Math.min(rect.top + 4, window.innerHeight - 330));

    menu.style.left = `${menuLeft}px`;
    menu.style.top = `${menuTop}px`;

    let panelLeft = menuLeft + menuWidth + gap;
    if (panelLeft + panelWidth > window.innerWidth - 8) panelLeft = menuLeft - panelWidth - gap;
    panelLeft = Math.max(8, Math.min(panelLeft, window.innerWidth - panelWidth - 8));
    if (panel) {
      panel.style.left = `${panelLeft}px`;
      panel.style.top = `${menuTop}px`;
    }

    badge.style.left = `${rect.left}px`;
    badge.style.top = `${Math.max(8, rect.top - 28)}px`;
    if (!/同步|已同步|失败|预览|裁切/.test(badge.textContent || '')) {
      badge.textContent = `图片 ${Math.round(rect.width)}×${Math.round(rect.height)}`;
    }
  }

  function findImageFromEvent(event) {
    const target = event.target;
    if (!target || isExtensionElement(target)) return null;
    const image = target.closest ? target.closest('img') : null;
    return image && isLikelyArticleImage(image) ? image : null;
  }

  function onDocumentPointer(event) {
    if (!event || !event.target) return;
    if (event.type !== 'pointerdown' || event.button !== 0) return;
    if (isExtensionElement(event.target)) return;
    if (document.getElementById('mpse-inline-panel')) {
      hideTools();
      return;
    }

    const image = findImageFromEvent(event);
    if (image) {
      event.preventDefault();
      event.stopPropagation();
      if (state.cropMode && image === state.image && getCropContainer(image)) {
        beginCropPan(image, event);
        return;
      }
      showToolsForImage(image);
      return;
    }

    hideTools();
  }

  function onDocumentDoubleClick(event) {
    if (!event || !event.target || isExtensionElement(event.target)) return;
    if (document.getElementById('mpse-inline-panel')) return;
    const image = findImageFromEvent(event);
    if (!image) return;
    event.preventDefault();
    event.stopPropagation();
    showToolsForImage(image);
    if (state.cropMode) {
      exitCropMode();
    } else {
      enterCropMode(image);
    }
  }

  function onDocumentWheel(event) {
    if (!state.cropMode || !event.ctrlKey || !event.target) return;
    const image = findImageFromEvent(event);
    if (!image || image !== state.image || !getCropContainer(image)) return;
    event.preventDefault();
    event.stopPropagation();
    zoomCrop(image, event);
  }

  function onDocumentPointerMove(event) {
    updateGeometryGesture(event);
  }

  function onDocumentPointerUp(event) {
    finishGeometryGesture(event);
  }

  function onDocumentKeyDown(event) {
    if (event.key === 'Escape' && state.cropMode) {
      exitCropMode();
      setBadgeText('已退出裁切');
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
      doc.addEventListener('dblclick', onDocumentDoubleClick, true);
      doc.addEventListener('pointermove', onDocumentPointerMove, true);
      doc.addEventListener('pointerup', onDocumentPointerUp, true);
      doc.addEventListener('wheel', onDocumentWheel, { capture: true, passive: false });
      doc.addEventListener('keydown', onDocumentKeyDown, true);
      doc.addEventListener('scroll', () => {
        if (state.image) window.requestAnimationFrame(positionTools);
      }, true);
    }
  }

  function onGlobalPointerUp(event) {
    if (state.interaction) {
      finishGeometryGesture(event);
      return;
    }
    if (!state.isDragging) return;
    state.isDragging = false;
    if (state.needsCommit) scheduleContentCommit('drag-end');
  }

  let bindTimer = 0;

  function scheduleBindDocuments() {
    if (bindTimer) return;
    bindTimer = window.setTimeout(() => {
      bindTimer = 0;
      bindDocuments();
    }, 180);
  }

  function boot() {
    if (!isMpHost()) return;
    const root = document.documentElement;
    if (root.getAttribute(VERSION_ATTR) === VERSION) return;
    root.setAttribute(VERSION_ATTR, VERSION);

    cleanupLegacyDom();
    injectBridge();
    createMenu();
    createPanel();
    createBox();
    createBadge();
    bindDocuments();

    const observer = new MutationObserver(scheduleBindDocuments);
    observer.observe(document.documentElement, { childList: true, subtree: true });

    window.setInterval(scheduleBindDocuments, 1500);
    window.addEventListener('pointerup', onGlobalPointerUp, true);
    window.addEventListener('mouseup', onGlobalPointerUp, true);
    window.addEventListener('resize', () => {
      if (state.image) window.requestAnimationFrame(positionTools);
    });
    window.addEventListener('scroll', () => {
      if (state.image) window.requestAnimationFrame(positionTools);
    }, true);

    console.info(`[公众号源码排版助手] image tools ${VERSION} loaded`);
  }

  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
      boot();
    }
  } catch (error) {
    console.warn(`[公众号源码排版助手] image tools ${VERSION} failed:`, error);
  }
})();
