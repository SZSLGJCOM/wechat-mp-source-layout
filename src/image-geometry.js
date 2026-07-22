(() => {
  'use strict';

  const MIN_FRACTION = 0.04;

  function clamp(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.min(Math.max(number, min), max);
  }

  function normalizeRect(rect = {}) {
    const width = clamp(rect.width, MIN_FRACTION, 1);
    const height = clamp(rect.height, MIN_FRACTION, 1);
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
      media: normalizeRect(model.media),
      baseAspect: clamp(model.baseAspect, 0.05, 40)
    };
  }

  function resizePositiveAxis(frame, media, deltaRatio, axis) {
    const size = axis === 'x' ? 'width' : 'height';
    const origin = axis;
    const minimum = Math.max(
      MIN_FRACTION / frame[size] - 1,
      MIN_FRACTION / media[size] - 1
    );
    const maximum = Math.min(
      (1 - frame[origin]) / frame[size] - 1,
      (1 - media[origin]) / media[size] - 1
    );
    const ratio = clamp(deltaRatio, minimum, maximum);
    return {
      frame: { ...frame, [size]: frame[size] * (1 + ratio) },
      media: { ...media, [size]: media[size] * (1 + ratio) }
    };
  }

  function resizeNegativeAxis(frame, media, deltaRatio, axis) {
    const size = axis === 'x' ? 'width' : 'height';
    const origin = axis;
    const minimum = Math.max(
      -frame[origin] / frame[size],
      -media[origin] / media[size]
    );
    const maximum = Math.min(
      1 - MIN_FRACTION / frame[size],
      1 - MIN_FRACTION / media[size]
    );
    const ratio = clamp(deltaRatio, minimum, maximum);
    return {
      frame: {
        ...frame,
        [origin]: frame[origin] + frame[size] * ratio,
        [size]: frame[size] * (1 - ratio)
      },
      media: {
        ...media,
        [origin]: media[origin] + media[size] * ratio,
        [size]: media[size] * (1 - ratio)
      }
    };
  }

  function resizeFrameEdge(model, handle, deltaRatio) {
    const start = normalizeModel(model);
    let next;
    if (handle === 'e') next = resizePositiveAxis(start.frame, start.media, deltaRatio, 'x');
    else if (handle === 'w') next = resizeNegativeAxis(start.frame, start.media, deltaRatio, 'x');
    else if (handle === 's') next = resizePositiveAxis(start.frame, start.media, deltaRatio, 'y');
    else if (handle === 'n') next = resizeNegativeAxis(start.frame, start.media, deltaRatio, 'y');
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
    const factor = clamp(scale, 0.1, 10);
    const width = clamp(start.media.width * factor, MIN_FRACTION, 1);
    const height = clamp(start.media.height * factor, MIN_FRACTION, 1);
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
    normalizeModel,
    resizeFrameEdge,
    panMedia,
    zoomMedia,
    previewFrameRect,
    horizontalTransformPercent,
    modelsMatch
  });
})();
