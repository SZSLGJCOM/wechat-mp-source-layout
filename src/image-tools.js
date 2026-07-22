(() => {
  'use strict';

  const VERSION = 'v0.10.1';
  const MENU_ID = 'mpse-img2-menu';
  const PANEL_ID = 'mpse-img2-panel';
  const BOX_ID = 'mpse-img2-box';
  const BADGE_ID = 'mpse-img2-badge';
  const DRAG_SHIELD_ID = 'mpse-img2-drag-shield';
  const HANDLE_CLASS = 'mpse-img2-handle';
  const CROP_ATTR = 'data-mpse-image-crop';
  const GEOMETRY_DRAG_THRESHOLD = 4;
  const BOUND_FLAG = '__mpseImageToolsBound__';
  const GENERIC_BOUND_ATTR = 'data-mpse-image-tools-bound';
  const VERSION_ATTR = 'data-mpse-image-tools-version';
  const bridgeClient = window.__MPSE_BRIDGE_CLIENT__;
  const imageGeometry = window.__MPSE_IMAGE_GEOMETRY__;
  const imagePresentation = window.__MPSE_IMAGE_PRESENTATION__;
  const snapshotMerge = window.__MPSE_IMAGE_SNAPSHOT_MERGE__;
  const injectBridge = bridgeClient && typeof bridgeClient.inject === 'function'
    ? bridgeClient.inject
    : () => false;
  const readEditorContent = bridgeClient && typeof bridgeClient.readContent === 'function'
    ? bridgeClient.readContent
    : () => Promise.reject(new Error('扩展桥接客户端未加载，请刷新页面后重试'));
  const mutateEditorContent = bridgeClient && typeof bridgeClient.mutateContent === 'function'
    ? bridgeClient.mutateContent
    : () => Promise.reject(new Error('扩展桥接客户端未加载，请刷新页面后重试'));

  if (!imageGeometry) throw new Error('图片几何模块未加载，请刷新页面后重试');
  if (!imagePresentation) throw new Error('图片展示模块未加载，请刷新页面后重试');
  if (!snapshotMerge) throw new Error('图片写回合并模块未加载，请刷新页面后重试');

  const MANAGED_DATA_KEYS = [
    'mpseGlowOn', 'mpseGlowBlur', 'mpseGlowSpread', 'mpseGlowOpacity', 'mpseGlowColor',
    'mpseBrightness', 'mpseContrast', 'mpseSaturate', 'mpseGray', 'mpseColorOn', 'mpseRotate', 'mpseRotateOn',
    'mpseShadowOn', 'mpseShadowX', 'mpseShadowY', 'mpseShadowBlur', 'mpseShadowSpread', 'mpseShadowOpacity', 'mpseShadowColor',
    'mpseBaseBoxShadow', 'mpseCircleOn', 'mpseCircleBase', 'mpseCircleDiameter', 'mpseColorBase', 'mpseRotateBase', 'mpseFrameBase',
    'mpseImageBase', 'mpseRadiusOn', 'mpseRadiusValue',
    'mpseSpacingOn', 'mpseSpacingBase', 'mpseFrameOn',
    'mpseFrameBorderWidth', 'mpseFramePadding', 'mpseFrameRadius', 'mpseFrameBorderColor', 'mpseFrameBackgroundColor',
    'mpseFeatherOn', 'mpseFeatherAmount', 'mpseFeatherBase',
    'mpseStrokeOn', 'mpseStrokeWidth', 'mpseStrokeColor', 'mpseStrokeOpacity', 'mpseStrokeBase',
    'mpseOpacityOn', 'mpseOpacityValue', 'mpseOpacityBase'
  ];
  const FRAME_STYLE_PROPS = [
    'border', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
    'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
    'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
    'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'background-color', 'border-radius', 'box-sizing', 'overflow'
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
    commitPhase: '',
    queuedCommit: false,
    pendingCommitReason: '',
    isDragging: false,
    interaction: null,
    cropMode: false,
    cropTransientHost: false,
    cropTransientBase: false,
    cropTransientCirclePresentation: null,
    cropSessionRevision: 0,
    cropSessionGeometryChanged: false,
    needsCommit: false,
    lastSnapshot: null,
    pendingSnapshots: new Map(),
    commitRetryCount: 0,
    positionFrame: 0,
    pageObserver: null,
    blockedByLayer: false,
    handleElements: [],
    gestureEpoch: 0,
    editRevision: 0,
    selectionRevision: 0,
    reacquireTimer: null,
    lastImagePress: null,
    lastCropToggleAt: 0,
    zoomFrame: 0,
    pendingZoom: null
  };

  function isMpHost() {
    return location.hostname === 'mp.weixin.qq.com';
  }

  function isEditorLikePage() {
    if (!isMpHost()) return false;
    if (!/^\/cgi-bin\/appmsg(?:\/|$)/.test(location.pathname)) return false;
    if (document.querySelector('.edui-toolbar, .edui-editor, #ueditor_0, iframe[id*=ueditor], iframe[name*=ueditor]')) return true;
    return getAccessibleDocuments().some((doc) => Boolean(doc.querySelector('[contenteditable="true"], body[contenteditable="true"]')));
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

  function readFrameDocument(frame) {
    try {
      return frame.contentDocument || null;
    } catch (_) {
      return null;
    }
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
    const direct = node.closest('[contenteditable="true"], body[contenteditable="true"]');
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

  function ensureImageEditId(image) {
    let value = getAttr(image, 'data-mpse-image-id');
    if (value) return value;
    const random = globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    value = `img-${random}`;
    image.setAttribute('data-mpse-image-id', value);
    return value;
  }

  function imageIndexInArticle(image) {
    const root = findEditableRoot(image);
    const list = root && root.querySelectorAll
      ? Array.from(root.querySelectorAll('img')).filter((candidate) => !isExtensionElement(candidate))
      : getAllArticleImages();
    const idx = list.indexOf(image);
    return idx >= 0 ? idx : 0;
  }

  function editorScopeKey(image) {
    const root = findEditableRoot(image);
    if (!root) return '';
    const frame = getFrameByDocument(image.ownerDocument);
    const frameIndex = frame ? Array.from(document.querySelectorAll('iframe')).indexOf(frame) : -1;
    const frameKey = frame ? (frame.id || frame.name || `iframe-${frameIndex}`) : 'top';
    const rootKey = root.id || root.getAttribute('data-editor-id') || root.tagName.toLowerCase();
    return `${frameKey}:${rootKey}`;
  }

  function imageSignature(image) {
    return {
      index: imageIndexInArticle(image),
      scopeKey: editorScopeKey(image),
      editId: getAttr(image, 'data-mpse-image-id'),
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

  function imageIdentityKey(identity) {
    if (!identity) return '';
    const primary = identity.editId || identity.fileId || identity.dataSrc || identity.src || identity.dataBackSrc || identity.dataCropSrc
      || `${identity.w || ''}:${identity.ratio || ''}:${identity.alt || ''}`;
    const position = identity.editId ? 'stable' : (Number.isFinite(identity.index) ? identity.index : -1);
    return `${identity.scopeKey || 'article'}:${position}:${primary}`;
  }

  function scoreImageByIdentity(candidate, identity) {
    if (!candidate || !identity) return 0;
    let score = 0;
    const src = stableUrl(candidate.getAttribute('src'));
    const dataSrc = stableUrl(candidate.getAttribute('data-src'));
    const dataBackSrc = stableUrl(candidate.getAttribute('data-backsrc'));
    const dataCropSrc = stableUrl(candidate.getAttribute('data-croporisrc'));
    const editId = candidate.getAttribute('data-mpse-image-id') || '';

    if (identity.editId && editId && identity.editId === editId) score += 5000;
    if (identity.dataSrc && dataSrc && identity.dataSrc === dataSrc) score += 1200;
    if (identity.src && src && identity.src === src) score += 900;
    if (identity.dataBackSrc && dataBackSrc && identity.dataBackSrc === dataBackSrc) score += 800;
    if (identity.dataCropSrc && dataCropSrc && identity.dataCropSrc === dataCropSrc) score += 700;
    const identityUrls = [identity.src, identity.dataSrc, identity.dataBackSrc, identity.dataCropSrc].filter(Boolean);
    const candidateUrls = [src, dataSrc, dataBackSrc, dataCropSrc].filter(Boolean);
    if (identityUrls.some((url) => candidateUrls.includes(url))) score += 650;
    if (identity.fileId && (candidate.getAttribute('data-fileid') === identity.fileId || candidate.getAttribute('data-mediaid') === identity.fileId)) score += 600;
    if (identity.w && candidate.getAttribute('data-w') === identity.w) score += 50;
    if (identity.ratio && candidate.getAttribute('data-ratio') === identity.ratio) score += 50;
    if (identity.alt && candidate.getAttribute('alt') === identity.alt) score += 20;
    if (identity.className && candidate.getAttribute('class') === identity.className) score += 10;
    return score;
  }

  function identityHasPrimaryKey(identity) {
    return Boolean(identity && (identity.editId || identity.src || identity.dataSrc || identity.dataBackSrc || identity.dataCropSrc || identity.fileId));
  }

  function exactIndexFallback(images, identity) {
    if (!identity || identityHasPrimaryKey(identity) || !Number.isFinite(identity.index)) return null;
    const candidate = images[identity.index];
    return candidate && scoreImageByIdentity(candidate, identity) > 0 ? candidate : null;
  }

  function shortlistImagesByEditId(images, identity) {
    const indexed = images.map((image, index) => ({ image, index }));
    if (!identity?.editId) return { exact: null, indexed };
    const exact = indexed.find(({ image }) => getAttr(image, 'data-mpse-image-id') === identity.editId);
    if (exact) return { exact: exact.image, indexed: [] };
    return {
      exact: null,
      indexed: indexed.filter(({ image }) => !getAttr(image, 'data-mpse-image-id'))
    };
  }

  function locateImageInHtml(root, identity) {
    const images = Array.from(root.querySelectorAll('img'));
    if (!images.length) return null;
    const shortlist = shortlistImagesByEditId(images, identity);
    if (shortlist.exact) return shortlist.exact;

    let best = null;
    let bestScore = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    const preferredIndex = Number.isFinite(identity && identity.index) ? identity.index : 0;
    for (const { image: img, index } of shortlist.indexed) {
      const score = scoreImageByIdentity(img, identity);
      const distance = Math.abs(index - preferredIndex);
      if (score > bestScore || (score === bestScore && distance < bestDistance)) {
        best = img;
        bestScore = score;
        bestDistance = distance;
      }
    }

    if (identityHasPrimaryKey(identity)) return best && bestScore >= 600 ? best : null;
    return exactIndexFallback(images, identity);
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

  function rectsIntersect(first, second) {
    return Boolean(first && second && first.right > second.left && first.left < second.right
      && first.bottom > second.top && first.top < second.bottom);
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
    if (!rectsIntersect(getViewportRect(), rect)) return false;
    const frame = getFrameByDocument(image.ownerDocument);
    if (frame && !rectsIntersect(getFrameContentRect(frame), rect)) return false;

    const selection = getSelectionElement(image);
    for (let parent = selection.parentElement; parent && parent !== image.ownerDocument.documentElement; parent = parent.parentElement) {
      if (isClippingAncestor(parent) && !rectsIntersect(getTopRect(parent), rect)) return false;
    }
    if (frame) {
      for (let parent = frame.parentElement; parent && parent !== document.documentElement; parent = parent.parentElement) {
        if (isClippingAncestor(parent) && !rectsIntersect(getTopRect(parent), rect)) return false;
      }
    }
    return true;
  }

  function createClientPointMapping(sourceDocument) {
    if (!sourceDocument || sourceDocument === document) return null;
    const frame = getFrameByDocument(sourceDocument);
    if (!frame) return null;
    const frameRect = frame.getBoundingClientRect();
    const sourceWindow = sourceDocument.defaultView;
    const frameWidth = Math.max(1, (sourceWindow && sourceWindow.innerWidth) || frame.clientWidth || frameRect.width);
    const frameHeight = Math.max(1, (sourceWindow && sourceWindow.innerHeight) || frame.clientHeight || frameRect.height);
    return {
      sourceDocument,
      offsetX: frameRect.left + frame.clientLeft * frameRect.width / frameWidth,
      offsetY: frameRect.top + frame.clientTop * frameRect.height / frameHeight,
      scaleX: frameRect.width / frameWidth,
      scaleY: frameRect.height / frameHeight
    };
  }

  function getTopClientPoint(event, mapping = null) {
    const x = Number(event && event.clientX);
    const y = Number(event && event.clientY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

    if (event && event.mpseTopCoordinates) return { x, y };

    const sourceDocument = (event.target && event.target.ownerDocument)
      || (event.view && event.view.document)
      || null;
    if (mapping && (!sourceDocument || sourceDocument === mapping.sourceDocument)) {
      return { x: mapping.offsetX + x * mapping.scaleX, y: mapping.offsetY + y * mapping.scaleY };
    }
    if (!sourceDocument || sourceDocument === document) return { x, y };
    const pointMapping = createClientPointMapping(sourceDocument);
    return pointMapping ? { x: pointMapping.offsetX + x * pointMapping.scaleX, y: pointMapping.offsetY + y * pointMapping.scaleY } : null;
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
    shield.addEventListener('wheel', (event) => {
      if (state.interaction) stopUiEvent(event);
    }, { capture: true, passive: false });
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

  function transferInlineStyles(source, target, props) {
    if (!source || !target) return;
    for (const prop of props) {
      const value = source.style.getPropertyValue(prop);
      const priority = source.style.getPropertyPriority(prop);
      if (value) target.style.setProperty(prop, value, priority);
      else target.style.removeProperty(prop);
      source.style.removeProperty(prop);
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
    const declaredLeft = element.style.getPropertyValue('margin-left');
    const declaredRight = element.style.getPropertyValue('margin-right');
    if (style.float === 'right') return 'right';
    if (style.float === 'left') return 'left';
    if (declaredLeft === 'auto' && declaredRight === 'auto') return 'center';
    if (declaredLeft === 'auto') return 'right';
    if (declaredRight === 'auto') return 'left';
    const marginLeft = parseFloat(style.marginLeft || '0');
    const marginRight = parseFloat(style.marginRight || '0');
    if (style.display === 'block' && marginLeft > 1 && marginRight > 1 && Math.abs(marginLeft - marginRight) < 2) return 'center';
    if (style.display === 'block' && marginLeft > 1 && marginRight <= 1) return 'right';
    if (parentStyle && ['inline', 'inline-block'].includes(style.display)) {
      if (parentStyle.textAlign === 'center') return 'center';
      if (parentStyle.textAlign === 'right') return 'right';
    }
    return 'left';
  }

  function captureCropLayout(image) {
    const view = image && image.ownerDocument && image.ownerDocument.defaultView;
    const computed = view && image ? view.getComputedStyle(image) : null;
    const computedDisplay = computed ? computed.display : 'block';
    const alignment = detectHorizontalAlignment(image);
    const hostProps = [
      'width', 'height', 'max-width', 'display', 'margin-left', 'margin-right',
      'margin-top', 'margin-bottom', 'vertical-align', 'float', 'transform', 'transform-origin'
    ];
    const imageOnlyProps = ['position', 'left', 'top', 'right', 'bottom', 'translate', 'scale'];
    const props = [...hostProps, ...imageOnlyProps];
    const styles = captureInlineStyles(image, props);
    const hostStyles = Object.fromEntries(hostProps.map((key) => [key, { ...styles[key] }]));
    for (const property of ['margin-top', 'margin-bottom', 'vertical-align', 'float']) {
      if (!hostStyles[property].value && computed) hostStyles[property] = { value: computed.getPropertyValue(property), priority: '' };
    }
    if (!hostStyles['margin-left'].value && !hostStyles['margin-right'].value) {
      if (alignment === 'center') {
        hostStyles['margin-left'] = { value: 'auto', priority: '' };
        hostStyles['margin-right'] = { value: 'auto', priority: '' };
      } else if (alignment === 'right') {
        hostStyles['margin-left'] = { value: 'auto', priority: '' };
        hostStyles['margin-right'] = { value: '0px', priority: '' };
      } else if (computed) {
        hostStyles['margin-left'] = { value: computed.marginLeft, priority: '' };
        hostStyles['margin-right'] = { value: computed.marginRight, priority: '' };
      }
    }
    return {
      alignment,
      display: computedDisplay === 'inline' ? 'inline-block' : (computedDisplay === 'none' ? 'block' : computedDisplay),
      offsetX: 0,
      offsetY: 0,
      frameStyles: captureFrameSourceStyles(image),
      hostStyles,
      styles
    };
  }

  function readCropLayout(image) {
    const host = getCropContainer(image);
    if (!host) return captureCropLayout(image);
    try {
      const layout = JSON.parse(host.dataset.mpseCropLayout || '{}');
      if (layout && layout.styles && ['left', 'center', 'right'].includes(layout.alignment)) {
        layout.offsetX = Number.isFinite(Number(layout.offsetX)) ? clamp(Number(layout.offsetX), -4, 4) : 0;
        layout.offsetY = Number.isFinite(Number(layout.offsetY)) ? clamp(Number(layout.offsetY), -4, 4) : 0;
        return layout;
      }
    } catch (_) {
      // Invalid persisted layout metadata falls back to the current frame.
    }
    return {
      alignment: detectHorizontalAlignment(host),
      display: host.style.getPropertyValue('display') || 'block',
      offsetX: 0,
      offsetY: 0,
      styles: captureInlineStyles(host, [
        'width', 'height', 'max-width', 'display', 'margin-left', 'margin-right',
        'margin-top', 'margin-bottom', 'vertical-align', 'float', 'transform', 'transform-origin'
      ])
    };
  }

  function writeCropLayout(image, layout) {
    const host = getCropContainer(image);
    if (!host || !layout) return;
    host.dataset.mpseCropLayout = JSON.stringify(layout);
  }

  function readDecorationMetrics(element, baseWidth) {
    const view = element?.ownerDocument?.defaultView;
    const style = view && element ? view.getComputedStyle(element) : null;
    const number = (property) => Math.max(0, parseFloat(style?.getPropertyValue(property) || '0') || 0);
    const text = (property, fallback = '') => style?.getPropertyValue(property) || fallback;
    return {
      baseWidth: Math.max(0.01, Number(baseWidth) || 100),
      paddingTop: number('padding-top'),
      paddingRight: number('padding-right'),
      paddingBottom: number('padding-bottom'),
      paddingLeft: number('padding-left'),
      borderTopWidth: number('border-top-width'),
      borderRightWidth: number('border-right-width'),
      borderBottomWidth: number('border-bottom-width'),
      borderLeftWidth: number('border-left-width'),
      borderTopStyle: text('border-top-style', 'none'),
      borderRightStyle: text('border-right-style', 'none'),
      borderBottomStyle: text('border-bottom-style', 'none'),
      borderLeftStyle: text('border-left-style', 'none'),
      borderTopColor: text('border-top-color', 'transparent'),
      borderRightColor: text('border-right-color', 'transparent'),
      borderBottomColor: text('border-bottom-color', 'transparent'),
      borderLeftColor: text('border-left-color', 'transparent')
    };
  }

  function applyCropDecorationScale(host, layout, baseWidth) {
    if (!host || !layout) return;
    if (!layout.decoration) layout.decoration = readDecorationMetrics(host, baseWidth);
    const metrics = layout.decoration;
    const factor = Math.max(0.01, baseWidth) / Math.max(0.01, Number(metrics.baseWidth) || baseWidth);
    const scaled = (value) => `${(Math.max(0, Number(value) || 0) * factor).toFixed(3)}px`;
    setStyles(host, {
      'box-sizing': 'content-box',
      'padding-top': scaled(metrics.paddingTop),
      'padding-right': scaled(metrics.paddingRight),
      'padding-bottom': scaled(metrics.paddingBottom),
      'padding-left': scaled(metrics.paddingLeft),
      'border-top-width': scaled(metrics.borderTopWidth),
      'border-right-width': scaled(metrics.borderRightWidth),
      'border-bottom-width': scaled(metrics.borderBottomWidth),
      'border-left-width': scaled(metrics.borderLeftWidth),
      'border-top-style': metrics.borderTopStyle,
      'border-right-style': metrics.borderRightStyle,
      'border-bottom-style': metrics.borderBottomStyle,
      'border-left-style': metrics.borderLeftStyle,
      'border-top-color': metrics.borderTopColor,
      'border-right-color': metrics.borderRightColor,
      'border-bottom-color': metrics.borderBottomColor,
      'border-left-color': metrics.borderLeftColor
    });
  }

  function refreshCropDecoration(image) {
    const host = getCropContainer(image);
    if (!host) return;
    const layout = readCropLayout(image);
    const baseWidth = readCropBaseWidth(image);
    layout.decoration = readDecorationMetrics(host, baseWidth);
    writeCropLayout(image, layout);
  }

  function getCropContentRect(image) {
    const host = getCropContainer(image);
    if (!host) return getTopRect(image);
    const outer = getTopRect(host);
    const local = host.getBoundingClientRect();
    const style = host.ownerDocument.defaultView?.getComputedStyle(host);
    const scaleX = outer.width / Math.max(1, local.width);
    const scaleY = outer.height / Math.max(1, local.height);
    const leftInset = (parseFloat(style?.borderLeftWidth || '0') + parseFloat(style?.paddingLeft || '0')) * scaleX;
    const rightInset = (parseFloat(style?.borderRightWidth || '0') + parseFloat(style?.paddingRight || '0')) * scaleX;
    const topInset = (parseFloat(style?.borderTopWidth || '0') + parseFloat(style?.paddingTop || '0')) * scaleY;
    const bottomInset = (parseFloat(style?.borderBottomWidth || '0') + parseFloat(style?.paddingBottom || '0')) * scaleY;
    const left = outer.left + leftInset;
    const top = outer.top + topInset;
    const width = Math.max(1, outer.width - leftInset - rightInset);
    const height = Math.max(1, outer.height - topInset - bottomInset);
    return { left, top, right: left + width, bottom: top + height, width, height };
  }

  function getCropDecorationSize(image) {
    const host = getCropContainer(image);
    const style = host?.ownerDocument?.defaultView?.getComputedStyle(host);
    const number = (property) => Math.max(0, parseFloat(style?.getPropertyValue(property) || '0') || 0);
    const left = number('padding-left') + number('border-left-width');
    const right = number('padding-right') + number('border-right-width');
    const top = number('padding-top') + number('border-top-width');
    const bottom = number('padding-bottom') + number('border-bottom-width');
    return { left, right, top, bottom, horizontal: left + right, vertical: top + bottom };
  }

  function transformAxisValue(percent, pixelAdjustment) {
    const percentage = `${percent.toFixed(6)}%`;
    if (Math.abs(pixelAdjustment) < 0.001) return percentage;
    const sign = pixelAdjustment < 0 ? '-' : '+';
    return `calc(${percentage} ${sign} ${Math.abs(pixelAdjustment).toFixed(3)}px)`;
  }

  function hasCropLayoutOffset(image) {
    const layout = getCropContainer(image) ? readCropLayout(image) : null;
    return Boolean(layout && (Math.abs(layout.offsetX) >= 0.0001 || Math.abs(layout.offsetY) >= 0.0001));
  }

  function setCropLayoutStyle(layout, property, value) {
    if (!layout.styles) layout.styles = {};
    layout.styles[property] = { value: String(value || ''), priority: value ? 'important' : '' };
    if (!layout.hostStyles) layout.hostStyles = {};
    layout.hostStyles[property] = { ...layout.styles[property] };
  }

  function cropOffsetMargin(layout, property, offsetPercent) {
    const styles = layout && (layout.hostStyles || layout.styles);
    const entry = styles && styles[property];
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

  function getImageLayoutBounds(image) {
    const host = getLayoutHost(image);
    const view = host && host.ownerDocument && host.ownerDocument.defaultView;
    let parent = host && host.parentElement;
    while (parent && view) {
      const style = view.getComputedStyle(parent);
      if (style.display !== 'inline' && style.display !== 'contents') break;
      parent = parent.parentElement;
    }
    if (!parent || !view) return null;
    const localRect = parent.getBoundingClientRect();
    const topRect = getTopRect(parent);
    if (localRect.width < 1 || localRect.height < 1 || topRect.width < 1) return null;
    const scaleX = topRect.width / localRect.width;
    const scaleY = topRect.height / localRect.height;
    const parentStyle = view.getComputedStyle(parent);
    const paddingLeft = parseFloat(parentStyle.paddingLeft || '0');
    const paddingRight = parseFloat(parentStyle.paddingRight || '0');
    const paddingTop = parseFloat(parentStyle.paddingTop || '0');
    const left = topRect.left + (parent.clientLeft + paddingLeft) * scaleX;
    const right = topRect.left + (parent.clientLeft + parent.clientWidth - paddingRight) * scaleX;
    let top = topRect.top + (parent.clientTop + paddingTop) * scaleY;
    const previous = host.previousElementSibling;
    if (previous) top = Math.max(top, getTopRect(previous).bottom);
    return right > left ? { left, right, top, width: right - left } : null;
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
    applyCropDecorationScale(host, layout, baseWidth);
    writeCropLayout(image, layout);
    const hostStyles = layout.hostStyles || layout.styles || {};
    const decoration = getCropDecorationSize(image);
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
    const transformX = imageGeometry.horizontalTransformPercent(frame, layout.alignment)
      + layout.offsetX / frame.width * 100;
    const transformY = (frame.y + layout.offsetY) / frame.height * 100;
    const flowOffset = baseWidth * (frame.y + layout.offsetY) / crop.baseAspect;
    const marginTop = hostStyles['margin-top'];
    const marginLeft = hostStyles['margin-left'];
    const marginRight = hostStyles['margin-right'];
    const verticalAlign = hostStyles['vertical-align'];
    const floatValue = hostStyles.float;
    const baseTransform = layout.styles?.transform?.value || '';
    const baseTransformOrigin = layout.styles?.['transform-origin']?.value || 'center center';
    const translation = Math.abs(transformX) < 0.0001 && Math.abs(transformY) < 0.0001
      ? ''
      : `translate3d(${transformAxisValue(transformX, -decoration.horizontal * transformX / 100)}, ${transformAxisValue(transformY, -decoration.vertical * transformY / 100)}, 0)`;
    setStyles(host, {
      width: `${(baseWidth * frame.width).toFixed(4)}%`,
      'max-width': '100%',
      display: layout.display || 'block',
      position: 'relative',
      overflow: 'hidden',
      'aspect-ratio': aspect.toFixed(6),
      'line-height': '0',
      'margin-left': marginLeft ? marginLeft.value : '',
      'margin-right': marginRight ? marginRight.value : '',
      'margin-top': marginTop ? marginTop.value : '',
      'margin-bottom': cropOffsetMargin(layout, 'margin-bottom', flowOffset),
      'vertical-align': verticalAlign ? verticalAlign.value : '',
      float: floatValue ? floatValue.value : '',
      transform: translation,
      'transform-origin': 'center center'
    });
    const view = host.ownerDocument.defaultView;
    const hostStyle = view ? view.getComputedStyle(host) : null;
    const paddingLeft = parseFloat(hostStyle?.paddingLeft || '0');
    const paddingRight = parseFloat(hostStyle?.paddingRight || '0');
    const paddingTop = parseFloat(hostStyle?.paddingTop || '0');
    const paddingBottom = parseFloat(hostStyle?.paddingBottom || '0');
    const horizontalPadding = paddingLeft + paddingRight;
    const verticalPadding = paddingTop + paddingBottom;
    const leftPercent = -media.x / media.width * 100;
    const topPercent = -media.y / media.height * 100;
    const leftPixels = paddingLeft + media.x / media.width * horizontalPadding;
    const topPixels = paddingTop + media.y / media.height * verticalPadding;
    setStyles(image, {
      position: 'absolute',
      left: `calc(${leftPercent.toFixed(5)}% + ${leftPixels.toFixed(3)}px)`,
      top: `calc(${topPercent.toFixed(5)}% + ${topPixels.toFixed(3)}px)`,
      width: `calc(${(100 / media.width).toFixed(5)}% - ${(horizontalPadding / media.width).toFixed(3)}px)`,
      height: `calc(${(100 / media.height).toFixed(5)}% - ${(verticalPadding / media.height).toFixed(3)}px)`,
      'max-width': 'none',
      display: 'block',
      'margin-left': '0',
      'margin-right': '0',
      'margin-top': '0',
      'margin-bottom': '0',
      border: '0',
      padding: '0',
      'background-color': 'transparent',
      'box-sizing': 'border-box',
      transform: baseTransform,
      'transform-origin': baseTransformOrigin
    });
    return crop;
  }

  function ensureCropContainer(image) {
    const existing = getCropContainer(image);
    if (existing) return { host: existing, created: false, circlePresentation: null };
    if (!image || !image.parentNode) return { host: null, created: false, circlePresentation: null };

    const circleDiameter = image.dataset.mpseCircleOn === '1'
      ? clamp(getDataNumber(image, 'mpseCircleDiameter', 160), 40, 520)
      : null;
    const circlePresentation = suspendImageCirclePresentation(image);
    const rect = image.getBoundingClientRect();
    const presentationRect = getTopRect(image);
    const sourceMetrics = readDecorationMetrics(image, 100);
    const horizontalDecoration = sourceMetrics.paddingLeft + sourceMetrics.paddingRight
      + sourceMetrics.borderLeftWidth + sourceMetrics.borderRightWidth;
    const verticalDecoration = sourceMetrics.paddingTop + sourceMetrics.paddingBottom
      + sourceMetrics.borderTopWidth + sourceMetrics.borderBottomWidth;
    const presentationSize = imagePresentation.scaleContentSize((image.offsetWidth || rect.width) - horizontalDecoration,
      (image.offsetHeight || rect.height) - verticalDecoration, image.style.getPropertyValue('scale'));
    const layoutWidth = presentationSize.width;
    const layoutHeight = presentationSize.height;
    const availableWidth = getAvailableImageWidth(image);
    const baseAspect = Math.max(0.05, layoutWidth / Math.max(1, layoutHeight));
    const baseWidth = clamp(layoutWidth / Math.max(1, availableWidth) * 100, 4, 100);
    const layout = captureCropLayout(image);
    imagePresentation.normalizeCropLayout(layout);
    layout.baseWidth = baseWidth;
    layout.baseHeightPx = layoutHeight;
    layout.decoration = { ...sourceMetrics, baseWidth };
    if (image.style.getPropertyValue('box-shadow')) captureBaseBoxShadow(image);
    const host = image.ownerDocument.createElement('span');
    host.setAttribute(CROP_ATTR, '1');
    host.dataset.mpseCropBaseWidth = baseWidth.toFixed(4);
    host.dataset.mpseCropLayout = JSON.stringify(layout);
    restoreInlineStyles(host, layout.hostStyles || layout.styles);
    host.style.removeProperty('height');
    image.parentNode.insertBefore(host, image);
    host.appendChild(image);
    transferInlineStyles(image, host, FRAME_STYLE_PROPS);
    applyCropDecorationScale(host, layout, baseWidth);
    writeCropLayout(image, layout);

    for (const prop of ['width', 'max-width', 'display', 'margin-left', 'margin-right', 'margin-top', 'margin-bottom', 'vertical-align', 'float', 'position', 'left', 'top', 'right', 'bottom', 'height', 'translate', 'scale', 'transform', 'transform-origin']) {
      image.style.removeProperty(prop);
    }
    writeCropState(image, {
      frame: { x: 0, y: 0, width: 1, height: 1 },
      media: { x: 0, y: 0, width: 1, height: 1 },
      baseAspect
    });
    layout.hostStyles.translate = { value: imagePresentation.positionCropHost(host, presentationRect, getTopRect), priority: 'important' };
    writeCropLayout(image, layout);
    clearFrameAppearance(image);
    renderCropAppearance(image);
    if (circlePresentation && circleDiameter !== null && image.dataset.mpseCircleOn === '1') {
      imageControls.applyCircleCropGeometry(image, circleDiameter, true);
      renderCropAppearance(image);
    }
    return { host, created: true, circlePresentation };
  }

  function unwrapCropContainer(image) {
    const host = getCropContainer(image);
    if (!host || !host.parentNode) return image;
    const parent = host.parentNode;
    const baseWidth = readCropBaseWidth(image);
    const layout = readCropLayout(image);
    const restoreOriginalFrame = Boolean(layout.frameStyles && !layout.frameChanged
      && Number.isFinite(layout.baseWidth) && Math.abs(baseWidth - layout.baseWidth) < 0.01);
    transferInlineStyles(host, image, FRAME_STYLE_PROPS);
    if (restoreOriginalFrame) restoreInlineStyles(image, layout.frameStyles);
    for (const prop of ['position', 'left', 'top', 'right', 'bottom', 'height', 'max-width', 'display', 'margin-left', 'margin-right', 'margin-top', 'margin-bottom', 'width', 'vertical-align', 'float', 'translate', 'scale']) {
      image.style.removeProperty(prop);
    }
    restoreInlineStyles(image, layout.styles);
    if (layout.frameStyles?.overflow) {
      restoreInlineStyles(image, { overflow: layout.frameStyles.overflow });
    }
    if (Number.isFinite(layout.baseWidth) && Math.abs(baseWidth - layout.baseWidth) >= 0.01) {
      setStyle(image, 'width', `${baseWidth.toFixed(4)}%`);
      const heightEntry = layout.styles && layout.styles.height;
      if (heightEntry && heightEntry.value && heightEntry.value !== 'auto' && Number.isFinite(layout.baseHeightPx)) {
        setStyle(image, 'height', `${(layout.baseHeightPx * baseWidth / layout.baseWidth).toFixed(3)}px`);
      }
    }
    parent.insertBefore(image, host);
    host.remove();
    rebuildFrameAppearance(image);
    renderAppearance(image);
    if (image.dataset.mpseShadowOn !== '1' && image.dataset.mpseGlowOn !== '1') {
      delete image.dataset.mpseBaseBoxShadow;
    }
    return image;
  }

  function resetCrop() {
    const image = state.image;
    if (!image || !getCropContainer(image)) return;
    const circleDiameter = image.dataset.mpseCircleOn === '1'
      ? readCircleDiameter(image)
      : null;
    if (circleDiameter !== null) clearEffect('circle', false);
    if (hasCropLayoutOffset(image)) {
      const crop = readCropState(image);
      writeCropState(image, {
        frame: { x: 0, y: 0, width: 1, height: 1 },
        media: { x: 0, y: 0, width: 1, height: 1 },
        baseAspect: crop.baseAspect
      });
    } else {
      state.image = unwrapCropContainer(image);
    }
    state.cropMode = false;
    state.cropTransientHost = false;
    state.cropTransientBase = false;
    state.cropTransientCirclePresentation = null;
    state.cropSessionRevision = 0;
    state.cropSessionGeometryChanged = false;
    const box = document.getElementById(BOX_ID);
    if (box) box.classList.remove('mpse-crop-mode');
    if (circleDiameter !== null) applyEffect('circle', { diameter: circleDiameter });
    else markChanged(state.image, 'crop-reset');
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

  function deferGeometryFinish(event, forceCancel = false, closeSelection = false) {
    const interaction = state.interaction;
    if (!interaction || (state.image && state.image.isConnected)) return false;
    if (rebaseInteractionAfterEditorWrite(interaction.identity || state.identity)) return false;
    const point = getTopClientPoint(event, interaction.pointMapping) || interaction.lastPoint;
    if (point) {
      interaction.lastPoint = point;
      interaction.lastEvent = {
        type: 'pointermove',
        pointerId: interaction.pointerId,
        clientX: point.x,
        clientY: point.y,
        mpseTopCoordinates: true,
        target: document
      };
    }
    interaction.pendingFinish = {
      forceCancel: Boolean(interaction.pendingFinish?.forceCancel || forceCancel
        || (event && (event.type === 'pointercancel' || event.type === 'lostpointercapture'))),
      closeSelection: Boolean(interaction.pendingFinish?.closeSelection || closeSelection)
    };
    if (!interaction.disconnectTimer) {
      interaction.disconnectTimer = window.setTimeout(() => {
        interaction.disconnectTimer = 0;
        if (state.interaction !== interaction || !interaction.pendingFinish) return;
        if (rebaseInteractionAfterEditorWrite(interaction.identity || state.identity)) return;
        finishGeometryGesture(undefined, true);
      }, 800);
    }
    return true;
  }

  function finishOrDeferGeometry(event, forceCancel = false) {
    if (deferGeometryFinish(event, forceCancel)) return true;
    return finishGeometryGesture(event, forceCancel);
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
      'transform', 'scale', 'transform-origin', 'clip-path', 'overflow'
    ]);
    interaction.imagePreviewStyles = captureInlineStyles(image, ['transform', 'translate']);
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

  function applyCropLayoutOffset(image, desiredRect) {
    const crop = readCropState(image);
    const host = getCropContainer(image);
    if (!crop || !host || !desiredRect) return;
    const actualRect = getTopRect(host);
    if (actualRect.width < 1 || actualRect.height < 1) return;
    const layout = readCropLayout(image);
    layout.offsetX = clamp(
      layout.offsetX + (desiredRect.left - actualRect.left) * crop.frame.width / actualRect.width,
      -4,
      4
    );
    layout.offsetY = clamp(
      layout.offsetY + (desiredRect.top - actualRect.top) * crop.frame.height / actualRect.height,
      -4,
      4
    );
    writeCropLayout(image, layout);
    writeCropState(image, crop);
  }

  function applyGeometryPreview(interaction, preview, image) {
    const target = getSelectionElement(image);
    if (preview.kind === 'resize') {
      const origin = interaction.resizeOrigin;
      const baseTransform = interaction.targetPreviewStyles?.transform?.value || '';
      setStyle(target, 'transform-origin', `${(origin.x * 100).toFixed(6)}% ${(origin.y * 100).toFixed(6)}%`);
      setStyle(target, 'scale', '');
      setStyle(target, 'transform', `${baseTransform} scale(${preview.scale})`.trim());
      updateGeometryOverlayRect(imageGeometry.resizePreviewRect(interaction.rect, preview.scale, origin));
      return;
    }

    if (preview.kind === 'pan') {
      const deltaX = preview.crop.media.x - interaction.startCrop.media.x;
      const deltaY = preview.crop.media.y - interaction.startCrop.media.y;
      const baseTransform = interaction.imagePreviewStyles?.transform?.value || '';
      setStyle(image, 'translate', '');
      setStyle(image, 'transform', `translate3d(${(-deltaX * 100).toFixed(6)}%, ${(-deltaY * 100).toFixed(6)}%, 0) ${baseTransform}`.trim());
      updateGeometryOverlayRect(interaction.rect);
      return;
    }

    const contentRect = imageGeometry.previewFrameRect(
      interaction.contentRect || interaction.rect,
      interaction.startCrop.frame,
      preview.crop.frame
    );
    const startContent = interaction.contentRect || interaction.rect;
    const rect = {
      left: contentRect.left - (startContent.left - interaction.rect.left),
      top: contentRect.top - (startContent.top - interaction.rect.top),
      right: contentRect.right + (interaction.rect.right - startContent.right),
      bottom: contentRect.bottom + (interaction.rect.bottom - startContent.bottom)
    };
    rect.width = rect.right - rect.left;
    rect.height = rect.bottom - rect.top;
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
    const requestedScale = horizontalRatio >= verticalRatio
      ? 1 + horizontalDelta / Math.max(1, interaction.rect.width)
      : 1 + verticalDelta / Math.max(1, interaction.rect.height);
    const minimumScale = 4 / Math.max(4, interaction.startWidthPercent);
    let maximumScale = 100 / Math.max(4, interaction.startWidthPercent);
    let boundedMinimumScale = minimumScale;
    if (Number.isFinite(interaction.circleDiameterPx) && interaction.circleDiameterPx > 0) {
      boundedMinimumScale = Math.max(boundedMinimumScale, 40 / interaction.circleDiameterPx);
      maximumScale = Math.min(maximumScale, 520 / interaction.circleDiameterPx);
    }
    const bounds = interaction.bounds;
    if (bounds) {
      const available = interaction.resizeOrigin.x < 0.5
        ? bounds.right - interaction.rect.left
        : interaction.rect.right - bounds.left;
      maximumScale = Math.min(maximumScale, Math.max(boundedMinimumScale, available / Math.max(1, interaction.rect.width)));
      if (interaction.resizeOrigin.y > 0.5) {
        const verticalAvailable = interaction.rect.bottom - bounds.top;
        maximumScale = Math.min(maximumScale, Math.max(boundedMinimumScale, verticalAvailable / Math.max(1, interaction.rect.height)));
      }
    }
    const scale = clamp(requestedScale, boundedMinimumScale, Math.max(boundedMinimumScale, maximumScale));
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

  function discardCapturedImageBase(image, created) {
    if (created && image && image.dataset) delete image.dataset.mpseImageBase;
  }

  function beginGeometryGesture(handle, event, captureTarget) {
    const image = state.image;
    if (!image || !image.isConnected) return;
    const createdImageBase = captureImageBase(image);
    state.identity = imageSignature(image);
    const pointMapping = createClientPointMapping(event.target && event.target.ownerDocument);
    const point = getTopClientPoint(event, pointMapping);
    if (!point) {
      discardCapturedImageBase(image, createdImageBase);
      return;
    }
    const isCorner = ['nw', 'ne', 'se', 'sw'].includes(handle);
    const cropResult = ensureCropContainer(image);
    if (!cropResult.host) {
      discardCapturedImageBase(image, createdImageBase);
      return;
    }
    const target = cropResult.host;
    const rect = getTopRect(target);
    const startCrop = readCropState(image);
    const contentRect = startCrop ? getCropContentRect(image) : rect;
    deferContentCommitForGesture();
    const interaction = {
      kind: isCorner ? 'resize' : 'crop',
      identity: state.identity,
      handle,
      pointerId: event.pointerId,
      pointerTarget: captureTarget || event.target,
      pointMapping,
      startX: point.x,
      startY: point.y,
      rect,
      startCrop,
      contentRect,
      startCropBaseWidth: startCrop ? readCropBaseWidth(image) : null,
      baseCanvasHeight: startCrop ? contentRect.height / Math.max(imageGeometry.MIN_FRACTION, startCrop.frame.height) : null,
      resizeOrigin: imageGeometry.cornerResizeOrigin(handle),
      startWidthPercent: readLayoutWidthPercent(image),
      availableWidth: getAvailableImageWidth(image),
      bounds: getImageLayoutBounds(image),
      createdCrop: cropResult.created,
      createdImageBase,
      sessionRevision: state.editRevision,
      circlePresentation: cropResult.circlePresentation,
      circleDiameterPx: image.dataset.mpseCircleOn === '1'
        ? Math.min(contentRect.width, contentRect.height)
        : null,
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
    const createdImageBase = captureImageBase(image);
    state.identity = imageSignature(image);
    const pointMapping = createClientPointMapping(event.target && event.target.ownerDocument);
    const point = getTopClientPoint(event, pointMapping);
    if (!point) {
      discardCapturedImageBase(image, createdImageBase);
      return;
    }
    const result = ensureCropContainer(image);
    if (!result.host) {
      discardCapturedImageBase(image, createdImageBase);
      return;
    }
    const rect = getTopRect(result.host);
    deferContentCommitForGesture();
    const interaction = {
      kind: 'pan',
      identity: state.identity,
      pointerId: event.pointerId,
      pointerTarget: image,
      pointMapping,
      startX: point.x,
      startY: point.y,
      rect,
      startCrop: readCropState(image),
      contentRect: getCropContentRect(image),
      createdCrop: result.created,
      createdImageBase,
      sessionRevision: state.editRevision,
      circlePresentation: result.circlePresentation,
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

  function getEdgeResizeConstraints(interaction) {
    const baseWidth = Math.max(0.01, interaction.startCropBaseWidth || 100);
    const minimumVisibleWidth = Math.max(4, 2400 / Math.max(1, interaction.availableWidth));
    const decoration = getCropDecorationSize(state.image);
    const maximumContentWidth = Math.max(24, interaction.availableWidth - decoration.horizontal) * 100
      / Math.max(1, interaction.availableWidth);
    return {
      minWidth: minimumVisibleWidth / baseWidth,
      maxWidth: maximumContentWidth / baseWidth,
      minHeight: 24 / Math.max(24, interaction.baseCanvasHeight || interaction.rect.height),
      maxHeight: 1,
      horizontalMediaRatioFactor: 1,
      verticalMediaRatioFactor: 1
    };
  }

  function updateGeometryGesture(event) {
    const interaction = state.interaction;
    const image = state.image;
    if (!interaction || !interactionOwnsEvent(interaction, event)) return;
    const point = event && event.mpseTopCoordinates
      ? { x: Number(event.clientX), y: Number(event.clientY) }
      : getTopClientPoint(event, interaction.pointMapping);
    if (!point) return;
    interaction.lastPoint = point;
    interaction.lastEvent = event;
    if (!image || !image.isConnected) return;
    let rect = interaction.rect;
    if (rect.width < 1 || rect.height < 1) return;
    if (!interaction.started) {
      const distance = Math.hypot(point.x - interaction.startX, point.y - interaction.startY);
      if (distance < GEOMETRY_DRAG_THRESHOLD) return;
      interaction.started = true;
      rect = interaction.rect;
    }
    const geometryRect = interaction.kind === 'resize' ? rect : (interaction.contentRect || rect);
    const dx = (point.x - interaction.startX) / geometryRect.width;
    const dy = (point.y - interaction.startY) / geometryRect.height;

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
      const constraints = interaction.edgeConstraints || (interaction.edgeConstraints = getEdgeResizeConstraints(interaction));
      let crop = imageGeometry.resizeFrameEdge(start, interaction.handle, ratio, constraints);
      if (image.dataset.mpseCircleOn === '1') {
        crop = imageGeometry.constrainFrameAspect(crop, interaction.handle, 1);
      }
      interaction.preview = { kind: 'crop', crop };
    }
    queueGeometryPreview(interaction);
  }

  function rollbackCropZoomSetup(pending) {
    if (!pending) return;
    let image = pending.image;
    if (pending.createdCrop && image?.isConnected && getCropContainer(image)) {
      const restored = unwrapCropContainer(image);
      resumeImageCirclePresentation(restored, pending.circlePresentation);
      if (state.image === image) state.image = restored;
      image = restored;
    }
    discardCapturedImageBase(image, pending.createdImageBase);
  }

  function cancelPendingCropZoom(image = null) {
    const pending = state.pendingZoom;
    if (!pending || (image && pending.image !== image)) return false;
    if (state.zoomFrame) window.cancelAnimationFrame(state.zoomFrame);
    state.zoomFrame = 0;
    state.pendingZoom = null;
    rollbackCropZoomSetup(pending);
    if (state.needsCommit) scheduleContentCommit('crop-zoom-cancel');
    return true;
  }

  function flushCropZoom() {
    state.zoomFrame = 0;
    const pending = state.pendingZoom;
    state.pendingZoom = null;
    if (!pending || pending.image !== state.image || !pending.image.isConnected) return;
    const image = pending.image;
    const host = getCropContainer(image);
    const crop = readCropState(image);
    if (!host || !crop) {
      rollbackCropZoomSetup(pending);
      return;
    }
    const rect = getCropContentRect(image);
    if (rect.width < 1 || rect.height < 1) {
      rollbackCropZoomSetup(pending);
      if (state.needsCommit) scheduleContentCommit('crop-zoom-invalid');
      return;
    }
    const point = pending.point;
    const pointX = clamp((point.x - rect.left) / rect.width, 0, 1);
    const pointY = clamp((point.y - rect.top) / rect.height, 0, 1);
    const scale = Math.exp(clamp(pending.deltaY, -240, 240) * 0.0015);
    const next = imageGeometry.zoomMedia(crop, scale, pointX, pointY);
    if (imageGeometry.modelsMatch(crop, next)) {
      rollbackCropZoomSetup(pending);
      if (state.needsCommit) scheduleContentCommit('crop-zoom-noop');
      schedulePositionTools();
      return;
    }
    writeCropState(image, next);
    if (pending.createdCrop) {
      state.cropTransientHost = true;
      state.cropTransientBase = pending.createdImageBase;
      state.cropTransientCirclePresentation = pending.circlePresentation;
      state.cropSessionRevision = pending.sessionRevision;
    }
    state.cropSessionGeometryChanged = true;
    markChanged(image, 'crop-zoom');
    schedulePositionTools();
  }

  function queueCropZoom(image, event) {
    const point = getTopClientPoint(event);
    if (!point) return;
    const createdImageBase = captureImageBase(image);
    const result = ensureCropContainer(image);
    if (!result.host) {
      discardCapturedImageBase(image, createdImageBase);
      return;
    }
    deferContentCommitForGesture();
    if (!state.pendingZoom || state.pendingZoom.image !== image) {
      state.pendingZoom = {
        image,
        point,
        deltaY: 0,
        createdCrop: result.created,
        createdImageBase,
        circlePresentation: result.circlePresentation,
        sessionRevision: state.editRevision
      };
    }
    state.pendingZoom.point = point;
    state.pendingZoom.deltaY += Number(event.deltaY) || 0;
    if (!state.zoomFrame) state.zoomFrame = window.requestAnimationFrame(flushCropZoom);
  }

  function restoreGeometryGesture(interaction, image) {
    clearGeometryPreview(interaction, image);
    if (!interaction || !image || !image.isConnected) return image;
    let restored = image;
    if (interaction.createdCrop && getCropContainer(image)) {
      restored = unwrapCropContainer(image);
      resumeImageCirclePresentation(restored, interaction.circlePresentation);
    }
    return restored;
  }

  function finishGeometryGesture(event, forceCancel = false) {
    const interaction = state.interaction;
    if (!interaction || !interactionOwnsEvent(interaction, event)) return false;
    state.lastImagePress = null;
    if (interaction.disconnectTimer) window.clearTimeout(interaction.disconnectTimer);
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
      if (interaction.createdImageBase && state.image) delete state.image.dataset.mpseImageBase;
      if (state.needsCommit) scheduleContentCommit('gesture-cancel');
      schedulePositionTools();
      return true;
    }
    const changed = hasGeometryChanged(interaction, preview);
    if (changed && image && image.isConnected) {
      if (interaction.kind === 'resize') {
        const desiredRect = imageGeometry.resizePreviewRect(interaction.rect, preview.scale, interaction.resizeOrigin);
        setLayoutWidthPercent(image, preview.widthPercent, interaction.availableWidth);
        applyCropLayoutOffset(image, desiredRect);
      } else {
        writeCropState(image, preview.crop);
      }
      updateGeometryOverlay(image);
    }
    if (changed && (state.cropMode || interaction.kind === 'crop')) {
      state.cropSessionGeometryChanged = true;
    }
    if (changed && state.cropMode && interaction.createdCrop) {
      state.cropTransientHost = true;
      state.cropTransientBase = interaction.createdImageBase;
      state.cropTransientCirclePresentation = interaction.circlePresentation;
      state.cropSessionRevision = interaction.sessionRevision ?? state.editRevision;
    }
    if (interaction.kind === 'crop' && changed && state.image) {
      if (!state.cropMode) {
        state.cropTransientBase = interaction.createdImageBase;
        state.cropTransientCirclePresentation = interaction.circlePresentation;
        state.cropSessionRevision = state.editRevision;
      }
      state.cropMode = true;
      state.cropTransientHost = interaction.createdCrop || state.cropTransientHost;
      createBox().classList.add('mpse-crop-mode');
      setBadgeText('裁切模式：拖动图片，Ctrl + 滚轮缩放');
    }
    if (!changed) {
      state.image = restoreGeometryGesture(interaction, image);
      image = state.image;
      if (interaction.createdImageBase && image) delete image.dataset.mpseImageBase;
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
    state.cropMode = true;
    state.cropTransientHost = false;
    state.cropTransientBase = false;
    state.cropTransientCirclePresentation = null;
    state.cropSessionRevision = state.editRevision;
    state.cropSessionGeometryChanged = false;
    createBox().classList.add('mpse-crop-mode');
    setBadgeText('裁切模式：拖动图片，Ctrl + 滚轮缩放');
    schedulePositionTools();
  }

  function exitCropMode() {
    const image = state.image;
    cancelPendingCropZoom(image);
    const untouchedSession = state.cropTransientBase && state.editRevision === state.cropSessionRevision;
    const shouldUnwrap = state.cropTransientHost && image
      && getCropContainer(image) && !state.cropSessionGeometryChanged && !hasCropLayoutOffset(image);
    const pendingSnapshot = image && state.pendingSnapshots.get(imageIdentityKey(imageSignature(image)));
    const refreshSnapshot = Boolean(shouldUnwrap && pendingSnapshot?.cropAction === 'ensure');
    if (shouldUnwrap) {
      state.image = unwrapCropContainer(image);
      resumeImageCirclePresentation(state.image, null);
      if (untouchedSession && state.image) delete state.image.dataset.mpseImageBase;
      if (refreshSnapshot) markChanged(state.image, 'crop-exit');
    } else if (untouchedSession && image) {
      delete image.dataset.mpseImageBase;
    }
    state.cropMode = false;
    state.cropTransientHost = false;
    state.cropTransientBase = false;
    state.cropTransientCirclePresentation = null;
    state.cropSessionRevision = 0;
    state.cropSessionGeometryChanged = false;
    const box = document.getElementById(BOX_ID);
    if (box) box.classList.remove('mpse-crop-mode');
    const badge = document.getElementById(BADGE_ID);
    if (badge && /裁切/.test(badge.textContent || '')) badge.textContent = '';
    schedulePositionTools();
  }

  const controlsFactory = window.__MPSE_IMAGE_CONTROLS__;
  if (!controlsFactory || typeof controlsFactory.create !== 'function') {
    throw new Error('图片参数控制模块未加载，请刷新页面后重试');
  }
  const imageControls = controlsFactory.create({
    MENU_ID,
    PANEL_ID,
    state,
    imageGeometry,
    frameStyleProps: FRAME_STYLE_PROPS,
    clamp,
    parsePx,
    parsePercent,
    getDataNumber,
    getDataString,
    clampInt,
    normalizeCssColorToHex,
    parseOpacityFromCssColor,
    escapeHtml,
    setStyle,
    setStyles,
    captureInlineStyles,
    restoreInlineStyles,
    getVisualCarrier,
    getCropContainer,
    getCropContentRect,
    getLayoutHost,
    getAppearanceHost,
    detectHorizontalAlignment,
    readCropLayout,
    writeCropLayout,
    getAvailableImageWidth,
    readCropState,
    hasCropAdjustment,
    readCropBaseWidth,
    setCropBaseWidth,
    writeCropState,
    setCropLayoutStyle,
    setLayoutWidthPercent,
    refreshCropDecoration,
    createPanel,
    isLikelyArticleImage,
    hideTools,
    positionTools,
    schedulePositionTools,
    markChanged
  });
  const {
    captureImageBase,
    restoreImageBase,
    renderAppearance,
    renderCropAppearance,
    rebuildFrameAppearance,
    clearFrameAppearance,
    captureBaseBoxShadow,
    captureFrameSourceStyles,
    readCircleDiameter,
    applyCircleCropGeometry,
    suspendImageCirclePresentation,
    resumeImageCirclePresentation,
    collectValues,
    showPanel,
    closePanel,
    setButtonStates,
    refreshVisiblePanel,
    onPanelInput,
    applyEffect,
    clearEffect,
    hasManagedEffect,
    getCaptionNode
  } = imageControls;

  function resetImage() {
    let image = state.image;
    if (!image || !image.isConnected) return;
    const hasExactBase = image.dataset.mpseImageBase !== undefined;
    if (!hasExactBase) {
      for (const effect of ['radius', 'spacing', 'shadow', 'glow', 'feather', 'stroke', 'opacity', 'color', 'rotate', 'frame', 'caption', 'circle']) {
        clearEffect(effect, false);
      }
    } else {
      const caption = getCaptionNode(image);
      if (caption) caption.remove();
    }
    image = unwrapCropContainer(image);
    if (!image || !image.isConnected) return;
    state.image = image;
    exitCropMode();
    if (hasExactBase) restoreImageBase(image);
    for (const key of MANAGED_DATA_KEYS) delete image.dataset[key];
    markChanged(image, 'reset');
    closePanel();
    setButtonStates();
    positionTools();
  }

  function snapshotCurrentImage(image = state.image, reason = '') {
    if (!image || !image.isConnected) return null;
    const identity = imageSignature(image);
    const key = imageIdentityKey(identity);
    const previous = state.pendingSnapshots.get(key);
    if (image === state.image) state.identity = identity;
    const cropHost = getCropContainer(image);
    return snapshotMerge.createSnapshot({
      identity,
      image,
      cropHost,
      carrier: cropHost ? null : getVisualCarrier(image),
      block: image.closest && image.closest('p,section,div,figure'),
      caption: getCaptionNode(image),
      previous,
      reason,
      managedDataKeys: MANAGED_DATA_KEYS,
      cropAttribute: CROP_ATTR
    });
  }

  function markChanged(image, reason, schedule = true) {
    if (!image || !image.ownerDocument) return;
    ensureImageEditId(image);
    image.setAttribute('data-mpse-image-edited', '1');
    const snapshot = snapshotCurrentImage(image, reason);
    if (!snapshot) return;
    snapshot.revision = ++state.editRevision;
    snapshot.gestureEpoch = state.gestureEpoch;
    state.lastSnapshot = snapshot;
    state.pendingSnapshots.set(imageIdentityKey(snapshot.identity), snapshot);
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
      if (state.selectionRevision !== selectionRevision || state.gestureEpoch !== gestureEpoch) return;
      if (state.isDragging) {
        scheduleSelectedImageReacquire(identity, { ...options, delay: 120 });
        return;
      }
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
    if (snapshot.captionAction === 'none') return;
    const targetAnchor = targetImage.closest('section,p,figure,div') || targetImage;
    const next = targetAnchor.nextElementSibling;
    if (next && next.getAttribute('data-mpse-image-caption') === '1') next.remove();
    if (!snapshot.captionHtml) return;
    const temp = root.ownerDocument.createElement('div');
    temp.innerHTML = snapshot.captionHtml;
    const caption = temp.firstElementChild;
    if (caption && targetAnchor.parentNode) targetAnchor.parentNode.insertBefore(caption, targetAnchor.nextSibling);
  }

  function applyCropSnapshot(target, snapshot) {
    const currentHost = getCropContainer(target);
    const result = snapshotMerge.reconcileCropHost(
      target,
      currentHost,
      snapshot.cropAction,
      () => target.ownerDocument.createElement('span')
    );
    const host = result.host;
    if (result.removed) snapshotMerge.applyStylePatch(result.target, snapshot.cropRemovalImgStylePatch);
    if (!host || snapshot.cropAction !== 'ensure') return result.target;
    if (result.created) {
      snapshotMerge.syncAttributes(host, snapshot.cropCreateHostData, (name) => name === CROP_ATTR || name.startsWith('data-mpse-'));
      snapshotMerge.applyStylePatch(result.target, snapshot.cropCreateImgStylePatch);
      snapshotMerge.applyStylePatch(host, snapshot.cropCreateHostStylePatch);
    }
    if (snapshot.hostDataAction === 'sync') {
      snapshotMerge.syncAttributes(host, snapshot.hostData, (name) => name === CROP_ATTR || name.startsWith('data-mpse-'));
    }
    snapshotMerge.applyStylePatch(host, snapshot.hostStylePatch);
    return result.target;
  }

  function applySnapshotToTarget(target, root, snapshot) {
    target = applyCropSnapshot(target, snapshot);
    snapshotMerge.applyStylePatch(target, snapshot.imgStylePatch);
    target.setAttribute('data-mpse-image-edited', '1');
    if (snapshot.identity.editId) target.setAttribute('data-mpse-image-id', snapshot.identity.editId);
    copyManagedData(snapshot, target);

    const carrier = getCropContainer(target) ? null : getVisualCarrier(target);
    if (carrier) snapshotMerge.applyStylePatch(carrier, snapshot.carrierStylePatch);

    const block = target.closest('p,section,div,figure');
    if (block) snapshotMerge.applyStylePatch(block, snapshot.blockStylePatch);
    replaceOrRemoveCaption(target, root, snapshot);
    return target;
  }

  function parseContentRoot(content) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(`<div id="mpse-root">${content || ''}</div>`, 'text/html');
    return doc.getElementById('mpse-root');
  }

  function applySnapshotToRoot(root, snapshot) {
    if (!snapshot || !snapshot.identity) return { changed: false, reason: 'no-snapshot' };
    if (!root) return { changed: false, reason: 'parse-failed' };

    let target = locateImageInHtml(root, snapshot.identity);
    if (!target) return { changed: false, reason: 'image-not-found' };

    applySnapshotToTarget(target, root, snapshot);
    return { changed: true, reason: 'ok' };
  }

  function restoreLatestSnapshotInEditor(snapshot) {
    if (!snapshot || !snapshot.identity) return null;
    const target = findImageByIdentity(snapshot.identity);
    const root = target && (findEditableRoot(target) || target.ownerDocument.body);
    return target && root ? applySnapshotToTarget(target, root, snapshot) : null;
  }

  function recoverDisconnectedInteraction() {
    if (!state.interaction || (state.image && state.image.isConnected)) return;
    if (!rebaseInteractionAfterEditorWrite(state.identity || state.lastSnapshot?.identity)) {
      finishGeometryGesture(undefined, true);
    }
  }

  function cropWasPersistedInRoot(root, identity) {
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

  function pendingSnapshotBatch() {
    return Array.from(state.pendingSnapshots.entries())
      .map(([key, snapshot]) => ({ key, snapshot }))
      .sort((first, second) => first.snapshot.revision - second.snapshot.revision);
  }

  function commitBatchIsCurrent(batch) {
    return Boolean(batch.length && !state.isDragging && !state.interaction
      && state.pendingSnapshots.size === batch.length
      && batch.every(({ key, snapshot }) => state.pendingSnapshots.get(key) === snapshot));
  }

  function applySnapshotBatch(content, batch) {
    const root = parseContentRoot(content);
    if (!root) return { html: content, changed: false, reason: 'parse-failed' };
    for (const { key, snapshot } of batch) {
      const result = applySnapshotToRoot(root, snapshot);
      if (!result.changed) return { ...result, html: content, failedKey: key, failedSnapshot: snapshot };
    }
    return { html: root.innerHTML, changed: true, reason: 'ok' };
  }

  function clearCommittedSnapshots(batch) {
    for (const { key, snapshot } of batch) {
      if (state.pendingSnapshots.get(key) === snapshot) state.pendingSnapshots.delete(key);
    }
    state.needsCommit = state.pendingSnapshots.size > 0;
  }

  function restorePendingSnapshotsInEditor() {
    let restored = null;
    for (const { snapshot } of pendingSnapshotBatch()) {
      restored = restoreLatestSnapshotInEditor(snapshot) || restored;
    }
    return restored;
  }

  async function commitSnapshotToEditor(reason) {
    if (state.isDragging) return;
    if (state.commitInFlight) {
      state.queuedCommit = true;
      return;
    }
    const batch = pendingSnapshotBatch();
    if (!state.needsCommit || !batch.length) return;
    const seq = ++state.commitSeq;
    state.commitInFlight = true;
    state.commitPhase = 'queued';
    state.pendingCommitReason = '';
    let failed = false;
    let allowRetry = true;
    setBadgeText('同步中…');

    try {
      const transaction = await mutateEditorContent((current) => {
        state.commitPhase = 'get';
        if (!commitBatchIsCurrent(batch)) return { changed: false, reason: 'stale-batch' };
        const content = typeof current.content === 'string' ? current.content : '';
        const mutation = applySnapshotBatch(content, batch);
        if (mutation.changed) state.commitPhase = 'set';
        return mutation;
      }, 15000);
      const current = transaction.read || {};
      const result = transaction.value || { changed: false, reason: 'empty-transaction' };
      if (result.reason === 'stale-batch') return;
      if (!result.changed) {
        const missingWasRemoved = result.reason === 'image-not-found'
          && result.failedKey
          && !findImageByIdentity(result.failedSnapshot?.identity);
        if (missingWasRemoved) {
          if (state.pendingSnapshots.get(result.failedKey) === result.failedSnapshot) {
            state.pendingSnapshots.delete(result.failedKey);
          }
          state.needsCommit = state.pendingSnapshots.size > 0;
          state.commitRetryCount = 0;
          allowRetry = state.needsCommit;
          setBadgeText(state.needsCommit ? '等待同步' : '已同步');
          return;
        }
        state.commitRetryCount += 1;
        allowRetry = state.commitRetryCount < 3;
        state.needsCommit = true;
        console.warn('[公众号源码排版助手] image html sync skipped:', result.reason);
        setBadgeText('仅预览');
        return;
      }
      const remainedCurrent = commitBatchIsCurrent(batch);
      const activeIdentity = state.identity;
      const interactionIdentity = state.interaction?.identity || activeIdentity;
      clearCommittedSnapshots(batch);
      state.commitRetryCount = 0;

      if (!remainedCurrent) {
        restorePendingSnapshotsInEditor();
        if (state.interaction && !rebaseInteractionAfterEditorWrite(interactionIdentity || batch[0].snapshot.identity)) {
          finishGeometryGesture(undefined, true);
        } else if (activeIdentity) {
          scheduleSelectedImageReacquire(activeIdentity, { delay: 0 });
        }
        return;
      }

      if (state.identity) scheduleSelectedImageReacquire(state.identity, { delay: 0, seq });

      let cropPersisted = true;
      const cropSnapshots = batch.filter(({ snapshot }) => snapshot.cropAction === 'ensure').map(({ snapshot }) => snapshot);
      if (cropSnapshots.length) {
        try {
          state.commitPhase = 'verify';
          const verification = await readEditorContent(15000);
          const verificationRoot = parseContentRoot(verification.content);
          cropPersisted = cropSnapshots.every((snapshot) => cropWasPersistedInRoot(verificationRoot, snapshot.identity));
        } catch (error) {
          console.warn('[公众号源码排版助手] image crop verification failed:', error);
        }
      }
      if (seq === state.commitSeq) {
        if (DEBUG) console.info('[公众号源码排版助手] image html synced', reason || '', current.mode || 'unknown');
        setBadgeText(cropPersisted ? '已同步' : '裁切未保留');
      }
    } catch (error) {
      failed = true;
      state.needsCommit = state.pendingSnapshots.size > 0;
      recoverDisconnectedInteraction();
      console.warn('[公众号源码排版助手] image html sync failed:', error);
      setBadgeText('同步失败');
    } finally {
      state.commitInFlight = false;
      state.commitPhase = '';
      if (state.queuedCommit || (!failed && allowRetry && state.needsCommit)) {
        state.queuedCommit = false;
        scheduleContentCommit('queued');
      }
    }
  }

  function findImageByIdentity(identity) {
    if (!identity) return null;
    let best = null;
    let bestScore = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    const list = getAllArticleImages().filter((image) => !identity.scopeKey || editorScopeKey(image) === identity.scopeKey);
    const shortlist = shortlistImagesByEditId(list, identity);
    if (shortlist.exact) return shortlist.exact;
    const preferredIndex = Number.isFinite(identity.index) ? identity.index : 0;
    for (const { image, index } of shortlist.indexed) {
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
    if (identityHasPrimaryKey(identity)) return best && bestScore >= 600 ? best : null;
    return exactIndexFallback(list, identity);
  }

  function reacquireSelectedImage(identity = state.identity) {
    const best = findImageByIdentity(identity);
    if (best) {
      state.image = best;
      state.identity = imageSignature(best);
      if (state.cropMode && state.cropTransientHost && !getCropContainer(best)) {
        if (!state.cropSessionGeometryChanged) {
          const result = ensureCropContainer(best);
          if (!result.host) {
            exitCropMode();
          } else {
            state.cropTransientHost = true;
            if (result.circlePresentation) state.cropTransientCirclePresentation = result.circlePresentation;
          }
        } else {
          exitCropMode();
        }
      }
      revealToolElements();
      setButtonStates();
      refreshVisiblePanel();
      schedulePositionTools();
    }
    return best;
  }

  function rebaseInteractionAfterEditorWrite(identity) {
    const interaction = state.interaction;
    if (!interaction) return false;
    const image = findImageByIdentity(identity);
    if (!image) return false;

    const previousPointerTarget = interaction.pointerTarget;
    if (interaction.kind === 'pan') {
      restoreInteractionCursor(interaction);
      releasePointer(previousPointerTarget, interaction.pointerId);
    }

    if (interaction.frame) window.cancelAnimationFrame(interaction.frame);
    clearGeometryPreview(interaction, state.image);
    interaction.frame = 0;
    interaction.preview = null;
    interaction.appliedPreview = null;
    interaction.edgeConstraints = null;
    interaction.started = false;
    interaction.createdCrop = false;
    state.image = image;
    state.identity = imageSignature(image);
    interaction.identity = state.identity;
    const createdImageBase = captureImageBase(image);
    interaction.createdImageBase = interaction.createdImageBase || createdImageBase;

    if (['pan', 'resize', 'crop'].includes(interaction.kind)) {
      const result = ensureCropContainer(image);
      if (!result.host) {
        discardCapturedImageBase(image, createdImageBase);
        return false;
      }
      interaction.createdCrop = interaction.createdCrop || result.created;
      interaction.circlePresentation = interaction.circlePresentation || result.circlePresentation;
    }
    if (interaction.kind === 'pan') {
      interaction.pointerTarget = image;
      interaction.pointMapping = createClientPointMapping(image.ownerDocument);
      capturePointer(image, interaction.pointerId);
      setInteractionCursor(interaction, 'grabbing');
    } else {
      interaction.pointMapping = createClientPointMapping(interaction.pointerTarget?.ownerDocument);
    }
    const target = getSelectionElement(image);
    interaction.rect = getTopRect(target);
    interaction.startCrop = readCropState(image);
    interaction.contentRect = interaction.startCrop ? getCropContentRect(image) : interaction.rect;
    interaction.resizeOrigin = imageGeometry.cornerResizeOrigin(interaction.handle);
    interaction.startWidthPercent = readLayoutWidthPercent(image);
    interaction.availableWidth = getAvailableImageWidth(image);
    interaction.bounds = getImageLayoutBounds(image);
    interaction.startCropBaseWidth = interaction.startCrop ? readCropBaseWidth(image) : null;
    interaction.baseCanvasHeight = interaction.startCrop
      ? interaction.contentRect.height / Math.max(imageGeometry.MIN_FRACTION, interaction.startCrop.frame.height)
      : null;
    captureGeometryPreviewStyles(interaction, image);
    if (interaction.lastPoint) {
      updateGeometryGesture({
        type: 'pointermove',
        pointerId: interaction.pointerId,
        clientX: interaction.lastPoint.x,
        clientY: interaction.lastPoint.y,
        mpseTopCoordinates: true,
        target: document
      });
    } else if (interaction.lastEvent) {
      updateGeometryGesture(interaction.lastEvent);
    }
    if (interaction.pendingFinish) {
      const pending = interaction.pendingFinish;
      interaction.pendingFinish = null;
      finishGeometryGesture({
        type: pending.forceCancel ? 'pointercancel' : 'pointerup',
        pointerId: interaction.pointerId,
        target: document
      }, pending.forceCancel);
      if (pending.closeSelection) {
        hideTools();
        return true;
      }
    }
    revealToolElements();
    return true;
  }

  function revealToolElements() {
    createMenu().classList.add('mpse-visible');
    createBox().classList.add('mpse-visible');
    createHandles();
    createBadge().classList.add('mpse-visible');
    setToolElementsOffscreen(false);
  }

  function showToolsForImage(image) {
    cancelScheduledReacquire();
    state.selectionRevision += 1;
    if (state.cropMode && state.image && state.image !== image) exitCropMode();
    state.image = image;
    state.identity = imageSignature(image);
    revealToolElements();
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

  function hideToolElements(preserveFocusedPanel = false) {
    for (const id of [MENU_ID, PANEL_ID, BOX_ID, BADGE_ID]) {
      const element = document.getElementById(id);
      if (element && !(preserveFocusedPanel && id === PANEL_ID && element.contains(document.activeElement))) {
        element.classList.remove('mpse-visible', 'mpse-offscreen');
      }
    }
    for (const handle of getImageHandles()) handle.classList.remove('mpse-visible', 'mpse-offscreen');
    hideDragShield();
  }

  function hideTools(force = false) {
    if (!force && state.interaction && deferGeometryFinish(undefined, true, true)) {
      setToolElementsOffscreen(true);
      return;
    }
    if (state.interaction) finishGeometryGesture(undefined, true);
    cancelPendingCropZoom();
    exitCropMode();
    state.image = null;
    state.identity = null;
    state.activePanel = null;
    state.isDragging = false;
    state.blockedByLayer = false;
    state.lastImagePress = null;
    cancelScheduledReacquire();
    state.selectionRevision += 1;
    hideToolElements();
    if (state.needsCommit) scheduleContentCommit('selection-close');
  }

  function positionTools() {
    if (!isEditorLikePage()) {
      if (state.image || state.interaction || state.isDragging) hideTools(true);
      else hideToolElements();
      return;
    }
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
      if (state.interaction) {
        if (rebaseInteractionAfterEditorWrite(state.interaction.identity || state.identity)) return;
        setToolElementsOffscreen(true);
        return;
      }
      hideToolElements(true);
      if (state.identity) scheduleSelectedImageReacquire(state.identity, { delay: 0 });
      return;
    }
    if (state.blockedByLayer) {
      state.blockedByLayer = true;
      if (state.interaction) finishOrDeferGeometry(undefined, true);
      else if (state.isDragging) endActiveDrag();
      setToolElementsOffscreen(true);
      return;
    }
    state.blockedByLayer = false;
    if (state.interaction) return;
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
    const menuHeight = Math.min(menu.offsetHeight || 330, Math.max(1, window.innerHeight - 16));

    positionSelectionBox(box, rect);
    box.classList.toggle('mpse-crop-mode', state.cropMode);
    positionHandles(rect);

    const menuWidth = 54;
    const panelWidth = 238;
    const gap = 20;
    let menuLeft = rect.right + gap;
    if (menuLeft + menuWidth > window.innerWidth - 8) menuLeft = rect.left - menuWidth - gap;
    menuLeft = Math.max(8, Math.min(menuLeft, window.innerWidth - menuWidth - 8));
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
      '[class*="dialog__mask"]',
      '[role="dialog"]'
    ].join(',');
    const viewport = getViewportRect();
    const selectionRect = state.image?.isConnected ? getTopRect(getSelectionElement(state.image)) : null;
    const docs = getAccessibleDocuments();
    const editorRects = [];
    for (const doc of docs) {
      for (const root of Array.from(doc.querySelectorAll('[contenteditable="true"], body[contenteditable="true"]')).slice(0, 8)) {
        const rect = getTopRect(root);
        if (rect.width > 120 && rect.height > 80 && rectsIntersect(viewport, rect)) editorRects.push(rect);
      }
    }
    if (selectionRect) editorRects.push(selectionRect);
    const globalSelector = [
      'dialog[open]',
      '[aria-modal="true"]',
      '.weui-mask',
      '.weui-desktop-mask',
      '.weui-desktop-dialog__wrp',
      '.weui-desktop-dialog_wrapper',
      '[class*="modal-mask"]',
      '[class*="dialog__mask"]'
    ].join(',');
    for (const doc of docs) {
      const view = doc.defaultView;
      if (!view) continue;
      for (const element of doc.querySelectorAll(selector)) {
        if (isExtensionElement(element)) continue;
        const style = view.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) <= 0.01) continue;
        if (element.getAttribute('aria-hidden') === 'true') continue;
        const rect = getTopRect(element);
        if (rect.width <= 120 || rect.height <= 80 || !rectsIntersect(viewport, rect)) continue;
        if (element.matches(globalSelector) || editorRects.some((editorRect) => rectsIntersect(editorRect, rect))) return true;
      }
    }
    return false;
  }

  function monitorBlockingEditorLayer() {
    if (!state.image) return;
    if (!isEditorLikePage()) {
      hideTools(true);
      return;
    }
    const blocked = hasBlockingEditorLayer();
    if (blocked) {
      state.blockedByLayer = true;
      if (state.interaction) finishOrDeferGeometry(undefined, true);
      else if (state.isDragging) endActiveDrag();
      setToolElementsOffscreen(true);
      return;
    }
    if (state.blockedByLayer) {
      state.blockedByLayer = false;
      schedulePositionTools();
    }
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
    finishOrDeferGeometry(event, true);
  }

  function onDocumentPointer(event) {
    if (!event || !event.target) return;
    if (event.type !== 'pointerdown' || event.button !== 0) return;
    if (!isEditorLikePage()) {
      hideTools(true);
      return;
    }
    if (isExtensionElement(event.target)) return;
    if (document.getElementById('mpse-inline-panel') || hasBlockingEditorLayer()) {
      hideTools();
      return;
    }

    const image = findImageFromEvent(event);
    if (image) {
      if (state.cropMode && image === state.image) {
        state.lastImagePress = null;
        event.preventDefault();
        event.stopPropagation();
        beginCropPan(image, event);
        return;
      }
      const repeatedPress = isRepeatedImagePress(image, event);
      if (repeatedPress) {
        state.lastImagePress = null;
        event.preventDefault();
        event.stopPropagation();
        toggleCropMode(image);
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
    if (!isEditorLikePage()) return;
    if (document.getElementById('mpse-inline-panel') || hasBlockingEditorLayer()) return;
    const image = findImageFromEvent(event);
    if (!image) return;
    event.preventDefault();
    event.stopPropagation();
    state.lastImagePress = null;
    toggleCropMode(image);
  }

  function onDocumentWheel(event) {
    if (!isEditorLikePage()) return;
    if (!state.cropMode || !event.ctrlKey || !event.target) return;
    const image = findImageFromEvent(event);
    if (!image || image !== state.image) return;
    event.preventDefault();
    event.stopPropagation();
    queueCropZoom(image, event);
  }

  function onDocumentPointerMove(event) {
    if (state.interaction) stopUiEvent(event);
    updateGeometryGesture(event);
  }

  function onDocumentPointerUp(event) {
    const disconnectedLoss = Boolean(event && event.type === 'lostpointercapture' && state.interaction
      && ((!state.image || !state.image.isConnected)
        || (event.target && event.target.isConnected === false)
        || (state.interaction.pointerTarget && state.interaction.pointerTarget.isConnected === false)));
    if (state.interaction) stopUiEvent(event);
    if (disconnectedLoss) {
      if (deferGeometryFinish(undefined, false)) return;
      finishGeometryGesture({ type: 'pointerup', pointerId: state.interaction?.pointerId, target: document });
      return;
    }
    if (state.interaction) finishOrDeferGeometry(event);
    else if (state.isDragging) endActiveDrag();
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
    if (event.key === 'Escape' && (state.cropMode || state.interaction)) {
      if (state.interaction) finishOrDeferGeometry(undefined, true);
      if (state.cropMode) exitCropMode();
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
      doc.addEventListener('scroll', onEditorViewportChange, true);
      if (doc.defaultView && doc.defaultView !== window) {
        doc.defaultView.addEventListener('scroll', onEditorViewportChange, true);
        doc.defaultView.addEventListener('resize', onEditorViewportChange);
      }
    }
  }

  function onGlobalPointerUp(event) {
    if (state.interaction) {
      stopUiEvent(event);
      finishOrDeferGeometry(event);
      return;
    }
    endActiveDrag();
  }

  function endActiveDrag() {
    if (!state.isDragging || state.interaction) return;
    state.isDragging = false;
    if (state.needsCommit) scheduleContentCommit('drag-end');
    if (state.identity && (!state.image || !state.image.isConnected)) {
      scheduleSelectedImageReacquire(state.identity, { delay: 0 });
    } else if (state.image) {
      schedulePositionTools();
    }
  }

  function onEditorViewportChange() {
    if (state.interaction) finishOrDeferGeometry(undefined, true);
    else if (state.image) schedulePositionTools();
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

    const observer = new MutationObserver((records) => {
      const interactionTarget = state.interaction && state.image ? getSelectionElement(state.image) : null;
      const relevant = records.some((record) => !isExtensionElement(record.target)
        && (!state.interaction || (record.target !== state.image && record.target !== interactionTarget)));
      if (!relevant) return;
      scheduleBindDocuments();
      if (state.image) {
        monitorBlockingEditorLayer();
        schedulePositionTools();
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'open', 'aria-modal', 'aria-hidden']
    });
    state.pageObserver = observer;

    window.setInterval(scheduleBindDocuments, 1500);
    window.setInterval(monitorBlockingEditorLayer, 500);
    window.addEventListener('pointermove', onGlobalPointerMove, true);
    window.addEventListener('pointerup', onGlobalPointerUp, true);
    window.addEventListener('pointercancel', onGlobalPointerUp, true);
    window.addEventListener('mouseup', onGlobalPointerUp, true);
    window.addEventListener('blur', () => {
      if (state.interaction) finishOrDeferGeometry(undefined, true);
      else endActiveDrag();
    }, true);
    window.addEventListener('resize', onEditorViewportChange);
    window.addEventListener('scroll', onEditorViewportChange, true);

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
