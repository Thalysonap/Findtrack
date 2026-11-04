'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../js/core.js');

const defaults = () => ({
  budgets: {}, goals: [], alerts: { due: true, budget: true, cashflow: true },
  notification: false, learnedRules: {}, dismissed: {}, spawned: {}, pinHash: null,
  pin: null, balanceHidden: false, theme: 'dark', projectionHorizon: 3, cashflowAdvanceDays: 7
});

test('converte valores brasileiros para centavos inteiros', () => {
  assert.equal(core.parseMoneyToCents('R$ 1.234,56'), 123456);
  assert.equal(core.parseMoneyToCents('19,9'), 1990);
  assert.equal(core.centsToAmount(123456), 1234.56);
});

test('valida datas reais, incluindo ano bissexto', () => {
  assert.equal(core.isValidDate('2024-02-29'), true);
  assert.equal(core.isValidDate('2025-02-29'), false);
  assert.equal(core.isValidDate('2026-13-01'), false);
});

test('migra lançamentos decimais antigos e elimina ids duplicados', () => {
  let sequence = 0;
  const items = core.migrateItems([
    { id: 'abcdef', name: 'Mercado', value: 10.25, date: '2026-10-01', category: 'Mercado', type: 'expense' },
    { id: 'abcdef', name: 'Padaria', value: 2.5, date: '2026-10-02', category: 'Alimentação', type: 'expense' }
  ], () => `generated_${++sequence}`);
  assert.deepEqual(items.map(item => item.valueCents), [1025, 250]);
  assert.notEqual(items[0].id, items[1].id);
});

test('saldo atual não inclui receita futura, mas projeção inclui', () => {
  const items = [
    { type: 'income', date: '2026-10-01', valueCents: 100000, paid: false },
    { type: 'income', date: '2026-11-01', valueCents: 50000, paid: false },
    { type: 'expense', date: '2026-10-10', valueCents: 20000, paid: true },
    { type: 'expense', date: '2026-10-25', valueCents: 30000, paid: false }
  ];
  const result = core.calculateBalances(items, '2026-10-17');
  assert.equal(result.currentCents, 80000);
  assert.equal(result.projectedCents, 100000);
});

test('projeção mensal separa cada mês e não antecipa o mês seguinte', () => {
  const items = [
    { type: 'income', date: '2026-10-05', valueCents: 100000, paid: false },
    { type: 'income', date: '2026-10-20', valueCents: 50000, paid: false },
    { type: 'income', date: '2026-11-05', valueCents: 70000, paid: false },
    { type: 'expense', date: '2026-10-10', valueCents: 20000, paid: true },
    { type: 'expense', date: '2026-10-25', valueCents: 30000, paid: false },
    { type: 'expense', date: '2026-11-10', valueCents: 40000, paid: false },
    { type: 'expense', date: '2026-09-15', valueCents: 10000, paid: false }
  ];
  const [oct, nov, dec] = core.calculateMonthlyProjection(items, '2026-10-17', 3);
  assert.equal(oct.month, '2026-10');
  assert.equal(oct.overdueCents, 10000);
  assert.equal(oct.closingCents, 90000);
  assert.equal(nov.month, '2026-11');
  assert.equal(nov.incomeCents, 70000);
  assert.equal(nov.closingCents, 120000);
  assert.equal(dec.month, '2026-12');
  assert.equal(dec.closingCents, 120000);
});

test('projeção inclui recorrências futuras sem duplicar lançamentos existentes', () => {
  const items = [
    { id: 'recur1', name: 'Aluguel', type: 'expense', category: '🏠 Moradia', date: '2026-10-10', valueCents: 100000, paid: true, recurrence: 'monthly' },
    { id: 'recur2', name: 'Aluguel', type: 'expense', category: '🏠 Moradia', date: '2026-11-10', valueCents: 100000, paid: false, recurrence: 'monthly' }
  ];
  const [oct, nov, dec, jan] = core.calculateMonthlyProjection(items, '2026-10-17', 4);
  assert.equal(oct.expenseCents, 100000);
  assert.equal(nov.expenseCents, 100000);
  assert.equal(dec.expenseCents, 100000);
  assert.equal(jan.expenseCents, 100000);
});

test('fluxo de caixa aplica receitas e despesas futuras em suas datas', () => {
  const items = [
    { type: 'income', date: '2026-10-01', valueCents: 10000, paid: false },
    { type: 'expense', date: '2026-10-20', valueCents: 15000, paid: false },
    { type: 'income', date: '2026-10-19', valueCents: 10000, paid: false }
  ];
  const result = core.calculateCashFlow(items, '2026-10-17');
  assert.equal(result.balanceNowCents, 10000);
  assert.equal(result.endBalanceCents, 5000);
  assert.equal(result.negativeDate, null);
});

test('configurações normalizam horizonte e antecedência do alerta', () => {
  const settings = core.migrateSettings({ projectionHorizon: 9, cashflowAdvanceDays: 999 }, defaults);
  assert.equal(settings.projectionHorizon, 3);
  assert.equal(settings.cashflowAdvanceDays, 60);
  const valid = core.migrateSettings({ projectionHorizon: 12, cashflowAdvanceDays: 14 }, defaults);
  assert.equal(valid.projectionHorizon, 12);
  assert.equal(valid.cashflowAdvanceDays, 14);
});

test('backup versionado preserva configurações e rejeita itens inválidos', () => {
  const backup = core.createBackup([], { theme: 'light', pinHash: 'a'.repeat(64), pin: { salt: 'b'.repeat(32), hash: 'c'.repeat(64), iterations: 210000 } }, []);
  assert.equal(backup.settings.pin, null);
  assert.equal(backup.settings.pinHash, null);
  const parsed = core.parseBackup(JSON.stringify(backup), defaults, () => 'generated_1');
  assert.equal(parsed.settings.theme, 'light');
  assert.equal(parsed.settings.pin, null);
  assert.throws(() => core.parseBackup(JSON.stringify({
    app: 'fintrack', version: 2,
    items: [{ id: 'badbad', name: '', valueCents: -1, date: 'x', type: 'expense' }]
  }), defaults, () => 'generated_2'));
});
