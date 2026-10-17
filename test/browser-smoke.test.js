'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const root = path.resolve(__dirname, '..');

function element(id) {
  return {
    id, value: '', textContent: '', innerHTML: '', className: '', hidden: false,
    checked: false, style: {}, dataset: {}, files: [],
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, setAttribute() {}, focus() {}, click() {},
    setSelectionRange() {}, closest() { return null; }
  };
}

test('aplicação inicializa com DOM limpo e sem manipuladores inline', async () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const ui = fs.readFileSync(path.join(root, 'js/script.js'), 'utf8');
  assert.doesNotMatch(html, /\son(?:click|change|input|keydown)=/i);
  assert.doesNotMatch(ui, /\son(?:click|change|input|keydown)=/i);

  const elements = new Map();
  const document = {
    documentElement: element('html'), visibilityState: 'visible',
    getElementById(id) { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); },
    querySelectorAll() { return []; },
    addEventListener() {}, createElement(tag) { return element(tag); }
  };
  const local = new Map();
  const context = vm.createContext({
    console, document, crypto: webcrypto, TextEncoder, Uint8Array, Date, Math, JSON,
    setTimeout, clearTimeout, Blob, URL,
    localStorage: {
      getItem(key) { return local.has(key) ? local.get(key) : null; },
      setItem(key, value) { local.set(key, String(value)); }
    },
    navigator: { onLine: true }, addEventListener() {},
    location: { reload() {} }, confirm: () => true
  });
  context.window = context;
  context.globalThis = context;

  for (const file of ['core.js', 'storage.js', 'notifications.js', 'script.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'js', file), 'utf8'), context, { filename: file });
  }
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(elements.get('heroBalance').textContent, 'R$ 0,00');
  assert.equal(elements.get('lockScreen').hidden, true);
  vm.runInContext('toggleBalanceVisibility()', context);
  assert.equal(elements.get('heroBalance').textContent, 'R$ ••••');
});
