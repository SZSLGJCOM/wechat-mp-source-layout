(() => {
  'use strict';

  const ADVANCED_EFFECTS = Object.freeze(['shadow', 'glow', 'feather', 'stroke', 'color']);
  const MAX_OUTPUT_EDGE = 4096;
  const MAX_OUTPUT_BYTES = 9 * 1024 * 1024;
  const MAX_RENDER_ATTEMPTS = 5;

  function clamp(value, min, max, fallback = min) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  }

  function dataNumber(image, name, fallback) {
    return clamp(image?.dataset?.[name], -100000, 100000, fallback);
  }

  function dataString(image, name, fallback) {
    const value = image?.dataset?.[name];
    return typeof value === 'string' && value ? value : fallback;
  }

  function recipeFromImage(image) {
    return {
      version: 1,
      color: image?.dataset?.mpseColorOn === '1' ? {
        brightness: clamp(dataNumber(image, 'mpseBrightness', 100), 40, 180),
        contrast: clamp(dataNumber(image, 'mpseContrast', 100), 40, 180),
        saturate: clamp(dataNumber(image, 'mpseSaturate', 100), 0, 240),
        gray: clamp(dataNumber(image, 'mpseGray', 0), 0, 100)
      } : null,
      stroke: image?.dataset?.mpseStrokeOn === '1' ? {
        width: clamp(dataNumber(image, 'mpseStrokeWidth', 0), 0, 20),
        opacity: clamp(dataNumber(image, 'mpseStrokeOpacity', 100), 0, 100),
        color: dataString(image, 'mpseStrokeColor', '#07c160')
      } : null,
      shadow: image?.dataset?.mpseShadowOn === '1' ? {
        x: clamp(dataNumber(image, 'mpseShadowX', 0), -80, 80),
        y: clamp(dataNumber(image, 'mpseShadowY', 8), -80, 80),
        blur: clamp(dataNumber(image, 'mpseShadowBlur', 24), 0, 120),
        spread: clamp(dataNumber(image, 'mpseShadowSpread', 0), -40, 40),
        opacity: clamp(dataNumber(image, 'mpseShadowOpacity', 16), 0, 100),
        color: dataString(image, 'mpseShadowColor', '#0f2337')
      } : null,
      glow: image?.dataset?.mpseGlowOn === '1' ? {
        blur: clamp(dataNumber(image, 'mpseGlowBlur', 22), 0, 120),
        spread: clamp(dataNumber(image, 'mpseGlowSpread', 0), 0, 40),
        opacity: clamp(dataNumber(image, 'mpseGlowOpacity', 55), 0, 100),
        color: dataString(image, 'mpseGlowColor', '#ffd447')
      } : null,
      feather: image?.dataset?.mpseFeatherOn === '1' ? {
        amount: clamp(dataNumber(image, 'mpseFeatherAmount', 0), 0, 45)
      } : null
    };
  }

  function hasEffects(recipe) {
    return Boolean(recipe && ADVANCED_EFFECTS.some((effect) => {
      const value = recipe[effect];
      if (!value) return false;
      if (effect === 'stroke') return value.width > 0 && value.opacity > 0;
      if (effect === 'feather') return value.amount > 0;
      if (effect === 'shadow' || effect === 'glow') return value.opacity > 0;
      return true;
    }));
  }

  function recipeKey(recipe) {
    return JSON.stringify(recipe || {});
  }

  function computePadding(recipe, scale = 1) {
    const density = Math.max(0.05, Number(scale) || 1);
    let left = 0;
    let right = 0;
    let top = 0;
    let bottom = 0;

    if (recipe?.stroke?.width > 0) {
      const extent = recipe.stroke.width * density;
      left = right = top = bottom = Math.max(left, extent);
    }
    if (recipe?.shadow?.opacity > 0) {
      const spread = Math.max(0, recipe.shadow.spread) * density;
      const blurExtent = recipe.shadow.blur * density * 1.6;
      const x = recipe.shadow.x * density;
      const y = recipe.shadow.y * density;
      const extent = spread + blurExtent;
      left = Math.max(left, extent - x);
      right = Math.max(right, extent + x);
      top = Math.max(top, extent - y);
      bottom = Math.max(bottom, extent + y);
    }
    if (recipe?.glow?.opacity > 0) {
      const extent = (recipe.glow.spread + recipe.glow.blur * 2.55) * density;
      left = Math.max(left, extent);
      right = Math.max(right, extent);
      top = Math.max(top, extent);
      bottom = Math.max(bottom, extent);
    }

    return {
      left: Math.ceil(left + 2),
      right: Math.ceil(right + 2),
      top: Math.ceil(top + 2),
      bottom: Math.ceil(bottom + 2)
    };
  }

  function format(value) {
    return Number(Number(value).toFixed(4));
  }

  function escapeXml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function hexColor(value, fallback) {
    const raw = String(value || '').trim();
    if (/^#[0-9a-f]{6}$/i.test(raw)) return raw;
    if (/^#[0-9a-f]{3}$/i.test(raw)) {
      return `#${raw.slice(1).split('').map((part) => part + part).join('')}`;
    }
    return fallback;
  }

  function appendColorPipeline(primitives, recipe) {
    let input = 'SourceGraphic';
    if (!recipe?.color) return input;
    const brightness = recipe.color.brightness / 100;
    const contrast = recipe.color.contrast / 100;
    const saturation = recipe.color.saturate / 100;
    const graySaturation = 1 - recipe.color.gray / 100;
    primitives.push(
      `<feComponentTransfer in="${input}" result="color-brightness">`
      + `<feFuncR type="linear" slope="${format(brightness)}"/>`
      + `<feFuncG type="linear" slope="${format(brightness)}"/>`
      + `<feFuncB type="linear" slope="${format(brightness)}"/>`
      + '<feFuncA type="identity"/></feComponentTransfer>'
    );
    input = 'color-brightness';
    primitives.push(
      `<feComponentTransfer in="${input}" result="color-contrast">`
      + `<feFuncR type="linear" slope="${format(contrast)}" intercept="${format(0.5 - contrast * 0.5)}"/>`
      + `<feFuncG type="linear" slope="${format(contrast)}" intercept="${format(0.5 - contrast * 0.5)}"/>`
      + `<feFuncB type="linear" slope="${format(contrast)}" intercept="${format(0.5 - contrast * 0.5)}"/>`
      + '<feFuncA type="identity"/></feComponentTransfer>'
    );
    input = 'color-contrast';
    primitives.push(`<feColorMatrix in="${input}" type="saturate" values="${format(saturation)}" result="color-saturate"/>`);
    input = 'color-saturate';
    if (graySaturation < 1) {
      primitives.push(`<feColorMatrix in="${input}" type="saturate" values="${format(graySaturation)}" result="color-gray"/>`);
      input = 'color-gray';
    }
    return input;
  }

  function appendAlphaLayer(primitives, layers, name, effect, scale, opacityFactor = 1, blurFactor = 1, spreadFactor = 1) {
    if (!effect || effect.opacity <= 0) return;
    let input = 'SourceAlpha';
    const spread = effect.spread * scale * spreadFactor;
    if (Math.abs(spread) >= 0.01) {
      primitives.push(`<feMorphology in="${input}" operator="${spread > 0 ? 'dilate' : 'erode'}" radius="${format(Math.abs(spread))}" result="${name}-spread"/>`);
      input = `${name}-spread`;
    }
    const blur = effect.blur * scale * blurFactor;
    if (blur >= 0.01) {
      primitives.push(`<feGaussianBlur in="${input}" stdDeviation="${format(blur / 2)}" result="${name}-blur"/>`);
      input = `${name}-blur`;
    }
    const x = (effect.x || 0) * scale;
    const y = (effect.y || 0) * scale;
    if (Math.abs(x) >= 0.01 || Math.abs(y) >= 0.01) {
      primitives.push(`<feOffset in="${input}" dx="${format(x)}" dy="${format(y)}" result="${name}-offset"/>`);
      input = `${name}-offset`;
    }
    primitives.push(`<feFlood flood-color="${escapeXml(hexColor(effect.color, '#000000'))}" flood-opacity="${format(effect.opacity / 100 * opacityFactor)}" result="${name}-color"/>`);
    primitives.push(`<feComposite in="${name}-color" in2="${input}" operator="in" result="${name}-layer"/>`);
    layers.push(`${name}-layer`);
  }

  function buildSvg(options) {
    const {
      dataUrl,
      recipe,
      contentWidth,
      contentHeight,
      scale,
      padding = computePadding(recipe, scale)
    } = options;
    const outputWidth = contentWidth + padding.left + padding.right;
    const outputHeight = contentHeight + padding.top + padding.bottom;
    const primitives = [];
    const layers = [];
    let content = appendColorPipeline(primitives, recipe);

    appendAlphaLayer(primitives, layers, 'shadow', recipe?.shadow, scale);
    if (recipe?.glow) {
      appendAlphaLayer(primitives, layers, 'glow-near', { ...recipe.glow, x: 0, y: 0 }, scale);
      appendAlphaLayer(primitives, layers, 'glow-far', { ...recipe.glow, x: 0, y: 0 }, scale, 0.42, 1.65, 0.5);
    }
    if (recipe?.stroke?.width > 0 && recipe.stroke.opacity > 0) {
      const width = recipe.stroke.width * scale;
      primitives.push(`<feMorphology in="SourceAlpha" operator="dilate" radius="${format(width)}" result="stroke-dilate"/>`);
      primitives.push('<feComposite in="stroke-dilate" in2="SourceAlpha" operator="out" result="stroke-ring"/>');
      primitives.push(`<feFlood flood-color="${escapeXml(hexColor(recipe.stroke.color, '#07c160'))}" flood-opacity="${format(recipe.stroke.opacity / 100)}" result="stroke-color"/>`);
      primitives.push('<feComposite in="stroke-color" in2="stroke-ring" operator="in" result="stroke-layer"/>');
      layers.push('stroke-layer');
    }
    if (recipe?.feather?.amount > 0) {
      primitives.push(`<feGaussianBlur in="SourceAlpha" stdDeviation="${format(recipe.feather.amount * scale / 2)}" result="feather-alpha"/>`);
      primitives.push(`<feComposite in="${content}" in2="feather-alpha" operator="in" result="feather-content"/>`);
      content = 'feather-content';
    }
    layers.push(content);

    const merge = layers.map((layer) => `<feMergeNode in="${layer}"/>`).join('');
    primitives.push(`<feMerge result="baked-result">${merge}</feMerge>`);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${outputWidth}" height="${outputHeight}" viewBox="0 0 ${outputWidth} ${outputHeight}">`
      + `<defs><filter id="mpse-bake" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" x="0" y="0" width="${outputWidth}" height="${outputHeight}" color-interpolation-filters="sRGB">${primitives.join('')}</filter></defs>`
      + `<image x="${padding.left}" y="${padding.top}" width="${contentWidth}" height="${contentHeight}" preserveAspectRatio="none" href="${escapeXml(dataUrl)}" filter="url(#mpse-bake)"/>`
      + '</svg>';
  }

  async function bitmapFromBlob(blob) {
    if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('无法解码原始图片'));
      };
      image.src = url;
    });
  }

  function canvasFor(width, height) {
    if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  async function canvasBlob(canvas) {
    if (typeof canvas.convertToBlob === 'function') {
      return canvas.convertToBlob({ type: 'image/png' });
    }
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('无法导出烘焙图片'));
      }, 'image/png');
    });
  }

  async function rasterize(svg, width, height) {
    const bitmap = await bitmapFromBlob(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    try {
      const canvas = canvasFor(width, height);
      const context = canvas.getContext('2d', { alpha: true, colorSpace: 'srgb' });
      if (!context) throw new Error('当前浏览器不支持图片像素渲染');
      context.clearRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);
      return canvasBlob(canvas);
    } finally {
      if (typeof bitmap.close === 'function') bitmap.close();
    }
  }

  function sourceDimensions(bitmap) {
    return {
      width: Number(bitmap.width || bitmap.naturalWidth) || 0,
      height: Number(bitmap.height || bitmap.naturalHeight) || 0
    };
  }

  async function bake(options) {
    const dataUrl = String(options?.dataUrl || '');
    const recipe = options?.recipe;
    if (!dataUrl.startsWith('data:image/') || !hasEffects(recipe)) {
      throw new Error('没有可烘焙的图片或高级效果');
    }
    const sourceBlob = await fetch(dataUrl).then((response) => response.blob());
    const sourceBitmap = await bitmapFromBlob(sourceBlob);
    const source = sourceDimensions(sourceBitmap);
    if (typeof sourceBitmap.close === 'function') sourceBitmap.close();
    if (!source.width || !source.height) throw new Error('无法读取原图尺寸');

    const displayWidth = Math.max(1, Number(options.displayWidth) || Math.min(source.width, 800));
    let contentWidth = Math.min(source.width, Math.round(displayWidth * 3));
    let contentHeight = Math.max(1, Math.round(contentWidth * source.height / source.width));
    const initialEdgeScale = Math.min(1, MAX_OUTPUT_EDGE / Math.max(contentWidth, contentHeight));
    contentWidth = Math.max(1, Math.round(contentWidth * initialEdgeScale));
    contentHeight = Math.max(1, Math.round(contentHeight * initialEdgeScale));
    const maxBytes = Math.max(1024, Number(options.maxBytes) || MAX_OUTPUT_BYTES);

    let result = null;
    for (let attempt = 0; attempt < MAX_RENDER_ATTEMPTS; attempt += 1) {
      const scale = contentWidth / displayWidth;
      const padding = options.preserveBounds
        ? { left: 0, right: 0, top: 0, bottom: 0 }
        : computePadding(recipe, scale);
      const outputWidth = contentWidth + padding.left + padding.right;
      const outputHeight = contentHeight + padding.top + padding.bottom;
      const edgeScale = Math.min(1, MAX_OUTPUT_EDGE / Math.max(outputWidth, outputHeight));
      if (edgeScale < 1) {
        contentWidth = Math.max(1, Math.floor(contentWidth * edgeScale));
        contentHeight = Math.max(1, Math.floor(contentHeight * edgeScale));
        continue;
      }
      const svg = buildSvg({ dataUrl, recipe, contentWidth, contentHeight, scale, padding });
      const blob = await rasterize(svg, outputWidth, outputHeight);
      result = { blob, width: outputWidth, height: outputHeight, contentWidth, contentHeight, padding, scale };
      if (blob.size <= maxBytes) return result;
      const reduction = Math.max(0.58, Math.min(0.86, Math.sqrt(maxBytes / blob.size) * 0.92));
      contentWidth = Math.max(1, Math.floor(contentWidth * reduction));
      contentHeight = Math.max(1, Math.floor(contentHeight * reduction));
    }
    const error = new Error(`烘焙图片仍超过 ${Math.round(maxBytes / 1024 / 1024)}MB，请缩小原图后重试`);
    error.code = 'MPSE_BAKE_TOO_LARGE';
    error.result = result;
    throw error;
  }

  globalThis.__MPSE_IMAGE_BAKE__ = Object.freeze({
    ADVANCED_EFFECTS,
    hasEffects,
    recipeFromImage,
    recipeKey,
    computePadding,
    buildSvg,
    bake
  });
})();
