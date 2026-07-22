#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'manifest.json'), 'utf8'));
const productName = String(manifest.name || '').trim().replace(/[\\/:*?"<>|]/g, '');
const version = String(manifest.version || '').trim();
const releaseSlug = 'gongzhonghao-yuanma-paiban-zhushou';
const packageFiles = ['manifest.json', 'src', 'icons', 'README.md', 'CHANGELOG.md', 'LICENSE'];

if (!productName || !version) {
  throw new Error('manifest.json must provide a product name and version');
}

for (const file of packageFiles) {
  if (!fs.existsSync(path.join(rootDir, file))) {
    throw new Error(`Missing package file: ${file}`);
  }
}

const outputDir = path.join(rootDir, 'release');
const archivePath = path.join(outputDir, `${releaseSlug}-v${version}.zip`);
fs.mkdirSync(outputDir, { recursive: true });

if (fs.existsSync(archivePath)) fs.rmSync(archivePath);

try {
  execFileSync('git', [
    'archive',
    '--format=zip',
    `--output=${archivePath}`,
    `--prefix=${productName}/`,
    'HEAD',
    ...packageFiles
  ], { cwd: rootDir, stdio: 'inherit' });
} catch (error) {
  if (fs.existsSync(archivePath)) fs.rmSync(archivePath);
  throw error;
}

console.info(`已生成“${productName}”安装包：${path.relative(rootDir, archivePath)}`);
