(() => {
  'use strict';

  const VERSION = 'v0.9.9';
  const MENU_ID = 'mpse-img2-menu';
  const PANEL_ID = 'mpse-img2-panel';
  const BOX_ID = 'mpse-img2-box';
  const BADGE_ID = 'mpse-img2-badge';
  const DRAG_SHIELD_ID = 'mpse-img2-drag-shield';
  const HANDLE_CLASS = 'mpse-img2-handle';
  const CROP_ATTR = 'data-mpse-image-crop';
  const GEOMETRY_DRAG_THRESHOLD = 4;
  const BOUND_FLAG = '__mpseImageToolsV094Bound__';
  const GENERIC_BOUND_ATTR = 'data-mpse-image-tools-bound';
  const VERSION_ATTR = 'data-mpse-image-tools-version';
  const bridgeClient = window.__MPSE_BRIDGE_CLIENT__;
  const imageGeometry = window.__MPSE_IMAGE_GEOMETRY__;
  const injectBridge = bridgeClient && typeof bridgeClient.inject === 'function'
    ? bridgeClient.inject
    : () => false;
  const requestBridge = bridgeClient && typeof bridgeClient.request === 'function'
    ? bridgeClient.request
    : () => Promise.reject(new Error('扩展桥接客户端未加载，请刷新页面后重试'));

  if (!imageGeometry) throw new Error('图片几何模块未加载，请刷新页面后重试');

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
    'mpseBaseBoxShadow', 'mpseCircleOn', 'mpseCircleBase', 'mpseColorBase', 'mpseRotateBase', 'mpseFrameBase',
    'mpseFeatherOn', 'mpseFeatherAmount', 'mpseFeatherBase',
    'mpseStrokeOn', 'mpseStrokeWidth', 'mpseStrokeColor', 'mpseStrokeOpacity', 'mpseStrokeBase',
    'mpseOpacityOn', 'mpseOpacityValue', 'mpseOpacityBase'
  ];

  const APPEARANCE_EFFECTS = {
    feather: {
      activeKey: 'mpseFeatherOn',
      baseKey: 'mpseFeatherBase',
      valueKeys: ['mpseFeatherAmount'],
      props: ['mask-image', '-webkit-mask-image', 'mask-size', '-webkit-mask-size', 'mask-repeat', '-webkit-mask-repeat', 'mask-position', '-webkit-mask-position']
    },
    stroke: {
      activeKey: 'mpseStrokeOn',
      baseKey: 'mpseStrokeBase',
      valueKeys: ['mpseStrokeWidth', 'mpseStrokeColor', 'mpseStrokeOpacity'],
      props: ['outline', 'outline-offset']
    },
    opacity: {
      activeKey: 'mpseOpacityOn',
      baseKey: 'mpseOpacityBase',
      valueKeys: ['mpseOpacityValue'],
      props: ['opacity']
    }
  };

  const DEBUG = false;

  const state = {
    image: null,
    identity: null,
    activePanel: null,
    lastDocCount: 0,
    commitTimer: null,
    commitSeq: 0,
    commitInFlight: false,
    commitPhase: '',
    queuedCommit: false,
    pendingCommitReason: '',
    isDragging: false,
    interaction: null,
    cropMode: false,
    cropTransientHost: false,
    needsCommit: false,
    lastSnapshot: null,
    positionFrame: 0,
    handleElements: [],
    gestureEpoch: 0,
    editRevision: 0,
    selectionRevision: 0,
    reacquireTimer: null,
    lastImagePress: null,
    lastCropToggleAt: 0
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

  function readOpacityPercent(image, fallback = 100) {
    const raw = String(image && image.style ? image.style.getPropertyValue('opacity') : '').trim();
    if (!raw) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? clampInt(value * 100, 0, 100, fallback) : fallback;
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
    if (image.dataset.mpseFeatherOn === '1') applied.add('feather');
    if (image.dataset.mpseStrokeOn === '1') applied.add('stroke');
    if (image.dataset.mpseOpacityOn === '1') applied.add('opacity');
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
    return Boolean(node.closest(`#${MENU_ID}, #${PANEL_ID}, #${BOX_ID}, #${BADGE_ID}, #${DRAG_SHIELD_ID}, .${HANDLE_CLASS}, #mpse-svg2-panel, #mpse-svg2-pick-button, #mpse-svgb-menu, #mpse-svgb-panel, #mpse-svgb-box, #mpse-svgb-badge, #mpse-inline-panel, #mpse-toolbar-button, #mpse-floating-button`));
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
    if (style.display === 'none' || style.visibility === 'hidden') return false;
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
    const root = findEditableRoot(image);
    const list = root && root.querySelectorAll
      ? Array.from(root.querySelectorAll('img')).filter((candidate) => !isExtensionElement(candidate))
      : getAllArticleImages();
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
    let bestDistance = Number.POSITIVE_INFINITY;
    const preferredIndex = Number.isFinite(identity && identity.index) ? identity.index : 0;
    for (const [index, img] of images.entries()) {
      const score = scoreImageByIdentity(img, identity);
      const distance = Math.abs(index - preferredIndex);
      if (score > bestScore || (score === bestScore && distance < bestDistance)) {
        best = img;
        bestScore = score;
        bestDistance = distance;
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
    const frameWidth = Math.max(1, frame.clientWidth || frameRect.width);
    const frameHeight = Math.max(1, frame.clientHeight || frameRect.height);
    const scaleX = frameRect.width / frameWidth;
    const scaleY = frameRect.height / frameHeight;
    const left = frameRect.left + frame.clientLeft * scaleX + rect.left * scaleX;
    const top = frameRect.top + frame.clientTop * scaleY + rect.top * scaleY;
    return {
      left,
      top,
      right: left + rect.width * scaleX,
      bottom: top + rect.height * scaleY,
      width: rect.width * scaleX,
      height: rect.height * scaleY
    };
  }

  function rectContains(outer, inner) {
    const tolerance = 1;
    return inner.left >= outer.left - tolerance && inner.right <= outer.right + tolerance
      && inner.top >= outer.top - tolerance && inner.bottom <= outer.bottom + tolerance;
  }

  function getViewportRect() {
    return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  }

  function getFrameContentRect(frame) {
    const rect = frame.getBoundingClientRect();
    const width = Math.max(1, frame.clientWidth || rect.width);
    const height = Math.max(1, frame.clientHeight || rect.height);
    const scaleX = rect.width / width;
    const scaleY = rect.height / height;
    const left = rect.left + frame.clientLeft * scaleX;
    const top = rect.top + frame.clientTop * scaleY;
    return { left, top, right: left + width * scaleX, bottom: top + height * scaleY };
  }

  function isClippingAncestor(element) {
    const view = element && element.ownerDocument && element.ownerDocument.defaultView;
    if (!view || !element) return false;
    const style = view.getComputedStyle(element);
    return /(?:hidden|clip|auto|scroll)/.test(`${style.overflow} ${style.overflowX} ${style.overflowY}`);
  }

  function isSelectionVisible(image, rect) {
    if (!rectContains(getViewportRect(), rect)) return false;
    const frame = getFrameByDocument(image.ownerDocument);
    if (frame && !rectContains(getFrameContentRect(frame), rect)) return false;

    const selection = getSelectionElement(image);
    for (let parent = selection.parentElement; parent && parent !== image.ownerDocument.documentElement; parent = parent.parentElement) {
      if (isClippingAncestor(parent) && !rectContains(getTopRect(parent), rect)) return false;
    }
    if (frame) {
      for (let parent = frame.parentElement; parent && parent !== document.documentElement; parent = parent.parentElement) {
        if (isClippingAncestor(parent) && !rectContains(getTopRect(parent), rect)) return false;
      }
    }
    return true;
  }

  function getTopClientPoint(event) {
    const x = Number(event && event.clientX);
    const y = Number(event && event.clientY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

    const sourceDocument = event.target && event.target.ownerDocument;
    if (!sourceDocument || sourceDocument === document) return { x, y };

    const frame = getFrameByDocument(sourceDocument);
    if (!frame) return null;
    const frameRect = frame.getBoundingClientRect();
    const sourceWindow = sourceDocument.defaultView;
    const frameWidth = Math.max(1, (sourceWindow && sourceWindow.innerWidth) || frame.clientWidth || frameRect.width);
    const frameHeight = Math.max(1, (sourceWindow && sourceWindow.innerHeight) || frame.clientHeight || frameRect.height);
    const scaleX = frameRect.width / frameWidth;
    const scaleY = frameRect.height / frameHeight;
    return {
      x: frameRect.left + frame.clientLeft * scaleX + x * scaleX,
      y: frameRect.top + frame.clientTop * scaleY + y * scaleY
    };
  }

  function schedulePositionTools() {
    if (state.positionFrame) return;
    state.positionFrame = window.requestAnimationFrame(() => {
      state.positionFrame = 0;
      positionTools();
    });
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
      <button type="button" data-effect="feather" title="边缘羽化">羽化</button>
      <button type="button" data-effect="stroke" title="图片描边">描边</button>
      <button type="button" data-effect="color" title="亮度/对比/饱和">色彩</button>
      <button type="button" data-effect="opacity" title="图片透明度">透明</button>
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
    document.body.appendChild(box);
    return box;
  }

  function createDragShield() {
    let shield = document.getElementById(DRAG_SHIELD_ID);
    if (shield) return shield;
    shield = document.createElement('div');
    shield.id = DRAG_SHIELD_ID;
    shield.setAttribute('aria-hidden', 'true');
    document.body.appendChild(shield);
    return shield;
  }

  function cursorForHandle(handle) {
    if (handle === 'n' || handle === 's') return 'ns-resize';
    if (handle === 'e' || handle === 'w') return 'ew-resize';
    if (handle === 'ne' || handle === 'sw') return 'nesw-resize';
    return 'nwse-resize';
  }

  function showDragShield(cursor) {
    const shield = createDragShield();
    shield.style.setProperty('cursor', cursor || 'default', 'important');
    shield.classList.add('mpse-visible');
  }

  function hideDragShield() {
    const shield = document.getElementById(DRAG_SHIELD_ID);
    if (!shield) return;
    shield.classList.remove('mpse-visible');
    shield.style.removeProperty('cursor');
  }

  function getImageHandles() {
    if (state.handleElements.length && state.handleElements.every((handle) => handle.isConnected)) {
      return state.handleElements;
    }
    state.handleElements = Array.from(document.querySelectorAll(`.${HANDLE_CLASS}`));
    return state.handleElements;
  }

  function createHandles() {
    const definitions = [
      ['nw', '左上角缩放'], ['n', '顶部裁切'], ['ne', '右上角缩放'], ['e', '右侧裁切'],
      ['se', '右下角缩放'], ['s', '底部裁切'], ['sw', '左下角缩放'], ['w', '左侧裁切']
    ];
    for (const [handle, label] of definitions) {
      const id = `mpse-img2-handle-${handle}`;
      let button = document.getElementById(id);
      if (button) continue;
      button = document.createElement('button');
      button.id = id;
      button.type = 'button';
      button.className = `${HANDLE_CLASS} ${HANDLE_CLASS}-${handle}`;
      button.dataset.mpseImageHandle = handle;
      button.setAttribute('aria-label', label);
      button.title = label;
      button.style.setProperty('cursor', cursorForHandle(handle), 'important');
      button.addEventListener('pointerdown', onHandlePointerDown, true);
      button.addEventListener('pointercancel', onHandlePointerCancel, true);
      button.addEventListener('lostpointercapture', onHandlePointerCancel, true);
      document.body.appendChild(button);
    }
    state.handleElements = Array.from(document.querySelectorAll(`.${HANDLE_CLASS}`));
  }

  function positionHandles(rect) {
    const positions = {
      nw: [rect.left, rect.top], n: [(rect.left + rect.right) / 2, rect.top], ne: [rect.right, rect.top], e: [rect.right, (rect.top + rect.bottom) / 2],
      se: [rect.right, rect.bottom], s: [(rect.left + rect.right) / 2, rect.bottom], sw: [rect.left, rect.bottom], w: [rect.left, (rect.top + rect.bottom) / 2]
    };
    for (const handle of getImageHandles()) {
      const point = positions[handle.dataset.mpseImageHandle];
      if (!point) continue;
      handle.style.setProperty('transform', `translate3d(${point[0]}px, ${point[1]}px, 0) translate(-50%, -50%)`, 'important');
      handle.classList.add('mpse-visible');
    }
  }

  function positionSelectionBox(box, rect) {
    setStyles(box, {
      left: '0px',
      top: '0px',
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      transform: `translate3d(${rect.left}px, ${rect.top}px, 0)`
    });
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
    for (const id of [MENU_ID, PANEL_ID, BOX_ID, BADGE_ID, DRAG_SHIELD_ID]) {
      const element = document.getElementById(id);
      if (element) element.remove();
    }
    for (const handle of getImageHandles()) handle.remove();
    state.handleElements = [];
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
    const nextValue = String(value);
    const nextPriority = important ? 'important' : '';
    if (element.style.getPropertyValue(prop) === nextValue
      && element.style.getPropertyPriority(prop) === nextPriority) return;
    element.style.setProperty(prop, nextValue, nextPriority);
  }

  function setStyles(element, styles) {
    for (const [prop, value] of Object.entries(styles)) setStyle(element, prop, value);
  }

  function captureInlineStyles(element, props) {
    if (!element || !element.style) return null;
    return props.reduce((styles, prop) => {
      styles[prop] = {
        value: element.style.getPropertyValue(prop),
        priority: element.style.getPropertyPriority(prop)
      };
      return styles;
    }, {});
  }

  function restoreInlineStyles(element, styles) {
    if (!element || !element.style || !styles) return;
    for (const [prop, entry] of Object.entries(styles)) {
      if (entry.value) element.style.setProperty(prop, entry.value, entry.priority);
      else element.style.removeProperty(prop);
    }
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

  function getAppearanceHost(image) {
    return getCropContainer(image) || image;
  }

  function getSelectionElement(image) {
    return getCropContainer(image) || image;
  }

  function detectHorizontalAlignment(element) {
    const view = element && element.ownerDocument && element.ownerDocument.defaultView;
    if (!view || !element) return 'left';
    const style = view.getComputedStyle(element);
    const parentStyle = element.parentElement ? view.getComputedStyle(element.parentElement) : null;
    if (style.float === 'right') return 'right';
    if (style.marginLeft === 'auto' && style.marginRight === 'auto') return 'center';
    if (style.marginLeft === 'auto') return 'right';
    if (style.marginRight === 'auto') return 'left';
    if (parentStyle && parentStyle.textAlign === 'center') return 'center';
    if (parentStyle && parentStyle.textAlign === 'right') return 'right';
    return 'left';
  }

  function captureCropLayout(image) {
    const view = image && image.ownerDocument && image.ownerDocument.defaultView;
    const computed = view && image ? view.getComputedStyle(image) : null;
    const computedDisplay = computed ? computed.display : 'block';
    return {
      alignment: detectHorizontalAlignment(image),
      display: computedDisplay === 'inline' ? 'inline-block' : (computedDisplay === 'none' ? 'block' : computedDisplay),
      styles: captureInlineStyles(image, [
        'width', 'height', 'max-width', 'display', 'margin-left', 'margin-right',
        'margin-top', 'margin-bottom', 'vertical-align', 'float'
      ])
    };
  }

  function readCropLayout(image) {
    const host = getCropContainer(image);
    if (!host) return captureCropLayout(image);
    try {
      const layout = JSON.parse(host.dataset.mpseCropLayout || '{}');
      if (layout && layout.styles && ['left', 'center', 'right'].includes(layout.alignment)) return layout;
    } catch (_) {
      // Invalid persisted layout metadata falls back to the current frame.
    }
    return {
      alignment: detectHorizontalAlignment(host),
      display: host.style.getPropertyValue('display') || 'block',
      styles: captureInlineStyles(host, [
        'width', 'height', 'max-width', 'display', 'margin-left', 'margin-right',
        'margin-top', 'margin-bottom', 'vertical-align', 'float'
      ])
    };
  }

  function cropMarginTop(layout, offsetPercent) {
    const entry = layout && layout.styles && layout.styles['margin-top'];
    const base = entry && String(entry.value || '').trim();
    if (Math.abs(offsetPercent) < 0.0001) return base || '';
    if (!base || /^0(?:[a-z%]+)?$/i.test(base) || base === 'auto') return `${offsetPercent.toFixed(5)}%`;
    return `calc(${base} + ${offsetPercent.toFixed(5)}%)`;
  }

  function getAvailableImageWidth(image) {
    const host = getLayoutHost(image);
    const view = host && host.ownerDocument && host.ownerDocument.defaultView;
    let parent = host && host.parentElement;
    while (parent && view) {
      const style = view.getComputedStyle(parent);
      if (style.display !== 'inline' && style.display !== 'contents') {
        const padding = parseFloat(style.paddingLeft || '0') + parseFloat(style.paddingRight || '0');
        const clientWidth = Math.max(0, (parent.clientWidth || 0) - padding);
        if (clientWidth > 1) return clientWidth;
        const rect = parent.getBoundingClientRect();
        if (rect.width - padding > 1) return rect.width - padding;
      }
      parent = parent.parentElement;
    }
    const root = findEditableRoot(image);
    return root && root.getBoundingClientRect ? Math.max(1, root.getBoundingClientRect().width) : 1;
  }

  function readCropState(image) {
    const host = getCropContainer(image);
    if (!host) return null;
    const number = (key, fallback) => {
      const value = Number(host.dataset[key]);
      return Number.isFinite(value) ? value : fallback;
    };
    const media = {
      x: number('mpseCropX', 0),
      y: number('mpseCropY', 0),
      width: number('mpseCropWidth', 1),
      height: number('mpseCropHeight', 1)
    };
    return imageGeometry.normalizeModel({
      frame: {
        x: number('mpseCropFrameX', media.x),
        y: number('mpseCropFrameY', media.y),
        width: number('mpseCropFrameWidth', media.width),
        height: number('mpseCropFrameHeight', media.height)
      },
      media,
      baseAspect: number('mpseCropAspect', 1)
    });
  }

  function hasCropAdjustment(image) {
    const crop = readCropState(image);
    return Boolean(crop && !imageGeometry.modelsMatch(crop, {
      frame: { x: 0, y: 0, width: 1, height: 1 },
      media: { x: 0, y: 0, width: 1, height: 1 },
      baseAspect: crop.baseAspect
    }));
  }

  function readCropBaseWidth(image) {
    const host = getCropContainer(image);
    const stored = Number(host && host.dataset.mpseCropBaseWidth);
    if (Number.isFinite(stored)) return clamp(stored, 4, 2500);
    return readLayoutWidthPercent(image);
  }

  function setCropBaseWidth(image, value) {
    const host = getCropContainer(image);
    if (!host) return;
    host.dataset.mpseCropBaseWidth = clamp(value, 4, 2500).toFixed(4);
  }

  function writeCropState(image, next) {
    const host = getCropContainer(image);
    if (!host) return null;
    const crop = imageGeometry.normalizeModel(next);
    const baseWidth = readCropBaseWidth(image);
    const layout = readCropLayout(image);
    const { frame, media } = crop;
    host.dataset.mpseCropX = media.x.toFixed(6);
    host.dataset.mpseCropY = media.y.toFixed(6);
    host.dataset.mpseCropWidth = media.width.toFixed(6);
    host.dataset.mpseCropHeight = media.height.toFixed(6);
    host.dataset.mpseCropFrameX = frame.x.toFixed(6);
    host.dataset.mpseCropFrameY = frame.y.toFixed(6);
    host.dataset.mpseCropFrameWidth = frame.width.toFixed(6);
    host.dataset.mpseCropFrameHeight = frame.height.toFixed(6);
    host.dataset.mpseCropAspect = crop.baseAspect.toFixed(6);

    const aspect = crop.baseAspect * frame.width / frame.height;
    const transformX = imageGeometry.horizontalTransformPercent(frame, layout.alignment);
    const topOffset = baseWidth * frame.y / crop.baseAspect;
    setStyles(host, {
      width: `${(baseWidth * frame.width).toFixed(4)}%`,
      'max-width': '100%',
      display: layout.display || 'block',
      position: 'relative',
      overflow: 'hidden',
      'aspect-ratio': aspect.toFixed(6),
      'line-height': '0',
      'margin-top': cropMarginTop(layout, topOffset),
      transform: Math.abs(transformX) < 0.0001 ? '' : `translate3d(${transformX.toFixed(6)}%, 0, 0)`,
      'transform-origin': 'center center'
    });
    setStyles(image, {
      position: 'absolute',
      left: `${(-media.x / media.width * 100).toFixed(5)}%`,
      top: `${(-media.y / media.height * 100).toFixed(5)}%`,
      width: `${(100 / media.width).toFixed(5)}%`,
      height: `${(100 / media.height).toFixed(5)}%`,
      'max-width': 'none',
      display: 'block',
      'margin-left': '0',
      'margin-right': '0',
      'margin-top': '0',
      'margin-bottom': '0'
    });
    return crop;
  }

  function ensureCropContainer(image) {
    const existing = getCropContainer(image);
    if (existing) return { host: existing, created: false };
    if (!image || !image.parentNode) return { host: null, created: false };

    const rect = image.getBoundingClientRect();
    const availableWidth = getAvailableImageWidth(image);
    const baseAspect = Math.max(0.05, rect.width / Math.max(1, rect.height));
    const baseWidth = clamp(rect.width / Math.max(1, availableWidth) * 100, 4, 100);
    const layout = captureCropLayout(image);
    layout.baseWidth = baseWidth;
    layout.baseHeightPx = rect.height;
    const host = image.ownerDocument.createElement('span');
    host.setAttribute(CROP_ATTR, '1');
    host.dataset.mpseCropBaseWidth = baseWidth.toFixed(4);
    host.dataset.mpseCropLayout = JSON.stringify(layout);
    restoreInlineStyles(host, layout.styles);
    host.style.removeProperty('height');
    image.parentNode.insertBefore(host, image);
    host.appendChild(image);

    for (const prop of ['width', 'max-width', 'display', 'margin-left', 'margin-right', 'margin-top', 'margin-bottom', 'vertical-align', 'float', 'position', 'left', 'top', 'height']) {
      image.style.removeProperty(prop);
    }
    const radius = image.style.getPropertyValue('border-radius');
    if (radius) setStyle(host, 'border-radius', radius);
    writeCropState(image, {
      frame: { x: 0, y: 0, width: 1, height: 1 },
      media: { x: 0, y: 0, width: 1, height: 1 },
      baseAspect
    });
    renderAppearance(image);
    return { host, created: true };
  }

  function unwrapCropContainer(image) {
    const host = getCropContainer(image);
    if (!host || !host.parentNode) return image;
    const parent = host.parentNode;
    const baseWidth = readCropBaseWidth(image);
    const layout = readCropLayout(image);
    for (const prop of ['position', 'left', 'top', 'height', 'max-width', 'display', 'margin-left', 'margin-right', 'margin-top', 'margin-bottom', 'width', 'vertical-align', 'float', 'translate', 'scale']) {
      image.style.removeProperty(prop);
    }
    restoreInlineStyles(image, layout.styles);
    if (Number.isFinite(layout.baseWidth) && Math.abs(baseWidth - layout.baseWidth) >= 0.01) {
      setStyle(image, 'width', `${baseWidth.toFixed(4)}%`);
      const heightEntry = layout.styles && layout.styles.height;
      if (heightEntry && heightEntry.value && heightEntry.value !== 'auto' && Number.isFinite(layout.baseHeightPx)) {
        setStyle(image, 'height', `${(layout.baseHeightPx * baseWidth / layout.baseWidth).toFixed(3)}px`);
      }
    }
    parent.insertBefore(image, host);
    host.remove();
    renderAppearance(image);
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
    schedulePositionTools();
  }

  function readLayoutWidthPercent(image, available = getAvailableImageWidth(image)) {
    const host = getLayoutHost(image);
    if (!host) return 100;
    const declared = host.style.getPropertyValue('width');
    if (/%\s*$/.test(declared)) return clamp(parsePercent(declared, 100), 4, 100);
    const rect = host.getBoundingClientRect();
    return clamp(rect.width / Math.max(1, available) * 100, 4, 100);
  }

  function setLayoutWidthPercent(image, width, available = getAvailableImageWidth(image)) {
    const host = getLayoutHost(image);
    if (!host) return false;
    const visualWidth = clamp(width, 4, 100);
    if (Math.abs(readLayoutWidthPercent(image, available) - visualWidth) < 0.01) return false;
    const crop = readCropState(image);
    if (crop) {
      setCropBaseWidth(image, visualWidth / Math.max(0.04, crop.frame.width));
      writeCropState(image, crop);
      return true;
    }
    setStyle(host, 'width', `${visualWidth.toFixed(3)}%`);
    return true;
  }

  function cropStatesMatch(first, second) {
    return imageGeometry.modelsMatch(first, second);
  }

  function capturePointer(target, pointerId) {
    if (!target || !Number.isFinite(pointerId) || !target.setPointerCapture) return;
    try {
      target.setPointerCapture(pointerId);
    } catch (_) {
      // Pointer capture can be unavailable across editor frames.
    }
  }

  function releasePointer(target, pointerId) {
    if (!target || !Number.isFinite(pointerId) || !target.releasePointerCapture) return;
    try {
      if (!target.hasPointerCapture || target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
    } catch (_) {
      // Pointer capture may already have been released by the browser.
    }
  }

  function matchesGeometryPointer(interaction, event) {
    if (!interaction || !event || !Number.isFinite(interaction.pointerId) || !Number.isFinite(event.pointerId)) return true;
    return interaction.pointerId === event.pointerId;
  }

  function interactionOwnsEvent(interaction, event) {
    return Boolean(interaction && matchesGeometryPointer(interaction, event));
  }

  function deferContentCommitForGesture() {
    if (!state.commitTimer) return;
    window.clearTimeout(state.commitTimer);
    state.commitTimer = null;
  }

  function setInteractionCursor(interaction, cursor) {
    if (!interaction) return;
    showDragShield(cursor);
    const target = interaction.pointerTarget;
    if (!target || !target.style) return;
    interaction.cursorBefore = {
      value: target.style.getPropertyValue('cursor'),
      priority: target.style.getPropertyPriority('cursor')
    };
    target.style.setProperty('cursor', cursor, 'important');
  }

  function restoreInteractionCursor(interaction) {
    hideDragShield();
    if (!interaction || !interaction.cursorBefore || !interaction.pointerTarget || !interaction.pointerTarget.style) return;
    const { value, priority } = interaction.cursorBefore;
    if (value) interaction.pointerTarget.style.setProperty('cursor', value, priority);
    else interaction.pointerTarget.style.removeProperty('cursor');
  }

  function queueGeometryPreview(interaction) {
    if (!interaction || interaction.frame) return;
    interaction.frame = window.requestAnimationFrame(() => {
      interaction.frame = 0;
      if (state.interaction !== interaction) return;
      flushGeometryPreview(interaction);
    });
  }

  function captureGeometryPreviewStyles(interaction, image) {
    if (!interaction || !image) return;
    interaction.previewTarget = getSelectionElement(image);
    interaction.targetPreviewStyles = captureInlineStyles(interaction.previewTarget, [
      'scale', 'transform-origin', 'clip-path', 'overflow'
    ]);
    interaction.imagePreviewStyles = captureInlineStyles(image, ['translate']);
  }

  function clearGeometryPreview(interaction, image = state.image) {
    if (!interaction) return;
    restoreInlineStyles(interaction.previewTarget, interaction.targetPreviewStyles);
    restoreInlineStyles(image, interaction.imagePreviewStyles);
  }

  function updateGeometryOverlayRect(rect) {
    const box = document.getElementById(BOX_ID);
    if (!box || !rect) return;
    positionSelectionBox(box, rect);
    positionHandles(rect);
  }

  function resizePreviewRect(interaction, scale) {
    const width = interaction.rect.width * scale;
    const height = interaction.rect.height * scale;
    const left = interaction.handle.includes('w') ? interaction.rect.right - width : interaction.rect.left;
    const top = interaction.handle.includes('n') ? interaction.rect.bottom - height : interaction.rect.top;
    return { left, top, right: left + width, bottom: top + height, width, height };
  }

  function applyGeometryPreview(interaction, preview, image) {
    const target = getSelectionElement(image);
    if (preview.kind === 'resize') {
      const originX = interaction.handle.includes('w') ? 'right' : 'left';
      const originY = interaction.handle.includes('n') ? 'bottom' : 'top';
      setStyle(target, 'transform-origin', `${originX} ${originY}`);
      setStyle(target, 'scale', String(preview.scale));
      updateGeometryOverlayRect(resizePreviewRect(interaction, preview.scale));
      return;
    }

    if (preview.kind === 'pan') {
      const deltaX = preview.crop.media.x - interaction.startCrop.media.x;
      const deltaY = preview.crop.media.y - interaction.startCrop.media.y;
      setStyle(image, 'translate', `${(-deltaX * 100).toFixed(6)}% ${(-deltaY * 100).toFixed(6)}%`);
      updateGeometryOverlayRect(interaction.rect);
      return;
    }

    const rect = imageGeometry.previewFrameRect(interaction.rect, interaction.startCrop.frame, preview.crop.frame);
    const top = (rect.top - interaction.rect.top) / interaction.rect.height * 100;
    const right = (interaction.rect.right - rect.right) / interaction.rect.width * 100;
    const bottom = (interaction.rect.bottom - rect.bottom) / interaction.rect.height * 100;
    const left = (rect.left - interaction.rect.left) / interaction.rect.width * 100;
    setStyle(target, 'overflow', 'visible');
    setStyle(target, 'clip-path', `inset(${top.toFixed(6)}% ${right.toFixed(6)}% ${bottom.toFixed(6)}% ${left.toFixed(6)}%)`);
    updateGeometryOverlayRect(rect);
  }

  function flushGeometryPreview(interaction = state.interaction) {
    if (!interaction) return;
    if (interaction.frame) {
      window.cancelAnimationFrame(interaction.frame);
      interaction.frame = 0;
    }
    const preview = interaction.preview;
    if (!preview) return;
    interaction.preview = null;

    const image = state.image;
    if (!image || !image.isConnected) return;
    interaction.appliedPreview = preview;
    applyGeometryPreview(interaction, preview, image);
  }

  function hasGeometryChanged(interaction, preview) {
    if (!interaction || !preview) return false;
    if (interaction.kind === 'resize') {
      return Math.abs(preview.widthPercent - interaction.startWidthPercent) >= 0.01;
    }
    return !cropStatesMatch(preview.crop, interaction.startCrop);
  }

  function getCornerResizePreview(interaction, point) {
    const horizontalDirection = interaction.handle.includes('w') ? -1 : 1;
    const verticalDirection = interaction.handle.includes('n') ? -1 : 1;
    const horizontalDelta = horizontalDirection * (point.x - interaction.startX);
    const verticalDelta = verticalDirection * (point.y - interaction.startY);
    const horizontalRatio = Math.abs(horizontalDelta / Math.max(1, interaction.rect.width));
    const verticalRatio = Math.abs(verticalDelta / Math.max(1, interaction.rect.height));
    const scale = horizontalRatio >= verticalRatio
      ? 1 + horizontalDelta / Math.max(1, interaction.rect.width)
      : 1 + verticalDelta / Math.max(1, interaction.rect.height);
    const widthPercent = clamp(interaction.startWidthPercent * scale, 4, 100);
    return { widthPercent, scale: widthPercent / Math.max(0.01, interaction.startWidthPercent) };
  }

  function updateGeometryOverlay(image = state.image) {
    const box = document.getElementById(BOX_ID);
    if (!box || !image || !image.isConnected) return null;
    const rect = getTopRect(getSelectionElement(image));
    positionSelectionBox(box, rect);
    positionHandles(rect);
    return rect;
  }

  function initializeCropGesture(interaction, image) {
    if (interaction.startCrop) return true;
    const result = ensureCropContainer(image);
    if (!result.host || !image.isConnected) return false;
    interaction.createdCrop = result.created;
    interaction.startCrop = readCropState(image);
    interaction.rect = getTopRect(result.host);
    captureGeometryPreviewStyles(interaction, image);
    return Boolean(interaction.startCrop);
  }

  function beginGeometryGesture(handle, event, captureTarget) {
    const image = state.image;
    if (!image || !image.isConnected) return;
    const point = getTopClientPoint(event);
    if (!point) return;
    const isCorner = ['nw', 'ne', 'se', 'sw'].includes(handle);
    const target = getSelectionElement(image);
    const rect = getTopRect(target);
    const startCrop = readCropState(image);
    deferContentCommitForGesture();
    const interaction = {
      kind: isCorner ? 'resize' : 'crop',
      handle,
      pointerId: event.pointerId,
      pointerTarget: captureTarget || event.target,
      startX: point.x,
      startY: point.y,
      rect,
      startCrop,
      startCropBaseWidth: startCrop ? readCropBaseWidth(image) : null,
      startWidthPercent: readLayoutWidthPercent(image),
      availableWidth: getAvailableImageWidth(image),
      fixedHeight: !startCrop && Boolean(target.style.getPropertyValue('height') && target.style.getPropertyValue('height') !== 'auto'),
      sourceHeight: target.getBoundingClientRect().height,
      createdCrop: false,
      started: false,
      gestureEpoch: ++state.gestureEpoch,
      preview: null,
      appliedPreview: null,
      frame: 0
    };
    cancelScheduledReacquire();
    captureGeometryPreviewStyles(interaction, image);
    state.interaction = interaction;
    state.isDragging = true;
    capturePointer(captureTarget || event.target, event.pointerId);
    setInteractionCursor(interaction, cursorForHandle(handle));
  }

  function beginCropPan(image, event) {
    const result = ensureCropContainer(image);
    if (!result.host) return;
    const point = getTopClientPoint(event);
    if (!point) return;
    const rect = getTopRect(result.host);
    deferContentCommitForGesture();
    const interaction = {
      kind: 'pan',
      pointerId: event.pointerId,
      pointerTarget: image,
      startX: point.x,
      startY: point.y,
      rect,
      startCrop: readCropState(image),
      createdCrop: result.created,
      started: false,
      gestureEpoch: ++state.gestureEpoch,
      preview: null,
      appliedPreview: null,
      frame: 0
    };
    cancelScheduledReacquire();
    captureGeometryPreviewStyles(interaction, image);
    state.interaction = interaction;
    state.isDragging = true;
    capturePointer(image, event.pointerId);
    setInteractionCursor(interaction, 'grabbing');
  }

  function updateGeometryGesture(event) {
    const interaction = state.interaction;
    const image = state.image;
    if (!interaction || !image || !image.isConnected || !interactionOwnsEvent(interaction, event)) return;
    const point = getTopClientPoint(event);
    if (!point) return;
    interaction.lastPoint = point;
    let rect = interaction.rect;
    if (rect.width < 1 || rect.height < 1) return;
    if (!interaction.started) {
      const distance = Math.hypot(point.x - interaction.startX, point.y - interaction.startY);
      if (distance < GEOMETRY_DRAG_THRESHOLD) return;
      interaction.started = true;
      if (interaction.kind === 'crop' && !initializeCropGesture(interaction, image)) {
        interaction.started = false;
        return;
      }
      rect = interaction.rect;
    }
    const dx = (point.x - interaction.startX) / rect.width;
    const dy = (point.y - interaction.startY) / rect.height;

    if (interaction.kind === 'resize') {
      interaction.preview = { kind: 'resize', ...getCornerResizePreview(interaction, point) };
      queueGeometryPreview(interaction);
      return;
    }

    const start = interaction.startCrop;
    if (!start) return;
    if (interaction.kind === 'pan') {
      interaction.preview = { kind: 'pan', crop: imageGeometry.panMedia(start, dx, dy) };
    } else {
      const ratio = interaction.handle === 'e' || interaction.handle === 'w' ? dx : dy;
      interaction.preview = { kind: 'crop', crop: imageGeometry.resizeFrameEdge(start, interaction.handle, ratio) };
    }
    queueGeometryPreview(interaction);
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
    writeCropState(image, imageGeometry.zoomMedia(crop, scale, pointX, pointY));
    markChanged(image, 'crop-zoom');
    schedulePositionTools();
  }

  function restoreGeometryGesture(interaction, image) {
    clearGeometryPreview(interaction, image);
    if (!interaction || !image || !image.isConnected) return image;
    if (interaction.createdCrop && getCropContainer(image)) return unwrapCropContainer(image);
    return image;
  }

  function finishGeometryGesture(event, forceCancel = false) {
    const interaction = state.interaction;
    if (!interaction || !interactionOwnsEvent(interaction, event)) return false;
    const canceled = forceCancel || Boolean(event && (event.type === 'pointercancel' || event.type === 'lostpointercapture'));
    if (canceled) {
      if (interaction.frame) window.cancelAnimationFrame(interaction.frame);
      interaction.frame = 0;
      interaction.preview = null;
    } else {
      flushGeometryPreview(interaction);
    }
    let image = state.image;
    const preview = interaction.appliedPreview;
    clearGeometryPreview(interaction, image);
    state.interaction = null;
    state.isDragging = false;
    restoreInteractionCursor(interaction);
    releasePointer(interaction.pointerTarget, interaction.pointerId);
    if (canceled) {
      state.image = restoreGeometryGesture(interaction, image);
      schedulePositionTools();
      return true;
    }
    const changed = hasGeometryChanged(interaction, preview);
    if (changed && image && image.isConnected) {
      if (interaction.kind === 'resize') {
        setLayoutWidthPercent(image, preview.widthPercent, interaction.availableWidth);
        if (interaction.fixedHeight && !getCropContainer(image)) {
          setStyle(image, 'height', `${(interaction.sourceHeight * preview.scale).toFixed(3)}px`);
        }
      } else {
        writeCropState(image, preview.crop);
      }
      updateGeometryOverlay(image);
    }
    if (interaction.kind === 'crop' && changed && state.image) {
      state.cropMode = true;
      state.cropTransientHost = interaction.createdCrop || state.cropTransientHost;
      createBox().classList.add('mpse-crop-mode');
      setBadgeText('裁切模式：拖动图片，Ctrl + 滚轮缩放');
    }
    if (!changed && interaction.started) {
      state.image = restoreGeometryGesture(interaction, image);
      image = state.image;
    }
    if (changed && state.image) {
      markChanged(state.image, interaction.kind === 'pan' ? 'crop-pan' : interaction.kind, false);
      scheduleContentCommit('drag-end');
    } else if (state.needsCommit) {
      scheduleContentCommit('drag-end');
    }
    schedulePositionTools();
    return true;
  }

  function enterCropMode(image) {
    const result = ensureCropContainer(image);
    if (!result.host) return;
    state.cropMode = true;
    state.cropTransientHost = result.created;
    createBox().classList.add('mpse-crop-mode');
    setBadgeText('裁切模式：拖动图片，Ctrl + 滚轮缩放');
    schedulePositionTools();
  }

  function exitCropMode() {
    const image = state.image;
    const shouldUnwrap = state.cropTransientHost && !state.needsCommit && image
      && getCropContainer(image) && !hasCropAdjustment(image);
    if (shouldUnwrap) {
      state.image = unwrapCropContainer(image);
      if (hasAppearanceEffects(state.image)) markChanged(state.image, 'crop-exit');
    }
    state.cropMode = false;
    state.cropTransientHost = false;
    const box = document.getElementById(BOX_ID);
    if (box) box.classList.remove('mpse-crop-mode');
    const badge = document.getElementById(BADGE_ID);
    if (badge && /裁切/.test(badge.textContent || '')) badge.textContent = '';
    schedulePositionTools();
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

  function captureStyleBase(image, key, props, target = image) {
    if (!image || image.dataset[key]) return;
    const values = {};
    for (const prop of props) {
      values[prop] = {
        value: target.style.getPropertyValue(prop) || '',
        priority: target.style.getPropertyPriority(prop) || ''
      };
    }
    image.dataset[key] = JSON.stringify(values);
  }

  function applyStyleBase(image, key, props, target = image) {
    if (!image) return;
    try {
      const values = JSON.parse(image.dataset[key] || '{}');
      for (const prop of props) {
        const entry = values[prop];
        if (entry && typeof entry === 'object') {
          setStyle(target, prop, entry.value || '', entry.priority === 'important');
        } else {
          setStyle(target, prop, entry || '');
        }
      }
    } catch (_) {
      for (const prop of props) setStyle(target, prop, '');
    }
  }

  function restoreStyleBase(image, key, props, target = image) {
    applyStyleBase(image, key, props, target);
    delete image.dataset[key];
  }

  function appearanceConfig(effect) {
    return APPEARANCE_EFFECTS[effect] || null;
  }

  function isAppearanceEnabled(image, effect) {
    const config = appearanceConfig(effect);
    return Boolean(config && image && image.dataset[config.activeKey] === '1');
  }

  function hasAppearanceEffects(image) {
    return ['feather', 'stroke', 'opacity'].some((effect) => isAppearanceEnabled(image, effect));
  }

  function clearAppearanceProperties(target, props) {
    for (const prop of props) setStyle(target, prop, '');
  }

  function getAppearanceStyles(image, effect) {
    if (effect === 'feather') {
      const amount = clamp(getDataNumber(image, 'mpseFeatherAmount', 0), 0, 45);
      const opaqueStop = clamp(100 - amount * 2, 0, 100);
      const mask = `radial-gradient(ellipse at center, #000 0%, #000 ${opaqueStop}%, transparent 100%)`;
      return {
        'mask-image': mask,
        '-webkit-mask-image': mask,
        'mask-size': '100% 100%',
        '-webkit-mask-size': '100% 100%',
        'mask-repeat': 'no-repeat',
        '-webkit-mask-repeat': 'no-repeat',
        'mask-position': 'center',
        '-webkit-mask-position': 'center'
      };
    }
    if (effect === 'stroke') {
      const width = clamp(getDataNumber(image, 'mpseStrokeWidth', 0), 0, 20);
      const color = getDataString(image, 'mpseStrokeColor', '#07c160');
      const opacity = clamp(getDataNumber(image, 'mpseStrokeOpacity', 100), 0, 100) / 100;
      return { outline: `${width}px solid ${hexToRgba(color, opacity, '#07c160')}`, 'outline-offset': '0px' };
    }
    if (effect === 'opacity') {
      return { opacity: String(clamp(getDataNumber(image, 'mpseOpacityValue', 100), 0, 100) / 100) };
    }
    return {};
  }

  function renderAppearance(image) {
    if (!image || !image.style) return;
    const host = getAppearanceHost(image);
    for (const effect of ['feather', 'stroke', 'opacity']) {
      const config = appearanceConfig(effect);
      const enabled = isAppearanceEnabled(image, effect);
      const hasBase = image.dataset[config.baseKey] !== undefined;
      if (host !== image && (enabled || hasBase)) clearAppearanceProperties(host, config.props);
      if (enabled) {
        if (host !== image) clearAppearanceProperties(image, config.props);
        setStyles(host, getAppearanceStyles(image, effect));
      } else if (hasBase) {
        applyStyleBase(image, config.baseKey, config.props, image);
      }
    }
  }

  function clearAppearanceEffect(image, effect) {
    const config = appearanceConfig(effect);
    if (!config || !image) return;
    delete image.dataset[config.activeKey];
    for (const key of config.valueKeys) delete image.dataset[key];
    renderAppearance(image);
    delete image.dataset[config.baseKey];
  }

  function resetAppearanceEffects(image) {
    if (!image) return;
    const host = getAppearanceHost(image);
    for (const effect of ['feather', 'stroke', 'opacity']) {
      const config = appearanceConfig(effect);
      const hasBase = image.dataset[config.baseKey] !== undefined;
      const enabled = isAppearanceEnabled(image, effect);
      if (host !== image && (enabled || hasBase)) clearAppearanceProperties(host, config.props);
      if (hasBase || enabled) restoreStyleBase(image, config.baseKey, config.props, image);
      delete image.dataset[config.activeKey];
      for (const key of config.valueKeys) delete image.dataset[key];
    }
  }

  function applyAppearanceEffect(image, effect, values) {
    const config = appearanceConfig(effect);
    if (!config || !image) return;
    captureStyleBase(image, config.baseKey, config.props);

    if (effect === 'feather') {
      const amount = clamp(values.amount, 0, 45);
      if (amount <= 0) {
        clearAppearanceEffect(image, effect);
        return;
      }
      image.dataset.mpseFeatherOn = '1';
      image.dataset.mpseFeatherAmount = String(amount);
    }

    if (effect === 'stroke') {
      const width = clamp(values.width, 0, 20);
      if (width <= 0) {
        clearAppearanceEffect(image, effect);
        return;
      }
      image.dataset.mpseStrokeOn = '1';
      image.dataset.mpseStrokeWidth = String(width);
      image.dataset.mpseStrokeColor = values.strokeColor || '#07c160';
      image.dataset.mpseStrokeOpacity = String(clamp(values.opacity, 0, 100));
    }

    if (effect === 'opacity') {
      const value = clamp(values.value, 0, 100);
      if (value >= 100) {
        clearAppearanceEffect(image, effect);
        return;
      }
      image.dataset.mpseOpacityOn = '1';
      image.dataset.mpseOpacityValue = String(value);
    }

    renderAppearance(image);
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
    if (effect === 'feather') return range('羽化范围', 'amount', 0, 45, 1, getDataNumber(image, 'mpseFeatherAmount', 0), '%');
    if (effect === 'stroke') return `${range('描边宽度', 'width', 0, 20, 1, getDataNumber(image, 'mpseStrokeWidth', 0), 'px')}${range('描边透明度', 'opacity', 0, 100, 1, getDataNumber(image, 'mpseStrokeOpacity', 100), '%')}${color('描边颜色', 'strokeColor', getDataString(image, 'mpseStrokeColor', '#07c160'))}`;
    if (effect === 'color') return `${range('亮度', 'brightness', 40, 180, 1, colorDefaults.brightness, '%')}${range('对比度', 'contrast', 40, 180, 1, colorDefaults.contrast, '%')}${range('饱和度', 'saturate', 0, 240, 1, colorDefaults.saturate, '%')}${range('灰度', 'gray', 0, 100, 1, colorDefaults.gray, '%')}`;
    if (effect === 'opacity') return range('图片透明度', 'value', 0, 100, 1, getDataNumber(image, 'mpseOpacityValue', readOpacityPercent(image, 100)), '%');
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
    if (effect === 'feather') return '羽化作用于图片或裁切容器的边缘，拖到 0 可恢复原状。';
    if (effect === 'stroke') return '描边不改变图片尺寸，也不会影响阴影、发光或相框。';
    if (effect === 'opacity') return '透明度作用于整张图片；调回 100% 可恢复原始透明度。';
    return '只有实际调整后才会同步到正文 HTML';
  }

  function isToggleEffect(effect) {
    return effect === 'shadow' || effect === 'glow';
  }

  function isEffectEnabled(image, effect) {
    if (!image) return false;
    if (effect === 'shadow') return image.dataset.mpseShadowOn === '1';
    if (effect === 'glow') return image.dataset.mpseGlowOn === '1';
    if (appearanceConfig(effect)) return isAppearanceEnabled(image, effect);
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
    const titles = { radius: '圆角', size: '尺寸', spacing: '间距', shadow: '阴影', glow: '发光', feather: '羽化', stroke: '描边', color: '色彩', opacity: '透明度', rotate: '旋转', frame: '相框', caption: '图注', circle: '圆形' };
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
      setLayoutWidthPercent(image, width);
      setStyles(layoutHost, { 'max-width': '100%', display: 'block' });
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

    if (appearanceConfig(effect)) applyAppearanceEffect(image, effect, values);

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
    schedulePositionTools();
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
    if (appearanceConfig(effect)) clearAppearanceEffect(image, effect);
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
    schedulePositionTools();
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
    resetAppearanceEffects(image);
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

  function markChanged(image, reason, schedule = true) {
    if (!image || !image.ownerDocument) return;
    image.setAttribute('data-mpse-image-edited', '1');
    const snapshot = snapshotCurrentImage();
    if (!snapshot) return;
    snapshot.revision = ++state.editRevision;
    snapshot.gestureEpoch = state.gestureEpoch;
    state.lastSnapshot = snapshot;
    state.needsCommit = true;

    if (DEBUG) console.info('[公众号源码排版助手] image style applied', reason || '', image.getAttribute('style') || '');
    if (schedule) scheduleContentCommit(reason);
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

    const delay = reason === 'drag-end' ? 420 : 360;
    state.commitTimer = window.setTimeout(() => {
      state.commitTimer = null;
      commitSnapshotToEditor(state.pendingCommitReason);
    }, delay);
  }

  function cancelScheduledReacquire() {
    if (!state.reacquireTimer) return;
    window.clearTimeout(state.reacquireTimer);
    state.reacquireTimer = null;
  }

  function scheduleSelectedImageReacquire(identity, options = {}) {
    if (!identity) return;
    cancelScheduledReacquire();
    const selectionRevision = state.selectionRevision;
    const gestureEpoch = state.gestureEpoch;
    state.reacquireTimer = window.setTimeout(() => {
      state.reacquireTimer = null;
      if (state.selectionRevision !== selectionRevision || state.gestureEpoch !== gestureEpoch || state.isDragging) return;
      if (options.snapshot && state.lastSnapshot !== options.snapshot) return;
      if (Number.isFinite(options.seq) && state.commitSeq !== options.seq) return;
      reacquireSelectedImage(identity);
    }, Math.max(0, Number(options.delay) || 0));
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
    const host = target && getCropContainer(target);
    if (!host) return false;
    return host.style.getPropertyValue('position') === 'relative'
      && host.style.getPropertyValue('overflow') === 'hidden'
      && Boolean(host.style.getPropertyValue('aspect-ratio'))
      && target.style.getPropertyValue('position') === 'absolute'
      && Boolean(target.style.getPropertyValue('left'))
      && Boolean(target.style.getPropertyValue('top'))
      && Boolean(target.style.getPropertyValue('width'))
      && Boolean(target.style.getPropertyValue('height'));
  }

  function commitMatchesCurrentEdit(snapshot) {
    return Boolean(snapshot && !state.isDragging && !state.interaction
      && state.lastSnapshot === snapshot
      && state.editRevision === snapshot.revision
      && state.gestureEpoch === snapshot.gestureEpoch);
  }

  async function commitSnapshotToEditor(reason) {
    if (state.isDragging) return;
    if (state.commitInFlight) {
      state.queuedCommit = true;
      return;
    }
    if (!state.needsCommit || !state.lastSnapshot) return;
    const snapshot = state.lastSnapshot;
    state.needsCommit = false;
    const seq = ++state.commitSeq;
    state.commitInFlight = true;
    state.commitPhase = 'get';
    state.pendingCommitReason = '';
    let failed = false;
    setBadgeText('同步中…');

    try {
      const current = await requestBridge('GET_CONTENT', {}, 15000);
      if (!commitMatchesCurrentEdit(snapshot)) {
        state.needsCommit = true;
        return;
      }
      const content = typeof current.content === 'string' ? current.content : '';
      const result = applySnapshotToHtml(content, snapshot);
      if (!result.changed) {
        console.warn('[公众号源码排版助手] image html sync skipped:', result.reason);
        setBadgeText('仅预览');
        return;
      }
      if (!commitMatchesCurrentEdit(snapshot)) {
        state.needsCommit = true;
        return;
      }
      state.commitPhase = 'set';
      await requestBridge('SET_CONTENT', { content: result.html }, 15000);
      if (!commitMatchesCurrentEdit(snapshot)) {
        if (state.interaction) rebaseInteractionAfterEditorWrite(snapshot.identity);
        else if (state.identity) scheduleSelectedImageReacquire(state.identity, { delay: 0 });
        return;
      }
      let cropPersisted = true;
      if (snapshot.cropHtml) {
        try {
          state.commitPhase = 'verify';
          const verification = await requestBridge('GET_CONTENT', {}, 15000);
          cropPersisted = cropWasPersisted(verification.content, snapshot.identity);
        } catch (error) {
          console.warn('[公众号源码排版助手] image crop verification failed:', error);
        }
      }
      if (seq === state.commitSeq && commitMatchesCurrentEdit(snapshot)) {
        if (DEBUG) console.info('[公众号源码排版助手] image html synced', reason || '', current.mode || 'unknown');
        setBadgeText(cropPersisted ? '已同步' : '裁切未保留');
        scheduleSelectedImageReacquire(snapshot.identity, { delay: 180, snapshot, seq });
      }
    } catch (error) {
      failed = true;
      state.needsCommit = true;
      console.warn('[公众号源码排版助手] image html sync failed:', error);
      setBadgeText('同步失败');
    } finally {
      state.commitInFlight = false;
      state.commitPhase = '';
      if (state.queuedCommit || (!failed && state.needsCommit)) {
        state.queuedCommit = false;
        scheduleContentCommit('queued');
      }
    }
  }

  function reacquireSelectedImage(identity = state.identity) {
    if (!identity) return;
    let best = null;
    let bestScore = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    const list = getAllArticleImages();
    const preferredIndex = Number.isFinite(identity.index) ? identity.index : 0;
    for (const [index, image] of list.entries()) {
      const asDom = {
        getAttribute: (name) => {
          if (name === 'src') return getAttr(image, 'src') || image.currentSrc || image.src || '';
          return getAttr(image, name);
        }
      };
      const score = scoreImageByIdentity(asDom, identity);
      const distance = Math.abs(index - preferredIndex);
      if (score > bestScore || (score === bestScore && distance < bestDistance)) {
        best = image;
        bestScore = score;
        bestDistance = distance;
      }
    }
    if (!best && list[identity.index]) best = list[identity.index];
    if (best) {
      state.image = best;
      state.identity = imageSignature(best);
      if (state.cropMode && !getCropContainer(best)) exitCropMode();
      setButtonStates();
      refreshVisiblePanel();
      schedulePositionTools();
    }
  }

  function showToolsForImage(image) {
    if (state.cropMode && state.image && state.image !== image) exitCropMode();
    state.image = image;
    state.identity = imageSignature(image);
    createMenu().classList.add('mpse-visible');
    createBox().classList.add('mpse-visible');
    createHandles();
    createBadge().classList.add('mpse-visible');
    setToolElementsOffscreen(false);
    setButtonStates();
    refreshVisiblePanel();
    positionTools();
  }

  function setToolElementsOffscreen(offscreen) {
    for (const id of [MENU_ID, PANEL_ID, BOX_ID, BADGE_ID]) {
      const element = document.getElementById(id);
      if (element) element.classList.toggle('mpse-offscreen', offscreen);
    }
    for (const handle of getImageHandles()) handle.classList.toggle('mpse-offscreen', offscreen);
  }

  function hideToolElements() {
    for (const id of [MENU_ID, PANEL_ID, BOX_ID, BADGE_ID]) {
      const element = document.getElementById(id);
      if (element) element.classList.remove('mpse-visible', 'mpse-offscreen');
    }
    for (const handle of getImageHandles()) handle.classList.remove('mpse-visible', 'mpse-offscreen');
    hideDragShield();
  }

  function hideTools() {
    if (state.interaction) finishGeometryGesture(undefined, true);
    exitCropMode();
    state.image = null;
    state.identity = null;
    state.activePanel = null;
    state.isDragging = false;
    state.lastImagePress = null;
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
    if (state.interaction) return;
    if (hasBlockingEditorLayer()) {
      setToolElementsOffscreen(true);
      return;
    }
    const rect = getTopRect(getSelectionElement(image));
    if (rect.width < 1 || rect.height < 1) {
      setToolElementsOffscreen(true);
      return;
    }
    if (!isSelectionVisible(image, rect)) {
      setToolElementsOffscreen(true);
      return;
    }
    setToolElementsOffscreen(false);

    positionSelectionBox(box, rect);
    box.classList.toggle('mpse-crop-mode', state.cropMode);
    positionHandles(rect);

    const menuWidth = 54;
    const panelWidth = 238;
    const gap = 20;
    let menuLeft = rect.right + gap;
    if (menuLeft + menuWidth > window.innerWidth - 8) menuLeft = rect.left - menuWidth - gap;
    menuLeft = Math.max(8, Math.min(menuLeft, window.innerWidth - menuWidth - 8));
    const menuHeight = Math.min(menu.offsetHeight || 330, Math.max(1, window.innerHeight - 16));
    const menuTop = Math.max(8, Math.min(rect.top + 4, window.innerHeight - menuHeight - 8));

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

  function hasBlockingEditorLayer() {
    const selector = [
      'dialog[open]',
      '[aria-modal="true"]',
      '.weui-mask',
      '.weui-desktop-mask',
      '.weui-desktop-dialog__wrp',
      '.weui-desktop-dialog_wrapper',
      '[class*="modal-mask"]',
      '[class*="dialog__mask"]'
    ].join(',');
    for (const doc of getAccessibleDocuments()) {
      const view = doc.defaultView;
      if (!view) continue;
      for (const element of doc.querySelectorAll(selector)) {
        if (isExtensionElement(element)) continue;
        const style = view.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') continue;
        const rect = element.getBoundingClientRect();
        if (rect.width > 120 && rect.height > 80) return true;
      }
    }
    return false;
  }

  function findImageFromEvent(event) {
    const target = event.target;
    if (!target || isExtensionElement(target)) return null;
    const image = target.closest ? target.closest('img') : null;
    return image && isLikelyArticleImage(image) ? image : null;
  }

  function isRepeatedImagePress(image, event) {
    const point = getTopClientPoint(event);
    const now = Date.now();
    const previous = state.lastImagePress;
    state.lastImagePress = { image, identity: imageSignature(image), time: now, x: point ? point.x : NaN, y: point ? point.y : NaN };
    const sameImage = previous && (previous.image === image || scoreImageByIdentity(image, previous.identity) >= 600);
    if (!sameImage || now - previous.time > 500 || !point) return false;
    return Math.hypot(point.x - previous.x, point.y - previous.y) <= 28;
  }

  function toggleCropMode(image) {
    const now = Date.now();
    if (now - state.lastCropToggleAt < 420) return;
    state.lastCropToggleAt = now;
    if (state.interaction) finishGeometryGesture();
    const wasCropMode = state.cropMode && state.identity
      && (image === state.image || scoreImageByIdentity(image, state.identity) >= 600);
    showToolsForImage(image);
    if (wasCropMode) exitCropMode();
    else enterCropMode(image);
  }

  function onHandlePointerDown(event) {
    if (!event || event.button !== 0) return;
    const handle = event.currentTarget;
    if (!handle) return;
    stopUiEvent(event);
    state.lastImagePress = null;
    if (state.interaction) finishGeometryGesture();
    beginGeometryGesture(handle.dataset.mpseImageHandle, event, handle);
  }

  function onHandlePointerCancel(event) {
    finishGeometryGesture(event, true);
  }

  function onDocumentPointer(event) {
    if (!event || !event.target) return;
    if (event.type !== 'pointerdown' || event.button !== 0) return;
    if (isExtensionElement(event.target)) return;
    if (document.getElementById('mpse-inline-panel') || hasBlockingEditorLayer()) {
      hideTools();
      return;
    }

    const image = findImageFromEvent(event);
    if (image) {
      const repeatedPress = isRepeatedImagePress(image, event);
      if (repeatedPress) {
        state.lastImagePress = null;
        event.preventDefault();
        event.stopPropagation();
        toggleCropMode(image);
        return;
      }
      if (state.cropMode && image === state.image && getCropContainer(image)) {
        event.preventDefault();
        event.stopPropagation();
        beginCropPan(image, event);
        return;
      }
      showToolsForImage(image);
      return;
    }

    state.lastImagePress = null;
    hideTools();
  }

  function onDocumentDoubleClick(event) {
    if (!event || !event.target || isExtensionElement(event.target)) return;
    if (document.getElementById('mpse-inline-panel') || hasBlockingEditorLayer()) return;
    const image = findImageFromEvent(event);
    if (!image) return;
    event.preventDefault();
    event.stopPropagation();
    state.lastImagePress = null;
    toggleCropMode(image);
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
    if (state.interaction) stopUiEvent(event);
    updateGeometryGesture(event);
  }

  function onDocumentPointerUp(event) {
    if (state.interaction) stopUiEvent(event);
    finishGeometryGesture(event);
  }

  function onDocumentDragStart(event) {
    if (!event || !event.target || !state.image) return;
    const selection = getSelectionElement(state.image);
    if (state.interaction || event.target === state.image || (selection && selection.contains(event.target))) {
      stopUiEvent(event);
    }
  }

  function onDocumentSelectStart(event) {
    if (state.interaction) stopUiEvent(event);
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
      doc.addEventListener('pointercancel', onDocumentPointerUp, true);
      doc.addEventListener('lostpointercapture', onDocumentPointerUp, true);
      doc.addEventListener('dragstart', onDocumentDragStart, true);
      doc.addEventListener('selectstart', onDocumentSelectStart, true);
      doc.addEventListener('wheel', onDocumentWheel, { capture: true, passive: false });
      doc.addEventListener('keydown', onDocumentKeyDown, true);
      doc.addEventListener('scroll', () => {
        if (state.image) schedulePositionTools();
      }, true);
    }
  }

  function onGlobalPointerUp(event) {
    if (state.interaction) {
      stopUiEvent(event);
      finishGeometryGesture(event);
      return;
    }
    if (!state.isDragging) return;
    state.isDragging = false;
    if (state.needsCommit) scheduleContentCommit('drag-end');
  }

  function onGlobalPointerMove(event) {
    if (state.interaction) stopUiEvent(event);
    updateGeometryGesture(event);
  }

  let bindTimer = 0;

  function scheduleBindDocuments() {
    if (bindTimer) return;
    bindTimer = window.setTimeout(() => {
      bindTimer = 0;
      bindDocuments();
      if (state.image) schedulePositionTools();
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
    createHandles();
    createDragShield();
    createBadge();
    bindDocuments();

    const observer = new MutationObserver(scheduleBindDocuments);
    observer.observe(document.documentElement, { childList: true, subtree: true });

    window.setInterval(scheduleBindDocuments, 1500);
    window.addEventListener('pointermove', onGlobalPointerMove, true);
    window.addEventListener('pointerup', onGlobalPointerUp, true);
    window.addEventListener('pointercancel', onGlobalPointerUp, true);
    window.addEventListener('mouseup', onGlobalPointerUp, true);
    window.addEventListener('blur', () => finishGeometryGesture(undefined, true), true);
    window.addEventListener('resize', () => {
      if (state.image) schedulePositionTools();
    });
    window.addEventListener('scroll', () => {
      if (state.image) schedulePositionTools();
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
