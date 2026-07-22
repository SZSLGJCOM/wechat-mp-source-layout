(() => {
  'use strict';

  const MIN_FRACTION = 0.04;
  const MIN_MEDIA_FRACTION = 0.125;

  function clamp(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.min(Math.max(number, min), max);
  }

  function normalizeRect(rect = {}, minimum = MIN_FRACTION) {
    const width = clamp(rect.width, minimum, 1);
    const height = clamp(rect.height, minimum, 1);
    return {
      x: clamp(rect.x, 0, 1 - width),
      y: clamp(rect.y, 0, 1 - height),
      width,
      height
    };
  }

  function normalizeModel(model = {}) {
    return {
      frame: normalizeRect(model.frame),
      media: normalizeRect(model.media, MIN_MEDIA_FRACTION),
      baseAspect: clamp(model.baseAspect, 0.05, 40)
    };
  }

  function resizePositiveAxis(frame, media, deltaRatio, axis, limits) {
    const size = axis === 'x' ? 'width' : 'height';
    const origin = axis;
    const mediaRatioFactor = limits.mediaRatioFactor;
    const minimum = Math.max(
      limits.minimum / frame[size] - 1,
      (MIN_MEDIA_FRACTION / media[size] - 1) / mediaRatioFactor
    );
    const maximum = Math.min(
      (1 - frame[origin]) / frame[size] - 1,
      ((1 - media[origin]) / media[size] - 1) / mediaRatioFactor,
      limits.maximum / frame[size] - 1
    );
    const ratio = clamp(deltaRatio, minimum, maximum);
    const mediaRatio = ratio * mediaRatioFactor;
    return {
      frame: { ...frame, [size]: frame[size] * (1 + ratio) },
      media: { ...media, [size]: media[size] * (1 + mediaRatio) }
    };
  }

  function resizeNegativeAxis(frame, media, deltaRatio, axis, limits) {
    const size = axis === 'x' ? 'width' : 'height';
    const origin = axis;
    const mediaRatioFactor = limits.mediaRatioFactor;
    const minimum = Math.max(
      -frame[origin] / frame[size],
      -media[origin] / media[size] / mediaRatioFactor,
      1 - limits.maximum / frame[size]
    );
    const maximum = Math.min(
      1 - limits.minimum / frame[size],
      (1 - MIN_MEDIA_FRACTION / media[size]) / mediaRatioFactor
    );
    const ratio = clamp(deltaRatio, minimum, maximum);
    const mediaRatio = ratio * mediaRatioFactor;
    return {
      frame: {
        ...frame,
        [origin]: frame[origin] + frame[size] * ratio,
        [size]: frame[size] * (1 - ratio)
      },
      media: {
        ...media,
        [origin]: media[origin] + media[size] * mediaRatio,
        [size]: media[size] * (1 - mediaRatio)
      }
    };
  }

  function resizeFrameEdge(model, handle, deltaRatio, constraints = {}) {
    const start = normalizeModel(model);
    const horizontalLimits = {
      minimum: clamp(Number.isFinite(Number(constraints.minWidth)) ? constraints.minWidth : MIN_FRACTION, MIN_FRACTION, 1),
      maximum: clamp(Number.isFinite(Number(constraints.maxWidth)) ? constraints.maxWidth : 1, MIN_FRACTION, 1),
      mediaRatioFactor: clamp(Number.isFinite(Number(constraints.horizontalMediaRatioFactor)) ? constraints.horizontalMediaRatioFactor : 1, 0.01, 100)
    };
    const verticalLimits = {
      minimum: clamp(Number.isFinite(Number(constraints.minHeight)) ? constraints.minHeight : MIN_FRACTION, MIN_FRACTION, 1),
      maximum: clamp(Number.isFinite(Number(constraints.maxHeight)) ? constraints.maxHeight : 1, MIN_FRACTION, 1),
      mediaRatioFactor: clamp(Number.isFinite(Number(constraints.verticalMediaRatioFactor)) ? constraints.verticalMediaRatioFactor : 1, 0.01, 100)
    };
    horizontalLimits.maximum = Math.max(horizontalLimits.minimum, horizontalLimits.maximum);
    verticalLimits.maximum = Math.max(verticalLimits.minimum, verticalLimits.maximum);
    let next;
    if (handle === 'e') next = resizePositiveAxis(start.frame, start.media, deltaRatio, 'x', horizontalLimits);
    else if (handle === 'w') next = resizeNegativeAxis(start.frame, start.media, deltaRatio, 'x', horizontalLimits);
    else if (handle === 's') next = resizePositiveAxis(start.frame, start.media, deltaRatio, 'y', verticalLimits);
    else if (handle === 'n') next = resizeNegativeAxis(start.frame, start.media, deltaRatio, 'y', verticalLimits);
    else return start;
    return { ...next, baseAspect: start.baseAspect };
  }

  function panMedia(model, deltaXRatio, deltaYRatio) {
    const start = normalizeModel(model);
    return {
      ...start,
      media: {
        ...start.media,
        x: clamp(start.media.x - deltaXRatio * start.media.width, 0, 1 - start.media.width),
        y: clamp(start.media.y - deltaYRatio * start.media.height, 0, 1 - start.media.height)
      }
    };
  }

  function zoomMedia(model, scale, focalX, focalY) {
    const start = normalizeModel(model);
    const minimumScale = Math.max(
      MIN_MEDIA_FRACTION / start.media.width,
      MIN_MEDIA_FRACTION / start.media.height
    );
    const maximumScale = Math.min(1 / start.media.width, 1 / start.media.height);
    const factor = clamp(scale, minimumScale, maximumScale);
    const width = start.media.width * factor;
    const height = start.media.height * factor;
    const anchorX = clamp(focalX, 0, 1);
    const anchorY = clamp(focalY, 0, 1);
    return {
      ...start,
      media: {
        x: clamp(start.media.x + start.media.width * anchorX - width * anchorX, 0, 1 - width),
        y: clamp(start.media.y + start.media.height * anchorY - height * anchorY, 0, 1 - height),
        width,
        height
      }
    };
  }

  function previewFrameRect(startRect, startFrame, nextFrame) {
    const frame = normalizeRect(startFrame);
    const next = normalizeRect(nextFrame);
    const width = startRect.width * next.width / frame.width;
    const height = startRect.height * next.height / frame.height;
    const left = startRect.left + startRect.width * (next.x - frame.x) / frame.width;
    const top = startRect.top + startRect.height * (next.y - frame.y) / frame.height;
    return { left, top, right: left + width, bottom: top + height, width, height };
  }

  function horizontalTransformPercent(frame, alignment) {
    const normalized = normalizeRect(frame);
    let offset = normalized.x;
    if (alignment === 'center') offset -= (1 - normalized.width) / 2;
    else if (alignment === 'right') offset += normalized.width - 1;
    return offset / normalized.width * 100;
  }

  function layoutResizeOrigin(frame, alignment) {
    const normalized = normalizeRect(frame || { x: 0, y: 0, width: 1, height: 1 });
    const anchorX = alignment === 'center' ? 0.5 : (alignment === 'right' ? 1 : 0);
    return {
      x: (anchorX - normalized.x) / normalized.width,
      y: -normalized.y / normalized.height
    };
  }

  function cornerResizeOrigin(handle) {
    return {
      x: String(handle || '').includes('w') ? 1 : 0,
      y: String(handle || '').includes('n') ? 1 : 0
    };
  }

  function alignedFrameOffset(frame, alignment) {
    const normalized = normalizeRect(frame || { x: 0, y: 0, width: 1, height: 1 });
    const anchorX = alignment === 'center' ? 0.5 : (alignment === 'right' ? 1 : 0);
    return anchorX - normalized.x - normalized.width * anchorX;
  }

  function resizePreviewRect(startRect, scale, origin) {
    const factor = clamp(scale, 0.04, 25);
    const anchor = origin || { x: 0, y: 0 };
    const width = startRect.width * factor;
    const height = startRect.height * factor;
    const left = startRect.left + startRect.width * anchor.x * (1 - factor);
    const top = startRect.top + startRect.height * anchor.y * (1 - factor);
    return { left, top, right: left + width, bottom: top + height, width, height };
  }

  function modelsMatch(first, second, tolerance = 0.0001) {
    if (!first || !second) return first === second;
    const a = normalizeModel(first);
    const b = normalizeModel(second);
    return ['x', 'y', 'width', 'height'].every((key) => (
      Math.abs(a.frame[key] - b.frame[key]) < tolerance
      && Math.abs(a.media[key] - b.media[key]) < tolerance
    )) && Math.abs(a.baseAspect - b.baseAspect) < tolerance;
  }

  globalThis.__MPSE_IMAGE_GEOMETRY__ = Object.freeze({
    MIN_FRACTION,
    MIN_MEDIA_FRACTION,
    normalizeModel,
    resizeFrameEdge,
    panMedia,
    zoomMedia,
    previewFrameRect,
    horizontalTransformPercent,
    layoutResizeOrigin,
    cornerResizeOrigin,
    alignedFrameOffset,
    resizePreviewRect,
    modelsMatch
  });
})();
