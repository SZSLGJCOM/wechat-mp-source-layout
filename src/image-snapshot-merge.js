(() => {
  'use strict';

  const frame = [
    'border', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
    'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
    'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
    'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'background-color', 'border-radius', 'box-sizing', 'overflow'
  ];
  const layout = [
    'width', 'height', 'max-width', 'display', 'margin-left', 'margin-right',
    'margin-top', 'margin-bottom', 'vertical-align', 'float'
  ];
  const featherMask = [
    'mask-image', '-webkit-mask-image', 'mask-size', '-webkit-mask-size',
    'mask-repeat', '-webkit-mask-repeat', 'mask-position', '-webkit-mask-position'
  ];
  const alphaEffectCleanup = {
    shadow: ['box-shadow'],
    glow: ['box-shadow'],
    feather: featherMask,
    stroke: ['outline', 'outline-offset'],
    bake: ['box-shadow', ...featherMask, 'outline', 'outline-offset']
  };
  const alphaFilterEffects = new Set(Object.keys(alphaEffectCleanup));
  const appearance = {
    radius: ['border-radius', 'overflow', 'vertical-align'],
    size: ['width', 'height', 'max-width', 'display', 'margin-left', 'margin-right'],
    spacing: ['display', 'margin-top', 'margin-bottom'],
    shadow: ['filter', 'box-shadow'],
    glow: ['filter', 'box-shadow'],
    feather: ['filter', ...featherMask],
    stroke: ['filter', 'outline', 'outline-offset'],
    opacity: ['opacity'],
    color: ['filter'],
    bake: ['filter', 'box-shadow', ...featherMask, 'outline', 'outline-offset'],
    rotate: ['transform', 'transform-origin'],
    frame,
    circle: [...frame, 'width', 'height', 'max-width', 'object-fit', 'display', 'margin-left', 'margin-right']
  };
  const cropImage = [
    ...layout, ...frame, 'position', 'left', 'top', 'right', 'bottom',
    'transform', 'transform-origin', 'translate', 'scale', 'object-fit'
  ];
  const cropHost = [
    ...layout, ...frame, 'position', 'aspect-ratio', 'line-height',
    'transform', 'transform-origin', 'translate', 'scale'
  ];
  const cropCreateImage = Array.from(new Set([...cropImage, ...Object.values(appearance).flat()]));
  const cropCreateHost = Array.from(new Set([...cropHost, ...Object.values(appearance).flat()]));
  const resetImage = Array.from(new Set([...cropCreateImage, ...Object.values(appearance).flat()]));
  const carrier = [...frame, 'display', 'box-shadow', 'opacity', 'outline', 'outline-offset'];
  const cropHostEffects = new Set(['radius', 'size', 'spacing', 'opacity', 'rotate', 'frame', 'circle']);
  const cropDualTargetEffects = new Set(['opacity']);
  const cropGeometryReasons = new Set(['resize', 'crop', 'crop-pan', 'crop-zoom', 'crop-reset', 'circle']);
  const cropMetadataEffects = new Set(['size', 'radius', 'spacing', 'rotate', 'frame']);
  const cropRemovalReasons = new Set(['crop-exit', 'crop-reset', 'reset']);
  const cropSizeImage = ['position', 'left', 'top', 'width', 'height'];
  const cropSizeWidthHost = [...frame, 'width', 'max-width', 'display', 'margin-bottom', 'transform'];
  const cropSizeAlignHost = ['display', 'margin-left', 'margin-right', 'transform', 'transform-origin'];

  function effectFromReason(reason) {
    const normalized = String(reason || '');
    const effect = normalized.startsWith('clear-') ? normalized.slice(6) : normalized;
    return effect.startsWith('size-') ? 'size' : effect;
  }

  function targetForEffect(image, cropHost, effect) {
    return effect !== 'color' && !alphaFilterEffects.has(effect) && cropHost && cropHostEffects.has(effect)
      ? cropHost
      : image;
  }

  function cropIntent(cropHost, reason) {
    const effect = effectFromReason(reason);
    return {
      action: cropHost ? 'ensure' : (cropRemovalReasons.has(reason) ? 'remove' : 'preserve'),
      ownsStructure: Boolean(cropHost && cropGeometryReasons.has(effect)),
      ownsHostData: Boolean(cropHost && (cropGeometryReasons.has(effect) || cropMetadataEffects.has(effect)))
    };
  }

  function stylePropertiesForReason(reason, effect, hasCropHost) {
    if (reason === 'size-width') return hasCropHost
      ? ['width', 'max-width', 'display']
      : ['width', 'height', 'max-width', 'display'];
    if (reason === 'size-align') return ['display', 'margin-left', 'margin-right'];
    return appearance[effect] || [];
  }

  function uniqueProperties(properties) {
    return Array.from(new Set((properties || []).filter((property) => typeof property === 'string' && property)));
  }

  function captureStylePatch(element, properties) {
    if (!element || !element.style) return {};
    const patch = {};
    for (const property of uniqueProperties(properties)) {
      patch[property] = {
        value: element.style.getPropertyValue(property) || '',
        priority: element.style.getPropertyPriority(property) || ''
      };
    }
    return patch;
  }

  function refreshStylePatch(element, previousPatch, additionalProperties = []) {
    const properties = [...Object.keys(previousPatch || {}), ...additionalProperties];
    return captureStylePatch(element, properties);
  }

  function applyStylePatch(element, patch) {
    if (!element || !element.style || !patch) return;
    for (const [property, entry] of Object.entries(patch)) {
      const value = entry && typeof entry === 'object' ? String(entry.value || '') : String(entry || '');
      const priority = entry && typeof entry === 'object' ? String(entry.priority || '') : '';
      if (value) element.style.setProperty(property, value, priority);
      else element.style.removeProperty(property);
    }
  }

  function captureAttributes(element, predicate) {
    const attributes = {};
    if (!element || !element.attributes) return attributes;
    for (const attribute of Array.from(element.attributes)) {
      if (!predicate || predicate(attribute.name, attribute.value)) attributes[attribute.name] = attribute.value;
    }
    return attributes;
  }

  function syncAttributes(element, attributes, predicate) {
    if (!element || !element.attributes) return;
    for (const attribute of Array.from(element.attributes)) {
      if (predicate && predicate(attribute.name, attribute.value)
        && !Object.prototype.hasOwnProperty.call(attributes || {}, attribute.name)) {
        element.removeAttribute(attribute.name);
      }
    }
    for (const [name, value] of Object.entries(attributes || {})) element.setAttribute(name, value);
  }

  function createSnapshot(options) {
    const {
      identity, image, cropHost: cropHostElement, carrier: carrierElement, block: blockElement, caption, previous, reason = '',
      managedDataKeys = [], imageAttributeNames = [], cropAttribute = 'data-mpse-image-crop'
    } = options || {};
    if (!identity || !image) return null;
    const effect = effectFromReason(reason);
    const intent = cropIntent(cropHostElement, reason);
    const previousAction = previous && ['ensure', 'remove'].includes(previous.cropAction) ? previous.cropAction : null;
    const topologyOperation = intent.ownsStructure || cropRemovalReasons.has(reason);
    const cropAction = previousAction && !topologyOperation
      ? previousAction
      : (intent.action === 'preserve' ? (previousAction || 'preserve') : intent.action);
    const finalHasHost = cropAction === 'ensure' || (cropAction === 'preserve' && Boolean(cropHostElement));
    const topologyMatches = cropAction === 'preserve'
      || (cropAction === 'ensure' && Boolean(cropHostElement))
      || (cropAction === 'remove' && !cropHostElement);
    const ownsHostData = intent.ownsHostData || previous?.hostDataAction === 'sync';
    const imageProperties = new Set(Object.keys(previous?.imgStylePatch || {}));
    const hostProperties = new Set(Object.keys(previous?.hostStylePatch || {}));
    const carrierProperties = new Set(Object.keys(previous?.carrierStylePatch || {}));
    const blockProperties = new Set(Object.keys(previous?.blockStylePatch || {}));
    let effectProperties = [];
    let effectTargetsHost = false;

    if (reason === 'reset') {
      imageProperties.clear();
      for (const property of resetImage) imageProperties.add(property);
      hostProperties.clear();
      for (const property of carrier) carrierProperties.add(property);
      blockProperties.add('text-align');
    } else {
      effectProperties = stylePropertiesForReason(reason, effect, finalHasHost);
      effectTargetsHost = effect !== 'color' && !alphaFilterEffects.has(effect) && finalHasHost && cropHostEffects.has(effect);
      if (alphaFilterEffects.has(effect)) {
        for (const property of effectProperties) imageProperties.add(property);
        if (finalHasHost) {
          for (const property of alphaEffectCleanup[effect]) hostProperties.add(property);
        }
      } else if (finalHasHost && cropDualTargetEffects.has(effect)) {
        for (const property of effectProperties) {
          imageProperties.add(property);
          hostProperties.add(property);
        }
      } else {
        const targetProperties = effectTargetsHost ? hostProperties : imageProperties;
        for (const property of effectProperties) targetProperties.add(property);
      }
      if (reason === 'size-align' || reason === 'size') blockProperties.add('text-align');
    }

    if (intent.ownsStructure) {
      for (const property of cropImage) imageProperties.add(property);
      for (const property of cropHost) hostProperties.add(property);
    } else if (topologyMatches && cropHostElement && (reason === 'size-width' || reason === 'size')) {
      for (const property of cropSizeImage) imageProperties.add(property);
      for (const property of cropSizeWidthHost) hostProperties.add(property);
    }
    if (topologyMatches && cropHostElement && (reason === 'size-align' || reason === 'size')) {
      for (const property of cropSizeAlignHost) hostProperties.add(property);
    } else if (topologyMatches && !cropHostElement && cropAction === 'remove') {
      for (const property of hostProperties) imageProperties.add(property);
      hostProperties.clear();
    }

    let imgStylePatch;
    let hostStylePatch;
    if (topologyMatches) {
      imgStylePatch = refreshStylePatch(image, previous?.imgStylePatch, imageProperties);
      hostStylePatch = cropHostElement ? refreshStylePatch(cropHostElement, previous?.hostStylePatch, hostProperties) : {};
    } else {
      imgStylePatch = { ...(previous?.imgStylePatch || {}) };
      hostStylePatch = { ...(previous?.hostStylePatch || {}) };
      if (alphaFilterEffects.has(effect)) {
        Object.assign(imgStylePatch, captureStylePatch(image, effectProperties));
        if (cropHostElement) {
          Object.assign(hostStylePatch, captureStylePatch(cropHostElement, alphaEffectCleanup[effect]));
        }
      } else if (cropHostElement && cropDualTargetEffects.has(effect)) {
        if (finalHasHost) {
          Object.assign(imgStylePatch, captureStylePatch(image, effectProperties));
          Object.assign(hostStylePatch, captureStylePatch(cropHostElement, effectProperties));
        } else {
          Object.assign(imgStylePatch, captureStylePatch(cropHostElement, effectProperties));
        }
      } else {
        const effectPatch = captureStylePatch(targetForEffect(image, cropHostElement, effect), effectProperties);
        Object.assign(effectTargetsHost ? hostStylePatch : imgStylePatch, effectPatch);
      }
    }

    let captionAction = previous?.captionAction || 'none';
    let captionHtml = previous?.captionHtml || '';
    if (reason === 'reset') {
      captionAction = 'remove';
      captionHtml = '';
    } else if (effect === 'caption') {
      captionAction = caption ? 'upsert' : 'remove';
      captionHtml = caption ? caption.outerHTML : '';
    } else if (captionAction === 'upsert' && caption) {
      captionHtml = caption.outerHTML;
    }

    const isCropAttribute = (name) => name === cropAttribute || name.startsWith('data-mpse-');
    const ownsImageAttributes = reason === 'bake' || reason === 'reset';
    const imgAttributeAction = ownsImageAttributes
      ? 'sync'
      : (previous?.imgAttributeAction === 'sync' ? 'sync' : 'none');
    return {
      identity,
      cropAction,
      imgAttributeAction,
      imgAttributePatch: ownsImageAttributes
        ? captureAttributes(image, (name) => imageAttributeNames.includes(name))
        : (imgAttributeAction === 'sync' ? { ...(previous?.imgAttributePatch || {}) } : {}),
      imgStylePatch,
      hostStylePatch,
      hostData: cropAction === 'ensure' && cropHostElement && ownsHostData
        ? captureAttributes(cropHostElement, isCropAttribute)
        : (previous?.hostData || {}),
      hostDataAction: cropAction === 'ensure' && ownsHostData ? 'sync' : 'none',
      cropCreateImgStylePatch: cropAction === 'ensure' && cropHostElement
        ? captureStylePatch(image, cropCreateImage)
        : (previous?.cropCreateImgStylePatch || {}),
      cropCreateHostStylePatch: cropAction === 'ensure' && cropHostElement
        ? captureStylePatch(cropHostElement, cropCreateHost)
        : (previous?.cropCreateHostStylePatch || {}),
      cropCreateHostData: cropAction === 'ensure' && cropHostElement
        ? captureAttributes(cropHostElement, isCropAttribute)
        : (previous?.cropCreateHostData || {}),
      cropRemovalImgStylePatch: cropAction === 'remove'
        ? (topologyMatches ? captureStylePatch(image, cropCreateImage) : (previous?.cropRemovalImgStylePatch || {}))
        : {},
      imgData: managedDataKeys.reduce((data, key) => {
        if (image.dataset && image.dataset[key] !== undefined) data[key] = image.dataset[key];
        return data;
      }, {}),
      carrierStylePatch: carrierElement
        ? refreshStylePatch(carrierElement, previous?.carrierStylePatch, carrierProperties)
        : (previous?.carrierStylePatch || {}),
      blockStylePatch: blockElement
        ? refreshStylePatch(blockElement, previous?.blockStylePatch, blockProperties)
        : (previous?.blockStylePatch || {}),
      captionHtml,
      captionAction
    };
  }

  function reconcileCropHost(target, currentHost, action, createHost) {
    if (action === 'remove' && currentHost?.parentNode) {
      const parent = currentHost.parentNode;
      while (currentHost.firstChild) parent.insertBefore(currentHost.firstChild, currentHost);
      currentHost.remove();
      return { target, host: null, created: false, removed: true };
    }
    if (action !== 'ensure' || currentHost) return { target, host: currentHost || null, created: false, removed: false };
    if (!target?.parentNode || typeof createHost !== 'function') return { target, host: null, created: false, removed: false };
    const host = createHost();
    target.parentNode.insertBefore(host, target);
    host.appendChild(target);
    return { target, host, created: true, removed: false };
  }

  globalThis.__MPSE_IMAGE_SNAPSHOT_MERGE__ = Object.freeze({
    properties: Object.freeze({ appearance, cropImage, cropHost, cropCreateImage, cropCreateHost, resetImage, carrier }),
    effectFromReason,
    targetForEffect,
    cropIntent,
    captureStylePatch,
    refreshStylePatch,
    applyStylePatch,
    captureAttributes,
    syncAttributes,
    createSnapshot,
    reconcileCropHost
  });
})();
