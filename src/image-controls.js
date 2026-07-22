(() => {
  'use strict';

  function create(dependencies) {
    const {
      MENU_ID,
      PANEL_ID,
      state,
      imageGeometry,
      frameStyleProps,
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
    } = dependencies;

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

    const FRAME_APPEARANCE_PROPS = [...new Set([...frameStyleProps, 'overflow', 'vertical-align'])];
    const SPACING_STYLE_PROPS = ['display', 'margin-top', 'margin-bottom'];
    const CIRCLE_STYLE_PROPS = ['width', 'height', 'max-width', 'object-fit', 'display', 'margin-left', 'margin-right'];
    const IMAGE_BASE_STYLE_PROPS = [
      'border-radius', 'overflow', 'width', 'max-width', 'height', 'display',
      'margin-left', 'margin-right', 'margin-top', 'margin-bottom', 'box-shadow',
      'filter', 'border', 'padding', 'background-color', 'box-sizing', 'object-fit',
      'position', 'left', 'top', 'right', 'bottom', 'translate', 'scale', 'float',
      'transform', 'transform-origin', 'vertical-align', 'opacity', 'outline', 'outline-offset',
      'mask-image', '-webkit-mask-image', 'mask-size', '-webkit-mask-size',
      'mask-repeat', '-webkit-mask-repeat', 'mask-position', '-webkit-mask-position'
    ];
    const CARRIER_BASE_STYLE_PROPS = [...frameStyleProps, 'overflow', 'display', 'box-shadow', 'opacity', 'outline', 'outline-offset'];

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
      image = getAppearanceHost(image);
      if (!image || !image.style) return fallback;
      return parsePx(image.style.getPropertyValue('border-width') || image.style.getPropertyValue('border'), fallback);
    }

    function readBorderColor(image, fallback = '#e6e8eb') {
      image = getAppearanceHost(image);
      if (!image || !image.style) return fallback;
      const direct = image.style.getPropertyValue('border-color');
      if (direct) return normalizeCssColorToHex(direct, fallback);
      const border = image.style.getPropertyValue('border');
      const color = border.match(/(#[0-9a-f]{3,6}|rgba?\([^)]*\))/i);
      return color ? normalizeCssColorToHex(color[1], fallback) : fallback;
    }

    function readBackgroundColor(image, fallback = '#ffffff') {
      image = getAppearanceHost(image);
      return normalizeCssColorToHex(image && image.style ? image.style.getPropertyValue('background-color') : '', fallback);
    }

    function readPadding(image, fallback = 0) {
      const target = getAppearanceHost(image);
      if (!target || !target.style) return fallback;
      const inline = target.style.getPropertyValue('padding') || target.style.getPropertyValue('padding-top');
      if (inline) return parsePx(inline, fallback);
      const view = target.ownerDocument && target.ownerDocument.defaultView;
      return parsePx(view ? view.getComputedStyle(target).paddingTop : '', fallback);
    }

    function readBoxShadow(image) {
      const target = getAppearanceHost(image);
      const value = target && target.style ? target.style.getPropertyValue('box-shadow') : '';
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
      if (getCropContainer(image)) {
        try {
          const rect = getCropContentRect(image);
          const diameter = Math.round(Math.min(rect.width || 160, rect.height || rect.width || 160));
          return clamp(diameter, 40, 520);
        } catch (_) {
          return 160;
        }
      }
      const target = getLayoutHost(image);
      const widthPx = readStyleNumber(target, 'width', NaN);
      const heightPx = readStyleNumber(target, 'height', NaN);
      if (Number.isFinite(widthPx) && widthPx > 0) return widthPx;
      if (Number.isFinite(heightPx) && heightPx > 0) return heightPx;
      try {
        const rect = target.getBoundingClientRect();
        const d = Math.round(Math.min(rect.width || 160, rect.height || rect.width || 160));
        return clamp(d, 40, 520);
      } catch (_) {
        return 160;
      }
    }

    function hasNonEmptyStyle(image, prop) {
      return Boolean(image && image.style && String(image.style.getPropertyValue(prop) || '').trim());
    }

    function getAppliedEffects(image) {
      const applied = new Set();
      if (!image || !image.style) return applied;

      const width = image.style.getPropertyValue('width');

      if (image.dataset.mpseRadiusOn === '1') applied.add('radius');
      if (width || hasNonEmptyStyle(image, 'max-width') || hasNonEmptyStyle(image, 'margin-left') || hasNonEmptyStyle(image, 'margin-right') || getCropContainer(image)) applied.add('size');
      if (image.dataset.mpseSpacingOn === '1') applied.add('spacing');
      if (image.dataset.mpseShadowOn === '1') applied.add('shadow');
      if (image.dataset.mpseGlowOn === '1') applied.add('glow');
      if (image.dataset.mpseFeatherOn === '1') applied.add('feather');
      if (image.dataset.mpseStrokeOn === '1') applied.add('stroke');
      if (image.dataset.mpseOpacityOn === '1') applied.add('opacity');
      if (image.dataset.mpseColorOn === '1') applied.add('color');
      if (image.dataset.mpseRotateOn === '1') applied.add('rotate');
      if (image.dataset.mpseFrameOn === '1') applied.add('frame');
      if (getCaptionNode(image)) applied.add('caption');
      if (image.dataset.mpseCircleOn === '1') applied.add('circle');
      return applied;
    }

    function captureImageBase(image) {
      if (!image || image.dataset.mpseImageBase !== undefined) return false;
      const cropHost = getCropContainer(image);
      const carrier = getVisualCarrier(image);
      const persistentCarrier = carrier && carrier !== cropHost ? carrier : null;
      const block = image.closest && image.closest('p,section,div,figure');
      image.dataset.mpseImageBase = JSON.stringify({
        imageStyles: captureInlineStyles(image, IMAGE_BASE_STYLE_PROPS),
        carrierStyles: captureInlineStyles(persistentCarrier, CARRIER_BASE_STYLE_PROPS),
        hasCarrier: Boolean(persistentCarrier),
        blockStyles: captureInlineStyles(block, ['text-align']),
        hasBlock: Boolean(block)
      });
      return true;
    }

    function restoreImageBase(image) {
      if (!image || image.dataset.mpseImageBase === undefined) return false;
      let base;
      try {
        base = JSON.parse(image.dataset.mpseImageBase || '{}');
      } catch (_) {
        base = {};
      }
      const carrier = getVisualCarrier(image);
      const block = image.closest && image.closest('p,section,div,figure');
      restoreInlineStyles(image, base.imageStyles);
      if (base.hasCarrier && carrier) restoreInlineStyles(carrier, base.carrierStyles);
      if (base.hasBlock && block) restoreInlineStyles(block, base.blockStyles);
      delete image.dataset.mpseImageBase;
      return true;
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
      const target = getAppearanceHost(image);
      image.dataset.mpseBaseBoxShadow = target.style.getPropertyValue('box-shadow') || '';
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

      const target = getAppearanceHost(image);
      if (target !== image) setStyle(image, 'box-shadow', '');
      setStyle(target, 'box-shadow', shadows.join(', '));
    }

    function restoreBaseBoxShadow(image) {
      if (!image) return;
      const target = getAppearanceHost(image);
      if (target !== image) setStyle(image, 'box-shadow', '');
      setStyle(target, 'box-shadow', image.dataset.mpseBaseBoxShadow || '');
      // A crop host owns the visible shadow while it exists. Keep the source
      // value on the image until unwrap can move it back without rendering it
      // twice on the host and the nested media.
      if (target !== image) return;
      delete image.dataset.mpseBaseBoxShadow;
    }

    function captureCircleBase(image) {
      if (!image || image.dataset.mpseCircleBase !== undefined) return;
      const host = getCropContainer(image);
      image.dataset.mpseCircleBase = JSON.stringify(host ? {
        mode: 'crop',
        crop: readCropState(image),
        baseWidth: readCropBaseWidth(image),
        imageStyles: captureInlineStyles(image, ['object-fit'])
      } : {
        mode: 'image',
        imageStyles: captureInlineStyles(image, CIRCLE_STYLE_PROPS)
      });
    }

    function restoreImageCirclePresentationBase(image) {
      if (!image || image.dataset.mpseCircleBase === undefined) return false;
      try {
        const base = JSON.parse(image.dataset.mpseCircleBase || '{}');
        if (base.mode !== 'image' || !base.imageStyles) return false;
        restoreInlineStyles(image, base.imageStyles);
        return true;
      } catch (_) {
        return false;
      }
    }

    function suspendImageCirclePresentation(image) {
      if (!image || getCropContainer(image) || image.dataset.mpseCircleOn !== '1') return null;
      const presentation = captureInlineStyles(image, CIRCLE_STYLE_PROPS);
      return restoreImageCirclePresentationBase(image) ? presentation : null;
    }

    function resumeImageCirclePresentation(image, presentation) {
      if (!image || getCropContainer(image)) return false;
      if (presentation) {
        restoreInlineStyles(image, presentation);
      } else if (image.dataset.mpseCircleOn === '1') {
        const diameter = clamp(getDataNumber(image, 'mpseCircleDiameter', 160), 40, 520);
        setStyles(image, {
          width: `${diameter}px`, height: `${diameter}px`, 'max-width': '100%',
          'object-fit': 'cover', display: 'block', 'margin-left': 'auto', 'margin-right': 'auto'
        });
      } else {
        return false;
      }
      rebuildFrameAppearance(image);
      return true;
    }

    function restoreCircleBase(image) {
      if (!image) return;
      try {
        const base = JSON.parse(image.dataset.mpseCircleBase || '{}');
        const host = getCropContainer(image);
        if (host && base.crop) {
          const current = readCropState(image);
          const appliedBaseWidth = Number(base.appliedBaseWidth);
          const currentBaseWidth = readCropBaseWidth(image);
          const scale = Number.isFinite(appliedBaseWidth) && appliedBaseWidth > 0
            ? currentBaseWidth / appliedBaseWidth
            : 1;
          const originalBaseWidth = Number(base.baseWidth);
          setCropBaseWidth(image, (Number.isFinite(originalBaseWidth) ? originalBaseWidth : currentBaseWidth) * scale);
          writeCropState(image, imageGeometry.restoreFrameAfterPresentation(base.crop, base.appliedCrop, current));
          restoreInlineStyles(image, base.imageStyles);
        } else if (base.mode === 'image' && host) {
          restoreInlineStyles(image, { 'object-fit': base.imageStyles?.['object-fit'] || { value: '', priority: '' } });
        } else if (!restoreImageCirclePresentationBase(image)) {
          restoreInlineStyles(image, base.imageStyles);
        }
      } catch (_) {
        // Invalid base data leaves the current source style untouched.
      }
      delete image.dataset.mpseCircleBase;
      delete image.dataset.mpseCircleOn;
      delete image.dataset.mpseCircleDiameter;
      rebuildFrameAppearance(image);
    }

    function applyCircleCropGeometry(image, diameter, squareFrame = false) {
      const crop = readCropState(image);
      if (!crop) return false;

      let base = null;
      try {
        base = JSON.parse(image.dataset.mpseCircleBase || '{}');
      } catch (_) {
        base = {};
      }
      if (!base.crop) {
        base.crop = crop;
        base.baseWidth = readCropBaseWidth(image);
      }

      let next = crop;
      if (squareFrame) {
        const frame = { ...crop.frame };
        const aspect = crop.baseAspect * frame.width / frame.height;
        if (aspect > 1) {
          const width = frame.height / crop.baseAspect;
          frame.x += (frame.width - width) / 2;
          frame.width = width;
        } else {
          const height = crop.baseAspect * frame.width;
          frame.y += (frame.height - height) / 2;
          frame.height = height;
        }
        next = imageGeometry.normalizeModel({ ...crop, frame });
      }

      const desiredWidth = clamp(diameter / Math.max(1, getAvailableImageWidth(image)) * 100, 4, 100);
      setCropBaseWidth(image, desiredWidth / Math.max(imageGeometry.MIN_FRACTION, next.frame.width));
      writeCropState(image, next);
      if (!base.appliedCrop) base.appliedCrop = next;
      base.appliedBaseWidth = readCropBaseWidth(image);
      image.dataset.mpseCircleBase = JSON.stringify(base);

      const layout = readCropLayout(image);
      layout.frameChanged = true;
      writeCropLayout(image, layout);
      return true;
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

    function hasFrameAppearanceEffect(image) {
      return Boolean(image && (image.dataset.mpseFrameOn === '1'
        || image.dataset.mpseRadiusOn === '1'
        || image.dataset.mpseCircleOn === '1'));
    }

    function captureFrameAppearanceBase(image) {
      captureStyleBase(image, 'mpseFrameBase', FRAME_APPEARANCE_PROPS, getAppearanceHost(image));
    }

    function captureFrameSourceStyles(image) {
      const styles = captureInlineStyles(image, frameStyleProps);
      if (!image || image.dataset.mpseFrameBase === undefined) return styles;
      try {
        const base = JSON.parse(image.dataset.mpseFrameBase || '{}');
        for (const property of frameStyleProps) {
          if (base[property] && typeof base[property] === 'object') styles[property] = { ...base[property] };
        }
      } catch (_) {
        // Invalid reversible metadata falls back to the current inline source styles.
      }
      return styles;
    }

    function rebuildFrameAppearance(image) {
      if (!image) return;
      const target = getAppearanceHost(image);
      if (image.dataset.mpseFrameBase !== undefined) {
        applyStyleBase(image, 'mpseFrameBase', FRAME_APPEARANCE_PROPS, target);
      }
      if (image.dataset.mpseFrameOn === '1') {
        const borderWidth = getDataNumber(image, 'mpseFrameBorderWidth', 0);
        setStyles(target, {
          border: borderWidth > 0 ? `${borderWidth}px solid ${getDataString(image, 'mpseFrameBorderColor', '#e6e8eb')}` : '',
          padding: `${getDataNumber(image, 'mpseFramePadding', 0)}px`,
          'background-color': getDataString(image, 'mpseFrameBackgroundColor', '#ffffff'),
          'border-radius': `${getDataNumber(image, 'mpseFrameRadius', 0)}px`,
          'box-sizing': getCropContainer(image) ? 'content-box' : 'border-box'
        });
      }
      if (image.dataset.mpseRadiusOn === '1') {
        const radius = getDataNumber(image, 'mpseRadiusValue', 0);
        setStyles(target, { 'border-radius': `${radius}px`, overflow: radius > 0 ? 'hidden' : '', 'vertical-align': 'middle' });
      }
      if (image.dataset.mpseCircleOn === '1') {
        setStyles(target, { 'border-radius': '999px', overflow: 'hidden' });
      }
      if (getCropContainer(image)) setStyle(target, 'overflow', 'hidden');
      if (!hasFrameAppearanceEffect(image) && image.dataset.mpseFrameBase !== undefined) {
        delete image.dataset.mpseFrameBase;
      }
    }

    function captureCropTransformBase(image, layout) {
      if (image.dataset.mpseRotateBase !== undefined) return;
      image.dataset.mpseRotateBase = JSON.stringify({
        transform: layout.styles?.transform || { value: '', priority: '' },
        'transform-origin': layout.styles?.['transform-origin'] || { value: '', priority: '' }
      });
    }

    function restoreCropTransformBase(image) {
      const crop = readCropState(image);
      if (!crop) return false;
      const layout = readCropLayout(image);
      try {
        const base = JSON.parse(image.dataset.mpseRotateBase || '{}');
        layout.styles.transform = base.transform || { value: '', priority: '' };
        layout.styles['transform-origin'] = base['transform-origin'] || { value: '', priority: '' };
      } catch (_) {
        layout.styles.transform = { value: '', priority: '' };
        layout.styles['transform-origin'] = { value: '', priority: '' };
      }
      delete image.dataset.mpseRotateBase;
      writeCropLayout(image, layout);
      writeCropState(image, crop);
      return true;
    }

    function appearanceConfig(effect) {
      return APPEARANCE_EFFECTS[effect] || null;
    }

    function isAppearanceEnabled(image, effect) {
      const config = appearanceConfig(effect);
      return Boolean(config && image && image.dataset[config.activeKey] === '1');
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
      if (image.dataset.mpseBaseBoxShadow !== undefined
        || image.dataset.mpseShadowOn === '1'
        || image.dataset.mpseGlowOn === '1') rebuildManagedBoxShadow(image);
    }

    function renderCropAppearance(image) {
      rebuildFrameAppearance(image);
      const host = getCropContainer(image);
      if (host) setStyle(host, 'overflow', 'hidden');
      renderAppearance(image);
    }

    function clearAppearanceEffect(image, effect) {
      const config = appearanceConfig(effect);
      if (!config || !image) return;
      delete image.dataset[config.activeKey];
      for (const key of config.valueKeys) delete image.dataset[key];
      renderAppearance(image);
      delete image.dataset[config.baseKey];
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
      const appearanceHost = getAppearanceHost(image);
      const cropLayout = getCropContainer(image) ? readCropLayout(image) : null;
      const radius = image.dataset.mpseRadiusOn === '1'
        ? getDataNumber(image, 'mpseRadiusValue', 0)
        : readStyleNumber(appearanceHost, 'border-radius', 0);
      const layoutRect = layoutHost.getBoundingClientRect();
      const width = parsePercent(layoutHost.style.getPropertyValue('width'), clamp(layoutRect.width / Math.max(1, getAvailableImageWidth(image)) * 100, 4, 100));
      const top = cropLayout ? parsePx(cropLayout.styles?.['margin-top']?.value, 0) : readStyleNumber(layoutHost, 'margin-top', 0);
      const bottom = cropLayout ? parsePx(cropLayout.styles?.['margin-bottom']?.value, 0) : readStyleNumber(layoutHost, 'margin-bottom', 0);
      const shadowDefaults = readBoxShadow(image);
      const colorDefaults = readFilterValues(image);

      if (effect === 'radius') return range('圆角半径', 'radius', 0, 80, 1, radius, 'px');
      if (effect === 'size') {
        const align = cropLayout?.alignment || detectHorizontalAlignment(layoutHost);
        const cropAction = hasCropAdjustment(image)
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
      if (effect === 'frame') {
        const enabled = image.dataset.mpseFrameOn === '1';
        const borderWidth = enabled ? getDataNumber(image, 'mpseFrameBorderWidth', 0) : readBorderWidth(image, 0);
        const padding = enabled ? getDataNumber(image, 'mpseFramePadding', 0) : readPadding(image, 0);
        const frameRadius = enabled ? getDataNumber(image, 'mpseFrameRadius', 0) : readStyleNumber(appearanceHost, 'border-radius', 0);
        const borderColor = enabled ? getDataString(image, 'mpseFrameBorderColor', '#e6e8eb') : readBorderColor(image, '#e6e8eb');
        const backgroundColor = enabled ? getDataString(image, 'mpseFrameBackgroundColor', '#ffffff') : readBackgroundColor(image, '#ffffff');
        return `${range('边框宽度', 'borderWidth', 0, 20, 1, borderWidth, 'px')}${range('内边距', 'padding', 0, 40, 1, padding, 'px')}${range('框圆角', 'radius', 0, 80, 1, frameRadius, 'px')}${color('边框颜色', 'borderColor', borderColor)}${color('底色', 'backgroundColor', backgroundColor)}`;
      }
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

    function panelControlValue(control) {
      if (control.type === 'checkbox' || control.type === 'radio') {
        return `${control.checked ? '1' : '0'}:${control.value || ''}`;
      }
      return String(control.value ?? '');
    }

    function rememberPanelControlValues(panel) {
      for (const control of Array.from(panel.querySelectorAll('input, select'))) {
        if (!control.name) continue;
        control.dataset.mpseLastAppliedValue = panelControlValue(control);
      }
    }

    function hasNewPanelControlValue(control) {
      if (!control || !control.name || !control.dataset) return false;
      const value = panelControlValue(control);
      if (control.dataset.mpseLastAppliedValue === value) return false;
      control.dataset.mpseLastAppliedValue = value;
      return true;
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
      rememberPanelControlValues(panel);
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

    function getFocusedPanelControl(panel) {
      const active = panel && panel.ownerDocument ? panel.ownerDocument.activeElement : null;
      if (!active || !panel.contains(active) || typeof active.matches !== 'function') return null;
      return active.matches('input, textarea, select, [contenteditable="true"]') ? active : null;
    }

    function refreshVisiblePanel() {
      const panel = document.getElementById(PANEL_ID);
      if (!panel || (!panel.classList.contains('mpse-visible') && !state.activePanel)) return;
      if (!state.image || !state.image.isConnected) return;
      if (state.isDragging) return;
      if (getFocusedPanelControl(panel)) {
        setButtonStates();
        updateValueLabels(panel);
        positionTools();
        return;
      }
      showPanel(state.activePanel || panel.dataset.effect || 'radius');
    }

    function onPanelInput(event) {
      const panel = document.getElementById(PANEL_ID);
      if (!panel || !panel.classList.contains('mpse-visible')) return;
      if (!event.target || !event.target.closest(`#${PANEL_ID}`)) return;
      if (!state.image || !state.image.isConnected) return;
      if (!hasNewPanelControlValue(event.target)) return;
      updateValueLabels(panel);
      applyEffect(panel.dataset.effect, collectValues(panel), event.target.name || '');
    }

    function applyEffect(effect, values, changedField = '') {
      const image = state.image;
      if (!image || !image.isConnected) return;
      captureImageBase(image);
      const layoutHost = getLayoutHost(image);

      if (effect === 'radius') {
        const r = clamp(values.radius, 0, 80);
        captureFrameAppearanceBase(image);
        image.dataset.mpseRadiusOn = '1';
        image.dataset.mpseRadiusValue = String(r);
        rebuildFrameAppearance(image);
        if (getCropContainer(image)) {
          const layout = readCropLayout(image);
          layout.frameChanged = true;
          writeCropLayout(image, layout);
        }
      }

      if (effect === 'size') {
        const width = clamp(values.width, 10, 100);
        const align = values.align || detectHorizontalAlignment(layoutHost);
        const shouldResize = !changedField || changedField === 'width';
        const shouldAlign = !changedField || changedField === 'align';
        const crop = readCropState(image);
        if (crop) {
          const layout = readCropLayout(image);
          if (shouldAlign) {
            layout.alignment = align;
            layout.display = 'block';
            layout.offsetX = imageGeometry.alignedFrameOffset(crop.frame, align);
            setCropLayoutStyle(layout, 'display', 'block');
            setCropLayoutStyle(layout, 'margin-left', align === 'left' ? '0' : 'auto');
            setCropLayoutStyle(layout, 'margin-right', align === 'right' ? '0' : 'auto');
            writeCropLayout(image, layout);
          }
        }
        if (shouldResize) setLayoutWidthPercent(image, width);
        if (crop && (shouldResize || shouldAlign)) writeCropState(image, crop);
        else {
          if (shouldResize) {
            setStyles(layoutHost, { 'max-width': '100%', display: 'block' });
            setStyle(image, 'height', 'auto');
          }
          if (shouldAlign) setStyle(layoutHost, 'display', 'block');
          if (shouldAlign && align === 'left') setStyles(layoutHost, { 'margin-left': '0', 'margin-right': 'auto' });
          if (shouldAlign && align === 'center') setStyles(layoutHost, { 'margin-left': 'auto', 'margin-right': 'auto' });
          if (shouldAlign && align === 'right') setStyles(layoutHost, { 'margin-left': 'auto', 'margin-right': '0' });
        }
        const block = layoutHost.closest && layoutHost.closest('p,section,div,figure');
        if (shouldAlign && block) setStyle(block, 'text-align', align);
      }

      if (effect === 'spacing') {
        const crop = readCropState(image);
        captureStyleBase(image, 'mpseSpacingBase', SPACING_STYLE_PROPS, layoutHost);
        image.dataset.mpseSpacingOn = '1';
        if (crop) {
          const layout = readCropLayout(image);
          layout.display = 'block';
          setCropLayoutStyle(layout, 'display', 'block');
          setCropLayoutStyle(layout, 'margin-top', `${clamp(values.top, 0, 120)}px`);
          setCropLayoutStyle(layout, 'margin-bottom', `${clamp(values.bottom, 0, 120)}px`);
          writeCropLayout(image, layout);
          writeCropState(image, crop);
        } else {
          setStyles(layoutHost, { display: 'block', 'margin-top': `${clamp(values.top, 0, 120)}px`, 'margin-bottom': `${clamp(values.bottom, 0, 120)}px` });
        }
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
        image.dataset.mpseColorOn = '1';
        image.dataset.mpseBrightness = String(clamp(values.brightness, 40, 180));
        image.dataset.mpseContrast = String(clamp(values.contrast, 40, 180));
        image.dataset.mpseSaturate = String(clamp(values.saturate, 0, 240));
        image.dataset.mpseGray = String(clamp(values.gray, 0, 100));
        rebuildFilter(image);
      }

      if (effect === 'rotate') {
        const angle = clamp(values.angle, -180, 180);
        image.dataset.mpseRotate = String(angle);
        image.dataset.mpseRotateOn = '1';
        const crop = readCropState(image);
        if (crop) {
          const layout = readCropLayout(image);
          captureCropTransformBase(image, layout);
          layout.styles.transform = { value: `rotate(${angle}deg)`, priority: 'important' };
          layout.styles['transform-origin'] = { value: 'center center', priority: 'important' };
          writeCropLayout(image, layout);
          writeCropState(image, crop);
        } else {
          captureStyleBase(image, 'mpseRotateBase', ['transform', 'transform-origin']);
          setStyles(image, { transform: `rotate(${angle}deg)`, 'transform-origin': 'center center' });
        }
      }

      if (effect === 'frame') {
        const borderWidth = clamp(values.borderWidth, 0, 20);
        captureFrameAppearanceBase(image);
        image.dataset.mpseFrameOn = '1';
        image.dataset.mpseFrameBorderWidth = String(borderWidth);
        image.dataset.mpseFramePadding = String(clamp(values.padding, 0, 40));
        image.dataset.mpseFrameRadius = String(clamp(values.radius, 0, 80));
        image.dataset.mpseFrameBorderColor = values.borderColor || '#e6e8eb';
        image.dataset.mpseFrameBackgroundColor = values.backgroundColor || '#ffffff';
        rebuildFrameAppearance(image);
        if (getCropContainer(image)) {
          const layout = readCropLayout(image);
          layout.frameChanged = true;
          writeCropLayout(image, layout);
          refreshCropDecoration(image);
          writeCropState(image, readCropState(image));
        }
      }

      if (effect === 'caption') updateCaption(image, values);

      if (effect === 'circle') {
        const d = clamp(values.diameter, 40, 520);
        const activating = image.dataset.mpseCircleOn !== '1';
        captureFrameAppearanceBase(image);
        captureCircleBase(image);
        image.dataset.mpseCircleOn = '1';
        image.dataset.mpseCircleDiameter = String(d);
        const crop = readCropState(image);
        if (crop) {
          applyCircleCropGeometry(image, d, activating);
        } else {
          setStyles(image, {
            width: `${d}px`, height: `${d}px`, 'max-width': '100%',
            'object-fit': 'cover', display: 'block', 'margin-left': 'auto', 'margin-right': 'auto'
          });
        }
        rebuildFrameAppearance(image);
      }

      const changeReason = effect === 'size'
        ? (!changedField ? 'size' : (changedField === 'align' ? 'size-align' : 'size-width'))
        : effect;
      markChanged(image, changeReason);
      setButtonStates();
      schedulePositionTools();
    }

    function hasManagedEffect(image, effect) {
      if (!image) return false;
      if (effect === 'radius') return image.dataset.mpseRadiusOn === '1';
      if (effect === 'spacing') return image.dataset.mpseSpacingOn === '1' || image.dataset.mpseSpacingBase !== undefined;
      if (effect === 'shadow') return image.dataset.mpseShadowOn === '1';
      if (effect === 'glow') return image.dataset.mpseGlowOn === '1';
      if (appearanceConfig(effect)) {
        const config = appearanceConfig(effect);
        return image.dataset[config.activeKey] === '1' || image.dataset[config.baseKey] !== undefined;
      }
      if (effect === 'color') return image.dataset.mpseColorOn === '1' || image.dataset.mpseColorBase !== undefined;
      if (effect === 'rotate') return image.dataset.mpseRotateOn === '1' || image.dataset.mpseRotateBase !== undefined;
      if (effect === 'frame') return image.dataset.mpseFrameOn === '1';
      if (effect === 'caption') return Boolean(getCaptionNode(image));
      if (effect === 'circle') return image.dataset.mpseCircleOn === '1' || image.dataset.mpseCircleBase !== undefined;
      return false;
    }

    function clearEffect(effect, commit = true) {
      const image = state.image;
      if (!image || !image.isConnected || effect === 'size') return;
      if (!hasManagedEffect(image, effect)) return;

      if (effect === 'radius') {
        delete image.dataset.mpseRadiusOn;
        delete image.dataset.mpseRadiusValue;
        rebuildFrameAppearance(image);
        if (getCropContainer(image)) {
          const layout = readCropLayout(image);
          layout.frameChanged = true;
          writeCropLayout(image, layout);
        }
      }
      if (effect === 'spacing') {
        const crop = readCropState(image);
        if (crop) {
          const layout = readCropLayout(image);
          applyStyleBase(image, 'mpseSpacingBase', SPACING_STYLE_PROPS, getLayoutHost(image));
          const restored = captureInlineStyles(getLayoutHost(image), SPACING_STYLE_PROPS);
          for (const property of SPACING_STYLE_PROPS) {
            if (!layout.styles) layout.styles = {};
            if (!layout.hostStyles) layout.hostStyles = {};
            layout.styles[property] = { ...restored[property] };
            layout.hostStyles[property] = { ...restored[property] };
          }
          layout.display = restored.display?.value || layout.display;
          delete image.dataset.mpseSpacingBase;
          writeCropLayout(image, layout);
          writeCropState(image, crop);
        } else {
          restoreStyleBase(image, 'mpseSpacingBase', SPACING_STYLE_PROPS, getLayoutHost(image));
        }
        delete image.dataset.mpseSpacingOn;
      }
      if (effect === 'shadow') {
        for (const key of ['mpseShadowOn', 'mpseShadowX', 'mpseShadowY', 'mpseShadowBlur', 'mpseShadowSpread', 'mpseShadowOpacity', 'mpseShadowColor']) delete image.dataset[key];
        if (image.dataset.mpseGlowOn === '1') {
          rebuildManagedBoxShadow(image);
        } else {
          restoreBaseBoxShadow(image);
        }
      }
      if (effect === 'glow') {
        for (const key of ['mpseGlowOn', 'mpseGlowBlur', 'mpseGlowSpread', 'mpseGlowOpacity', 'mpseGlowColor']) delete image.dataset[key];
        if (image.dataset.mpseShadowOn === '1') {
          rebuildManagedBoxShadow(image);
        } else {
          restoreBaseBoxShadow(image);
        }
      }
      if (appearanceConfig(effect)) clearAppearanceEffect(image, effect);
      if (effect === 'color') {
        for (const key of ['mpseColorOn', 'mpseBrightness', 'mpseContrast', 'mpseSaturate', 'mpseGray']) delete image.dataset[key];
        restoreStyleBase(image, 'mpseColorBase', ['filter']);
      }
      if (effect === 'rotate') {
        delete image.dataset.mpseRotate;
        delete image.dataset.mpseRotateOn;
        if (!restoreCropTransformBase(image)) {
          restoreStyleBase(image, 'mpseRotateBase', ['transform', 'transform-origin']);
        }
      }
      if (effect === 'frame') {
        for (const key of ['mpseFrameOn', 'mpseFrameBorderWidth', 'mpseFramePadding', 'mpseFrameRadius', 'mpseFrameBorderColor', 'mpseFrameBackgroundColor']) {
          delete image.dataset[key];
        }
        rebuildFrameAppearance(image);
        if (getCropContainer(image)) {
          setStyle(getCropContainer(image), 'box-sizing', 'content-box');
          const layout = readCropLayout(image);
          layout.frameChanged = true;
          writeCropLayout(image, layout);
          refreshCropDecoration(image);
          writeCropState(image, readCropState(image));
        }
      }
      if (effect === 'caption') {
        const caption = getCaptionNode(image);
        if (caption) caption.remove();
      }
      if (effect === 'circle') {
        restoreCircleBase(image);
      }

      if (commit) {
        markChanged(image, `clear-${effect}`);
        setButtonStates();
        schedulePositionTools();
      }
      return true;
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

    function clearFrameAppearance(image) {
      clearAppearanceProperties(image, FRAME_APPEARANCE_PROPS);
    }

    return Object.freeze({
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
      restoreImageCirclePresentationBase,
      suspendImageCirclePresentation,
      resumeImageCirclePresentation,
      restoreCircleBase,
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
    });
  }

  window.__MPSE_IMAGE_CONTROLS__ = Object.freeze({ create });
})();
