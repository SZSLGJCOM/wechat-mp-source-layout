(() => {
  'use strict';

  const VERSION = 'v0.12.0';
  const PANEL_ID = 'mpse-svgb-panel';
  const BOX_ID = 'mpse-svgb-box';
  const BADGE_ID = 'mpse-svgb-badge';
  const BOUND_FLAG = '__mpseSvgBlockToolsV094Bound__';
  const GENERIC_BOUND_ATTR = 'data-mpse-svg-block-tools-bound';
  const VERSION_ATTR = 'data-mpse-svg-block-tools-version';
  const MAX_IMAGES = 9;
  const bridgeClient = window.__MPSE_BRIDGE_CLIENT__;
  const mutateEditorContent = bridgeClient && typeof bridgeClient.mutateContent === 'function'
    ? bridgeClient.mutateContent
    : () => Promise.reject(new Error('扩展桥接客户端未加载，请刷新页面后重试'));

  const state = {
    block: null,
    signature: null,
    commitTimer: null,
    commitSeq: 0,
    lastDocCount: 0,
    busy: false
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

  function clamp(value, min, max, fallback = min) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(n, min), max);
  }

  function parsePx(value, fallback = 0) {
    const match = String(value || '').match(/(-?\d+(?:\.\d+)?)\s*px/i);
    return match ? Number(match[1]) : fallback;
  }

  function parsePercent(value, fallback = 100) {
    const match = String(value || '').match(/(-?\d+(?:\.\d+)?)\s*%/i);
    return match ? Number(match[1]) : fallback;
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

  function decodeJsonDataAttr(value, fallback = []) {
    const raw = String(value || '').trim();
    if (!raw) return fallback;
    try {
      return JSON.parse(decodeURIComponent(escape(atob(raw))));
    } catch (_) {
      try {
        return JSON.parse(decodeURIComponent(raw));
      } catch (__) {
        return fallback;
      }
    }
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

  function readFrameDocument(frame) {
    try {
      return frame.contentDocument || null;
    } catch (_) {
      return null;
    }
  }

  function getAccessibleDocuments() {
    const docs = [document];
    for (const frame of Array.from(document.querySelectorAll('iframe'))) {
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

  function isExtensionElement(node) {
    if (!node || !node.closest) return false;
    return Boolean(node.closest(`#${PANEL_ID}, #${BOX_ID}, #${BADGE_ID}, #mpse-svg2-panel, #mpse-svg2-pick-button, #mpse-img2-menu, #mpse-img2-panel, #mpse-img2-badge, #mpse-inline-panel, #mpse-toolbar-button, #mpse-floating-button, #mpse-mobile-preview, #mpse-mobile-preview-button`));
  }

  function isVisibleElement(element) {
    if (!element || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 24 || rect.height < 24) return false;
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    return true;
  }

  function isLikelyEditorBlock(block) {
    if (!block || !block.closest) return false;
    if (block.closest('[contenteditable="true"], body[contenteditable="true"], #js_editorArea, #js_content, .rich_media_content, .ProseMirror, .ql-editor, .edui-editor, .edui-editor-body')) return true;
    const frame = getFrameByDocument(block.ownerDocument);
    if (frame) {
      const text = `${frame.id || ''} ${frame.name || ''} ${frame.className || ''}`;
      if (/ueditor|editor/i.test(text)) return true;
      if (frame.closest && frame.closest('.edui-editor-iframeholder, .edui-editor-body, .edui-editor')) return true;
    }
    return false;
  }

  function looksGeneratedSvgBlock(block) {
    if (!block || !block.querySelector) return false;
    if (!isVisibleElement(block)) return false;
    if (!isLikelyEditorBlock(block)) return false;
    if (block.getAttribute('data-mpse-svg-block') === '1') return true;
    if (block.getAttribute('data-mpse-svg-multi') === '1') return true;
    if (block.getAttribute('data-mpse-svg-dual') === '1') return true;
    const svg = block.matches && block.matches('svg') ? block : block.querySelector('svg');
    if (!svg) return false;
    if (svg.getAttribute('data-mpse-generated') === '1') return true;
    if (/SVG 动效|图 SVG/.test(svg.getAttribute('aria-label') || '')) return true;
    return false;
  }

  function closestSvgBlock(target) {
    if (!target || !target.closest) return null;
    const marked = target.closest('[data-mpse-svg-block="1"], [data-mpse-svg-multi="1"], [data-mpse-svg-dual="1"]');
    const svg = target.closest('svg');
    if (!svg) return null;
    if (marked && marked.contains(svg) && looksGeneratedSvgBlock(marked)) return marked;
    const block = svg.closest('section,div,p,span,figure') || svg;
    if (looksGeneratedSvgBlock(block)) return block;
    return null;
  }

  function findSvgBlockFromEvent(event) {
    const target = event && event.target;
    if (!target || isExtensionElement(target)) return null;
    return closestSvgBlock(target);
  }

  function uniqueBlocks(blocks) {
    const result = [];
    for (const block of blocks) {
      if (block && !result.includes(block) && looksGeneratedSvgBlock(block)) result.push(block);
    }
    return result;
  }

  function getAllLiveSvgBlocks() {
    const blocks = [];
    for (const doc of getAccessibleDocuments()) {
      for (const block of Array.from(doc.querySelectorAll('[data-mpse-svg-block="1"], [data-mpse-svg-multi="1"], [data-mpse-svg-dual="1"]'))) blocks.push(block);
      for (const svg of Array.from(doc.querySelectorAll('svg[data-mpse-generated="1"], svg[aria-label*="SVG 动效"], svg[aria-label*="图 SVG"]'))) {
        blocks.push(svg.closest('section,div,p,span,figure') || svg);
      }
    }
    return uniqueBlocks(blocks);
  }

  function getSvgBlocksFromRoot(root) {
    const blocks = [];
    function add(block) {
      if (!block || blocks.includes(block)) return;
      const hasSvg = block.matches && block.matches('svg') ? true : Boolean(block.querySelector && block.querySelector('svg'));
      const marked = block.getAttribute && (block.getAttribute('data-mpse-svg-block') === '1' || block.getAttribute('data-mpse-svg-multi') === '1' || block.getAttribute('data-mpse-svg-dual') === '1');
      const generatedSvg = block.matches && block.matches('svg[data-mpse-generated="1"]');
      if (marked || generatedSvg || hasSvg) blocks.push(block);
    }
    for (const block of Array.from(root.querySelectorAll('[data-mpse-svg-block="1"], [data-mpse-svg-multi="1"], [data-mpse-svg-dual="1"]'))) add(block);
    for (const svg of Array.from(root.querySelectorAll('svg[data-mpse-generated="1"], svg[aria-label*="SVG 动效"], svg[aria-label*="图 SVG"]'))) {
      add(svg.closest('section,div,p,span,figure') || svg);
    }
    return blocks;
  }

  function getSvgUrls(block) {
    if (!block) return [];
    const fromUrls = decodeJsonDataAttr(block.getAttribute('data-mpse-svg-urls'), null);
    if (Array.isArray(fromUrls) && fromUrls.length) return Array.from(new Set(fromUrls.map(displayUrl).filter(Boolean))).slice(0, MAX_IMAGES);

    const srcs = block.getAttribute('data-mpse-srcs') || '';
    if (srcs) {
      let parsed = null;
      try {
        parsed = JSON.parse(decodeURIComponent(srcs));
      } catch (_) {
        parsed = null;
      }
      if (Array.isArray(parsed) && parsed.length) return Array.from(new Set(parsed.map(displayUrl).filter(Boolean))).slice(0, MAX_IMAGES);
    }

    const urls = [];
    for (const image of Array.from(block.querySelectorAll('image'))) {
      const raw = image.getAttribute('href') || image.getAttribute('xlink:href') || image.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
      const url = displayUrl(raw);
      if (url && !urls.includes(url)) urls.push(url);
    }
    return urls.slice(0, MAX_IMAGES);
  }

  function getSvgViewBox(block) {
    const svg = block && (block.matches && block.matches('svg') ? block : block.querySelector('svg'));
    const raw = svg ? (svg.getAttribute('viewBox') || '') : '';
    const parts = raw.trim().split(/\s+/).map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) return { width: parts[2], height: parts[3] };
    const rect = block && block.getBoundingClientRect ? block.getBoundingClientRect() : null;
    return { width: Math.max(320, Math.round(rect && rect.width ? rect.width : 900)), height: Math.max(160, Math.round(rect && rect.height ? rect.height : 506)) };
  }

  function getBlockSignature(block) {
    const all = getAllLiveSvgBlocks();
    const index = all.indexOf(block);
    const urls = getSvgUrls(block);
    return {
      id: block && block.getAttribute ? (block.getAttribute('data-mpse-svg-id') || '') : '',
      index: index >= 0 ? index : 0,
      count: Number(block && block.getAttribute ? block.getAttribute('data-mpse-svg-count') : '') || urls.length || 0,
      effect: block && block.getAttribute ? (block.getAttribute('data-mpse-svg-effect') || '') : '',
      urls
    };
  }

  function blockMatchesSignature(block, signature) {
    if (!block || !signature) return false;
    const id = block.getAttribute('data-mpse-svg-id') || '';
    if (signature.id && id === signature.id) return true;
    const urls = getSvgUrls(block).map(stableUrl);
    const sigUrls = (signature.urls || []).map(stableUrl);
    if (sigUrls.length && urls.length) {
      const samePrefix = sigUrls.every((url, index) => urls[index] === url);
      if (samePrefix) return true;
    }
    return false;
  }

  function locateBlockInHtml(root, signature) {
    const blocks = getSvgBlocksFromRoot(root);
    if (!blocks.length) return null;
    if (signature && signature.id) {
      const byId = blocks.find((block) => block.getAttribute('data-mpse-svg-id') === signature.id);
      if (byId) return byId;
    }
    const byUrls = blocks.find((block) => blockMatchesSignature(block, signature));
    if (byUrls) return byUrls;
    if (signature && Number.isInteger(signature.index) && blocks[signature.index]) return blocks[signature.index];
    return blocks[0] || null;
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

  function buildSvgMarkup(urlsInput, values, originals) {
    const urls = Array.from(new Set((urlsInput || []).map(displayUrl).filter(Boolean))).slice(0, MAX_IMAGES);
    if (urls.length < 2) throw new Error('SVG 动效至少需要两张图');
    const count = urls.length;
    const w = Math.round(clamp(values.viewBoxW || values.w, 320, 2000, 900));
    const h = Math.round(clamp(values.viewBoxH || values.h, 120, 2500, 506));
    const perImageDur = clamp(values.duration, 1, 12, 4);
    const totalDur = Math.max(1, perImageDur * count);
    const radius = clamp(values.radius, 0, 80, 0);
    const widthPercent = clamp(values.widthPercent, 10, 100, 100);
    let effect = values.effect || (count === 2 ? 'fade' : 'multi-fade');
    if (count > 2 && ['fade', 'wipe-x', 'slide-left', 'click-reveal'].includes(effect)) effect = 'multi-fade';
    const id = values.id || `mpseSvg${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

    const common = `x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice"`;
    const escapedUrls = urls.map((url) => escapeAttr(url));
    let body = '';

    if (count === 2 && effect === 'wipe-x') {
      body = `
        <defs>
          <clipPath id="${id}Clip"><rect x="0" y="0" width="0" height="${h}"><animate attributeName="width" values="0;${w};${w};0" dur="${perImageDur}s" repeatCount="indefinite"></animate></rect></clipPath>
        </defs>
        <image ${common} href="${escapedUrls[0]}" xlink:href="${escapedUrls[0]}"></image>
        <image ${common} href="${escapedUrls[1]}" xlink:href="${escapedUrls[1]}" clip-path="url(#${id}Clip)"></image>
      `;
    } else if (count === 2 && effect === 'slide-left') {
      body = `
        <image ${common} href="${escapedUrls[0]}" xlink:href="${escapedUrls[0]}"></image>
        <image x="${w}" y="0" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice" href="${escapedUrls[1]}" xlink:href="${escapedUrls[1]}"><animate attributeName="x" values="${w};0;0;${w}" dur="${perImageDur}s" repeatCount="indefinite"></animate></image>
      `;
    } else if (count === 2 && effect === 'click-reveal') {
      body = `
        <image ${common} href="${escapedUrls[0]}" xlink:href="${escapedUrls[0]}"></image>
        <image id="${id}B" ${common} href="${escapedUrls[1]}" xlink:href="${escapedUrls[1]}" opacity="0" style="pointer-events:all;"><animate attributeName="opacity" begin="click" values="0;1" dur="0.25s" fill="freeze"></animate></image>
        <text x="${Math.round(w / 2)}" y="${Math.round(h - 28)}" text-anchor="middle" font-size="28" fill="rgba(255,255,255,.9)">点击查看</text>
      `;
    } else if (effect === 'multi-slide') {
      const loopUrls = escapedUrls.concat(escapedUrls[0]);
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
      body = escapedUrls.map((url, index) => {
        const anim = buildStackOpacity(index, count);
        return `<image ${common} href="${url}" xlink:href="${url}" opacity="${index === 0 ? '1' : '0'}"><animate attributeName="opacity" values="${anim.values}" keyTimes="${anim.keyTimes}" dur="${totalDur}s" repeatCount="indefinite"></animate></image>`;
      }).join('\n        ');
    } else {
      const keyTimes = animationKeyTimes(count);
      body = escapedUrls.map((url, index) => `<image ${common} href="${url}" xlink:href="${url}" opacity="${index === 0 ? '1' : '0'}"><animate attributeName="opacity" values="${buildDiscreteOpacityValues(index, count)}" keyTimes="${keyTimes}" dur="${totalDur}s" repeatCount="indefinite"></animate></image>`).join('\n        ');
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

    const srcData = escapeAttr(encodeURIComponent(JSON.stringify(urls)));
    const urlsData = encodeJsonDataAttr(urls);
    const originalsData = Array.isArray(originals) && originals.length ? ` data-mpse-svg-originals="${encodeJsonDataAttr(originals)}"` : '';

    return `
<section data-mpse-svg-block="1" data-mpse-svg-multi="1" data-mpse-svg-id="${escapeAttr(id)}" data-mpse-svg-count="${count}" data-mpse-svg-effect="${escapeAttr(effect)}" data-mpse-svg-width="${widthPercent}" data-mpse-svg-duration="${perImageDur}" data-mpse-svg-radius="${radius}" data-mpse-srcs="${srcData}" data-mpse-svg-urls="${urlsData}"${originalsData} style="${sectionStyle}">
  <svg data-mpse-generated="1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${w} ${h}" style="${svgStyle}" role="img" aria-label="${count} 图 SVG 动效">
    ${body.trim()}
  </svg>
</section>`;
  }

  function currentValuesForBlock(block) {
    const urls = getSvgUrls(block);
    const viewBox = getSvgViewBox(block);
    const style = block.style || null;
    const count = Number(block.getAttribute('data-mpse-svg-count')) || urls.length || 2;
    return {
      id: block.getAttribute('data-mpse-svg-id') || '',
      urls,
      originals: decodeJsonDataAttr(block.getAttribute('data-mpse-svg-originals'), []),
      count,
      effect: block.getAttribute('data-mpse-svg-effect') || (count === 2 ? 'fade' : 'multi-fade'),
      widthPercent: clamp(block.getAttribute('data-mpse-svg-width') || (style ? parsePercent(style.getPropertyValue('width'), 100) : 100), 10, 100, 100),
      duration: clamp(block.getAttribute('data-mpse-svg-duration') || 4, 1, 12, 4),
      radius: clamp(block.getAttribute('data-mpse-svg-radius') || (style ? parsePx(style.getPropertyValue('border-radius'), 0) : 0), 0, 80, 0),
      viewBoxW: viewBox.width,
      viewBoxH: viewBox.height
    };
  }

  function range(label, name, min, max, step, value, suffix = '') {
    return `
      <label class="mpse-svgb-control">
        <span>${escapeHtml(label)} <em data-value-for="${escapeHtml(name)}" data-suffix="${escapeHtml(suffix)}">${escapeHtml(value)}${escapeHtml(suffix)}</em></span>
        <input type="range" name="${escapeHtml(name)}" min="${min}" max="${max}" step="${step}" value="${escapeHtml(value)}">
      </label>
    `;
  }

  function select(label, name, value, options) {
    return `
      <label class="mpse-svgb-control">
        <span>${escapeHtml(label)}</span>
        <select name="${escapeHtml(name)}">
          ${options.map((item) => `<option value="${escapeHtml(item.value)}"${item.value === value ? ' selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}
        </select>
      </label>
    `;
  }

  function previewHtml(urls) {
    return (urls || []).slice(0, MAX_IMAGES).map((url, index) => `
      <div><span>${index + 1}</span><img src="${escapeAttr(displayUrl(url))}" alt=""></div>
    `).join('');
  }

  function collectPanelValues(panel) {
    const values = {};
    for (const input of Array.from(panel.querySelectorAll('input, select'))) {
      if (!input.name) continue;
      if (input.type === 'range') values[input.name] = Number(input.value);
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

  function setStatus(text, type = '') {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const status = panel.querySelector('.mpse-svgb-status');
    if (!status) return;
    status.textContent = text || '';
    status.classList.remove('mpse-ok', 'mpse-error');
    if (type === 'ok') status.classList.add('mpse-ok');
    if (type === 'error') status.classList.add('mpse-error');
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
    badge.textContent = 'SVG 动效';
    document.body.appendChild(badge);
    return badge;
  }

  function cleanupLegacyDom() {
    for (const id of [PANEL_ID, BOX_ID, BADGE_ID]) {
      const element = document.getElementById(id);
      if (element) element.remove();
    }
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
      if (target.closest('[data-svgb-close]')) {
        event.preventDefault();
        event.stopPropagation();
        hideTools();
        return;
      }
      if (target.closest('[data-svgb-restore]')) {
        event.preventDefault();
        event.stopPropagation();
        restoreActiveBlock();
        return;
      }
      if (target.closest('[data-svgb-delete]')) {
        event.preventDefault();
        event.stopPropagation();
        deleteActiveBlock();
        return;
      }
      if (target.closest('[data-svgb-update]')) {
        event.preventDefault();
        event.stopPropagation();
        applyActiveUpdate();
      }
    }, true);
    panel.addEventListener('input', () => {
      updatePanelValueLabels(panel);
      scheduleActiveUpdate();
    }, true);
    panel.addEventListener('change', () => {
      updatePanelValueLabels(panel);
      scheduleActiveUpdate();
    }, true);
    document.body.appendChild(panel);
    return panel;
  }

  function showBlockPanel(block) {
    if (!block || !block.isConnected) return;
    state.block = block;
    state.signature = getBlockSignature(block);
    const values = currentValuesForBlock(block);
    const count = Math.max(2, values.urls.length || values.count || 2);
    const panel = createPanel();
    panel.innerHTML = `
      <div class="mpse-svgb-head">
        <strong>SVG 动效</strong>
        <button type="button" data-svgb-close title="收起">×</button>
      </div>
      <div class="mpse-svgb-preview">
        ${previewHtml(values.urls)}
      </div>
      <div class="mpse-svgb-body">
        ${select('动效', 'effect', values.effect, effectOptionsForCount(count))}
        ${range('宽度', 'widthPercent', 10, 100, 1, values.widthPercent, '%')}
        ${range(count > 2 ? '单图停留' : '时长', 'duration', 1, 12, 0.5, values.duration, 's')}
        ${range('圆角', 'radius', 0, 80, 1, values.radius, 'px')}
      </div>
      <div class="mpse-svgb-actions">
        <button type="button" data-svgb-restore>复原静态图</button>
        <button type="button" data-svgb-update>更新 SVG</button>
        <button type="button" data-svgb-delete>删除</button>
      </div>
      <div class="mpse-svgb-status">已选中，可继续调参或复原。</div>
      <div class="mpse-svgb-tip">本工具生成的 SVG 会保存原图 HTML；缺少原图记录时会按图片地址复原为静态图。</div>
    `;
    panel.classList.add('mpse-visible');
    updatePanelValueLabels(panel);
    positionTools();
  }

  function hideTools() {
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.classList.remove('mpse-visible');
    for (const id of [BOX_ID, BADGE_ID]) {
      const element = document.getElementById(id);
      if (element) element.classList.remove('mpse-visible');
    }
    state.block = null;
    state.signature = null;
  }

  function positionTools() {
    const block = state.block;
    if (!block || !block.isConnected) return;
    const rect = getTopRect(block);
    const box = createBox();
    const badge = createBadge();
    box.style.left = `${rect.left}px`;
    box.style.top = `${rect.top}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
    box.classList.add('mpse-visible');

    badge.style.left = `${rect.left + 8}px`;
    badge.style.top = `${Math.max(8, rect.top + 8)}px`;
    badge.classList.add('mpse-visible');

    const panel = document.getElementById(PANEL_ID);
    if (!panel || !panel.classList.contains('mpse-visible')) return;
    const width = 280;
    let left = rect.right + 56;
    if (left + width > window.innerWidth - 8) left = rect.left - width - 56;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    const top = Math.max(8, Math.min(rect.top + 4, window.innerHeight - 460));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  function parseHtml(content) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(`<div id="mpse-root">${content || ''}</div>`, 'text/html');
    return { doc, root: doc.getElementById('mpse-root') };
  }

  function buildStaticImagesFromUrls(urls) {
    return (urls || []).map((url) => `
<p style="margin: 0 0 12px; line-height: 0;"><img src="${escapeAttr(displayUrl(url))}" style="display: block; width: 100%; max-width: 100%; height: auto;" /></p>`).join('');
  }

  async function mutateActiveBlock(mutator, statusText) {
    if (state.busy) return;
    state.busy = true;
    setStatus('同步中…');
    try {
      await mutateEditorContent((current) => {
        const content = typeof current.content === 'string' ? current.content : '';
        const parsed = parseHtml(content);
        const root = parsed.root;
        if (!root) throw new Error('无法解析正文 HTML');
        const target = locateBlockInHtml(root, state.signature || getBlockSignature(state.block));
        if (!target) throw new Error('没有在正文源码里定位到这个 SVG 块');
        const result = mutator(target, parsed.doc, root);
        if (!result || !result.changed) throw new Error((result && result.reason) || '没有改动');
        return root.innerHTML;
      }, 15000);
      setStatus(statusText || '已同步', 'ok');
      return true;
    } catch (error) {
      console.warn('[公众号源码排版助手] svg block mutation failed:', error);
      setStatus(`同步失败：${error.message || error}`, 'error');
      return false;
    } finally {
      state.busy = false;
    }
  }

  function scheduleActiveUpdate() {
    window.clearTimeout(state.commitTimer);
    state.commitTimer = window.setTimeout(() => applyActiveUpdate(), 420);
  }

  async function applyActiveUpdate() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel || !panel.classList.contains('mpse-visible') || !state.block) return;
    const seq = ++state.commitSeq;
    const formValues = collectPanelValues(panel);
    const liveValues = currentValuesForBlock(state.block);
    const values = { ...liveValues, ...formValues };

    const ok = await mutateActiveBlock((target) => {
      const currentValues = currentValuesForBlock(target);
      const urls = currentValues.urls.length ? currentValues.urls : values.urls;
      const originals = currentValues.originals.length ? currentValues.originals : values.originals;
      const nextHtml = buildSvgMarkup(urls, { ...currentValues, ...values, id: currentValues.id || values.id }, originals);
      const holder = target.ownerDocument.createElement('div');
      holder.innerHTML = nextHtml.trim();
      const nextBlock = holder.firstElementChild;
      if (!nextBlock) return { changed: false, reason: 'svg-build-failed' };
      target.insertAdjacentElement('beforebegin', nextBlock);
      target.remove();
      state.signature = {
        id: nextBlock.getAttribute('data-mpse-svg-id') || '',
        index: state.signature ? state.signature.index : 0,
        count: Number(nextBlock.getAttribute('data-mpse-svg-count')) || urls.length,
        effect: nextBlock.getAttribute('data-mpse-svg-effect') || '',
        urls
      };
      return { changed: true };
    }, '已同步');

    if (ok && seq === state.commitSeq) {
      window.setTimeout(reacquireActiveBlock, 220);
    }
  }

  async function restoreActiveBlock() {
    const ok = await mutateActiveBlock((target) => {
      const originals = decodeJsonDataAttr(target.getAttribute('data-mpse-svg-originals'), []);
      const urls = getSvgUrls(target);
      const html = Array.isArray(originals) && originals.length ? originals.join('\n') : buildStaticImagesFromUrls(urls);
      if (!html) return { changed: false, reason: 'no-originals-or-urls' };
      const holder = target.ownerDocument.createElement('div');
      holder.innerHTML = html;
      const nodes = Array.from(holder.childNodes);
      for (const node of nodes) target.parentNode.insertBefore(node, target);
      target.remove();
      return { changed: true };
    }, '已复原为静态图');
    if (ok) hideTools();
  }

  async function deleteActiveBlock() {
    const ok = await mutateActiveBlock((target) => {
      target.remove();
      return { changed: true };
    }, '已删除');
    if (ok) hideTools();
  }

  function reacquireActiveBlock() {
    if (!state.signature) return;
    const blocks = getAllLiveSvgBlocks();
    const found = blocks.find((block) => blockMatchesSignature(block, state.signature)) || blocks[state.signature.index];
    if (found) {
      state.block = found;
      positionTools();
    }
  }

  function onDocumentPointer(event) {
    if (!event || !event.target) return;
    if (event.type === 'pointerdown' && event.button !== 0) return;
    if (isExtensionElement(event.target)) return;
    if (document.getElementById('mpse-inline-panel')) return;
    const block = findSvgBlockFromEvent(event);
    if (!block) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.type !== 'pointerdown') return;
    showBlockPanel(block);
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
        if (state.block) window.requestAnimationFrame(positionTools);
      }, true);
    }
  }

  let bindTimer = 0;

  function scheduleBindDocuments() {
    if (bindTimer) return;
    bindTimer = window.setTimeout(() => {
      bindTimer = 0;
      bindDocuments();
      if (state.block) window.requestAnimationFrame(() => {
        if (!state.block || !state.block.isConnected) reacquireActiveBlock();
        positionTools();
      });
    }, 180);
  }

  function boot() {
    if (!isMpHost()) return;
    const root = document.documentElement;
    if (root.getAttribute(VERSION_ATTR) === VERSION) return;
    root.setAttribute(VERSION_ATTR, VERSION);

    cleanupLegacyDom();
    createPanel();
    createBox();
    createBadge();
    bindDocuments();
    window.setInterval(scheduleBindDocuments, 900);
    const observer = new MutationObserver(scheduleBindDocuments);
    observer.observe(document.documentElement, { childList: true, subtree: true });

    window.addEventListener('resize', () => {
      if (state.block) window.requestAnimationFrame(positionTools);
    });
    window.addEventListener('scroll', () => {
      if (state.block) window.requestAnimationFrame(positionTools);
    }, true);

    console.info(`[公众号源码排版助手] svg block tools ${VERSION} loaded`);
  }

  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
      boot();
    }
  } catch (error) {
    console.warn(`[公众号源码排版助手] svg block tools ${VERSION} failed:`, error);
  }
})();
