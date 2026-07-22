import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { FakeElement, FakeStyle, readJson, readText, rootDir } from './test-helpers.mjs';

await import(new URL('../src/image-snapshot-merge.js', import.meta.url));
const snapshotMerge = globalThis.__MPSE_IMAGE_SNAPSHOT_MERGE__;

test('repository exposes one-command extension verification', () => {
  const packagePath = path.join(rootDir, 'package.json');
  const verifierPath = path.join(rootDir, 'tools', 'verify-extension.mjs');
  const packagerPath = path.join(rootDir, 'tools', 'package-extension.mjs');

  assert.equal(fs.existsSync(packagePath), true, 'package.json must exist');
  assert.equal(fs.existsSync(verifierPath), true, 'tools/verify-extension.mjs must exist');
  assert.equal(fs.existsSync(packagerPath), true, 'tools/package-extension.mjs must exist');

  const pkg = readJson('package.json');
  assert.equal(pkg.scripts?.check, 'node tools/verify-extension.mjs');
  assert.equal(
    pkg.scripts?.test,
    'node --test tools/release-contracts.test.mjs tools/image-interaction-contracts.test.mjs tools/image-geometry.test.mjs tools/image-state-contracts.test.mjs tools/bridge-client.test.mjs tools/page-bridge.test.mjs'
  );
  assert.equal(pkg.scripts?.package, 'node tools/package-extension.mjs');

  const result = spawnSync(process.execPath, ['tools/verify-extension.mjs'], {
    cwd: rootDir,
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('release version and ASCII package folder stay consistent', () => {
  const pkg = readJson('package.json');
  const manifest = readJson('manifest.json');
  const readme = readText('README.md');
  const changelog = readText('CHANGELOG.md');
  const bridgeClient = readText('src/bridge-client.js');
  const imageTools = readText('src/image-tools.js');
  const packager = readText('tools/package-extension.mjs');
  const releaseVersion = manifest.version_name || manifest.version;

  assert.equal(pkg.version, manifest.version);
  assert.equal(releaseVersion, '0.10');
  assert.ok(readme.includes(`当前版本：\`v${releaseVersion}\``));
  assert.ok(changelog.includes(`## v${releaseVersion} ·`));
  assert.ok(bridgeClient.includes(`const VERSION = 'v${manifest.version}';`));
  assert.ok(imageTools.includes(`const VERSION = 'v${manifest.version}';`));
  assert.match(packager, /releaseSlug = 'gongzhonghao-yuanma-paiban-zhushou'/);
});

test('license is noncommercial and product introductions stay product-focused', () => {
  const license = readText('LICENSE');
  const readme = readText('README.md');
  const pkg = readJson('package.json');
  const manifest = readJson('manifest.json');

  assert.match(license, /PolyForm Noncommercial License 1\.0\.0/);
  assert.match(license, /Noncommercial Purposes/);
  assert.doesNotMatch(license, /MIT License/);
  assert.equal(pkg.license, 'PolyForm-Noncommercial-1.0.0');
  assert.doesNotMatch(readme, /源码公开|非商用|商业使用|开源|授权/);
  assert.doesNotMatch(manifest.description, /源码公开|非商用|开源|授权/);
});

test('content scripts load the shared bridge client before dependent modules', () => {
  const manifest = readJson('manifest.json');
  const js = manifest.content_scripts?.[0]?.js || [];

  assert.deepEqual(js, [
    'src/bridge-client.js',
    'src/content.js',
    'src/image-geometry.js',
    'src/image-controls.js',
    'src/image-snapshot-merge.js',
    'src/image-tools.js',
    'src/svg-tools.js',
    'src/svg-block-tools.js'
  ]);

  const exposed = manifest.web_accessible_resources
    ?.flatMap((entry) => entry.resources || []) || [];
  assert.ok(exposed.includes('src/page-bridge.js'));
});

test('image snapshot patches preserve the latest native styles and attributes', () => {
  const imageTarget = {};
  const hostTarget = {};
  assert.equal(snapshotMerge.effectFromReason('clear-shadow'), 'shadow');
  assert.equal(snapshotMerge.effectFromReason('size-align'), 'size');
  assert.equal(snapshotMerge.targetForEffect(imageTarget, hostTarget, 'shadow'), hostTarget);
  assert.equal(snapshotMerge.targetForEffect(imageTarget, hostTarget, 'color'), imageTarget);

  const localImage = new FakeElement('img', {}, { width: '52%', opacity: '0.7' });
  const patch = snapshotMerge.captureStylePatch(localImage, ['width']);
  const latestImage = new FakeElement('img', {
    src: 'native-new.jpg',
    class: 'native-class',
    'data-native-token': 'keep',
    'data-mpse-old': 'remove'
  }, {
    width: '88%',
    opacity: '0.35',
    color: 'rgb(1, 2, 3)'
  });

  snapshotMerge.applyStylePatch(latestImage, patch);
  snapshotMerge.syncAttributes(
    latestImage,
    { 'data-mpse-image-id': 'img-1' },
    (name) => name.startsWith('data-mpse-')
  );

  assert.equal(latestImage.style.getPropertyValue('width'), '52%');
  assert.equal(latestImage.style.getPropertyValue('opacity'), '0.35');
  assert.equal(latestImage.style.getPropertyValue('color'), 'rgb(1, 2, 3)');
  assert.equal(latestImage.getAttribute('src'), 'native-new.jpg');
  assert.equal(latestImage.getAttribute('class'), 'native-class');
  assert.equal(latestImage.getAttribute('data-native-token'), 'keep');
  assert.equal(latestImage.getAttribute('data-mpse-old'), null);
  assert.equal(latestImage.getAttribute('data-mpse-image-id'), 'img-1');

  localImage.style.setProperty('width', '48%');
  localImage.style.setProperty('opacity', '0.6');
  const cumulative = snapshotMerge.refreshStylePatch(localImage, patch, ['opacity']);
  assert.deepEqual(Object.keys(cumulative).sort(), ['opacity', 'width']);
  assert.equal(cumulative.width.value, '48%');
  assert.equal(cumulative.opacity.value, '0.6');

  const latestBlock = new FakeElement('p', {}, { 'text-align': 'right', color: 'blue' });
  snapshotMerge.applyStylePatch(latestBlock, { 'text-align': { value: 'center', priority: 'important' } });
  assert.equal(latestBlock.style.getPropertyValue('text-align'), 'center');
  assert.equal(latestBlock.style.getPropertyValue('color'), 'blue');

  const latestCarrier = new FakeElement('figure', { class: 'native-carrier' }, { display: 'inline', color: 'green' });
  snapshotMerge.applyStylePatch(latestCarrier, { display: { value: 'block', priority: '' } });
  assert.equal(latestCarrier.style.getPropertyValue('display'), 'block');
  assert.equal(latestCarrier.style.getPropertyValue('color'), 'green');
  assert.equal(latestCarrier.getAttribute('class'), 'native-carrier');
});

test('real image snapshots own only the properties changed by the current operation', () => {
  const image = new FakeElement('img', {}, {
    width: '52%', opacity: '0.7', filter: 'contrast(120%)', 'box-shadow': '0 2px 8px #000'
  });
  image.dataset = {};
  const identity = { editId: 'img-1' };
  const size = snapshotMerge.createSnapshot({ identity, image, reason: 'size-width' });
  assert.equal(size.cropAction, 'preserve');
  assert.deepEqual(Object.keys(size.imgStylePatch).sort(), ['display', 'height', 'max-width', 'width']);
  const align = snapshotMerge.createSnapshot({ identity, image, reason: 'size-align' });
  assert.deepEqual(Object.keys(align.imgStylePatch).sort(), ['display', 'margin-left', 'margin-right']);
  assert.equal(align.imgStylePatch.width, undefined);
  assert.equal(size.imgStylePatch.opacity, undefined);
  assert.equal(size.imgStylePatch.filter, undefined);
  assert.equal(size.imgStylePatch['box-shadow'], undefined);

  const host = new FakeElement('span', { 'data-mpse-image-crop': '1' }, {
    width: '52%', opacity: '0.6', filter: 'brightness(90%)', 'box-shadow': '0 4px 9px #000'
  });
  const opacity = snapshotMerge.createSnapshot({ identity, image, cropHost: host, reason: 'opacity' });
  assert.deepEqual(Object.keys(opacity.hostStylePatch), ['opacity']);
  assert.equal(opacity.hostDataAction, 'none');

  const crop = snapshotMerge.createSnapshot({ identity, image, cropHost: host, reason: 'crop' });
  for (const property of ['opacity', 'filter', 'box-shadow', 'outline', 'mask-image']) {
    assert.equal(crop.hostStylePatch[property], undefined, `${property} is not owned by crop geometry`);
  }
  assert.equal(crop.hostDataAction, 'sync');

  host.setAttribute('data-mpse-crop-x', '0.25');
  const afterOpacity = snapshotMerge.createSnapshot({ identity, image, cropHost: host, previous: crop, reason: 'opacity' });
  assert.equal(afterOpacity.cropAction, 'ensure');
  assert.equal(afterOpacity.hostDataAction, 'sync');
  assert.equal(afterOpacity.hostData['data-mpse-crop-x'], '0.25');
  assert.ok(afterOpacity.hostStylePatch.position, 'geometry style ownership must remain cumulative');

  const removed = snapshotMerge.createSnapshot({ identity, image, reason: 'crop-exit' });
  const afterRemovalEffect = snapshotMerge.createSnapshot({ identity, image, previous: removed, reason: 'opacity' });
  assert.equal(afterRemovalEffect.cropAction, 'remove');
  assert.ok(Object.keys(afterRemovalEffect.cropRemovalImgStylePatch).length > 0);
});

test('pending crop topology survives a stale editor DOM replacement', () => {
  const identity = { editId: 'img-stale' };
  const croppedImage = new FakeElement('img', {}, {
    position: 'absolute', left: '-12%', top: '-8%', width: '124%', height: '116%'
  });
  croppedImage.dataset = {};
  const cropHost = new FakeElement('span', { 'data-mpse-image-crop': '1' }, {
    position: 'relative', width: '64%', overflow: 'hidden'
  });
  const pendingEnsure = snapshotMerge.createSnapshot({
    identity, image: croppedImage, cropHost, reason: 'crop'
  });

  const staleUnwrappedImage = new FakeElement('img', {}, { width: '64%', opacity: '0.4' });
  staleUnwrappedImage.dataset = {};
  const ensureWithOpacity = snapshotMerge.createSnapshot({
    identity, image: staleUnwrappedImage, previous: pendingEnsure, reason: 'opacity'
  });
  assert.equal(ensureWithOpacity.cropAction, 'ensure');
  assert.deepEqual(ensureWithOpacity.cropCreateImgStylePatch, pendingEnsure.cropCreateImgStylePatch);
  assert.deepEqual(ensureWithOpacity.cropCreateHostStylePatch, pendingEnsure.cropCreateHostStylePatch);
  assert.deepEqual(ensureWithOpacity.imgStylePatch.position, pendingEnsure.imgStylePatch.position);
  assert.deepEqual(ensureWithOpacity.imgStylePatch.width, pendingEnsure.imgStylePatch.width);
  assert.equal(ensureWithOpacity.hostStylePatch.opacity.value, '0.4');

  const unwrappedImage = new FakeElement('img', {}, { width: '64%', opacity: '0.8' });
  unwrappedImage.dataset = {};
  const pendingRemove = snapshotMerge.createSnapshot({
    identity, image: unwrappedImage, reason: 'crop-exit'
  });
  const staleHost = new FakeElement('span', { 'data-mpse-image-crop': '1' }, { opacity: '0.3' });
  const staleNestedImage = new FakeElement('img', {}, { position: 'absolute', width: '120%' });
  staleNestedImage.dataset = {};
  const removeWithOpacity = snapshotMerge.createSnapshot({
    identity, image: staleNestedImage, cropHost: staleHost, previous: pendingRemove, reason: 'opacity'
  });
  assert.equal(removeWithOpacity.cropAction, 'remove');
  assert.deepEqual(removeWithOpacity.cropRemovalImgStylePatch, pendingRemove.cropRemovalImgStylePatch);
  assert.equal(removeWithOpacity.imgStylePatch.opacity.value, '0.3');
});

test('crop reconciliation keeps the latest image node and non-managed host content', () => {
  const parent = new FakeElement('section');
  const image = new FakeElement('img', { src: 'native-new.jpg', alt: 'native alt' }, { color: 'blue' });
  const tail = new FakeElement('span', { 'data-native-tail': '1' });
  parent.appendChild(image);
  parent.appendChild(tail);

  const ensured = snapshotMerge.reconcileCropHost(image, null, 'ensure', () => new FakeElement('span'));
  assert.equal(ensured.target, image);
  assert.equal(image.parentNode, ensured.host);
  assert.deepEqual(parent.children, [ensured.host, tail]);
  assert.equal(image.getAttribute('src'), 'native-new.jpg');
  assert.equal(image.getAttribute('alt'), 'native alt');

  ensured.host.setAttribute('class', 'native-host-class');
  ensured.host.setAttribute('data-native-host', 'keep');
  ensured.host.setAttribute('data-mpse-stale', 'remove');
  ensured.host.style.setProperty('color', 'purple');
  ensured.host.style.setProperty('width', '90%');
  snapshotMerge.applyStylePatch(ensured.host, { width: { value: '60%', priority: 'important' } });
  snapshotMerge.syncAttributes(
    ensured.host,
    { 'data-mpse-image-crop': '1', 'data-mpse-crop-x': '0.2' },
    (name) => name.startsWith('data-mpse-')
  );
  assert.equal(ensured.host.getAttribute('class'), 'native-host-class');
  assert.equal(ensured.host.getAttribute('data-native-host'), 'keep');
  assert.equal(ensured.host.getAttribute('data-mpse-stale'), null);
  assert.equal(ensured.host.style.getPropertyValue('width'), '60%');
  assert.equal(ensured.host.style.getPropertyValue('color'), 'purple');

  const nativeNote = new FakeElement('i', { 'data-native-note': 'keep' });
  ensured.host.appendChild(nativeNote);
  const removed = snapshotMerge.reconcileCropHost(image, ensured.host, 'remove', () => null);
  assert.equal(removed.target, image);
  assert.equal(removed.host, null);
  assert.deepEqual(parent.children, [image, nativeNote, tail]);
  assert.equal(nativeNote.getAttribute('data-native-note'), 'keep');

  const imageTools = readText('src/image-tools.js');
  assert.doesNotMatch(imageTools, /replaceChild\(replacement, replaceTarget\)/);
  assert.match(imageTools, /snapshotMerge\.applyStylePatch\(target, snapshot\.imgStylePatch\)/);
});

test('crop mode entry stays local until a real geometry operation', () => {
  const imageTools = readText('src/image-tools.js');
  const enter = imageTools.match(/function enterCropMode\(image\) \{[\s\S]*?\n  \}\n\n  function exitCropMode/);
  const reacquire = imageTools.match(/function reacquireSelectedImage\(identity = state\.identity\) \{[\s\S]*?\n  \}\n\n  function rebaseInteractionAfterEditorWrite/);
  const exit = imageTools.match(/function exitCropMode\(\) \{[\s\S]*?\n  \}\n\n  const controlsFactory/);
  const pointer = imageTools.match(/function onDocumentPointer\(event\) \{[\s\S]*?\n  \}\n\n  function onDocumentDoubleClick/);
  const wheel = imageTools.match(/function onDocumentWheel\(event\) \{[\s\S]*?\n  \}\n\n  function onDocumentPointerMove/);
  const queueZoom = imageTools.match(/function queueCropZoom\(image, event\) \{[\s\S]*?\n  \}\n\n  function restoreGeometryGesture/);

  assert.ok(enter && reacquire && exit && pointer && wheel && queueZoom, 'transient crop lifecycle must exist');
  assert.doesNotMatch(enter[0], /ensureCropContainer|captureImageBase|markChanged|scheduleContentCommit/);
  assert.match(pointer[0], /state\.cropMode && image === state\.image[\s\S]*?beginCropPan\(image, event\)/);
  assert.doesNotMatch(pointer[0], /state\.cropMode && image === state\.image && getCropContainer/);
  assert.match(wheel[0], /queueCropZoom\(image, event\)/);
  assert.doesNotMatch(wheel[0], /!getCropContainer\(image\)/);
  assert.match(queueZoom[0], /ensureCropContainer\(image\)[\s\S]*?deferContentCommitForGesture\(\)/);
  assert.match(reacquire[0], /state\.cropMode && state\.cropTransientHost && !getCropContainer\(best\)/);
  assert.match(reacquire[0], /ensureCropContainer\(best\)/);
  assert.doesNotMatch(reacquire[0], /markChanged|scheduleContentCommit/);
  assert.match(exit[0], /state\.pendingSnapshots\.get\(imageIdentityKey\(imageSignature\(image\)\)\)/);
  assert.doesNotMatch(exit[0], /state\.lastSnapshot\?\.cropAction/);

  for (const property of ['box-shadow', 'opacity', 'outline', 'mask-image']) {
    assert.ok(snapshotMerge.properties.cropCreateImage.includes(property), `${property} must survive topology creation`);
    assert.equal(snapshotMerge.properties.cropImage.includes(property), false, `${property} is not geometry-owned`);
  }
});

test('bridge request implementation is centralized in bridge-client', () => {
  const bridgeClient = readText('src/bridge-client.js');
  assert.match(bridgeClient, /window\.__MPSE_BRIDGE_CLIENT__/);
  assert.match(bridgeClient, /function requestBridge\(/);
  assert.match(bridgeClient, /function injectBridge\(/);

  for (const file of [
    'src/content.js',
    'src/image-tools.js',
    'src/svg-tools.js',
    'src/svg-block-tools.js'
  ]) {
    const source = readText(file);
    assert.match(source, /__MPSE_BRIDGE_CLIENT__/, `${file} must use shared bridge client`);
    assert.doesNotMatch(source, /function getExtensionResourceUrl\(/, `${file} must not duplicate resource lookup`);
    assert.doesNotMatch(source, /function injectBridge\(/, `${file} must not duplicate bridge injection`);
    assert.doesNotMatch(source, /function requestBridge\(/, `${file} must not duplicate bridge requests`);
  }
});

test('editor writes are serialized and uncertain JSAPI writes never fall back concurrently', () => {
  const pageBridge = readText('src/page-bridge.js');

  assert.match(pageBridge, /let setContentQueue = Promise\.resolve\(\)/);
  assert.match(pageBridge, /function enqueueSetContent\(/);
  assert.match(pageBridge, /const SET_CONFIRM_TIMEOUT_MS = 5000/);
  assert.match(pageBridge, /invokeMpEditor\('mp_editor_set_content', \{ content \}, SET_CONFIRM_TIMEOUT_MS, api\)/);
  assert.match(pageBridge, /writeStateUncertain = true;[\s\S]*?throw uncertainWrite\(\)/);
  assert.match(pageBridge, /async function waitForPendingSetContent\(\) \{[\s\S]*?if \(writeStateUncertain\) throw uncertainWrite\(\)/);
  assert.match(pageBridge, /await enqueueSetContent\(html, expectedContent, expectedMode\)/);
});

test('all editor tools share one atomic content mutation queue', () => {
  const bridgeClient = readText('src/bridge-client.js');
  const mutate = bridgeClient.match(/function mutateContent\(mutator, timeoutMs = 15000\) \{[\s\S]*?\n  \}\n\n  window\.__MPSE_BRIDGE_CLIENT__/);

  assert.ok(mutate, 'shared content mutation function must exist');
  assert.match(bridgeClient, /let contentOperationQueue = Promise\.resolve\(\)/);
  assert.match(bridgeClient, /function enqueueContentOperation\(operation\)/);
  assert.match(bridgeClient, /function readContent\(timeoutMs = 15000\) \{[\s\S]*?return enqueueContentOperation/);
  assert.match(bridgeClient, /function writeContent\(content\) \{[\s\S]*?return enqueueContentOperation/);
  assert.match(mutate[0], /return enqueueContentOperation\(async \(\) => \{/);
  assert.match(mutate[0], /requestBridge\('GET_CONTENT'/);
  assert.match(mutate[0], /normalizeMutationResult\(await mutator\(read\), currentContent\)/);
  assert.match(mutate[0], /requestBridge\('SET_CONTENT'/);

  for (const file of ['src/image-tools.js', 'src/svg-tools.js', 'src/svg-block-tools.js']) {
    const source = readText(file);
    assert.match(source, /bridgeClient\.mutateContent/, `${file} must use atomic content mutations`);
    assert.match(source, /mutateEditorContent\(\(current\) => \{/, `${file} must mutate the latest editor content`);
    assert.doesNotMatch(source, /requestBridge\('(?:GET|SET)_CONTENT'/, `${file} must not bypass the shared queue`);
  }

  const content = readText('src/content.js');
  assert.match(content, /bridgeClient\.writeContent/);
  assert.doesNotMatch(content, /requestBridge\('(?:GET|SET)_CONTENT'/);
});

test('README presents product updates without internal development wording', () => {
  const readme = readText('README.md');
  const css = readText('src/overlay.css');

  assert.match(readme, /\[查看更新日志\]\(CHANGELOG\.md\)/);
  assert.doesNotMatch(readme, /自检|旧版|开发阶段/);
  assert.doesNotMatch(css, /\/\*\s*v\d+\.\d+\.\d+/i);
});

test('public release files avoid internal release-log wording', () => {
  const publicFiles = [
    'README.md',
    'CHANGELOG.md',
    'docs/wechat-interface-notes.md',
    'src/content.js',
    'src/image-geometry.js',
    'src/image-controls.js',
    'src/image-snapshot-merge.js',
    'src/image-tools.js',
    'src/svg-tools.js',
    'src/svg-block-tools.js',
    'src/overlay.css'
  ];

  for (const file of publicFiles) {
    const source = readText(file);
    assert.doesNotMatch(source, /自检|旧版|开发阶段|v\d+\.\d+\.\d+ 生成|旧 SVG/, file);
  }

  assert.equal(fs.existsSync(path.join(rootDir, 'docs', 'self-check-v0.9.4.md')), false);
});

test('production comments are concise and professional', () => {
  for (const file of [
    'src/content.js',
    'src/image-geometry.js',
    'src/image-controls.js',
    'src/image-snapshot-merge.js',
    'src/image-tools.js',
    'src/page-bridge.js',
    'src/svg-tools.js',
    'src/svg-block-tools.js',
    'src/overlay.css'
  ]) {
    const source = readText(file);
    assert.doesNotMatch(source, /\/\/\s*(ignore|fall through)\b/i, file);
    assert.doesNotMatch(source, /catch\s*\([^)]*\)\s*\{\s*\}/, file);
    assert.doesNotMatch(source, /壹伴|临时|随便|凑合|低级|垃圾|屎山|忽略/i, file);
  }
});
