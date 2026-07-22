(() => {
  'use strict';

  function parseScaleComponent(value) {
    const token = String(value || '').trim();
    if (!token) return NaN;
    const number = Number.parseFloat(token);
    if (!Number.isFinite(number)) return NaN;
    return token.endsWith('%') ? number / 100 : number;
  }

  function parseInlineScale(value) {
    const raw = String(value || '').trim();
    if (!raw || raw === 'none') return { active: false, flatten: true, x: 1, y: 1 };
    const tokens = raw.split(/\s+/).filter(Boolean);
    const x = parseScaleComponent(tokens[0]);
    const y = tokens.length > 1 ? parseScaleComponent(tokens[1]) : x;
    const flatten = Number.isFinite(x) && Number.isFinite(y) && x > 0 && y > 0 && tokens.length <= 2;
    return {
      active: true,
      flatten,
      x: flatten ? Math.min(Math.max(x, 0.01), 100) : 1,
      y: flatten ? Math.min(Math.max(y, 0.01), 100) : 1
    };
  }

  function scaleContentSize(width, height, scaleValue) {
    const scale = parseInlineScale(scaleValue);
    return {
      width: Math.max(1, Number(width) || 1) * scale.x,
      height: Math.max(1, Number(height) || 1) * scale.y,
      scale
    };
  }

  function localTranslation(desiredRect, currentTopRect, currentLocalRect) {
    if (!desiredRect || !currentTopRect || !currentLocalRect) return { x: 0, y: 0 };
    const scaleX = Number(currentTopRect.width) / Math.max(1, Number(currentLocalRect.width) || 1);
    const scaleY = Number(currentTopRect.height) / Math.max(1, Number(currentLocalRect.height) || 1);
    return {
      x: (Number(desiredRect.left) - Number(currentTopRect.left)) / Math.max(0.0001, scaleX),
      y: (Number(desiredRect.top) - Number(currentTopRect.top)) / Math.max(0.0001, scaleY)
    };
  }

  function translationCss(translation) {
    const x = Math.abs(Number(translation?.x) || 0) < 0.001 ? 0 : Number(translation.x);
    const y = Math.abs(Number(translation?.y) || 0) < 0.001 ? 0 : Number(translation.y);
    return x || y ? `${x.toFixed(3)}px ${y.toFixed(3)}px` : '';
  }

  function normalizeCropLayout(layout) {
    const styles = layout?.styles || {};
    const hostStyles = layout?.hostStyles || {};
    const scaleEntry = styles.scale || { value: '', priority: '' };
    const scale = parseInlineScale(scaleEntry.value);
    const empty = { value: '', priority: '' };
    styles.scale = { ...empty };
    styles.translate = { ...empty };
    hostStyles.scale = scale.active && !scale.flatten ? { ...scaleEntry } : { ...empty };
    hostStyles.translate = { ...empty };
    layout.styles = styles;
    layout.hostStyles = hostStyles;
    return scale;
  }

  function positionCropHost(host, desiredRect, getTopRect) {
    if (!host || typeof getTopRect !== 'function') return '';
    host.style.removeProperty('translate');
    const currentTopRect = getTopRect(host);
    const currentLocalRect = host.getBoundingClientRect();
    const value = translationCss(localTranslation(desiredRect, currentTopRect, currentLocalRect));
    if (value) host.style.setProperty('translate', value, 'important');
    return value;
  }

  globalThis.__MPSE_IMAGE_PRESENTATION__ = Object.freeze({
    parseInlineScale,
    scaleContentSize,
    localTranslation,
    translationCss,
    normalizeCropLayout,
    positionCropHost
  });
})();
