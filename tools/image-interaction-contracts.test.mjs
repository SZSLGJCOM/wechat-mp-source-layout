import assert from 'node:assert/strict';
import test from 'node:test';

import { readText } from './test-helpers.mjs';

test('media tools only activate from direct media hits', () => {
  const imageTools = readText('src/image-tools.js');
  const svgTools = readText('src/svg-tools.js');
  const svgBlockTools = readText('src/svg-block-tools.js');

  for (const source of [imageTools, svgTools]) {
    assert.match(source, /const image = target\.closest \? target\.closest\('img'\) : null;/);
    assert.doesNotMatch(source, /wrapper\.querySelector\('img'\)/);
  }

  assert.match(svgBlockTools, /if \(!svg\) return null;/);
  assert.doesNotMatch(svgBlockTools, /wrapper\.querySelector\('svg'\)/);
  assert.doesNotMatch(svgBlockTools, /doc\.elementsFromPoint\(event\.clientX, event\.clientY\)/);
});

test('image controls keep panel state without creating a competing selection layer', () => {
  const imageTools = readText('src/image-tools.js');
  const css = readText('src/overlay.css');

  assert.match(imageTools, /activePanel: null/);
  assert.doesNotMatch(imageTools, /effectMemory/);
  assert.doesNotMatch(imageTools, /showPanel\(effect, true\)/);
  assert.doesNotMatch(imageTools, /doc\.addEventListener\('click', onDocumentPointer/);
  assert.doesNotMatch(imageTools, /function beginGeometryGesture\(/);
  assert.doesNotMatch(imageTools, /function enterCropMode\(/);
  assert.match(imageTools, /function applyCropSnapshot\(/);
  assert.match(imageTools, /data-mpse-image-crop/);
  assert.doesNotMatch(css, /\.mpse-img2-handle/);
  assert.doesNotMatch(css, /#mpse-img2-box/);
  assert.doesNotMatch(css, /#mpse-img2-drag-shield/);
  assert.doesNotMatch(css, /mpse-active::after/);
});

test('image effect menus only open panels and never apply default values', () => {
  const imageTools = readText('src/image-tools.js');
  const imageControls = readText('src/image-controls.js');
  const menu = imageTools.match(/function createMenu\(\) \{[\s\S]*?\n  \}\n\n  function createPanel/);
  const panel = imageTools.match(/function createPanel\(\) \{[\s\S]*?\n  \}\n\n  function createBadge/);
  const showPanel = imageControls.match(/function showPanel\(effect\) \{[\s\S]*?\n    \}\n\n    function setButtonStates/);
  const panelInput = imageControls.match(/function onPanelInput\(event\) \{[\s\S]*?\n    \}\n\n    function applyEffect/);

  assert.ok(menu, 'image menu handler must exist');
  assert.ok(panel, 'image panel handler must exist');
  assert.ok(showPanel, 'panel renderer must exist');
  assert.ok(panelInput, 'panel input handler must exist');
  assert.match(menu[0], /showPanel\(effect\)/);
  assert.doesNotMatch(menu[0], /applyEffect\(/, 'opening shadow or glow must not enable it');
  assert.doesNotMatch(showPanel[0], /applyEffect\(/, 'rendering a panel must stay read-only');
  assert.match(panel[0], /event\.target\.closest\('\[data-toggle-effect\]'\)/);
  assert.match(panel[0], /applyEffect\(effect, collectValues\(panel\)\)/);
  assert.match(panel[0], /addEventListener\('input', onPanelInput, true\)/);
  assert.match(panelInput[0], /applyEffect\(panel\.dataset\.effect, collectValues\(panel\), event\.target\.name \|\| ''\)/);
});

test('panel controls ignore duplicate input and change values while preserving real changes', () => {
  const imageControls = readText('src/image-controls.js');
  const helpers = imageControls.match(/function panelControlValue\(control\) \{[\s\S]*?\n    \}\n\n    function panelTipForEffect/);
  const showPanel = imageControls.match(/function showPanel\(effect\) \{[\s\S]*?\n    \}\n\n    function setButtonStates/);
  const panelInput = imageControls.match(/function onPanelInput\(event\) \{[\s\S]*?\n    \}\n\n    function applyEffect/);

  assert.ok(helpers, 'panel value tracking helpers must exist');
  assert.ok(showPanel, 'panel renderer must exist');
  assert.ok(panelInput, 'panel input handler must exist');
  assert.match(showPanel[0], /rememberPanelControlValues\(panel\)/);
  assert.doesNotMatch(showPanel[0], /applyEffect\(/, 'opening a panel must only record its initial values');
  assert.match(panelInput[0], /if \(!state\.image \|\| !state\.image\.isConnected\) return;[\s\S]*?hasNewPanelControlValue/);
  assert.match(panelInput[0], /if \(!hasNewPanelControlValue\(event\.target\)\) return;/);

  const helperBody = helpers[0].replace(/\n\n    function panelTipForEffect$/, '');
  const inputBody = panelInput[0].replace(/\n\n    function applyEffect$/, '');
  const { rememberPanelControlValues, hasNewPanelControlValue } = Function(
    `${helperBody}\nreturn { rememberPanelControlValues, hasNewPanelControlValue };`
  )();

  const range = {
    name: 'radius',
    type: 'range',
    value: '12',
    dataset: {},
    closest: () => panel
  };
  const panel = {
    dataset: { effect: 'radius' },
    classList: { contains: (name) => name === 'mpse-visible' },
    controls: [range],
    querySelectorAll() { return this.controls; }
  };
  rememberPanelControlValues(panel);
  assert.equal(hasNewPanelControlValue(range), false, 'the rendered value is a read-only baseline');

  const applied = [];
  const controlState = { image: { isConnected: true } };
  const onPanelInput = Function(
    'document',
    'PANEL_ID',
    'state',
    'hasNewPanelControlValue',
    'updateValueLabels',
    'applyEffect',
    'collectValues',
    `${inputBody}\nreturn onPanelInput;`
  )(
    { getElementById: () => panel },
    'panel',
    controlState,
    hasNewPanelControlValue,
    () => {},
    (effect, values, field) => applied.push({ effect, values, field }),
    () => Object.fromEntries(panel.controls.map((control) => [
      control.name,
      control.type === 'range' ? Number(control.value) : control.value
    ]))
  );

  onPanelInput({ type: 'input', target: range });
  assert.equal(applied.length, 0, 'an unchanged control must not apply on input');

  range.value = '13';
  controlState.image.isConnected = false;
  onPanelInput({ type: 'input', target: range });
  assert.equal(range.dataset.mpseLastAppliedValue, '12', 'a disconnected edit must not advance the applied token');
  controlState.image.isConnected = true;

  onPanelInput({ type: 'input', target: range });
  onPanelInput({ type: 'change', target: range });
  assert.deepEqual(applied, [{ effect: 'radius', values: { radius: 13 }, field: 'radius' }]);

  range.value = '14';
  onPanelInput({ type: 'input', target: range });
  range.value = '13';
  onPanelInput({ type: 'input', target: range });
  assert.deepEqual(applied.map(({ values }) => values.radius), [13, 14, 13], 'each genuine value transition remains live');

  const text = { name: 'caption', type: 'text', value: 'before', dataset: {}, closest: () => panel };
  panel.controls = [text];
  panel.dataset.effect = 'caption';
  rememberPanelControlValues(panel);
  text.value = 'after';
  onPanelInput({ type: 'change', target: text });
  assert.deepEqual(applied.at(-1), { effect: 'caption', values: { caption: 'after' }, field: 'caption' });

  const color = { name: 'strokeColor', type: 'color', value: '#07c160', dataset: {}, closest: () => panel };
  panel.controls = [color];
  panel.dataset.effect = 'stroke';
  rememberPanelControlValues(panel);
  color.value = '#000000';
  onPanelInput({ type: 'change', target: color });
  assert.deepEqual(applied.at(-1), { effect: 'stroke', values: { strokeColor: '#000000' }, field: 'strokeColor' });
});

test('active image panel is restored after editor DOM replacement but not after closing', () => {
  const imageTools = readText('src/image-tools.js');
  const imageControls = readText('src/image-controls.js');
  const refreshPanel = imageControls.match(/function refreshVisiblePanel\(\) \{[\s\S]*?\n    \}\n\n    function onPanelInput/);
  const reacquire = imageTools.match(/function reacquireSelectedImage\(identity = state\.identity\) \{[\s\S]*?\n  \}\n\n  function revealToolElements/);
  const hideElements = imageTools.match(/function hideToolElements\(preserveFocusedPanel = false\) \{[\s\S]*?\n  \}\n\n  function hideTools/);
  const closePanel = imageControls.match(/function closePanel\(\) \{[\s\S]*?\n    \}\n\n    function showPanel/);

  assert.ok(refreshPanel, 'panel refresh function must exist');
  assert.ok(reacquire, 'image reacquire function must exist');
  assert.ok(hideElements, 'temporary tool hiding function must exist');
  assert.ok(closePanel, 'explicit panel close function must exist');
  assert.match(hideElements[0], /classList\.remove\('mpse-visible', 'mpse-offscreen'\)/);
  assert.doesNotMatch(hideElements[0], /activePanel/, 'temporary DOM replacement must preserve panel intent');
  assert.match(refreshPanel[0], /\(!panel\.classList\.contains\('mpse-visible'\) && !state\.activePanel\)/);
  assert.match(refreshPanel[0], /showPanel\(state\.activePanel \|\| panel\.dataset\.effect \|\| 'radius'\)/);
  assert.match(reacquire[0], /revealToolElements\(\);[\s\S]*?refreshVisiblePanel\(\)/);
  assert.match(closePanel[0], /panel\.classList\.remove\('mpse-visible'\);[\s\S]*?state\.activePanel = null/);
});

test('focused panel input survives debounced DOM reacquire without losing value or selection', () => {
  const imageControls = readText('src/image-controls.js');
  const imageTools = readText('src/image-tools.js');
  const focusedSource = imageControls.match(/function getFocusedPanelControl\(panel\) \{[\s\S]*?\n    \}\n\n    function refreshVisiblePanel/);
  const refreshSource = imageControls.match(/function refreshVisiblePanel\(\) \{[\s\S]*?\n    \}\n\n    function onPanelInput/);
  const hideSource = imageTools.match(/function hideToolElements\(preserveFocusedPanel = false\) \{[\s\S]*?\n  \}\n\n  function hideTools/);
  assert.ok(focusedSource && refreshSource && hideSource, 'focused panel refresh guard must exist');

  const focusedBody = focusedSource[0].replace(/\n\n    function refreshVisiblePanel$/, '');
  const refreshBody = refreshSource[0].replace(/\n\n    function onPanelInput$/, '');
  const getFocusedPanelControl = Function(`${focusedBody}\nreturn getFocusedPanelControl;`)();

  const input = {
    value: '正在输入的图注',
    selectionStart: 3,
    selectionEnd: 7,
    matches: (selector) => selector.includes('input')
  };
  const panel = {
    ownerDocument: { activeElement: input },
    contains: (candidate) => candidate === input,
    classList: { contains: (name) => name === 'mpse-visible' },
    dataset: { effect: 'caption' }
  };
  const state = { image: { isConnected: true }, activePanel: 'caption', isDragging: false };
  const calls = { buttons: 0, labels: 0, position: 0, show: [] };
  const documentMock = { getElementById: () => panel };
  const refreshVisiblePanel = Function(
    'document',
    'PANEL_ID',
    'state',
    'getFocusedPanelControl',
    'setButtonStates',
    'updateValueLabels',
    'positionTools',
    'showPanel',
    `${refreshBody}\nreturn refreshVisiblePanel;`
  )(
    documentMock,
    'panel',
    state,
    getFocusedPanelControl,
    () => { calls.buttons += 1; },
    () => { calls.labels += 1; },
    () => { calls.position += 1; },
    (effect) => calls.show.push(effect)
  );

  refreshVisiblePanel();
  assert.equal(input.value, '正在输入的图注');
  assert.equal(input.selectionStart, 3);
  assert.equal(input.selectionEnd, 7);
  assert.deepEqual(calls.show, []);
  assert.deepEqual({ buttons: calls.buttons, labels: calls.labels, position: calls.position }, { buttons: 1, labels: 1, position: 1 });

  panel.ownerDocument.activeElement = null;
  refreshVisiblePanel();
  assert.deepEqual(calls.show, ['caption']);
  assert.match(refreshSource[0], /if \(getFocusedPanelControl\(panel\)\) \{[\s\S]*?return;[\s\S]*?showPanel\(/);
  assert.match(imageTools, /const delay = reason === 'drag-end' \? 420 : 360/);
  assert.match(imageTools, /revealToolElements\(\);[\s\S]*?refreshVisiblePanel\(\)/);
  assert.match(hideSource[0], /preserveFocusedPanel && id === PANEL_ID && element\.contains\(document\.activeElement\)/);
  assert.match(imageTools, /if \(!image\.isConnected\) \{[\s\S]*?hideToolElements\(true\);[\s\S]*?scheduleSelectedImageReacquire/);
});

test('radius and frame applied states use explicit managed data markers', () => {
  const imageTools = readText('src/image-tools.js');
  const imageControls = readText('src/image-controls.js');
  const appliedEffects = imageControls.match(/function getAppliedEffects\(image\) \{[\s\S]*?\n    \}\n\n    function captureImageBase/);
  const applyEffect = imageControls.match(/function applyEffect\(effect, values, changedField = ''\) \{[\s\S]*?\n    \}\n\n    function hasManagedEffect/);
  const clearEffect = imageControls.match(/function clearEffect\(effect, commit = true\) \{[\s\S]*?\n    \}\n\n    function updateCaption/);

  assert.ok(appliedEffects, 'applied-state detector must exist');
  assert.ok(applyEffect, 'effect applier must exist');
  assert.ok(clearEffect, 'effect clearer must exist');
  assert.match(imageTools, /'mpseRadiusOn', 'mpseRadiusValue'/);
  assert.match(imageTools, /'mpseSpacingOn', 'mpseSpacingBase', 'mpseFrameOn'/);
  assert.match(appliedEffects[0], /image\.dataset\.mpseRadiusOn === '1'\) applied\.add\('radius'\)/);
  assert.match(appliedEffects[0], /image\.dataset\.mpseFrameOn === '1'\) applied\.add\('frame'\)/);
  assert.match(applyEffect[0], /image\.dataset\.mpseRadiusOn = '1'/);
  assert.match(applyEffect[0], /image\.dataset\.mpseFrameOn = '1'/);
  assert.match(clearEffect[0], /delete image\.dataset\.mpseRadiusOn/);
  assert.match(clearEffect[0], /\['mpseFrameOn',[\s\S]*?delete image\.dataset\[key\]/);
});

test('native WeChat image selection owns resize, drag, double-click, and wheel events', () => {
  const imageTools = readText('src/image-tools.js');
  const imageControls = readText('src/image-controls.js');
  const css = readText('src/overlay.css');
  const pointerHandler = imageTools.match(/function onDocumentPointer\(event\) \{[\s\S]*?\n  \}\n\n  function bindDocuments/);
  const binding = imageTools.match(/function bindDocuments\(\) \{[\s\S]*?\n  \}\n\n  function onGlobalPointerUp/);

  assert.ok(pointerHandler, 'image pointer observation must remain available for the parameter menu');
  assert.ok(binding, 'document binding must exist');
  assert.match(pointerHandler[0], /showToolsForImage\(image\)/);
  assert.doesNotMatch(pointerHandler[0], /preventDefault\(|stopPropagation\(|stopUiEvent\(/);

  assert.match(binding[0], /addEventListener\('pointerdown', onDocumentPointer, true\)/);
  for (const nativeEvent of ['dragstart', 'dblclick', 'wheel', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture', 'selectstart']) {
    assert.doesNotMatch(binding[0], new RegExp(`addEventListener\\('${nativeEvent}'`));
  }

  for (const implementation of [
    'createBox',
    'createHandles',
    'createDragShield',
    'beginGeometryGesture',
    'beginCropPan',
    'toggleCropMode',
    'onDocumentDragStart',
    'onDocumentDoubleClick',
    'onDocumentWheel'
  ]) {
    assert.doesNotMatch(imageTools, new RegExp(`function ${implementation}\\(`));
  }

  assert.doesNotMatch(css, /mpse-img2-(?:box|handle|drag-shield)/);
  assert.match(imageControls, /选中框、拖动和缩放使用微信编辑器原生能力/);
});

test('legacy custom selection nodes are removed once without recreating them', () => {
  const imageTools = readText('src/image-tools.js');
  const cleanup = imageTools.match(/function cleanupLegacyDom\(\) \{[\s\S]*?\n  \}\n\n  function absorbUiEvent/);
  const boot = imageTools.match(/function boot\(\) \{[\s\S]*?\n  \}\n\n  try/);

  assert.ok(cleanup && boot, 'startup cleanup and boot functions must exist');
  assert.match(cleanup[0], /'mpse-img2-box', 'mpse-img2-drag-shield'/);
  assert.match(cleanup[0], /querySelectorAll\('\.mpse-img2-handle'\)/);
  assert.doesNotMatch(boot[0], /createBox\(|createHandles\(|createDragShield\(/);
  assert.match(boot[0], /createMenu\(\);[\s\S]*?createPanel\(\);[\s\S]*?createBadge\(\)/);
});

test('partially visible and oversized images keep their tools until fully clipped', () => {
  const imageTools = readText('src/image-tools.js');
  const visibleSource = imageTools.match(/function isSelectionVisible\(image, rect\) \{[\s\S]*?\n  \}\n\n  function schedulePositionTools/);
  assert.ok(visibleSource, 'selection visibility function must exist');
  assert.doesNotMatch(visibleSource[0], /rectContains\(/);
  assert.match(visibleSource[0], /!rectsIntersect\(getViewportRect\(\), rect\)/);
  assert.match(visibleSource[0], /frame && !rectsIntersect\(getFrameContentRect\(frame\), rect\)/);
  assert.match(visibleSource[0], /isClippingAncestor\(parent\) && !rectsIntersect\(getTopRect\(parent\), rect\)/);

  const viewport = { left: 0, top: 0, right: 100, bottom: 100 };
  const topDocument = { documentElement: {} };
  const rectsIntersect = (first, second) => Boolean(first && second
    && first.right > second.left && first.left < second.right
    && first.bottom > second.top && first.top < second.bottom);
  const isSelectionVisible = Function(
    'rectsIntersect',
    'getViewportRect',
    'getFrameByDocument',
    'getFrameContentRect',
    'getSelectionElement',
    'isClippingAncestor',
    'getTopRect',
    'document',
    `${visibleSource[0].replace(/\n\n  function schedulePositionTools$/, '')}\nreturn isSelectionVisible;`
  )(
    rectsIntersect,
    () => viewport,
    (ownerDocument) => ownerDocument.frame || null,
    (frame) => frame.rect,
    (image) => image,
    (element) => Boolean(element.clips),
    (element) => element.rect,
    topDocument
  );

  const topImage = { ownerDocument: topDocument, parentElement: null };
  assert.equal(isSelectionVisible(topImage, { left: 10, top: -500, right: 90, bottom: 500 }), true);
  assert.equal(isSelectionVisible(topImage, { left: 90, top: 20, right: 150, bottom: 80 }), true);
  assert.equal(isSelectionVisible(topImage, { left: 101, top: 20, right: 150, bottom: 80 }), false);

  const frame = { rect: { left: 0, top: 10, right: 100, bottom: 90 }, parentElement: null };
  const frameDocument = { documentElement: {}, frame };
  const framedImage = { ownerDocument: frameDocument, parentElement: null };
  assert.equal(isSelectionVisible(framedImage, { left: 20, top: 0, right: 80, bottom: 20 }), true);
  assert.equal(isSelectionVisible(framedImage, { left: 20, top: 0, right: 80, bottom: 9 }), false);

  const clippingParent = {
    clips: true,
    rect: { left: 20, top: 20, right: 80, bottom: 80 },
    parentElement: topDocument.documentElement
  };
  const clippedImage = { ownerDocument: topDocument, parentElement: clippingParent };
  assert.equal(isSelectionVisible(clippedImage, { left: 10, top: 30, right: 30, bottom: 60 }), true);
  assert.equal(isSelectionVisible(clippedImage, { left: 0, top: 30, right: 19, bottom: 60 }), false);
});
