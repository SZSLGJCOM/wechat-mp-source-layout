import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function closeTo(actual, expected, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} must be close to ${expected}`);
}

export class FakeStyle {
  constructor(values = {}) {
    this.values = new Map(Object.entries(values).map(([name, value]) => [name, { value, priority: '' }]));
  }

  getPropertyValue(name) {
    return this.values.get(name)?.value || '';
  }

  getPropertyPriority(name) {
    return this.values.get(name)?.priority || '';
  }

  setProperty(name, value, priority = '') {
    this.values.set(name, { value: String(value), priority: String(priority) });
  }

  removeProperty(name) {
    this.values.delete(name);
  }
}

export class FakeElement {
  constructor(tagName, attributes = {}, styles = {}) {
    this.tagName = tagName.toUpperCase();
    this.attributeValues = new Map(Object.entries(attributes));
    this.style = new FakeStyle(styles);
    this.children = [];
    this.parentNode = null;
  }

  get attributes() {
    return Array.from(this.attributeValues, ([name, value]) => ({ name, value }));
  }

  get firstChild() {
    return this.children[0] || null;
  }

  getAttribute(name) {
    return this.attributeValues.get(name) || null;
  }

  setAttribute(name, value) {
    this.attributeValues.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributeValues.delete(name);
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child, reference) {
    if (child.parentNode) child.parentNode.removeChild(child);
    const index = this.children.indexOf(reference);
    child.parentNode = this;
    if (index === -1) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index !== -1) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
}

export function readText(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

export function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}
