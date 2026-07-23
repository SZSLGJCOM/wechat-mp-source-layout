(() => {
  'use strict';

  const ROOT_ID = 'mpse-mobile-preview';
  const TOGGLE_BUTTON_ID = 'mpse-mobile-preview-button';
  const HTML_BUTTON_ID = 'mpse-toolbar-button';
  const PANEL_WIDTH = 250;
  const PREVIEW_MAX_HEIGHT = 570;
  const MIN_VIEWPORT_WIDTH = 1280;
  const VIEWPORT_MARGIN = 14;
  const RESERVED_RIGHT = 76;

  const state = {
    root: null,
    enabled: true,
    layoutAvailable: false,
    userPosition: null,
    drag: null,
    layoutFrame: 0,
    lastSurfaceRect: null
  };

  function readEnabledPreference() {
    try {
      return sessionStorage.getItem('mpse-mobile-preview-enabled') !== '0';
    } catch (_) {
      return true;
    }
  }

  function readSavedPosition() {
    try {
      const value = JSON.parse(sessionStorage.getItem('mpse-mobile-preview-position') || 'null');
      if (Number.isFinite(value?.left) && Number.isFinite(value?.top)) return value;
    } catch (_) {
      return null;
    }
    return null;
  }

  function saveEnabledPreference() {
    try {
      sessionStorage.setItem('mpse-mobile-preview-enabled', state.enabled ? '1' : '0');
    } catch (_) {
      // Session storage may be unavailable under restrictive browser policies.
    }
  }

  function savePosition() {
    if (!state.userPosition) return;
    try {
      sessionStorage.setItem('mpse-mobile-preview-position', JSON.stringify(state.userPosition));
    } catch (_) {
      // Session storage may be unavailable under restrictive browser policies.
    }
  }

  function syncToggleButton() {
    const button = document.getElementById(TOGGLE_BUTTON_ID);
    if (!button) return;
    button.classList.toggle('mpse-active', state.enabled);
    button.setAttribute('aria-pressed', state.enabled ? 'true' : 'false');
    button.title = state.enabled ? '关闭手机预览' : '打开手机预览';
  }

  function setPreviewEnabled(enabled) {
    state.enabled = Boolean(enabled);
    saveEnabledPreference();
    syncToggleButton();
    scheduleLayout();
  }

  function ensureToggleButton() {
    const htmlButton = document.getElementById(HTML_BUTTON_ID);
    if (!htmlButton?.parentElement) return;
    let button = document.getElementById(TOGGLE_BUTTON_ID);
    if (!button) {
      button = document.createElement('div');
      button.id = TOGGLE_BUTTON_ID;
      button.className = 'edui-box edui-button edui-default edui-for-mpse-mobile-preview';
      button.textContent = '手机预览';
      button.setAttribute('role', 'button');
      button.tabIndex = 0;
      button.addEventListener('click', () => setPreviewEnabled(!state.enabled));
      button.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        setPreviewEnabled(!state.enabled);
      });
    }
    if (htmlButton.nextElementSibling !== button) htmlButton.insertAdjacentElement('afterend', button);
    syncToggleButton();
  }

  function clampPosition(left, top) {
    const height = state.root.getBoundingClientRect().height
      || Math.min(PREVIEW_MAX_HEIGHT, Math.max(430, innerHeight - 180));
    const maxLeft = Math.max(VIEWPORT_MARGIN, innerWidth - PANEL_WIDTH - VIEWPORT_MARGIN);
    const maxTop = Math.max(VIEWPORT_MARGIN, innerHeight - height - VIEWPORT_MARGIN);
    return {
      left: Math.round(Math.min(Math.max(left, VIEWPORT_MARGIN), maxLeft)),
      top: Math.round(Math.min(Math.max(top, VIEWPORT_MARGIN), maxTop))
    };
  }

  function applyPosition(position) {
    const clamped = clampPosition(position.left, position.top);
    state.root.style.left = `${clamped.left}px`;
    state.root.style.top = `${clamped.top}px`;
    return clamped;
  }

  function findEditorSurfaceRect() {
    const selectors = [
      '.edui-editor', '.edui-editor-body', '.edui-editor-iframeholder',
      '#js_editorArea', '#ueditor_0', 'iframe[id*="ueditor"]', 'iframe[name*="ueditor"]',
      '#mpse-inline-panel'
    ];
    const candidates = [];
    for (const node of document.querySelectorAll(selectors.join(','))) {
      const rect = node.getBoundingClientRect();
      if (rect.width < 360 || rect.height < 120 || rect.right <= innerWidth * 0.42) continue;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      candidates.push({
        rect,
        score: rect.right + Math.min(rect.width, 1000) + Math.min(rect.height, 1000)
      });
    }
    candidates.sort((left, right) => right.score - left.score);
    if (candidates[0]) state.lastSurfaceRect = candidates[0].rect;
    return candidates[0]?.rect || state.lastSurfaceRect;
  }

  function applyVisibility() {
    const hidden = !state.enabled || !state.layoutAvailable;
    const becameVisible = state.root.hidden && !hidden;
    state.root.hidden = hidden;
    if (becameVisible) state.root.dispatchEvent(new CustomEvent('mpse-mobile-preview:show'));
  }

  function positionPreview() {
    state.layoutFrame = 0;
    ensureToggleButton();
    if (state.drag) return;
    const surface = findEditorSurfaceRect();
    state.layoutAvailable = Boolean(innerWidth >= MIN_VIEWPORT_WIDTH && surface);
    applyVisibility();
    if (!state.layoutAvailable || !state.enabled) return;
    if (state.userPosition) {
      state.userPosition = applyPosition(state.userPosition);
    } else {
      applyPosition({
        left: innerWidth - RESERVED_RIGHT - PANEL_WIDTH,
        top: Math.max(150, surface.top + 18)
      });
    }
  }

  function scheduleLayout() {
    if (state.layoutFrame) return;
    state.layoutFrame = requestAnimationFrame(positionPreview);
  }

  function bindDragGestures() {
    const device = state.root.querySelector('.mpse-preview-device');
    if (!device) return;
    device.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest?.('.mpse-preview-viewport')) return;
      const rect = state.root.getBoundingClientRect();
      state.drag = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top
      };
      device.setPointerCapture(event.pointerId);
      state.root.classList.add('mpse-preview-dragging');
      event.preventDefault();
    });
    device.addEventListener('pointermove', (event) => {
      if (!state.drag || state.drag.pointerId !== event.pointerId) return;
      state.userPosition = applyPosition({
        left: event.clientX - state.drag.offsetX,
        top: event.clientY - state.drag.offsetY
      });
    });
    const finishDrag = (event) => {
      if (!state.drag || state.drag.pointerId !== event.pointerId) return;
      state.drag = null;
      state.root.classList.remove('mpse-preview-dragging');
      savePosition();
    };
    device.addEventListener('pointerup', finishDrag);
    device.addEventListener('pointercancel', finishDrag);
  }

  function boot() {
    state.root = document.getElementById(ROOT_ID);
    if (!state.root) return;
    state.enabled = readEnabledPreference();
    state.userPosition = readSavedPosition();
    bindDragGestures();
    ensureToggleButton();
    scheduleLayout();
    window.addEventListener('resize', scheduleLayout, { passive: true });
    const observer = new MutationObserver(scheduleLayout);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.setInterval(scheduleLayout, 1400);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
