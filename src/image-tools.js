(() => {
  'use strict';

  const VERSION = 'v0.9.4';
  const MENU_ID = 'mpse-img2-menu';
  const PANEL_ID = 'mpse-img2-panel';
  const BOX_ID = 'mpse-img2-box';
  const BADGE_ID = 'mpse-img2-badge';
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
    'mpseShadowOn', 'mpseShadowX', 'mpseShadowY', 'mpseShadowBlur', 'mpseShadowSpread', 'mpseShadowOpacity', 'mpseShadowColor'
  ];

  const DEBUG = false;

  const state = {
    image: null,
    identity: null,
    effect: 'radius',
    effectMemory: new Map(),
    lastDocCount: 0,
    commitTimer: null,
    commitSeq: 0,
    isDragging: false,
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

  function imageMemoryKey(identity) {
    if (!identity) return '';
    return identity.dataSrc || identity.src || identity.fileId || `${identity.index || 0}:${identity.w || ''}:${identity.ratio || ''}`;
  }

  function rememberEffectForImage(effect) {
    const key = imageMemoryKey(state.identity);
    if (key && effect) state.effectMemory.set(key, effect);
  }

  function getRememberedEffectForImage(image, identity) {
    const key = imageMemoryKey(identity || (image ? imageSignature(image) : null));
    return key ? state.effectMemory.get(key) : '';
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

    if (radius > 0) applied.add('radius');
    if (width || hasNonEmptyStyle(image, 'max-width') || hasNonEmptyStyle(image, 'margin-left') || hasNonEmptyStyle(image, 'margin-right')) applied.add('size');
    if (top > 0 || bottom > 0) applied.add('spacing');
    if (shadow) {
      const looksLikeGlow = (image.dataset && image.dataset.mpseGlowOn === '1') || String(shadow).includes(',') || /255,\s*212,\s*71|ffd447/i.test(String(shadow));
      if (looksLikeGlow) applied.add('glow');
      else applied.add('shadow');
    }
    if (filter) applied.add('color');
    if (/rotate\(/i.test(transform)) applied.add('rotate');
    if (border || padding > 0 || bg) applied.add('frame');
    if (getCaptionNode(image)) applied.add('caption');
    if ((radius >= 120 || /999/.test(image.style.getPropertyValue('border-radius')) || objectFit === 'cover') && hasNonEmptyStyle(image, 'height')) applied.add('circle');
    return applied;
  }

  function pickCurrentEffectForImage(image, identity) {
    const remembered = getRememberedEffectForImage(image, identity);
    const applied = getAppliedEffects(image);
    if (remembered) return remembered;
    if (state.effect && applied.has(state.effect)) return state.effect;
    const priority = ['radius', 'size', 'spacing', 'shadow', 'glow', 'frame', 'caption', 'circle', 'color', 'rotate'];
    return priority.find((item) => applied.has(item)) || state.effect || 'radius';
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
      showPanel(effect, true);
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
        panel.classList.remove('mpse-visible');
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
    const blur = clamp(values.blur, 0, 120);
    const spread = clamp(values.spread, 0, 40);
    const opacity = clamp(values.opacity, 0, 100) / 100;
    const color = hexToRgb(values.glowColor || '#ffd447');
    const rgba1 = `rgba(${color.r}, ${color.g}, ${color.b}, ${opacity})`;
    const rgba2 = `rgba(${color.r}, ${color.g}, ${color.b}, ${Math.max(0, opacity * 0.42)})`;
    const secondBlur = Math.round(blur * 1.65);
    setStyle(image, 'box-shadow', `0 0 ${blur}px ${spread}px ${rgba1}, 0 0 ${secondBlur}px ${Math.max(0, Math.round(spread / 2))}px ${rgba2}`);
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
    const radius = readStyleNumber(image, 'border-radius', 12);
    const width = parsePercent(image.style.getPropertyValue('width'), 100);
    const top = readStyleNumber(image, 'margin-top', 0);
    const bottom = readStyleNumber(image, 'margin-bottom', 0);
    const shadowDefaults = readBoxShadow(image);
    const colorDefaults = readFilterValues(image);

    if (effect === 'radius') return range('圆角半径', 'radius', 0, 80, 1, radius, 'px');
    if (effect === 'size') {
      let align = 'center';
      if (image.style.getPropertyValue('margin-left') === '0px' || image.style.getPropertyValue('margin-left') === '0') align = 'left';
      if (image.style.getPropertyValue('margin-right') === '0px' || image.style.getPropertyValue('margin-right') === '0') align = 'right';
      return `${range('宽度', 'width', 10, 100, 1, width, '%')}${select('对齐', 'align', align)}`;
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
    if (effect === 'shadow' || effect === 'glow') return '阴影/发光的边角跟随图片圆角；需要圆角请单独调“圆角”。';
    return '状态会从当前图片样式反读；拖动后同步到正文 HTML';
  }

  function showPanel(effect, applyImmediately) {
    const image = state.image;
    if (!image || !image.isConnected || !isLikelyArticleImage(image)) {
      hideTools();
      return;
    }

    state.effect = effect;
    rememberEffectForImage(effect);
    const titles = { radius: '圆角', size: '尺寸', spacing: '间距', shadow: '阴影', glow: '发光', color: '色彩', rotate: '旋转', frame: '相框', caption: '图注', circle: '圆形' };
    const panel = createPanel();
    panel.dataset.effect = effect;
    panel.innerHTML = `
      <div class="mpse-img2-panel-head">
        <strong>${escapeHtml(titles[effect] || '图片参数')}</strong>
        <button type="button" data-close-panel title="收起">×</button>
      </div>
      <div class="mpse-img2-panel-body">${buildPanelBody(effect, image)}</div>
      <div class="mpse-img2-tip">${escapeHtml(panelTipForEffect(effect))}</div>
    `;
    panel.classList.add('mpse-visible');
    setActiveButton(effect);
    updateValueLabels(panel);
    if (applyImmediately) applyEffect(effect, collectValues(panel));
    positionTools();
  }

  function setActiveButton(effect) {
    setButtonStates(effect);
  }

  function setButtonStates(currentEffect = state.effect) {
    const menu = document.getElementById(MENU_ID);
    if (!menu) return;
    const applied = getAppliedEffects(state.image);
    for (const button of Array.from(menu.querySelectorAll('[data-effect]'))) {
      const effect = button.dataset.effect;
      const isCurrent = effect === currentEffect;
      const isApplied = applied.has(effect);
      button.classList.toggle('mpse-active', isCurrent);
      button.classList.toggle('mpse-applied', isApplied);
      button.setAttribute('aria-pressed', isCurrent ? 'true' : 'false');
      button.title = `${button.textContent || effect}${isApplied ? '：当前图片已应用' : ''}${isCurrent ? '（当前面板）' : ''}`;
    }
  }

  function refreshVisiblePanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel || !panel.classList.contains('mpse-visible')) return;
    if (!state.image || !state.image.isConnected) return;
    if (state.isDragging) return;
    showPanel(state.effect || panel.dataset.effect || 'radius', false);
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

    if (effect === 'radius') {
      const r = clamp(values.radius, 0, 80);
      setStyles(image, { 'border-radius': `${r}px`, overflow: r > 0 ? 'hidden' : '', 'vertical-align': 'middle' });
      setCarrierStyles(image, { 'border-radius': `${r}px`, overflow: r > 0 ? 'hidden' : '', display: 'inline-block' });
    }

    if (effect === 'size') {
      const width = clamp(values.width, 10, 100);
      const align = values.align || 'center';
      setStyles(image, { width: `${width}%`, 'max-width': '100%', height: 'auto', display: 'block' });
      if (align === 'left') setStyles(image, { 'margin-left': '0', 'margin-right': 'auto' });
      if (align === 'center') setStyles(image, { 'margin-left': 'auto', 'margin-right': 'auto' });
      if (align === 'right') setStyles(image, { 'margin-left': 'auto', 'margin-right': '0' });
      const block = image.closest && image.closest('p,section,div,figure');
      if (block) setStyle(block, 'text-align', align);
    }

    if (effect === 'spacing') {
      setStyles(image, { display: 'block', 'margin-top': `${clamp(values.top, 0, 120)}px`, 'margin-bottom': `${clamp(values.bottom, 0, 120)}px` });
    }

    if (effect === 'shadow') {
      const x = clamp(values.x, -80, 80);
      const y = clamp(values.y, -80, 80);
      const blur = clamp(values.blur, 0, 120);
      const spread = clamp(values.spread, -40, 40);
      const opacity = clamp(values.opacity, 0, 100) / 100;
      const shadowColor = values.shadowColor || '#0f2337';
      image.dataset.mpseShadowOn = '1';
      image.dataset.mpseShadowX = String(x);
      image.dataset.mpseShadowY = String(y);
      image.dataset.mpseShadowBlur = String(blur);
      image.dataset.mpseShadowSpread = String(spread);
      image.dataset.mpseShadowOpacity = String(clamp(values.opacity, 0, 100));
      image.dataset.mpseShadowColor = shadowColor;
      delete image.dataset.mpseGlowOn;
      setStyle(image, 'box-shadow', `${x}px ${y}px ${blur}px ${spread}px ${hexToRgba(shadowColor, opacity, '#0f2337')}`);
    }

    if (effect === 'glow') {
      image.dataset.mpseGlowOn = '1';
      image.dataset.mpseGlowBlur = String(clamp(values.blur, 0, 120));
      image.dataset.mpseGlowSpread = String(clamp(values.spread, 0, 40));
      image.dataset.mpseGlowOpacity = String(clamp(values.opacity, 0, 100));
      image.dataset.mpseGlowColor = values.glowColor || '#ffd447';
      delete image.dataset.mpseShadowOn;
      applyGlowBoxShadow(image, values);
    }

    if (effect === 'color') {
      image.dataset.mpseBrightness = String(clamp(values.brightness, 40, 180));
      image.dataset.mpseContrast = String(clamp(values.contrast, 40, 180));
      image.dataset.mpseSaturate = String(clamp(values.saturate, 0, 240));
      image.dataset.mpseGray = String(clamp(values.gray, 0, 100));
      rebuildFilter(image);
    }

    if (effect === 'rotate') {
      const angle = clamp(values.angle, -180, 180);
      image.dataset.mpseRotate = String(angle);
      setStyles(image, { transform: `rotate(${angle}deg)`, 'transform-origin': 'center center' });
    }

    if (effect === 'frame') {
      const borderWidth = clamp(values.borderWidth, 0, 20);
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
      setStyles(image, {
        width: `${d}px`, height: `${d}px`, 'max-width': '100%', 'border-radius': '999px',
        'object-fit': 'cover', display: 'block', 'margin-left': 'auto', 'margin-right': 'auto'
      });
    }

    markChanged(image, effect);
    setButtonStates(effect);
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
    const image = state.image;
    if (!image || !image.isConnected) return;
    for (const prop of MANAGED_STYLE_PROPS) image.style.removeProperty(prop);
    for (const key of MANAGED_DATA_KEYS) delete image.dataset[key];
    const carrier = getVisualCarrier(image);
    if (carrier) {
      for (const prop of ['border-radius', 'overflow', 'display']) carrier.style.removeProperty(prop);
    }
    const caption = getCaptionNode(image);
    if (caption) caption.remove();
    markChanged(image, 'reset');
    setButtonStates('reset');
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.classList.remove('mpse-visible');
    positionTools();
  }

  function snapshotCurrentImage() {
    const image = state.image;
    if (!image || !image.isConnected) return null;
    const carrier = getVisualCarrier(image);
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

    // 拖动期间仅预览，停止后再同步正文，避免编辑器频繁重建内容。
    if (state.isDragging) {
      setBadgeText('待同步');
      return;
    }

    const delay = reason === 'drag-end' ? 260 : 520;
    state.commitTimer = window.setTimeout(() => commitSnapshotToEditor(reason), delay);
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

  function applySnapshotToHtml(content, snapshot) {
    if (!snapshot || !snapshot.identity) return { html: content, changed: false, reason: 'no-snapshot' };
    const parser = new DOMParser();
    const doc = parser.parseFromString(`<div id="mpse-root">${content || ''}</div>`, 'text/html');
    const root = doc.getElementById('mpse-root');
    if (!root) return { html: content, changed: false, reason: 'parse-failed' };

    const target = locateImageInHtml(root, snapshot.identity);
    if (!target) return { html: content, changed: false, reason: 'image-not-found' };

    if (snapshot.imgStyle) target.setAttribute('style', snapshot.imgStyle);
    else target.removeAttribute('style');
    target.setAttribute('data-mpse-image-edited', '1');
    copyManagedData(snapshot, target);

    const carrier = target.parentElement;
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

  async function commitSnapshotToEditor(reason) {
    if (!state.needsCommit || !state.lastSnapshot) return;
    const snapshot = state.lastSnapshot;
    state.needsCommit = false;
    const seq = ++state.commitSeq;
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
      if (seq === state.commitSeq) {
        if (DEBUG) console.info('[公众号源码排版助手] image html synced', reason || '', current.mode || 'unknown');
        setBadgeText('已同步');
        window.setTimeout(reacquireSelectedImage, 180);
      }
    } catch (error) {
      state.needsCommit = true;
      console.warn('[公众号源码排版助手] image html sync failed:', error);
      setBadgeText('同步失败');
    }
  }

  function reacquireSelectedImage() {
    const identity = state.identity;
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
      setButtonStates(state.effect);
      refreshVisiblePanel();
      window.requestAnimationFrame(positionTools);
    }
  }

  function showToolsForImage(image) {
    state.image = image;
    state.identity = imageSignature(image);
    state.effect = pickCurrentEffectForImage(image, state.identity);
    createMenu().classList.add('mpse-visible');
    createBox().classList.add('mpse-visible');
    createBadge().classList.add('mpse-visible');
    setButtonStates(state.effect);
    refreshVisiblePanel();
    positionTools();
  }

  function hideTools() {
    state.image = null;
    state.identity = null;
    for (const id of [MENU_ID, PANEL_ID, BOX_ID, BADGE_ID]) {
      const element = document.getElementById(id);
      if (element) element.classList.remove('mpse-visible');
    }
  }

  function positionTools() {
    const image = state.image;
    const menu = document.getElementById(MENU_ID);
    const panel = document.getElementById(PANEL_ID);
    const box = document.getElementById(BOX_ID);
    const badge = document.getElementById(BADGE_ID);
    if (!image || !image.isConnected || !menu || !box || !badge) {
      hideTools();
      return;
    }
    const rect = getTopRect(image);
    if (rect.width < 1 || rect.height < 1) {
      hideTools();
      return;
    }

    setStyles(box, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });

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
    if (!/同步|已同步|失败|预览/.test(badge.textContent || '')) {
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
    if (event.type === 'pointerdown' && event.button !== 0) return;
    if (isExtensionElement(event.target)) return;
    if (document.getElementById('mpse-inline-panel')) {
      hideTools();
      return;
    }

    const image = findImageFromEvent(event);
    if (image) {
      event.preventDefault();
      event.stopPropagation();
      showToolsForImage(image);
      return;
    }

    if (event.type === 'click') hideTools();
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
        if (state.image) window.requestAnimationFrame(positionTools);
      }, true);
    }
  }

  function onGlobalPointerUp() {
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
