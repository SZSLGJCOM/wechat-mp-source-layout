#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];

function resolvePath(relativePath) {
  return path.join(rootDir, relativePath);
}

function readText(relativePath) {
  return fs.readFileSync(resolvePath(relativePath), 'utf8');
}

function readJson(relativePath) {
  try {
    return JSON.parse(readText(relativePath));
  } catch (error) {
    errors.push(`${relativePath} is not valid JSON: ${error.message}`);
    return null;
  }
}

function assertFile(relativePath) {
  if (!fs.existsSync(resolvePath(relativePath))) {
    errors.push(`Missing file: ${relativePath}`);
  }
}

function assert(condition, message) {
  if (!condition) errors.push(message);
}

function listFiles(dir, ext) {
  const out = [];
  for (const entry of fs.readdirSync(resolvePath(dir), { withFileTypes: true })) {
    const relativePath = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(relativePath, ext));
    } else if (entry.isFile() && relativePath.endsWith(ext)) {
      out.push(relativePath);
    }
  }
  return out;
}

function checkManifest() {
  const manifest = readJson('manifest.json');
  if (!manifest) return;

  assert(manifest.manifest_version === 3, 'manifest_version must be 3');
  assert(typeof manifest.name === 'string' && manifest.name.length > 0, 'manifest.name is required');
  assert(typeof manifest.version === 'string' && manifest.version.length > 0, 'manifest.version is required');

  const script = manifest.content_scripts?.[0];
  const js = script?.js || [];
  const css = script?.css || [];

  assert(js[0] === 'src/bridge-client.js', 'src/bridge-client.js must be the first content script');
  for (const file of [...js, ...css]) assertFile(file);

  const accessibleResources = manifest.web_accessible_resources
    ?.flatMap((entry) => entry.resources || []) || [];
  assert(accessibleResources.includes('src/page-bridge.js'), 'src/page-bridge.js must be web accessible');
  for (const file of accessibleResources) assertFile(file);

  for (const icon of Object.values(manifest.icons || {})) assertFile(icon);
}

function checkPackaging() {
  const pkg = readJson('package.json');
  const packager = readText('tools/package-extension.mjs');
  assert(pkg?.scripts?.package === 'node tools/package-extension.mjs', 'package command is required');
  assertFile('tools/package-extension.mjs');
  assert(/releaseSlug = 'gongzhonghao-yuanma-paiban-zhushou'/.test(packager), 'package folder must use the ASCII product slug');
}

function checkVersionConsistency() {
  const manifest = readJson('manifest.json');
  const pkg = readJson('package.json');
  if (!manifest || !pkg) return;
  const version = manifest.version;
  const releaseVersion = manifest.version_name || version;
  assert(pkg.version === version, 'package.json and manifest.json versions must match');
  assert(readText('README.md').includes(`当前版本：\`v${releaseVersion}\``), 'README current version must match manifest version_name');
  assert(readText('CHANGELOG.md').includes(`## v${releaseVersion} ·`), 'CHANGELOG must include the current release version');
  assert(readText('src/bridge-client.js').includes(`const VERSION = 'v${version}';`), 'bridge-client version must match manifest.json');
  assert(readText('src/image-tools.js').includes(`const VERSION = 'v${version}';`), 'image-tools version must match manifest.json');
}

function checkLicense() {
  const license = readText('LICENSE');
  const readme = readText('README.md');
  const pkg = readJson('package.json');
  const manifest = readJson('manifest.json');

  assert(/PolyForm Noncommercial License 1\.0\.0/.test(license), 'LICENSE must use PolyForm Noncommercial License 1.0.0');
  assert(/Noncommercial Purposes/.test(license), 'LICENSE must include noncommercial purpose terms');
  assert(!/MIT License/.test(license), 'LICENSE must not use MIT terms');
  assert(pkg && pkg.license === 'PolyForm-Noncommercial-1.0.0', 'package.json must declare PolyForm-Noncommercial-1.0.0');
  assert(!/源码公开|非商用|商业使用|开源|授权/.test(readme), 'README introduction must stay product-focused');
  assert(manifest && !/源码公开|非商用|开源|授权/.test(manifest.description || ''), 'manifest.description must stay product-focused');
}

function checkBridgeCentralization() {
  assertFile('src/bridge-client.js');
  if (!fs.existsSync(resolvePath('src/bridge-client.js'))) return;

  const bridgeClient = readText('src/bridge-client.js');
  assert(/window\.__MPSE_BRIDGE_CLIENT__/.test(bridgeClient), 'bridge-client must expose window.__MPSE_BRIDGE_CLIENT__');
  assert(/function requestBridge\(/.test(bridgeClient), 'bridge-client must implement requestBridge');
  assert(/function injectBridge\(/.test(bridgeClient), 'bridge-client must implement injectBridge');

  for (const file of [
    'src/content.js',
    'src/image-tools.js',
    'src/svg-tools.js',
    'src/svg-block-tools.js'
  ]) {
    const source = readText(file);
    assert(/__MPSE_BRIDGE_CLIENT__/.test(source), `${file} must use the shared bridge client`);
    assert(!/function getExtensionResourceUrl\(/.test(source), `${file} duplicates resource lookup`);
    assert(!/function injectBridge\(/.test(source), `${file} duplicates bridge injection`);
    assert(!/function requestBridge\(/.test(source), `${file} duplicates bridge requests`);
  }
}

function checkProductWording() {
  const readme = readText('README.md');
  const css = readText('src/overlay.css');

  assert(/\[查看更新日志\]\(CHANGELOG\.md\)/.test(readme), 'README should link to the changelog');
  assert(!/自检|旧版|开发阶段/.test(readme), 'README should avoid internal development wording');
  assert(!/\/\*\s*v\d+\.\d+\.\d+/i.test(css), 'overlay.css should avoid historical version comments');

  for (const file of [
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
  ]) {
    assert(!/自检|旧版|开发阶段|v\d+\.\d+\.\d+ 生成|旧 SVG/.test(readText(file)), `${file} contains internal development wording`);
  }

  assert(!fs.existsSync(resolvePath('docs/self-check-v0.9.4.md')), 'docs/self-check-v0.9.4.md should not be published');
}

function checkCommentHygiene() {
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
    assert(!/\/\/\s*(ignore|fall through)\b/i.test(source), `${file} contains low-value comments`);
    assert(!/catch\s*\([^)]*\)\s*\{\s*\}/.test(source), `${file} contains empty catch blocks`);
    assert(!/壹伴|临时|随便|凑合|低级|垃圾|屎山|忽略/i.test(source), `${file} contains unprofessional wording`);
  }
}

function checkJavaScriptSyntax() {
  for (const file of listFiles('src', '.js')) {
    const result = spawnSync(process.execPath, ['--check', resolvePath(file)], {
      cwd: rootDir,
      encoding: 'utf8'
    });
    if (result.status !== 0) {
      errors.push(`${file} failed node --check:\n${result.stdout}${result.stderr}`);
    }
  }
}

checkManifest();
checkPackaging();
checkVersionConsistency();
checkLicense();
checkBridgeCentralization();
checkProductWording();
checkCommentHygiene();
checkJavaScriptSyntax();

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join('\n'));
  process.exit(1);
}

console.log('extension verification ok');
