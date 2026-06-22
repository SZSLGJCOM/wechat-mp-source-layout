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

  assert(!/v\d+\.\d+\.\d+/i.test(readme), 'README should avoid historical version headings');
  assert(!/更新|自检|旧版|开发阶段/.test(readme), 'README should avoid release-log or development wording');
  assert(!/\/\*\s*v\d+\.\d+\.\d+/i.test(css), 'overlay.css should avoid historical version comments');

  for (const file of [
    'README.md',
    'docs/wechat-interface-notes.md',
    'src/content.js',
    'src/image-tools.js',
    'src/svg-tools.js',
    'src/svg-block-tools.js',
    'src/overlay.css'
  ]) {
    assert(!/自检|旧版|开发阶段|v\d+\.\d+\.\d+ 生成|旧 SVG/.test(readText(file)), `${file} contains internal release wording`);
  }

  assert(!fs.existsSync(resolvePath('docs/self-check-v0.9.4.md')), 'docs/self-check-v0.9.4.md should not be published');
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
checkBridgeCentralization();
checkProductWording();
checkJavaScriptSyntax();

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join('\n'));
  process.exit(1);
}

console.log('extension verification ok');
