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

  function horizontalTransformPercent(frame, alignment) {
    const normalized = normalizeRect(frame);
    let offset = normalized.x;
    if (alignment === 'center') offset -= (1 - normalized.width) / 2;
    else if (alignment === 'right') offset += normalized.width - 1;
    return offset / normalized.width * 100;
  }

  function alignedFrameOffset(frame, alignment) {
    const normalized = normalizeRect(frame || { x: 0, y: 0, width: 1, height: 1 });
    const anchorX = alignment === 'center' ? 0.5 : (alignment === 'right' ? 1 : 0);
    return anchorX - normalized.x - normalized.width * anchorX;
  }

  function restoreFrameAfterPresentation(baseModel, appliedModel, currentModel) {
    const base = normalizeModel(baseModel);
    const applied = normalizeModel(appliedModel || baseModel);
    const current = normalizeModel(currentModel || appliedModel || baseModel);
    const baseRight = base.frame.x + base.frame.width;
    const baseBottom = base.frame.y + base.frame.height;
    const appliedRight = applied.frame.x + applied.frame.width;
    const appliedBottom = applied.frame.y + applied.frame.height;
    const currentRight = current.frame.x + current.frame.width;
    const currentBottom = current.frame.y + current.frame.height;
    const x = base.frame.x + current.frame.x - applied.frame.x;
    const y = base.frame.y + current.frame.y - applied.frame.y;
    const right = baseRight + currentRight - appliedRight;
    const bottom = baseBottom + currentBottom - appliedBottom;
    const boundedX = clamp(x, 0, 1 - MIN_FRACTION);
    const boundedY = clamp(y, 0, 1 - MIN_FRACTION);
    const boundedRight = clamp(right, boundedX + MIN_FRACTION, 1);
    const boundedBottom = clamp(bottom, boundedY + MIN_FRACTION, 1);
    return normalizeModel({
      frame: {
        x: boundedX,
        y: boundedY,
        width: boundedRight - boundedX,
        height: boundedBottom - boundedY
      },
      media: current.media,
      baseAspect: base.baseAspect
    });
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
    horizontalTransformPercent,
    alignedFrameOffset,
    restoreFrameAfterPresentation,
    modelsMatch
  });
})();
