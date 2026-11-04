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

  vm.runInContext(`
    items = [{ id: 'hist1', name: 'Mercado', valueCents: 15000, date: '2026-01-10', category: '🛒 Mercado', type: 'expense', paid: true, recurrence: null, createdAt: 1 }];
    openSheet();
    document.getElementById('fName').value = 'Mercado';
    applyNameAutoFill();
    renderNameSuggestions('Merc');
  `, context);
  assert.equal(elements.get('fValue').dataset.raw, '15000');
  assert.equal(elements.get('fCategory').value, '🛒 Mercado');
  assert.equal(elements.get('nameSuggestWrap').hidden, false);
  assert.match(elements.get('nameSuggest').innerHTML, /Mercado/);

  const parsed = vm.runInContext('parseQuickAdd("aluguel 1200 dia 5 mensal")', context);
  assert.equal(parsed.recurrence, 'monthly');
  assert.equal(parsed.value, 120000);
  assert.equal(parsed.name, 'aluguel');

  vm.runInContext('toggleBalanceVisibility()', context);
  assert.equal(elements.get('heroBalance').textContent, 'R$ ••••');

  vm.runInContext('switchView("analysis")', context);
  const analysis = elements.get('analysisWrap').innerHTML;
  assert.match(analysis, /Previsão por mês/);
  assert.match(analysis, /3 meses/);

  vm.runInContext('openSettings()', context);
  assert.equal(elements.get('setCashflowDays').value, 7);
});
