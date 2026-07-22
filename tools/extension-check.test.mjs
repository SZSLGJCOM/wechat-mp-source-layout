import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readText(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

test('repository exposes one-command extension verification', () => {
  const packagePath = path.join(rootDir, 'package.json');
  const verifierPath = path.join(rootDir, 'tools', 'verify-extension.mjs');

  assert.equal(fs.existsSync(packagePath), true, 'package.json must exist');
  assert.equal(fs.existsSync(verifierPath), true, 'tools/verify-extension.mjs must exist');

  const pkg = readJson('package.json');
  assert.equal(pkg.scripts?.check, 'node tools/verify-extension.mjs');
  assert.match(pkg.scripts?.test || '', /node --test tools\/extension-check\.test\.mjs/);

  const result = spawnSync(process.execPath, ['tools/verify-extension.mjs'], {
    cwd: rootDir,
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
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
    'src/image-tools.js',
    'src/svg-tools.js',
    'src/svg-block-tools.js'
  ]);

  const exposed = manifest.web_accessible_resources
    ?.flatMap((entry) => entry.resources || []) || [];
  assert.ok(exposed.includes('src/page-bridge.js'));
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

test('README and stylesheet avoid historical version churn', () => {
  const readme = readText('README.md');
  const css = readText('src/overlay.css');

  assert.doesNotMatch(readme, /v\d+\.\d+\.\d+/i);
  assert.doesNotMatch(readme, /更新|自检|旧版|开发阶段/);
  assert.doesNotMatch(css, /\/\*\s*v\d+\.\d+\.\d+/i);
});

test('public release files avoid internal release-log wording', () => {
  const publicFiles = [
    'README.md',
    'docs/wechat-interface-notes.md',
    'src/content.js',
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

test('image controls separate panel state from persisted edits', () => {
  const imageTools = readText('src/image-tools.js');
  const css = readText('src/overlay.css');

  assert.match(imageTools, /activePanel: null/);
  assert.doesNotMatch(imageTools, /effectMemory/);
  assert.doesNotMatch(imageTools, /showPanel\(effect, true\)/);
  assert.doesNotMatch(imageTools, /doc\.addEventListener\('click', onDocumentPointer/);
  assert.match(imageTools, /function beginGeometryGesture\(/);
  assert.match(imageTools, /function enterCropMode\(/);
  assert.match(imageTools, /function applyCropSnapshot\(/);
  assert.match(imageTools, /data-mpse-image-crop/);
  assert.match(css, /\.mpse-img2-handle-nw/);
  assert.match(css, /#mpse-img2-box\.mpse-crop-mode/);
  assert.doesNotMatch(css, /mpse-active::after/);
});
