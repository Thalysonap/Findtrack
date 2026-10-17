(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.FintrackCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DATA_VERSION = 2;
  const VALID_TYPES = new Set(['expense', 'income']);

  function localDateStr(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function isValidDate(value) {
    if (value === '') return true;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
    const [y, m, d] = value.split('-').map(Number);
    const parsed = new Date(y, m - 1, d);
    return parsed.getFullYear() === y && parsed.getMonth() === m - 1 && parsed.getDate() === d;
  }

  function amountToCents(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number * 100) : 0;
  }

  function centsToAmount(cents) {
    const number = Number(cents);
    return Number.isSafeInteger(number) ? number / 100 : 0;
  }

  function parseMoneyToCents(value) {
    if (value == null) return 0;
    let text = String(value).replace(/[^\d.,-]/g, '');
    if (!text) return 0;
    const hasComma = text.includes(',');
    const hasDot = text.includes('.');
    if (hasComma && hasDot) text = text.replace(/\./g, '').replace(',', '.');
    else if (hasComma) text = text.replace(',', '.');
    else if (hasDot) {
      const after = text.split('.').pop();
      if (after.length === 3 && text.length > 4) text = text.replace(/\./g, '');
    }
    return amountToCents(Number.parseFloat(text));
  }

  function normalizeItem(raw, makeId) {
    if (!raw || typeof raw !== 'object') return null;
    const name = String(raw.name || '').trim().slice(0, 80);
    const type = VALID_TYPES.has(raw.type) ? raw.type : null;
    const date = raw.date == null ? '' : String(raw.date);
    const category = String(raw.category || (type === 'income' ? '➕ Outras entradas' : '📦 Outros')).trim().slice(0, 80);
    let valueCents = Number.isSafeInteger(raw.valueCents) ? raw.valueCents : amountToCents(raw.value);
    if (!name || !type || !isValidDate(date) || valueCents <= 0 || valueCents > 999999999999) return null;
    return {
      id: typeof makeId === 'function' ? makeId() : String(raw.id || ''),
      name,
      valueCents,
      date,
      category,
      type,
      paid: type === 'expense' ? !!raw.paid : false,
      recurrence: raw.recurrence === 'monthly' && type === 'expense' ? 'monthly' : null,
      createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : Date.now()
    };
  }

  function migrateItems(rawItems, makeId) {
    if (!Array.isArray(rawItems)) return [];
    const ids = new Set();
    return rawItems.map(raw => normalizeItem(raw, () => {
      let id = String(raw && raw.id || '');
      if (!/^[A-Za-z0-9_-]{6,80}$/.test(id) || ids.has(id)) id = makeId();
      ids.add(id);
      return id;
    })).filter(Boolean);
  }

  function migrateSettings(raw, defaults) {
    const base = defaults();
    const source = raw && typeof raw === 'object' ? raw : {};
    const settings = {
      ...base,
      ...source,
      alerts: { ...base.alerts, ...(source.alerts || {}) },
      budgets: Object.create(null),
      goals: []
    };
    const isV2 = Number(source.dataVersion) >= DATA_VERSION;
    for (const [category, value] of Object.entries(source.budgets || {})) {
      const cents = isV2 && Number.isSafeInteger(value) ? value : amountToCents(value);
      if (cents > 0) settings.budgets[String(category).slice(0, 80)] = cents;
    }
    settings.goals = Array.isArray(source.goals) ? source.goals.map(goal => {
      const targetCents = isV2 && Number.isSafeInteger(goal.targetCents) ? goal.targetCents : amountToCents(goal.target);
      const savedCents = isV2 && Number.isSafeInteger(goal.savedCents) ? goal.savedCents : amountToCents(goal.saved);
      if (!goal || !String(goal.name || '').trim() || targetCents <= 0) return null;
      return {
        id: String(goal.id || '').slice(0, 80),
        name: String(goal.name).trim().slice(0, 50),
        targetCents,
        savedCents: Math.max(0, savedCents),
        deadline: isValidDate(goal.deadline || '') ? (goal.deadline || null) : null
      };
    }).filter(Boolean) : [];
    settings.dataVersion = DATA_VERSION;
    settings.balanceHidden = !!settings.balanceHidden;
    settings.pin = source.pin && /^[a-f0-9]{32}$/i.test(source.pin.salt || '') && /^[a-f0-9]{64}$/i.test(source.pin.hash || '')
      && Number(source.pin.iterations) >= 100000 && Number(source.pin.iterations) <= 1000000
      ? { salt: source.pin.salt, hash: source.pin.hash, iterations: Number(source.pin.iterations) }
      : null;
    settings.pinHash = typeof source.pinHash === 'string' && /^(?:x[a-f0-9]+|[a-f0-9]{64})$/i.test(source.pinHash) ? source.pinHash : null;
    return settings;
  }

  function sumCents(list) {
    return list.reduce((total, item) => total + (Number.isSafeInteger(item.valueCents) ? item.valueCents : 0), 0);
  }

  function calculateBalances(items, today = localDateStr()) {
    const availableIncome = sumCents(items.filter(item => item.type === 'income' && (!item.date || item.date <= today)));
    const allIncome = sumCents(items.filter(item => item.type === 'income'));
    const paidExpenses = sumCents(items.filter(item => item.type === 'expense' && item.paid));
    const allExpenses = sumCents(items.filter(item => item.type === 'expense'));
    return {
      currentCents: availableIncome - paidExpenses,
      projectedCents: allIncome - allExpenses,
      availableIncome,
      allIncome,
      paidExpenses,
      allExpenses
    };
  }

  function calculateCashFlow(items, today = localDateStr()) {
    const balances = calculateBalances(items, today);
    const events = [];
    items.forEach(item => {
      if (!item.date) return;
      if (item.type === 'expense' && !item.paid) events.push({ date: item.date < today ? today : item.date, valueCents: -item.valueCents, type: 'expense' });
      if (item.type === 'income' && item.date > today) events.push({ date: item.date, valueCents: item.valueCents, type: 'income' });
    });
    events.sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type));
    let balanceCents = balances.currentCents;
    let negativeDate = balanceCents < 0 ? today : null;
    for (const event of events) {
      balanceCents += event.valueCents;
      if (balanceCents < 0 && negativeDate === null) negativeDate = event.date;
    }
    return { balanceNowCents: balances.currentCents, endBalanceCents: balanceCents, negativeDate, events };
  }

  function createBackup(items, settings, snapshots) {
    const portableSettings = { ...settings, pin: null, pinHash: null };
    return {
      app: 'fintrack',
      version: DATA_VERSION,
      exportedAt: new Date().toISOString(),
      items,
      settings: portableSettings,
      snapshots: Array.isArray(snapshots) ? snapshots : []
    };
  }

  function parseBackup(raw, defaults, makeId) {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const legacy = Array.isArray(parsed);
    if (!legacy && (!parsed || parsed.app !== 'fintrack' || !Array.isArray(parsed.items))) throw new Error('Formato de backup inválido');
    const sourceItems = legacy ? parsed : parsed.items;
    const items = migrateItems(sourceItems, makeId);
    if (sourceItems.length && items.length !== sourceItems.length) throw new Error('Backup contém lançamentos inválidos');
    const snapshots = legacy || !Array.isArray(parsed.snapshots) ? [] : parsed.snapshots.slice(0, 20).map(snapshot => ({
      at: Number.isFinite(Number(snapshot && snapshot.at)) ? Number(snapshot.at) : Date.now(),
      label: String(snapshot && snapshot.label || 'Versão importada').slice(0, 80),
      items: migrateItems(snapshot && snapshot.items || [], makeId)
    }));
    const importedSettings = legacy ? null : migrateSettings(parsed.settings, defaults);
    if (importedSettings) { importedSettings.pin = null; importedSettings.pinHash = null; }
    return {
      items,
      settings: importedSettings,
      snapshots,
      legacy
    };
  }

  return {
    DATA_VERSION,
    localDateStr,
    isValidDate,
    amountToCents,
    centsToAmount,
    parseMoneyToCents,
    normalizeItem,
    migrateItems,
    migrateSettings,
    sumCents,
    calculateBalances,
    calculateCashFlow,
    createBackup,
    parseBackup
  };
});
