'use strict';

/* ═══════════════════════════════════════════════════════════
   Fintrack — controle de gastos local (IndexedDB + offline)
   ═══════════════════════════════════════════════════════════ */

/* ─── Constantes ─────────────────────────── */
const MAX_SNAPSHOTS = 20;
const MONTHS = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
const DOW = ['D','S','T','Q','Q','S','S'];

const CHART_COLORS = ['#4DB87A','#5B6EF5','#E5A540','#E05A47','#9B7BFF','#3BC9DB','#F06595','#94D82D','#FFD43B','#845EF7','#FF922B','#20C997'];

/* ─── Estado ─────────────────────────────── */
let items = [];
let snapshots = [];
let settings = defaultSettings();
let db = null;

let currentView = 'home';
let currentTab = 'all';
let currentType = 'expense';
let editId = null;
let pendingDeleteId = null;
let heroView = 'today';
let heroBalances = { today: 0, all: 0 };
let searchTerm = '';
let recurrence = null;
let categoryManuallySet = false;
let viewMonth = currentMonthStr();
let homeMonth = currentMonthStr();
let unlocked = true;
let suggestionRefs = [];
let nameSuggestionRefs = [];
let alertRefs = [];
let persistTimer = null;
let persistPromise = Promise.resolve();
const pendingPersist = new Map();
let lockAttempts = 0;
let lockedUntil = 0;

function defaultSettings() {
  return {
    budgets: {},
    budgetRollover: false,
    goals: [],
    closedMonths: [],
    alerts: { due: true, budget: true, cashflow: true },
    notification: false,
    learnedRules: {},
    dismissed: {},
    spawned: {},
    pinHash: null,
    pin: null,
    balanceHidden: false,
    dataVersion: FintrackCore.DATA_VERSION,
    theme: 'dark',
    projectionHorizon: 3,
    cashflowAdvanceDays: 7
  };
}

/* ═══════════════════════════════════════════
   Persistência (IndexedDB com fallback)
   ═══════════════════════════════════════════ */
async function loadData() {
  await FintrackStorage.init();
  let [savedItems, savedSettings, savedSnaps] = await Promise.all([
    FintrackStorage.get('items'), FintrackStorage.get('settings'), FintrackStorage.get('snapshots')
  ]);
  // Compatibilidade com as chaves antigas.
  if (!Array.isArray(savedItems)) {
    try { savedItems = JSON.parse(localStorage.getItem('fintrack_v1')); } catch {}
  }
  if (!savedSettings) {
    try { savedSettings = JSON.parse(localStorage.getItem('fintrack_settings_v1')); } catch {}
  }
  items = FintrackCore.migrateItems(savedItems || [], newId);
  settings = FintrackCore.migrateSettings(savedSettings, defaultSettings);
  snapshots = Array.isArray(savedSnaps) ? savedSnaps.slice(0, MAX_SNAPSHOTS).map(snapshot => ({
    at: Number(snapshot.at) || Date.now(),
    label: String(snapshot.label || 'Versão salva').slice(0, 80),
    items: FintrackCore.migrateItems(snapshot.items || [], newId)
  })) : [];
  migrateCategories();
  await persistAll();
}

function migrateCategories() {
  const remap = { '💳 Cartão': '💳 Cartão & Finanças', '📱 Assinatura': '📱 Assinaturas' };
  let changed = false;
  items.forEach(i => { if (remap[i.category]) { i.category = remap[i.category]; changed = true; } });
  if (settings.budgets && typeof settings.budgets === 'object') {
    Object.keys(settings.budgets).forEach(k => {
      if (remap[k]) { settings.budgets[remap[k]] = settings.budgets[k]; delete settings.budgets[k]; changed = true; }
    });
  }
  if (settings.learnedRules && typeof settings.learnedRules === 'object') {
    Object.keys(settings.learnedRules).forEach(k => {
      if (remap[settings.learnedRules[k]]) { settings.learnedRules[k] = remap[settings.learnedRules[k]]; changed = true; }
    });
  }
  if (changed) save();
}

function save() {
  queuePersist([['items', items], ['settings', settings]]);
}

function saveSettings() {
  queuePersist([['settings', settings]]);
}

function pushSnapshot(label) {
  snapshots.unshift({ at: Date.now(), label, items: JSON.parse(JSON.stringify(items)) });
  if (snapshots.length > MAX_SNAPSHOTS) snapshots.length = MAX_SNAPSHOTS;
  queuePersist([['snapshots', snapshots]]);
}

function setSaveStatus(state, message) {
  const el = document.getElementById('saveStatus');
  if (!el) return;
  el.dataset.state = state;
  el.textContent = message || (state === 'saving' ? 'salvando…' : state === 'error' ? 'não salvo' : 'salvo');
  el.hidden = state === 'saved';
}

function queuePersist(entries) {
  clearTimeout(persistTimer);
  setSaveStatus('saving');
  entries.forEach(([key, value]) => pendingPersist.set(key, JSON.parse(JSON.stringify(value))));
  persistTimer = setTimeout(() => {
    const snapshot = [...pendingPersist.entries()];
    pendingPersist.clear();
    persistPromise = persistPromise.then(async () => {
      for (const [key, value] of snapshot) await FintrackStorage.set(key, value);
      setSaveStatus('saved');
    }).catch(error => {
      console.error('Falha ao salvar dados', error);
      setSaveStatus('error', 'erro ao salvar');
      showSnackbar('Não foi possível salvar. Exporte um backup antes de fechar.', null, null, 8000);
    });
  }, 80);
}

async function persistAll() {
  await Promise.all([
    FintrackStorage.set('items', items),
    FintrackStorage.set('settings', settings),
    FintrackStorage.set('snapshots', snapshots)
  ]).catch(error => {
    console.error('Falha ao salvar dados', error);
    setSaveStatus('error', 'erro ao salvar');
  });
}

/* ═══════════════════════════════════════════
   Utilidades
   ═══════════════════════════════════════════ */
function fmt(n) {
  if (settings.balanceHidden) return 'R$ ••••';
  return 'R$ ' + Math.abs(FintrackCore.centsToAmount(n)).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtSigned(n) {
  if (settings.balanceHidden) return 'R$ ••••';
  return (n < 0 ? '−' : '') + fmt(n);
}
function fmtShort(n) {
  if (settings.balanceHidden) return 'R$ ••••';
  n = FintrackCore.centsToAmount(n);
  const a = Math.abs(n);
  if (a >= 1000) return (n < 0 ? '-' : '') + 'R$ ' + (a / 1000).toFixed(1).replace('.', ',') + 'k';
  return (n < 0 ? '-' : '') + 'R$ ' + a.toFixed(0);
}
function fmtDate(d) {
  if (!d) return '';
  const [, m, day] = d.split('-');
  return `${day}/${m}`;
}
function fmtDateFull(d) {
  if (!d) return '';
  const [, m, day] = d.split('-');
  return `${day} ${MONTHS[parseInt(m, 10) - 1].slice(0, 3)}`;
}
const localDateStr = FintrackCore.localDateStr;
function todayStr() { return localDateStr(); }
function newId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function normalize(str) {
  return String(str).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function sum(arr) { return FintrackCore.sumCents(arr); }

/* ─── Períodos ───────────────────────────── */
function currentMonthStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function inMonth(date, ym) { return !!date && date.slice(0, 7) === ym; }
function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}
function dateInMonth(ym, day) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  const d = Math.min(Math.max(1, day || 1), last);
  return `${ym}-${String(d).padStart(2, '0')}`;
}

/* ─── Meses fechados (fechamento) ─────────── */
function isMonthClosed(ym) {
  return !!ym && settings.closedMonths.includes(ym);
}

function syncClosedMonths() {
  const cur = currentMonthStr();
  let changed = false;
  items.forEach(i => {
    const ym = i.date ? i.date.slice(0, 7) : '';
    if (ym && ym < cur && !settings.closedMonths.includes(ym)) {
      settings.closedMonths.push(ym);
      changed = true;
    }
  });
  if (changed) saveSettings();
}

function homeMonths() {
  const set = new Set();
  items.forEach(i => { if (i.date) set.add(i.date.slice(0, 7)); });
  set.add(currentMonthStr());
  if (homeMonth) set.add(homeMonth);
  return [...set].sort();
}

function monthBadge(ym) {
  if (ym === currentMonthStr()) return '<span class="month-badge">atual</span>';
  if (isMonthClosed(ym)) return '<span class="month-badge closed">fechado</span>';
  return '';
}

/* ─── Datas de vencimento ────────────────── */
function dueStatus(d) {
  if (!d) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(d + 'T00:00:00');
  const diff = Math.round((due - today) / 86400000);
  if (diff < 0) return { label: diff === -1 ? 'Venceu ontem' : `Venceu há ${Math.abs(diff)}d`, cls: 'badge-red', urgency: 0, diff };
  if (diff === 0) return { label: 'Hoje', cls: 'badge-today', urgency: 1, diff };
  if (diff === 1) return { label: 'Amanhã', cls: 'badge-yellow', urgency: 2, diff };
  if (diff <= 3) return { label: `Em ${diff}d`, cls: 'badge-yellow', urgency: 3, diff };
  return { label: fmtDateFull(d), cls: 'badge-muted', urgency: 4, diff };
}

function itemUrgency(it) {
  if (it.type === 'income') return 10;
  if (it.paid) return 6;
  const s = dueStatus(it.date);
  if (!s) return 5;
  return s.urgency;
}

function sortByUrgency(list) {
  return [...list].sort((a, b) => {
    const ua = itemUrgency(a), ub = itemUrgency(b);
    if (ua !== ub) return ua - ub;
    if (a.date && b.date) return a.date.localeCompare(b.date);
    if (a.date) return -1;
    if (b.date) return 1;
    return b.createdAt - a.createdAt;
  });
}

/* ═══════════════════════════════════════════
   Snackbar / Toast
   ═══════════════════════════════════════════ */
let snackbarTimer = null;
let snackbarCb = null;

function showSnackbar(msg, actionLabel, cb, duration = 5000) {
  const bar = document.getElementById('snackbar');
  const btn = document.getElementById('snackbarAction');
  document.getElementById('snackbarMsg').textContent = msg;
  clearTimeout(snackbarTimer);
  if (actionLabel && cb) {
    btn.style.display = 'inline-flex';
    btn.textContent = actionLabel;
    snackbarCb = cb;
  } else {
    btn.style.display = 'none';
    snackbarCb = null;
  }
  bar.classList.add('open');
  snackbarTimer = setTimeout(hideSnackbar, duration);
}
function hideSnackbar() {
  clearTimeout(snackbarTimer);
  document.getElementById('snackbar').classList.remove('open');
  snackbarCb = null;
}
function runSnackbarAction() {
  const cb = snackbarCb;
  hideSnackbar();
  if (cb) cb();
}
function toast(msg) { showSnackbar(msg, null, null, 2200); }

function markInvalid(input, msg) {
  input.classList.add('input-error');
  input.focus();
  if (msg) showSnackbar(msg, null, null, 2500);
  input.addEventListener('input', () => input.classList.remove('input-error'), { once: true });
}

/* ═══════════════════════════════════════════
   Totais e hero
   ═══════════════════════════════════════════ */
function openOverdueCents() {
  const cur = currentMonthStr();
  return sum(items.filter(i => i.type === 'expense' && !i.paid && i.date
    && i.date.slice(0, 7) < cur && !isMonthClosed(i.date.slice(0, 7))));
}

function calcTotals() {
  const cur = currentMonthStr();
  const ym = homeMonth;
  const monthItems = items.filter(i => inMonth(i.date, ym) || (!i.date && ym === cur));
  const expenses = monthItems.filter(i => i.type === 'expense');
  const income = monthItems.filter(i => i.type === 'income');
  const totalI = sum(income);
  const totalE = sum(expenses);

  if (ym === cur) {
    const balances = FintrackCore.calculateBalances(items, todayStr());
    const projection = FintrackCore.calculateMonthlyProjection(items, todayStr(), 1, settings.closedMonths);
    heroBalances.today = balances.currentCents;
    heroBalances.all = projection.length ? projection[0].closingCents : balances.projectedCents;
  } else {
    heroBalances.today = heroBalances.all = totalI - totalE;
  }
  updateHeroDisplay();

  document.getElementById('totalIncome').textContent = fmt(totalI);
  document.getElementById('totalExpense').textContent =
    fmt(ym === cur ? sum(expenses.filter(i => !i.paid)) + openOverdueCents() : totalE);

  const incLabel = document.getElementById('statIncomeLabel');
  if (incLabel) incLabel.textContent = 'Entradas do mês';
  const expLabel = document.getElementById('statExpenseLabel');
  if (expLabel) expLabel.textContent = ym === cur ? 'A pagar no mês' : isMonthClosed(ym) ? 'Saídas do mês' : 'Saídas previstas';

  const paidCount = expenses.filter(i => i.paid).length;
  const total = expenses.length;
  const pct = total ? Math.round(paidCount / total * 100) : 0;
  document.getElementById('paidCount').textContent = `${paidCount} de ${total} pagas no mês`;
  document.getElementById('paidPercent').textContent = `${pct}%`;

  const fill = document.getElementById('progressFill');
  fill.style.width = pct + '%';
  fill.style.background = pct === 100 ? 'var(--green)' : pct > 50 ? 'var(--yellow)' : 'var(--red)';

  renderTodayBadge();
}

function updateHeroDisplay() {
  const cur = currentMonthStr();
  const isCur = homeMonth === cur;
  document.getElementById('toggleToday').style.display = isCur ? '' : 'none';
  document.getElementById('toggleAll').style.display = isCur ? '' : 'none';

  const value = heroView === 'today' ? heroBalances.today : heroBalances.all;
  const el = document.getElementById('heroBalance');
  el.textContent = fmtSigned(value);
  el.className = 'hero-balance ' + (value > 0 ? 'positive' : value < 0 ? 'negative' : 'zero');

  let sub;
  if (isCur) {
    const [year, month] = cur.split('-').map(Number);
    sub = heroView === 'today' ? 'disponível hoje' : `saldo no fim de ${MONTHS[month - 1]} de ${year}`;
  } else if (isMonthClosed(homeMonth)) {
    sub = `fechamento de ${monthLabel(homeMonth)}`;
  } else {
    sub = `saldo planejado de ${monthLabel(homeMonth)}`;
  }
  document.getElementById('heroSublabel').textContent = sub;
}

function setHeroView(view) {
  heroView = view;
  document.getElementById('toggleToday').classList.toggle('active', view === 'today');
  document.getElementById('toggleAll').classList.toggle('active', view === 'all');
  updateHeroDisplay();
}

function toggleBalanceVisibility() {
  settings.balanceHidden = !settings.balanceHidden;
  saveSettings();
  updateBalanceToggle();
  render();
}

function updateBalanceToggle() {
  const button = document.getElementById('toggleBalance');
  if (!button) return;
  button.setAttribute('aria-pressed', settings.balanceHidden ? 'true' : 'false');
  button.setAttribute('aria-label', settings.balanceHidden ? 'Mostrar saldos' : 'Ocultar saldos');
  button.textContent = settings.balanceHidden ? '◉' : '◌';
}

function renderTodayBadge() {
  const today = todayStr();
  const n = items.filter(i => i.type === 'expense' && !i.paid && i.date === today && !isMonthClosed(today.slice(0, 7))).length;
  const badge = document.getElementById('todayBadge');
  if (n > 0) { badge.textContent = n; badge.style.display = 'inline-flex'; }
  else badge.style.display = 'none';
}

/* ═══════════════════════════════════════════
   Render principal
   ═══════════════════════════════════════════ */
function render() {
  syncClosedMonths();
  spawnRecurring();
  calcTotals();
  if (currentView === 'home') renderHome();
  else if (currentView === 'calendar') renderCalendar();
  else if (currentView === 'analysis') renderAnalysis();
  else if (currentView === 'plans') renderPlans();
  renderAlerts();
}

function switchView(v) {
  currentView = v;
  ['home', 'calendar', 'analysis', 'plans'].forEach(x => {
    document.getElementById('view-' + x).hidden = x !== v;
  });
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  render();
}

/* ─── Home (lista) ───────────────────────── */
function renderHome() {
  renderMonthBar();
  const wrap = document.getElementById('listWrap');
  const cur = currentMonthStr();
  const ym = homeMonth;
  const closed = isMonthClosed(ym);
  const isCur = ym === cur;

  if (searchTerm.trim()) {
    const q = normalize(searchTerm);
    let base;
    if (currentTab === 'open') base = items.filter(i => i.type === 'expense' && !i.paid);
    else if (currentTab === 'done') base = items.filter(i => i.type === 'expense' && i.paid);
    else if (currentTab === 'in') base = items.filter(i => i.type === 'income');
    else base = [...items];
    base = base.filter(i => normalize(i.name).includes(q) || normalize(i.category || '').includes(q));

    if (!base.length) {
      wrap.innerHTML = `<div class="empty"><div class="empty-icon">🔍</div><p>Nenhum resultado para "<b>${escapeHtml(searchTerm.trim())}</b>".</p><button type="button" class="empty-cta" data-action="clear-search">Limpar busca</button></div>`;
      return;
    }
    wrap.innerHTML = renderMonthGroups(sortByUrgency(base), currentTab, cur);
    setupSwipeListeners();
    return;
  }

  let scoped = items.filter(i => inMonth(i.date, ym) || (!i.date && isCur));
  if (currentTab === 'open') scoped = scoped.filter(i => i.type === 'expense' && !i.paid);
  else if (currentTab === 'done') scoped = scoped.filter(i => i.type === 'expense' && i.paid);
  else if (currentTab === 'in') scoped = scoped.filter(i => i.type === 'income');

  let html = '';
  if (closed) html += renderClosingCard(ym);

  if (!scoped.length) {
    if (isCur) {
      html += `<div class="empty"><div class="empty-icon">📭</div><p>Nada por aqui ainda.<br>Adicione seu primeiro lançamento para começar.</p><button type="button" class="empty-cta" data-action="open-sheet">Adicionar lançamento</button></div>`;
    } else if (closed) {
      html += `<div class="empty"><div class="empty-icon">🔒</div><p>Nenhum lançamento registrado em <b>${monthLabel(ym)}</b>.</p></div>`;
    } else {
      html += `<div class="empty"><div class="empty-icon">🗓️</div><p>Nada agendado para <b>${monthLabel(ym)}</b> ainda.</p><button type="button" class="empty-cta" data-action="open-sheet">Adicionar lançamento</button></div>`;
    }
    wrap.innerHTML = html;
    return;
  }

  if (closed || currentTab === 'done' || currentTab === 'in') {
    const sorted = [...scoped].sort((a, b) =>
      String(a.date || '').localeCompare(String(b.date || '')) || (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
    const title = currentTab === 'in' ? 'Entradas' : currentTab === 'open' ? 'Em aberto' : 'Lançamentos';
    html += renderSection(title, sorted, 'section-month', groupMeta(sorted, currentTab));
  } else {
    const today = todayStr();
    const sorted = sortByUrgency(scoped);
    const overdueItems = sorted.filter(i => i.type === 'expense' && !i.paid && i.date && i.date < today);
    const todayItems = isCur ? sorted.filter(i => i.type === 'expense' && !i.paid && i.date === today) : [];
    const rest = sorted.filter(i => !(i.type === 'expense' && !i.paid && i.date && i.date <= today));
    if (overdueItems.length) html += renderSection('Vencidas', overdueItems, 'section-overdue', fmt(sum(overdueItems)));
    if (todayItems.length) html += renderTodaySection(todayItems);
    if (rest.length) {
      const restTitle = isCur ? 'A seguir' : `Agendadas · ${MONTHS[Number(ym.slice(5, 7)) - 1]}`;
      html += renderSection(restTitle, rest, 'section-month', groupMeta(rest, currentTab));
    }
  }

  wrap.innerHTML = html;
  setupSwipeListeners();
}

function renderMonthBar() {
  const bar = document.getElementById('monthBar');
  if (!bar) return;
  const months = homeMonths();
  const cur = currentMonthStr();
  const curYear = new Date().getFullYear();
  const chips = months.map(ym => {
    const [y, m] = ym.split('-').map(Number);
    const short = MONTHS[m - 1].slice(0, 3);
    const label = y !== curYear ? `${short}/${String(y).slice(2)}` : short;
    const cls = ['month-chip'];
    if (ym === homeMonth) cls.push('active');
    if (ym === cur) cls.push('is-current');
    if (isMonthClosed(ym)) cls.push('is-closed');
    return `<button type="button" class="${cls.join(' ')}" data-action="select-month" data-month="${ym}" aria-label="${monthLabel(ym)}">
      ${isMonthClosed(ym) ? '<span class="month-chip-lock">🔒</span>' : ''}<span>${label}</span>
      ${ym === cur ? '<span class="month-chip-dot"></span>' : ''}
    </button>`;
  }).join('');
  bar.innerHTML = `
    <button type="button" class="month-arrow" data-action="home-month" data-delta="-1" aria-label="Mês anterior">‹</button>
    <div class="month-chips">${chips}</div>
    <button type="button" class="month-arrow" data-action="home-month" data-delta="1" aria-label="Próximo mês">›</button>`;
}

function changeHomeMonth(delta) {
  const months = homeMonths();
  let idx = months.indexOf(homeMonth);
  if (idx === -1) idx = months.indexOf(currentMonthStr());
  idx = Math.min(months.length - 1, Math.max(0, idx + Number(delta) || 0));
  if (months[idx] !== homeMonth) {
    homeMonth = months[idx];
    render();
  }
}

function selectHomeMonth(ym) {
  if (!ym || ym === homeMonth) return;
  homeMonth = ym;
  render();
}

function renderClosingCard(ym) {
  const exps = monthExpenses(ym);
  const incs = monthIncome(ym);
  const inc = sum(incs);
  const exp = sum(exps);
  const saldo = inc - exp;
  const paid = exps.filter(i => i.paid).length;
  return `
  <div class="closing-card">
    <div class="closing-head">
      <span class="closing-icon">🔒</span>
      <div class="closing-head-text">
        <span class="closing-title">Mês fechado</span>
        <span class="closing-sub">${monthLabel(ym)} · ${exps.length} despesa(s), ${paid} paga(s) · ${incs.length} entrada(s)</span>
      </div>
    </div>
    <div class="closing-stats">
      <div class="closing-stat"><span>Entradas</span><b class="green">+${fmt(inc)}</b></div>
      <div class="closing-stat"><span>Saídas</span><b class="red">−${fmt(exp)}</b></div>
    </div>
    <div class="closing-total">
      <span>Saldo do mês</span>
      <b class="${saldo >= 0 ? 'green' : 'red'}">${fmtSigned(saldo)}</b>
    </div>
    <p class="closing-note">Este mês foi encerrado. Os lançamentos ficam no histórico e continuam contando no seu saldo geral.</p>
  </div>`;
}

function renderMonthGroups(list, tab, cur) {
  const groups = new Map();
  list.forEach(item => {
    const key = item.date ? item.date.slice(0, 7) : '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  const keys = [...groups.keys()].sort((a, b) => compareMonthGroups(a, b, cur, tab));
  return keys.map(key => {
    const group = groups.get(key);
    if (!key) return renderSection('Sem data', group, 'section-normal', groupMeta(group, tab));
    const hasOverdue = key < cur && group.some(i => i.type === 'expense' && !i.paid);
    const cls = 'section-month ' + (key === cur ? 'section-current' : hasOverdue ? 'section-overdue' : 'section-normal');
    const tag = isMonthClosed(key) ? '<span class="tag-closed">fechado</span>' : '';
    return renderSection(`${monthLabel(key)}${tag}`, group, cls, groupMeta(group, tab));
  }).join('');
}

function compareMonthGroups(a, b, cur, tab) {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  if (tab === 'done') return b.localeCompare(a);
  if (a === cur) return -1;
  if (b === cur) return 1;
  const aFuture = a > cur;
  const bFuture = b > cur;
  if (aFuture && bFuture) return a.localeCompare(b);
  if (!aFuture && !bFuture) return b.localeCompare(a);
  return aFuture ? -1 : 1;
}

function groupMeta(list, tab) {
  if (!list.length) return '';
  if (tab === 'all') {
    const income = sum(list.filter(i => i.type === 'income'));
    const expense = sum(list.filter(i => i.type === 'expense'));
    return fmtSigned(income - expense);
  }
  return fmt(sum(list));
}

function renderTodaySection(list) {
  const total = sum(list);
  let html = `<div class="today-section">
      <div class="today-header">
        <div class="today-title"><span class="today-dot"></span><span>Vencem hoje</span></div>
        <span class="today-total">${fmt(total)}</span>
      </div>
      <div class="today-list">`;
  list.forEach(it => { html += renderItem(it, true); });
  return html + '</div></div>';
}

function renderSection(title, list, cls, meta) {
  let html = `<div class="section-group ${cls || ''}"><div class="section-title-row"><span class="section-title-text">${title}${list.length ? `<span class="section-count">${list.length}</span>` : ''}</span>${meta ? `<span class="section-title-meta">${meta}</span>` : ''}</div>`;
  list.forEach(it => { html += renderItem(it); });
  return html + '</div>';
}

function renderItem(it, isToday) {
  const status = dueStatus(it.date);
  const isExpense = it.type === 'expense';
  const closedMonth = it.date ? isMonthClosed(it.date.slice(0, 7)) : false;
  const icon = escapeHtml((it.category || '📦 Outros').split(' ')[0]);
  const idAttr = escapeHtml(it.id);

  let badgeCls, badgeLabel, subLabel;
  if (closedMonth && !it.paid && isExpense) {
    badgeCls = 'badge-muted'; badgeLabel = fmtDateFull(it.date); subLabel = '';
  } else if (it.paid) {
    badgeCls = 'badge-green'; badgeLabel = 'Paga';
    subLabel = it.date ? (status ? status.label.replace('Venceu', 'venceu').replace('Hoje', 'hoje') : fmtDateFull(it.date)) : '';
  } else if (status) {
    badgeCls = status.cls; badgeLabel = status.label; subLabel = '';
  } else {
    badgeCls = ''; badgeLabel = ''; subLabel = '';
  }

  const urgencyClass = !it.paid && isExpense && !closedMonth ? getUrgencyItemClass(it) : '';
  const todayClass = isToday ? 'item-today' : '';
  const paidClass = it.paid ? 'paid' : '';

  return `
    <div class="item ${paidClass} ${urgencyClass} ${todayClass}" id="item-${idAttr}" data-action="open-sheet" data-id="${idAttr}">
      <div class="item-icon" style="background:${isExpense ? 'var(--red-dim)' : 'var(--green-dim)'}">${icon}</div>
      <div class="item-info">
        <div class="item-name">${escapeHtml(it.name)}</div>
        <div class="item-meta">
          ${badgeLabel ? `<span class="badge ${badgeCls}">${badgeLabel}</span>` : ''}
          ${subLabel ? `<span class="meta-sub">${subLabel}</span>` : ''}
          ${it.recurrence === 'monthly' ? '<span class="meta-recur" title="Repetição mensal" aria-label="Repetição mensal">🔁</span>' : ''}
        </div>
      </div>
      <div class="item-right">
        <div class="item-value ${isExpense ? 'red' : 'green'}">${isExpense ? '−' : '+'}${fmt(it.valueCents)}</div>
        <div class="item-actions">
          ${isExpense ? `
            <button class="btn-action btn-done ${it.paid ? 'btn-done-active' : ''}" data-action="toggle-paid" data-id="${idAttr}"
              title="${it.paid ? 'Desmarcar' : 'Marcar paga'}"
              aria-label="${it.paid ? 'Desmarcar pagamento' : 'Marcar como paga'}">${it.paid ? '✓' : '○'}</button>` : ''}
          <button class="btn-action btn-del" data-action="delete-item" data-id="${idAttr}" title="Excluir" aria-label="Excluir">✕</button>
        </div>
      </div>
    </div>`;
}

function getUrgencyItemClass(it) {
  if (it.paid) return '';
  const s = dueStatus(it.date);
  if (!s) return '';
  if (s.diff < 0) return 'item-overdue';
  if (s.diff === 0) return 'item-duetoday';
  if (s.diff <= 3) return 'item-duenear';
  return '';
}

/* ─── Swipe ──────────────────────────────── */
function setupSwipeListeners() {
  const wrap = document.getElementById('listWrap');
  if (wrap._swipeReady) return;
  wrap._swipeReady = true;
  let startX = 0, startY = 0, moved = false, targetId = null;

  wrap.addEventListener('touchstart', e => {
    const item = e.target.closest('.item');
    if (!item) return;
    startX = e.touches[0].clientX; startY = e.touches[0].clientY;
    moved = false; targetId = item.id.replace('item-', '');
  }, { passive: true });

  wrap.addEventListener('touchmove', e => {
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10) moved = true;
  }, { passive: true });

  wrap.addEventListener('touchend', e => {
    if (!moved || !targetId) return;
    const dx = e.changedTouches[0].clientX - startX;
    const it = items.find(i => i.id === targetId);
    if (!it || it.type !== 'expense') return;
    if (dx > 60) {
      const el = document.getElementById('item-' + targetId);
      if (el) {
        el.style.transition = 'transform .2s, opacity .2s';
        el.style.transform = 'translateX(8px)';
        el.style.opacity = '0.7';
        setTimeout(() => { el.style.transform = ''; el.style.opacity = ''; togglePaid(targetId); }, 150);
      }
    }
    targetId = null;
  }, { passive: true });
}

/* ═══════════════════════════════════════════
   Ações de item
   ═══════════════════════════════════════════ */
function togglePaid(id) {
  const it = items.find(i => i.id === id);
  if (!it) return;
  const wasPaid = it.paid;
  it.paid = !it.paid;
  const created = it.paid ? createNextOccurrence(it) : null;
  save(); render();
  showSnackbar(it.paid ? `"${it.name}" paga` : `"${it.name}" reaberta`, 'Desfazer', () => {
    it.paid = wasPaid;
    if (created) { const i = items.findIndex(x => x.id === created.id); if (i > -1) items.splice(i, 1); }
    save(); render();
  });
}

function deleteItem(id) {
  const it = items.find(i => i.id === id);
  if (!it) return;
  pendingDeleteId = id;
  document.getElementById('confirmText').textContent = `Excluir "${it.name}"? Você poderá desfazer em seguida.`;
  document.getElementById('confirmPanel').classList.add('open');
}

function confirmDelete() {
  if (!pendingDeleteId) return;
  const idx = items.findIndex(i => i.id === pendingDeleteId);
  if (idx === -1) { closeConfirm(); return; }
  pushSnapshot('Exclusão');
  const removed = items.splice(idx, 1)[0];
  save(); render(); closeConfirm();
  showSnackbar(`"${removed.name}" excluída`, 'Desfazer', () => {
    items.push(removed); save(); render();
  });
}

function cancelDelete() { closeConfirm(); }
function closeConfirm() {
  pendingDeleteId = null;
  document.getElementById('confirmPanel').classList.remove('open');
}
function closeConfirmOnBg(e) {
  if (e.target === document.getElementById('confirmPanel')) cancelDelete();
}

function clearAll() {
  if (!items.length) { closeMenu(); return; }
  if (confirm('Apagar tudo? Esta ação não pode ser desfeita.')) {
    pushSnapshot('Apagar tudo');
    const backup = items.slice();
    items = []; save(); render(); closeMenu();
    showSnackbar('Tudo apagado', 'Desfazer', () => { items = backup; save(); render(); });
  }
}

function switchTab(tab) {
  currentTab = tab;
  ['all', 'open', 'done', 'in'].forEach(t => document.getElementById('tab-' + t).classList.toggle('active', t === tab));
  render();
}

function onSearch() {
  searchTerm = document.getElementById('searchInput').value;
  render();
}

function clearSearch() {
  const input = document.getElementById('searchInput');
  input.value = '';
  searchTerm = '';
  render();
  input.focus();
}

/* ═══════════════════════════════════════════
   Moeda
   ═══════════════════════════════════════════ */
function digitsToCurrency(digits) {
  if (!digits) digits = '0';
  digits = digits.replace(/^0+(?=\d)/, '');
  while (digits.length < 3) digits = '0' + digits;
  const cents = digits.slice(-2);
  let intPart = digits.slice(0, -2);
  intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `R$ ${intPart},${cents}`;
}
function currencyToCents(digits) { return digits ? parseInt(digits, 10) : 0; }

function setupCurrencyMask(input) {
  input.addEventListener('input', () => {
    const digits = input.value.replace(/\D/g, '');
    input.dataset.raw = digits;
    input.value = digitsToCurrency(digits);
  });
  input.addEventListener('focus', () => {
    setTimeout(() => input.setSelectionRange(input.value.length, input.value.length), 0);
  });
}
function getValueCents() { return currencyToCents(document.getElementById('fValue').dataset.raw || ''); }
function setValueDisplay(cents) {
  const input = document.getElementById('fValue');
  const digits = Math.max(0, Math.round(cents || 0)).toString();
  input.dataset.raw = digits;
  input.value = digitsToCurrency(digits);
}
function parseMoney(str) {
  return FintrackCore.parseMoneyToCents(str);
}

/* ═══════════════════════════════════════════
   Categorias (com detecção automática + aprendizado)
   ═══════════════════════════════════════════ */
const EXPENSE_CATEGORIES = [
  '🍔 Alimentação','🛒 Mercado','🏠 Moradia','🚗 Transporte','💊 Saúde',
  '🎓 Educação','🎮 Lazer','👕 Vestuário','💇 Beleza','🐾 Pets',
  '📱 Assinaturas','💳 Cartão & Finanças','📈 Investimentos','✈️ Viagem',
  '🎁 Presentes','💼 Trabalho','📦 Outros'
];
const INCOME_CATEGORIES = ['💵 Salário','💹 Rendimentos','🤝 Reembolso','➕ Outras entradas'];
const ALL_CATEGORIES = [...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES];

const CATEGORY_RULES = [
  // Ordem importa no empate: mais específicos primeiro.
  { cat: '🍔 Alimentação', words: [
    'restaurante','restauran','lanchonete','lanche','ifood','rappi','uber eats','99 food',
    'pizzaria','pizza','hamburg','burguer','burger','cafeteria','cafe','café','bar','sorveteria',
    'sorvete','pastel','marmita','comida','delivery','dogao','hot dog','esfiha','sushi','churrascaria',
    'padaria','doceria','confeitaria','acai','açaí','bebida','almoco','almoço','jantar','quentinha',
    'tapioca','subway','bk','mc donalds','mcdonalds','giraffas','outback','starbucks'
  ] },
  { cat: '🛒 Mercado', words: [
    'mercad','supermerc','hipermerc','atacad','assai','carrefour','hortifruti','acougue','peixaria',
    'sacolao','sacolão','emporio','empório','pao de acucar','pao de açucar','extra supermercado','big','mateus'
  ] },
  { cat: '🏠 Moradia', words: [
    'alug','aluguel','condominio','condomínio','cond','iptu','luz','energia','enel','cemig','sabesp',
    'agua','água','gas','gás','internet','wifi','fibra','financiamento','prestacao','prestação',
    'seguro residencial','reforma','moveis','móveis','eletrodomestico','geladeira','fogao','fogão',
    'celular','recarga','chip','vivo','claro','tim','oi'
  ] },
  { cat: '🚗 Transporte', words: [
    'uber','99','taxi','táxi','combustivel','combustível','gasolina','etanol','alcool','álcool',
    'posto','estacionamento','pedagio','pedágio','ipva','licenciamento','onibus','ônibus','metro',
    'metrô','trem','passagem','oficina','mecanico','mecânico','pneu','revisao','revisão','moto',
    'caminhao','bilhete','shell','ipiranga','br distribuidora','lavagem','pedagio','sem parar','tag'
  ] },
  { cat: '💊 Saúde', words: [
    'farmacia','farmácia','drogaria','drogasil','remedi','remédio','medic','médic','medico','médico',
    'consulta','exame','dentista','odonto','plano de saude','plano de saúde','unimed','hospital',
    'laborator','academia','fitness','psicolog','terapeut','fisio','ortoped','otorrino','vacina',
    'clinica','clínica','nutricionista','oftalmo','dermat'
  ] },
  { cat: '🎓 Educação', words: [
    'faculdade','universidade','curso','escola','colegio','colégio','mensalidade','livro','apostila',
    'material escolar','ingles','inglês','wizard','udemy','alura','creche','pos gradua','pós gradua',
    'gradua','enem','concurso','didatico','didático'
  ] },
  { cat: '🎮 Lazer', words: [
    'cinema','cine','show','teatro','parque','jogo','game','steam','playstation','xbox','nintendo',
    'ingresso','festa','balada','praia','passeio','clube','evento','shopping','role','rolê','boliche',
    'kart','bowling','diversao','diversão','museu','zoologico','zoológico','parque aquatico'
  ] },
  { cat: '👕 Vestuário', words: [
    'roupa','camisa','camiseta','calca','calça','tenis','tênis','sapato','sandalia','sandália','vestido',
    'renner','riachuelo','zara','shein','posthaus','calcado','calçado','bolsa','boutique','cueca','meia',
    'bermuda','blusa','casaco','moda'
  ] },
  { cat: '💇 Beleza', words: [
    'cabelo','cabeleireiro','barbearia','barbear','salao','salão','manicure','unha','unhas','estetica',
    'estética','cosmetic','cosmético','perfum','maquiagem','sobrancelha','depilacao','depilação','spa',
    'hidratacao','hidratação','tatuagem','piercing'
  ] },
  { cat: '🐾 Pets', words: [
    'pet','petz','cobasi','racao','ração','veterinari','veterinário','vet','banho e tosa','tosa',
    'petshop','pet shop','aquario','aquário','vacina animal','antipulgas','areia sanitaria'
  ] },
  { cat: '📱 Assinaturas', words: [
    'netflix','spotify','amazon prime','prime video','disney','disney+','hbo','max','globoplay','youtube',
    'deezer','icloud','google one','adobe','office 365','microsoft 365','assinatura','canva','dropbox',
    'paramount','star+','twitch','crunchyroll','chatgpt','openai','claude','xbox game pass','playstation plus'
  ] },
  { cat: '💳 Cartão & Finanças', words: [
    'fatura','cartao','cartão','cartao de credito','nubank','itau','itaú','bradesco','santander','caixa',
    'banco','tarifa','anuidade','juros','iof','emprestimo','empréstimo','credito','crédito','consorcio',
    'consórcio','seguro','anuidade cartao'
  ] },
  { cat: '📈 Investimentos', words: [
    'aporte','investimento','investir','cdb','tesouro','poupanca','poupança','acoes','ações','acao','ação',
    'fundo','previdencia','previdência','cripto','bitcoin','ethereum','corretora','nuinvest','clear',
    'binance','rico','dividendo','renda fixa','fii','tesouro direto'
  ] },
  { cat: '✈️ Viagem', words: [
    'passagem aerea','passagem aérea','hotel','pousada','airbnb','booking','hospedagem','pacote turistico',
    'pacote turístico','voo','aereo','aéreo','cruzeiro','resort','turismo','viagem','excurso','excursão'
  ] },
  { cat: '🎁 Presentes', words: [
    'presente','gift','doacao','doação','igreja','dizimo','dízimo','caridade','ong','vaquinha','cesta basica',
    'cesta básica','casamento','aniversario presente'
  ] },
  { cat: '💼 Trabalho', words: [
    'freela','freelance','projeto','cliente','consultoria','ferramenta','dominio','domínio','hospedagem site',
    'hostinger','canva pro','equipamento','curso trabalho'
  ] },
  // Receitas
  { cat: '💵 Salário', words: [
    'salario','salário','pagamento','holerite','pro labore','pro-labore','prolabore','ferias','férias',
    'decimo terceiro','13 salario','13 salário','adiantamento','bonus','bônus','comissao','comissão','gratificacao'
  ] },
  { cat: '💹 Rendimentos', words: [
    'rendimento','dividendo','juros recebidos','aluguel recebido','fii','cupom','jcp','cashback investimento'
  ] },
  { cat: '🤝 Reembolso', words: [
    'reembolso','estorno','cashback','devolucao','devolução','restituicao','restituição','ressarcimento','indenizacao'
  ] },
  { cat: '➕ Outras entradas', words: [
    'venda','vendas','transferencia recebida','pix recebido','deposito','depósito','entrada','recebimento',
    'premio','prêmio','sorteio','heranca','herança'
  ] },
];

const STOPWORDS = new Set(['de','da','do','das','dos','e','com','para','por','pra','pro','na','no','nas','nos',
  'a','o','as','os','um','uma','em','ao','aos','the','and','of','meu','minha','seu','sua','conta',
  'pagamento','valor','pagar','compra','loja','dia','mes','mês']);

function tokenize(s) {
  return normalize(s).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}
function significantTokens(s) {
  return tokenize(s).filter(t => t.length >= 3 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}
function tokenMatch(token, w) {
  if (token === w) return true;
  if (w.length < 4) return false;        // palavras curtas: só exato (evita "gas" em "gasolina")
  return token.includes(w);              // radicais (ex.: "mercad" casa com "supermercado")
}
function phraseMatches(tokens, phrase) {
  const words = tokenize(phrase);
  if (!words.length) return false;
  for (let i = 0; i + words.length <= tokens.length; i++) {
    let ok = true;
    for (let j = 0; j < words.length; j++) {
      if (!tokenMatch(tokens[i + j], words[j])) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

function categoriesFor(type) {
  return type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
}

function guessCategory(name, type = 'expense') {
  const raw = String(name || '').trim();
  if (!raw) return null;
  const tokens = tokenize(raw);
  if (!tokens.length) return null;
  const allowed = categoriesFor(type);
  const scores = {};
  const bump = (cat, pts) => { if (allowed.includes(cat)) scores[cat] = (scores[cat] || 0) + pts; };

  // 1) Nome exato já aprendido (legado e novo)
  const learnedFull = settings.learnedRules[normalize(raw)];
  if (learnedFull) return learnedFull;

  // 2) Regras aprendidas por palavra-chave (peso maior que regras padrão)
  tokens.forEach(t => { const c = settings.learnedRules[t]; if (c) bump(c, 3); });

  // 3) Regras padrão por palavra/frase
  for (const rule of CATEGORY_RULES) {
    for (const w of rule.words) if (phraseMatches(tokens, w)) bump(rule.cat, 1);
  }

  let best = null, bestScore = 0;
  for (const c in scores) if (scores[c] > bestScore) { bestScore = scores[c]; best = c; }
  return best;
}

function learnCategory(name, cat) {
  if (!name || !cat) return;
  settings.learnedRules[normalize(name)] = cat;
  significantTokens(name).forEach(t => { settings.learnedRules[t] = cat; });
}

function renderChips() {
  const cats = categoriesFor(currentType);
  document.getElementById('categoryChips').innerHTML = cats.map(cat =>
    `<button type="button" class="chip" data-action="set-category" data-cat="${escapeHtml(cat)}">${escapeHtml(cat)}</button>`
  ).join('');
  const cur = document.getElementById('fCategory').value;
  document.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c.dataset.cat === cur));
}
function ensureCategoryForType() {
  const cats = categoriesFor(currentType);
  const cur = document.getElementById('fCategory').value;
  if (!cats.includes(cur)) setCategory(currentType === 'income' ? '💵 Salário' : '📦 Outros', false);
}
function setCategory(cat, manual) {
  document.getElementById('fCategory').value = cat;
  document.getElementById('categoryPill').textContent = cat;
  document.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c.dataset.cat === cat));
  if (manual) categoryManuallySet = true;
}
function toggleCategoryChips() {
  const chips = document.getElementById('categoryChips');
  chips.style.display = chips.style.display === 'none' ? 'flex' : 'none';
}
function suggestCategory() {
  if (categoryManuallySet) return;
  const guess = guessCategory(document.getElementById('fName').value, currentType);
  if (guess) setCategory(guess, false);
}

function nameHistory(type = currentType) {
  const map = new Map();
  items.forEach(it => {
    if (!it.name || it.type !== type) return;
    const key = normalize(it.name.trim());
    if (!key) return;
    const at = Number(it.createdAt) || 0;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { item: it, count: 1, lastAt: at });
      return;
    }
    existing.count += 1;
    const newer = String(it.date || '').localeCompare(String(existing.item.date || '')) > 0 ||
      (it.date === existing.item.date && at >= existing.lastAt);
    if (newer) existing.item = it;
    existing.lastAt = Math.max(existing.lastAt, at);
  });
  return [...map.values()].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
}

function renderNameSuggestions(query = '') {
  const wrap = document.getElementById('nameSuggestWrap');
  const list = document.getElementById('nameSuggest');
  const label = document.getElementById('nameSuggestLabel');
  if (!wrap || !list || !label) return;
  if (editId) { wrap.hidden = true; nameSuggestionRefs = []; return; }
  const q = normalize(String(query || '').trim());
  const history = nameHistory(currentType);
  const visible = (q ? history.filter(entry => normalize(entry.item.name).includes(q)) : history).slice(0, 6);
  nameSuggestionRefs = visible;
  if (!visible.length) { wrap.hidden = true; list.innerHTML = ''; return; }
  label.textContent = q ? 'Sugestões' : 'Usados recentemente';
  list.innerHTML = visible.map((entry, index) => {
    const it = entry.item;
    const meta = `${fmt(it.valueCents)}${it.recurrence === 'monthly' ? ' · mensal' : ''}`;
    return `<button type="button" class="suggest-chip" data-action="use-name-suggestion" data-index="${index}">
      <span class="suggest-chip-name">${escapeHtml(it.name)}</span>
      <span class="suggest-chip-meta">${escapeHtml(meta)}</span>
    </button>`;
  }).join('');
  wrap.hidden = false;
}

function latestByName(name, type = currentType) {
  const key = normalize(String(name || '').trim());
  if (!key) return null;
  return items
    .filter(it => it.type === type && normalize(it.name.trim()) === key)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) ||
      (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))[0] || null;
}

function applyNameAutoFill() {
  if (editId) return false;
  const match = latestByName(document.getElementById('fName').value);
  if (!match) return false;
  if (!getValueCents() && match.valueCents > 0) setValueDisplay(match.valueCents);
  if (!categoryManuallySet && match.category) setCategory(match.category, false);
  return true;
}

function suggestionDateFor(item) {
  if (!item.date) return todayStr();
  const day = Number(item.date.slice(8, 10)) || 1;
  if (item.recurrence !== 'monthly') return todayStr();
  const cur = currentMonthStr();
  const hasCurrent = items.some(it => it.type === item.type &&
    normalize(it.name.trim()) === normalize(item.name.trim()) &&
    (it.date || '').slice(0, 7) === cur);
  return dateInMonth(hasCurrent ? shiftMonth(cur, 1) : cur, day);
}

function useNameSuggestion(index) {
  const entry = nameSuggestionRefs[index];
  if (!entry) return;
  const it = entry.item;
  document.getElementById('fName').value = it.name;
  setValueDisplay(it.valueCents);
  setCategory(it.category || (currentType === 'income' ? '💵 Salário' : '📦 Outros'), false);
  recurrence = it.type === 'expense' && it.recurrence === 'monthly' ? 'monthly' : null;
  updateRecurUI();
  document.getElementById('fDate').value = suggestionDateFor(it);
  showDateField();
  renderNameSuggestions(it.name);
  toast('Preenchido com base no histórico');
}

function setQuickDate(days = 0, months = 0) {
  const input = document.getElementById('fDate');
  if (months) {
    const base = input.value || todayStr();
    const target = shiftMonth(base.slice(0, 7), months);
    input.value = dateInMonth(target, Number(base.slice(8, 10)) || 1);
  } else {
    input.value = localDateStr(new Date(Date.now() + Number(days) * 86400000));
  }
}

/* ═══════════════════════════════════════════
   Recorrência
   ═══════════════════════════════════════════ */
function nextMonthDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const lastDay = new Date(y, m + 1, 0).getDate();
  return localDateStr(new Date(y, m, Math.min(d, lastDay)));
}
function createNextOccurrence(it) {
  if (it.recurrence !== 'monthly' || !it.date) return null;
  const nextDate = nextMonthDate(it.date);
  const exists = items.some(x => x.id !== it.id && x.name === it.name && x.category === it.category && x.type === it.type && x.date === nextDate);
  if (exists) return null;
  const copy = { ...it, id: newId(), paid: false, date: nextDate, createdAt: Date.now() };
  items.unshift(copy);
  return copy;
}
function toggleRecurrence() {
  recurrence = recurrence === 'monthly' ? null : 'monthly';
  updateRecurUI();
}
function updateRecurUI() {
  const on = recurrence === 'monthly';
  const btn = document.getElementById('recurToggle');
  btn.classList.toggle('active', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  document.getElementById('recurCheck').textContent = on ? '✓' : '○';
  document.getElementById('fRecurrence').value = on ? 'monthly' : '';
}

/* ═══════════════════════════════════════════
   Quick add inteligente
   ═══════════════════════════════════════════ */
function parseQuickAdd(text) {
  let t = ' ' + String(text).toLowerCase().trim() + ' ';

  let recurrence = null;
  const recurrenceRe = /\b(mensalmente|mensal|recorrente|fixo|assinatura|todo\s+m[eê]s)\b/gi;
  if (/\b(mensalmente|mensal|recorrente|fixo|assinatura|todo\s+m[eê]s)\b/i.test(t)) recurrence = 'monthly';
  t = t.replace(recurrenceRe, ' ');

  let date = todayStr();
  if (/\bontem\b/.test(t)) { date = localDateStr(new Date(Date.now() - 86400000)); t = t.replace(/\bontem\b/g, ' '); }
  else if (/amanh[aã]/.test(t)) { date = localDateStr(new Date(Date.now() + 86400000)); t = t.replace(/amanh[aã]/g, ' '); }
  else if (/\bhoje\b/.test(t)) { t = t.replace(/\bhoje\b/g, ' '); }
  else if (/\b(pr[oó]ximo m[eê]s|m[eê]s que vem)\b/.test(t)) {
    const next = shiftMonth(currentMonthStr(), 1);
    date = dateInMonth(next, new Date().getDate());
    t = t.replace(/\b(pr[oó]ximo m[eê]s|m[eê]s que vem)\b/g, ' ');
  } else {
    const dm = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
    if (dm) {
      const day = dm[1].padStart(2, '0');
      const mon = dm[2].padStart(2, '0');
      const yr = dm[3] ? (dm[3].length === 2 ? '20' + dm[3] : dm[3]) : String(new Date().getFullYear());
      date = `${yr}-${mon}-${day}`;
      t = t.replace(dm[0], ' ');
    } else {
      const dia = t.match(/\bdia\s+(\d{1,2})\b/);
      if (dia) {
        const day = Math.min(31, Math.max(1, Number(dia[1])));
        const month = day >= new Date().getDate() ? currentMonthStr() : shiftMonth(currentMonthStr(), 1);
        date = dateInMonth(month, day);
        t = t.replace(dia[0], ' ');
      }
    }
  }

  let value = 0;
  const moneyRe = /(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?|\d+)/g;
  let m, last = null;
  while ((m = moneyRe.exec(t)) !== null) last = m;
  if (last) {
    value = parseMoney(last[1]);
    t = t.slice(0, last.index) + ' ' + t.slice(last.index + last[0].length);
  }

  const name = t.replace(/\s+/g, ' ').trim();
  return { name: name || '', value, date, recurrence };
}

function applyQuickAdd() {
  const input = document.getElementById('quickAdd');
  const parsed = parseQuickAdd(input.value);
  if (!parsed.name) { showSnackbar('Digite algo como "mercado 150 ontem"', null, null, 2500); return; }
  document.getElementById('fName').value = parsed.name;
  if (parsed.value > 0) setValueDisplay(parsed.value);
  document.getElementById('fDate').value = parsed.date;
  document.getElementById('dateGroup').style.display = 'block';
  document.getElementById('dateToggle').style.display = 'none';
  if (parsed.recurrence) {
    recurrence = 'monthly';
    updateRecurUI();
  }
  const guess = guessCategory(parsed.name, 'expense');
  if (guess) setCategory(guess, false);
  applyNameAutoFill();
  renderNameSuggestions(parsed.name);
  input.value = '';
  toast('Campos preenchidos');
}

/* ═══════════════════════════════════════════
   Sheet (adicionar/editar)
   ═══════════════════════════════════════════ */
function openSheet(id) {
  editId = id || null;
  categoryManuallySet = false;
  renderChips();
  document.getElementById('categoryChips').style.display = 'none';
  document.getElementById('dateGroup').style.display = 'none';
  document.getElementById('dateToggle').textContent = '📅 Adicionar vencimento';
  document.getElementById('quickAdd').value = '';

  if (editId) {
    const it = items.find(i => i.id === editId);
    if (!it) return;
    document.getElementById('sheetTitle').textContent = 'Editar lançamento';
    document.getElementById('fName').value = it.name;
    setValueDisplay(it.valueCents);
    document.getElementById('fDate').value = it.date || '';
    setCategory(it.category, true);
    setType(it.type);
    document.getElementById('btnDeleteFull').style.display = 'block';
    document.getElementById('btnDuplicate').style.display = 'block';

    const paidBtn = document.getElementById('btnTogglePaid');
    if (it.type === 'expense') {
      paidBtn.style.display = 'block';
      paidBtn.textContent = it.paid ? '↩ Desmarcar pagamento' : '✓ Marcar como paga';
      paidBtn.className = it.paid ? 'btn-toggle-paid btn-toggle-unpaid' : 'btn-toggle-paid btn-toggle-done';
    } else paidBtn.style.display = 'none';

    if (it.date) {
      document.getElementById('dateGroup').style.display = 'block';
      document.getElementById('dateToggle').style.display = 'none';
    } else {
      document.getElementById('dateToggle').style.display = 'block';
    }
    recurrence = it.recurrence || null;
    updateRecurUI();
    renderNameSuggestions();
  } else {
    document.getElementById('sheetTitle').textContent = 'Nova entrada';
    document.getElementById('fName').value = '';
    setValueDisplay(0);
    document.getElementById('fDate').value = todayStr();
    setCategory('📦 Outros', false);
    setType('expense');
    document.getElementById('btnDeleteFull').style.display = 'none';
    document.getElementById('btnTogglePaid').style.display = 'none';
    document.getElementById('dateToggle').style.display = 'block';
    document.getElementById('btnDuplicate').style.display = 'none';
    recurrence = null;
    updateRecurUI();
    renderNameSuggestions();
  }

  document.getElementById('overlay').classList.add('open');
  setTimeout(() => document.getElementById('fValue').focus(), 300);
}

function showDateField() {
  document.getElementById('dateGroup').style.display = 'block';
  document.getElementById('dateToggle').style.display = 'none';
}
function closeSheet() { document.getElementById('overlay').classList.remove('open'); }
function closeOnBg(e) { if (e.target === document.getElementById('overlay')) closeSheet(); }

function setType(type) {
  currentType = type;
  document.getElementById('btnExpense').className = 'type-btn' + (type === 'expense' ? ' active-expense' : '');
  document.getElementById('btnIncome').className = 'type-btn' + (type === 'income' ? ' active-income' : '');
  if (type === 'income' && !editId) setCategory('💵 Salário', false);
  const recurBtn = document.getElementById('recurToggle');
  if (recurBtn) recurBtn.style.display = type === 'expense' ? 'flex' : 'none';
  if (type === 'income') { recurrence = null; updateRecurUI(); }
  if (typeof renderChips === 'function') { ensureCategoryForType(); renderChips(); }
  if (document.getElementById('nameSuggestWrap')) renderNameSuggestions(document.getElementById('fName').value);
}

function saveItem() {
  const name = document.getElementById('fName').value.trim();
  const valueCents = getValueCents();
  const date = document.getElementById('fDate').value;
  const cat = document.getElementById('fCategory').value;
  const recur = document.getElementById('fRecurrence').value || null;

  if (!name) { markInvalid(document.getElementById('fName'), 'Informe um nome'); return; }
  if (!valueCents || valueCents <= 0) { markInvalid(document.getElementById('fValue'), 'Informe um valor'); return; }
  if (!FintrackCore.isValidDate(date)) { markInvalid(document.getElementById('fDate'), 'Informe uma data válida'); return; }

  // Aprendizado: guarda a categoria escolhida (nome + palavras-chave)
  const guess = guessCategory(name, currentType);
  if (guess !== cat && name) {
    learnCategory(name, cat);
    saveSettings();
  }

  if (editId) {
    const it = items.find(i => i.id === editId);
    if (it) { it.name = name; it.valueCents = valueCents; it.date = date; it.category = cat; it.type = currentType; it.recurrence = recur; }
    toast('Lançamento atualizado');
  } else {
    items.unshift({ id: newId(), name, valueCents, date, category: cat, type: currentType, paid: false, recurrence: recur, createdAt: Date.now() });
    const ym = date ? date.slice(0, 7) : '';
    toast(ym && isMonthClosed(ym) ? `Salvo em ${monthLabel(ym)} — mês fechado` : 'Lançamento salvo');
  }
  save(); closeSheet(); render();
}

function togglePaidFromSheet() {
  if (!editId) return;
  const it = items.find(i => i.id === editId);
  if (!it) return;
  const wasPaid = it.paid;
  it.paid = !it.paid;
  const created = it.paid ? createNextOccurrence(it) : null;
  save(); closeSheet(); render();
  showSnackbar(it.paid ? `"${it.name}" paga` : `"${it.name}" reaberta`, 'Desfazer', () => {
    it.paid = wasPaid;
    if (created) { const i = items.findIndex(x => x.id === created.id); if (i > -1) items.splice(i, 1); }
    save(); render();
  });
}

function deleteFromSheet() { if (!editId) return; closeSheet(); deleteItem(editId); }

function duplicateFromSheet() {
  if (!editId) return;
  const it = items.find(i => i.id === editId);
  if (!it) return;
  const copy = { ...it, id: newId(), paid: false, createdAt: Date.now() };
  items.unshift(copy);
  save(); closeSheet(); render();
  showSnackbar('Lançamento duplicado', 'Desfazer', () => {
    const i = items.findIndex(x => x.id === copy.id);
    if (i > -1) items.splice(i, 1);
    save(); render();
  });
}

/* ═══════════════════════════════════════════
   CALENDÁRIO + HEATMAP
   ═══════════════════════════════════════════ */
function renderCalendar() {
  const wrap = document.getElementById('calendarWrap');
  const [y, m] = viewMonth.split('-').map(Number);
  const firstDow = new Date(y, m - 1, 1).getDay();
  const daysInMonth = new Date(y, m, 0).getDate();
  const today = todayStr();

  const dayStats = {};
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${viewMonth}-${String(d).padStart(2, '0')}`;
    dayStats[ds] = { spent: 0, income: 0, hasOpen: false, hasPaid: false, hasToday: false };
  }
  items.forEach(i => {
    if (!inMonth(i.date, viewMonth)) return;
    const s = dayStats[i.date];
    if (!s) return;
    if (i.type === 'expense') { s.spent += i.valueCents; i.paid ? (s.hasPaid = true) : (s.hasOpen = true); }
    else { s.income += i.valueCents; }
  });

  const maxSpent = Math.max(1, ...Object.values(dayStats).map(s => s.spent));

  const header = `
    <div class="month-nav">
      <button data-action="change-month" data-delta="-1" aria-label="Mês anterior">‹</button>
      <div class="month-nav-label">${monthLabel(viewMonth)}${monthBadge(viewMonth)}</div>
      <button data-action="change-month" data-delta="1" aria-label="Próximo mês">›</button>
    </div>`;

  const monthExp = items.filter(i => i.type === 'expense' && inMonth(i.date, viewMonth));
  const monthIncome = items.filter(i => i.type === 'income' && inMonth(i.date, viewMonth));
  const spentTotal = sum(monthExp);
  const incomeTotal = sum(monthIncome);
  const openTotal = sum(monthExp.filter(i => !i.paid));

  let grid = '<div class="cal-grid">';
  DOW.forEach(d => { grid += `<div class="cal-dow">${d}</div>`; });
  for (let b = 0; b < firstDow; b++) grid += '<div class="cal-cell empty"></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${viewMonth}-${String(d).padStart(2, '0')}`;
    const s = dayStats[ds];
    const heatH = s.spent > 0 ? Math.min(100, Math.round(s.spent / maxSpent * 100)) : 0;
    const heat = heatH > 0 ? `<div class="cal-heat" style="height:${heatH}%"></div>` : '';
    const dot = s.hasOpen ? '<span class="cal-dot open"></span>'
      : s.hasPaid ? '<span class="cal-dot paid"></span>'
      : s.income > 0 ? '<span class="cal-dot dot-today"></span>' : '';
    grid += `<button class="cal-cell ${ds === today ? 'today' : ''}" data-action="show-day" data-date="${ds}" title="${s.spent > 0 ? fmt(s.spent) : ''}">
      ${heat}<span class="cal-daynum">${d}</span>${dot}
    </button>`;
  }
  grid += '</div>';

  wrap.innerHTML = `
    ${header}
    <div class="card">
      <div class="card-title"><span>Resumo do mês</span><span class="card-sub">${monthLabel(viewMonth)}</span></div>
      <div class="hero-stats">
        <div class="stat stat-income"><div class="stat-icon">💰</div><div class="stat-body"><div class="stat-label">Entradas</div><div class="stat-value green">${fmt(incomeTotal)}</div></div></div>
        <div class="stat stat-expense"><div class="stat-icon">📤</div><div class="stat-body"><div class="stat-label">Gastos</div><div class="stat-value red">${fmt(spentTotal)}</div></div></div>
      </div>
      <div class="cal-legend">
        <span><span class="cal-dot open"></span> a pagar</span>
        <span><span class="cal-dot paid"></span> pago</span>
        <span style="margin-left:auto">Em aberto: <b style="color:var(--text)">${fmt(openTotal)}</b></span>
      </div>
    </div>
    <div class="card">
      <div class="card-title"><span>Calendário</span><span class="card-sub">intensidade = gasto no dia</span></div>
      ${grid}
    </div>`;
}

function changeMonth(delta) {
  viewMonth = shiftMonth(viewMonth, delta);
  if (currentView === 'calendar') renderCalendar();
  else if (currentView === 'analysis') renderAnalysis();
}

function showDay(ds) {
  const day = items.filter(i => i.date === ds);
  if (!day.length) { showSnackbar(`${fmtDate(ds)} — nenhum lançamento`, null, null, 2000); return; }
  const exp = day.filter(i => i.type === 'expense');
  const inc = day.filter(i => i.type === 'income');
  const parts = [];
  if (exp.length) parts.push(`${exp.length} despesa(s) ${fmt(sum(exp))}`);
  if (inc.length) parts.push(`${inc.length} entrada(s) ${fmt(sum(inc))}`);
  showSnackbar(`${fmtDate(ds)} — ${parts.join(' · ')}`, null, null, 3000);
}

/* ═══════════════════════════════════════════
   ANÁLISE (resumo, fluxo de caixa, categorias)
   ═══════════════════════════════════════════ */
function monthExpenses(ym) { return items.filter(i => i.type === 'expense' && inMonth(i.date, ym)); }
function monthIncome(ym) { return items.filter(i => i.type === 'income' && inMonth(i.date, ym)); }

function categoryTotals(ym) {
  const map = {};
  monthExpenses(ym).forEach(i => { map[i.category || '📦 Outros'] = (map[i.category || '📦 Outros'] || 0) + i.valueCents; });
  return Object.entries(map).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
}

function monthlyProjection(count = 3) {
  return FintrackCore.calculateMonthlyProjection(items, todayStr(), count, settings.closedMonths);
}

function donutSVG(segs) {
  const size = 128, stroke = 15, r = (size - stroke) / 2, c = 2 * Math.PI * r, cx = size / 2, cy = size / 2;
  const total = segs.reduce((s, x) => s + x.value, 0);
  if (!total) return '<div class="empty-mini">Sem gastos no período.</div>';
  let off = 0;
  const arcs = segs.map(s => {
    const len = (s.value / total) * c;
    const el = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${stroke}" stroke-dasharray="${len.toFixed(2)} ${(c - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`;
    off += len;
    return el;
  }).join('');
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${arcs}
    <text x="${cx}" y="${cy - 1}" text-anchor="middle" class="donut-center">${fmtShort(total)}</text>
    <text x="${cx}" y="${cy + 13}" text-anchor="middle" class="donut-center-sub">gasto no mês</text>
  </svg>`;
}

function monthlyBarsSVG(projection) {
  if (!projection.length) return '';
  const max = Math.max(1, ...projection.map(m => Math.max(m.incomeCents, m.outflowCents)));
  if (max <= 1) return '';
  const W = 300, H = 120, top = 10, base = 94, pad = 10;
  const slot = (W - 2 * pad) / projection.length;
  const barW = Math.max(7, Math.min(15, slot * 0.24));
  const bars = projection.map((m, i) => {
    const cx = pad + slot * (i + 0.5);
    const incH = Math.round((Math.max(0, m.incomeCents) / max) * (base - top));
    const expH = Math.round((Math.max(0, m.outflowCents) / max) * (base - top));
    const label = MONTHS[Number(m.month.slice(5, 7)) - 1].slice(0, 3);
    return `
      <rect x="${(cx - barW - 2).toFixed(1)}" y="${base - incH}" width="${barW}" height="${Math.max(1, incH)}" rx="3" fill="var(--green)"/>
      <rect x="${(cx + 2).toFixed(1)}" y="${base - expH}" width="${barW}" height="${Math.max(1, expH)}" rx="3" fill="var(--red)"/>
      <text x="${cx.toFixed(1)}" y="${H - 8}" text-anchor="middle" fill="var(--muted)" font-size="9" font-weight="600">${label}</text>`;
  }).join('');
  return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
    <line x1="${pad}" y1="${base}" x2="${W - pad}" y2="${base}" stroke="var(--border)" stroke-width="1"/>
    ${bars}
  </svg>`;
}

function projectionBalanceSVG(projection) {
  if (!projection.length) return '';
  const values = [projection[0].openingCents, ...projection.map(m => m.closingCents)];
  const W = 300, H = 92, padX = 10, padTop = 8, padBottom = 8;
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const span = (max - min) || 1;
  const x = i => padX + (i / (values.length - 1 || 1)) * (W - 2 * padX);
  const y = v => H - padBottom - ((v - min) / span) * (H - padTop - padBottom);
  const path = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const zero = y(0).toFixed(1);
  const dots = values.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.4" fill="var(--today)"/>`).join('');
  return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <line x1="${padX}" y1="${zero}" x2="${W - padX}" y2="${zero}" stroke="var(--border)" stroke-width="1" stroke-dasharray="4 4"/>
    <path d="${path}" fill="none" stroke="var(--today)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    ${dots}
  </svg>`;
}

function smartSummary() {
  const cur = currentMonthStr();
  const prev = shiftMonth(cur, -1);
  const curSpent = sum(monthExpenses(cur));
  const prevSpent = sum(monthExpenses(prev));
  const cats = categoryTotals(cur);
  const pending = sum(monthExpenses(cur).filter(i => !i.paid));
  const parts = [];

  if (curSpent === 0 && pending === 0) {
    parts.push('Ainda não há gastos registrados este mês.');
  } else {
    let txt = `Este mês você gastou <b>${fmt(curSpent)}</b>`;
    if (prevSpent > 0) {
      const diff = Math.round((curSpent - prevSpent) / prevSpent * 100);
      if (diff > 0) txt += ` (<span class="up">+${diff}%</span> vs mês passado)`;
      else if (diff < 0) txt += ` (<span class="down">${diff}%</span> vs mês passado)`;
      else txt += ' (igual ao mês passado)';
    }
    txt += '.';
    parts.push(txt);
    if (cats.length) parts.push(`Maior gasto: <b>${cats[0].label}</b> (${fmt(cats[0].value)}).`);
    if (pending > 0) parts.push(`Ainda a pagar este mês: <b>${fmt(pending)}</b>.`);
  }
  return parts.join(' ');
}

function renderAnalysis() {
  const wrap = document.getElementById('analysisWrap');
  const horizon = settings.projectionHorizon || 3;
  const projection = monthlyProjection(horizon);
  const cats = categoryTotals(viewMonth);
  const colored = cats.map((c, idx) => ({ ...c, color: CHART_COLORS[idx % CHART_COLORS.length] }));

  const header = `
    <div class="month-nav">
      <button data-action="change-month" data-delta="-1" aria-label="Mês anterior">‹</button>
      <div class="month-nav-label">${monthLabel(viewMonth)}${monthBadge(viewMonth)}</div>
      <button data-action="change-month" data-delta="1" aria-label="Próximo mês">›</button>
    </div>`;

  const legend = colored.map(c =>
    `<div class="legend-item"><span class="legend-dot" style="background:${c.color}"></span><span class="legend-name">${escapeHtml(c.label)}</span><span class="legend-val">${fmtShort(c.value)}</span></div>`
  ).join('');

  const projectionHtml = projection.map((m, idx) => {
    const cls = m.closingCents < 0 ? 'neg' : 'pos';
    const overdue = m.overdueCents > 0
      ? `<span class="proj-overdue">inclui ${fmt(m.overdueCents)} vencidas</span>`
      : '';
    const warn = m.negativeDate
      ? `<div class="proj-warn">Saldo fica negativo em ${fmtDate(m.negativeDate)}</div>`
      : '';
    return `
      <div class="proj-row${idx === 0 ? ' current' : ''}">
        <div class="proj-top">
          <span class="proj-month">${monthLabel(m.month)}</span>
          <span class="proj-balance ${cls}">${fmtSigned(m.closingCents)}</span>
        </div>
        <div class="proj-meta">
          <span class="proj-in">+ ${fmt(m.incomeCents)}</span>
          <span class="proj-out">− ${fmt(m.outflowCents)}</span>
          ${overdue}
        </div>
        ${warn}
      </div>`;
  }).join('');
  const hasFlow = projection.some(m => m.incomeCents > 0 || m.outflowCents > 0);
  const horizonHtml = [3, 6, 12].map(n =>
    `<button class="proj-horizon-btn${n === horizon ? ' active' : ''}" data-action="set-projection-horizon" data-months="${n}">${n} meses</button>`
  ).join('');

  // Sugestões de recorrência
  const suggestions = detectRecurrences();
  suggestionRefs = suggestions;
  const suggHtml = suggestions.length
    ? suggestions.map((s, i) => `
        <div class="alert-item info" style="align-items:center">
          <span style="flex:1">🔁 "<b>${escapeHtml(s.name)}</b>" aparece em ${s.count} meses. Tornar recorrente?</span>
          <button data-action="accept-recurrence" data-index="${i}" style="opacity:1;font-size:12px;font-weight:700">Sim</button>
          <button data-action="dismiss-suggestion" data-index="${i}" aria-label="Dispensar">✕</button>
        </div>`).join('')
    : '';

  wrap.innerHTML = `
    ${header}
    <div class="card">
      <div class="card-title"><span>Seu mês em resumo</span></div>
      <div class="ai-summary">${smartSummary()}</div>
    </div>

    <div class="card">
      <div class="card-title"><span>Previsão por mês</span><span class="card-sub">só o que vence em cada mês</span></div>
      <div class="proj-horizon">${horizonHtml}</div>
      <div class="proj-list">${projectionHtml}</div>
      ${hasFlow ? `<div class="proj-chart">
        <div class="proj-line-label">Saldo acumulado</div>
        ${projectionBalanceSVG(projection)}
        <div class="proj-line-label" style="margin-top:10px">Entradas e saídas por mês</div>
        ${monthlyBarsSVG(projection)}
        <div class="proj-legend">
          <span><i style="background:var(--green)"></i>entradas</span>
          <span><i style="background:var(--red)"></i>saídas</span>
          <span><i style="background:var(--today)"></i>saldo</span>
        </div>
      </div>` : ''}
    </div>

    <div class="card">
      <div class="card-title"><span>Gastos por categoria</span><span class="card-sub">${monthLabel(viewMonth)}</span></div>
      ${colored.length
        ? `<div class="donut-row"><div class="donut">${donutSVG(colored)}</div><div class="legend">${legend}</div></div>`
        : '<div class="empty-mini">Sem gastos neste mês.</div>'}
    </div>

    ${suggHtml ? `<div class="card"><div class="card-title"><span>Sugestões</span></div>${suggHtml}</div>` : ''}`;
}

function setProjectionHorizon(months) {
  settings.projectionHorizon = [3, 6, 12].includes(months) ? months : 3;
  saveSettings();
  renderAnalysis();
}

/* ─── Detecção de recorrência ────────────── */
function detectRecurrences() {
  const groups = {};
  items.filter(i => i.type === 'expense' && i.date && i.recurrence !== 'monthly').forEach(i => {
    const k = normalize(i.name) + '|' + i.category;
    (groups[k] = groups[k] || []).push(i);
  });
  const out = [];
  for (const k in groups) {
    const g = groups[k];
    const months = new Set(g.map(i => i.date.slice(0, 7)));
    const key = 'recur:' + k;
    if (months.size >= 2 && !settings.dismissed[key]) {
      out.push({ key, name: g[0].name, category: g[0].category, count: months.size });
    }
  }
  return out.slice(0, 3);
}

function acceptRecurrence(idx) {
  const s = suggestionRefs[idx];
  if (!s) return;
  const n = normalize(s.name);
  items.forEach(i => { if (i.type === 'expense' && normalize(i.name) === n && i.category === s.category) i.recurrence = 'monthly'; });
  save(); render();
  toast('Marcado como recorrente 🔁');
}

function dismissSuggestion(idx) {
  const s = suggestionRefs[idx];
  if (!s) return;
  settings.dismissed[s.key] = Date.now();
  saveSettings(); render();
}

function dismissAlert(idx) {
  const a = alertRefs[idx];
  if (!a) return;
  settings.dismissed[a.key] = Date.now();
  saveSettings(); render();
}

/* ─── Geração automática de recorrências ─── */
function spawnRecurring() {
  const cur = currentMonthStr();
  const groups = {};
  items.filter(i => i.recurrence === 'monthly' && i.date).forEach(i => {
    const k = normalize(i.name) + '|' + i.category + '|' + i.type;
    (groups[k] = groups[k] || []).push(i);
  });
  let created = 0, changed = false;
  for (const k in groups) {
    const g = groups[k];
    const hasCurrent = g.some(i => inMonth(i.date, cur));
    if (hasCurrent) {
      if (settings.spawned[k] !== cur) { settings.spawned[k] = cur; changed = true; }
      continue;
    }
    if (settings.spawned[k] === cur) continue;
    const latest = g.reduce((a, b) => (a.date > b.date ? a : b));
    if (latest.date.slice(0, 7) >= cur) continue;
    const day = Number(latest.date.slice(8, 10)) || 1;
    const copy = { ...latest, id: newId(), date: dateInMonth(cur, day), paid: false, recurrence: 'monthly' };
    items.push(copy);
    settings.spawned[k] = cur;
    created++; changed = true;
  }
  if (changed) save();
  return created;
}

/* ═══════════════════════════════════════════
   PLANOS (orçamento + metas)
   ═══════════════════════════════════════════ */
function categorySpent(ym, cat) { return sum(items.filter(i => i.type === 'expense' && i.category === cat && inMonth(i.date, ym))); }

function budgetLimit(cat) {
  const base = Number(settings.budgets[cat]) || 0;
  if (!base) return 0;
  if (!settings.budgetRollover) return base;
  const prev = shiftMonth(currentMonthStr(), -1);
  const surplus = Math.max(0, base - categorySpent(prev, cat));
  return base + surplus;
}

function renderPlans() {
  const wrap = document.getElementById('plansWrap');
  const cur = currentMonthStr();

  const budgetCats = EXPENSE_CATEGORIES;
  const rows = budgetCats.map(cat => {
    const limit = budgetLimit(cat);
    const spent = categorySpent(cur, cat);
    if (!limit && !spent) return '';
    const pct = limit ? Math.min(100, Math.round(spent / limit * 100)) : (spent ? 100 : 0);
    const cls = limit && spent > limit ? 'over' : pct >= 80 ? 'warn' : '';
    const inputVal = settings.budgets[cat] ? FintrackCore.centsToAmount(settings.budgets[cat]).toFixed(2).replace('.', ',') : '';
    const remain = limit - spent;
    return `
      <div class="budget-row">
        <div class="budget-head">
          <span class="budget-cat">${cat}</span>
          <span class="budget-vals"><span class="budget-val-big">${fmt(spent)}</span>${limit ? ` / ${fmt(limit)}` : ''}</span>
        </div>
        <div class="budget-bar"><div class="budget-fill ${cls}" style="width:${pct}%"></div></div>
        <div class="budget-head">
          <div class="budget-input-wrap">
            <span>Limite R$</span>
             <input class="budget-input" inputmode="decimal" value="${escapeHtml(inputVal)}" placeholder="0,00"
                   data-budget-cat="${escapeHtml(cat)}" aria-label="Limite para ${escapeHtml(cat)}">
          </div>
          ${limit ? `<span class="budget-vals" style="color:${remain < 0 ? 'var(--red)' : 'var(--green)'}">${remain < 0 ? 'estourou ' + fmt(-remain) : 'resta ' + fmt(remain)}</span>` : ''}
        </div>
      </div>`;
  }).join('');

  const goals = settings.goals.map(g => {
    const pct = g.targetCents ? Math.min(100, Math.round(g.savedCents / g.targetCents * 100)) : 0;
    const remain = Math.max(0, g.targetCents - g.savedCents);
    return `
      <div class="goal-card">
        <div class="goal-head">
          <span class="goal-name">${escapeHtml(g.name)}</span>
          <button class="goal-del" data-action="delete-goal" data-id="${escapeHtml(g.id)}" aria-label="Excluir meta">✕</button>
        </div>
        <div class="goal-bar"><div class="goal-fill" style="width:${pct}%;${pct >= 100 ? 'background:var(--green)' : ''}"></div></div>
        <div class="goal-meta">
          <span>${fmt(g.savedCents)} de ${fmt(g.targetCents)}</span>
          <span>${pct >= 100 ? '🎉 meta atingida' : 'faltam ' + fmt(remain)}</span>
        </div>
        <div class="goal-actions">
          <button class="btn-mini" data-action="deposit-goal" data-id="${escapeHtml(g.id)}">＋ Guardar</button>
          ${g.deadline ? `<button class="btn-mini ghost">até ${fmtDateFull(g.deadline)}</button>` : ''}
        </div>
      </div>`;
  }).join('');

  wrap.innerHTML = `
    <div class="card">
      <div class="card-title"><span>Orçamento por categoria</span>
        <label class="card-sub" style="display:flex;align-items:center;gap:6px">
          rollover
          <input type="checkbox" id="budgetRollover" ${settings.budgetRollover ? 'checked' : ''} style="width:34px;height:20px">
        </label>
      </div>
      ${rows || '<div class="empty-mini">Defina limites para acompanhar seus gastos por categoria.</div>'}
    </div>

    <div class="card">
      <div class="card-title"><span>Metas de economia</span></div>
      ${goals || '<div class="empty-mini">Nenhuma meta ainda.</div>'}
      <div class="form-inline" style="margin-top:12px">
        <input type="text" id="goalName" placeholder="Nome da meta (ex: Reserva)" maxlength="30">
        <div class="row">
          <input type="text" id="goalTarget" inputmode="decimal" placeholder="Valor alvo (R$)">
          <input type="date" id="goalDeadline" aria-label="Prazo">
        </div>
        <button class="btn-mini" data-action="add-goal">＋ Criar meta</button>
      </div>
    </div>`;
}

function setBudget(cat, val) {
  const num = parseMoney(val);
  if (num > 0) settings.budgets[cat] = num;
  else delete settings.budgets[cat];
  saveSettings(); renderPlans(); renderAlerts();
}

function toggleRollover(on) { settings.budgetRollover = !!on; saveSettings(); renderPlans(); }

function addGoal() {
  const name = document.getElementById('goalName').value.trim();
  const targetCents = parseMoney(document.getElementById('goalTarget').value);
  const deadline = document.getElementById('goalDeadline').value || null;
  if (!name) { markInvalid(document.getElementById('goalName'), 'Informe o nome da meta'); return; }
  if (targetCents <= 0) { markInvalid(document.getElementById('goalTarget'), 'Informe um valor alvo'); return; }
  settings.goals.push({ id: newId(), name, targetCents, savedCents: 0, deadline });
  saveSettings(); renderPlans();
  toast('Meta criada 🎯');
}

function deleteGoal(id) {
  settings.goals = settings.goals.filter(g => g.id !== id);
  saveSettings(); renderPlans();
}

let depGoalId = null;
function openDeposit(id) {
  depGoalId = id;
  const g = settings.goals.find(x => x.id === id);
  const el = document.getElementById('depositSheet');
  el.classList.add('open');
  setTimeout(() => document.getElementById('depValue').focus(), 200);
  document.getElementById('depValue').value = '';
}
function closeDeposit() { document.getElementById('depositSheet').classList.remove('open'); }
function closeDepositBg(e) { if (e.target.id === 'depositSheet') closeDeposit(); }
function quickDep(v) { document.getElementById('depValue').value = String(v).replace('.', ','); }
function applyDeposit() {
  if (!depGoalId) return;
  const g = settings.goals.find(x => x.id === depGoalId);
  if (!g) return;
  const cents = parseMoney(document.getElementById('depValue').value);
  if (cents > 0) { g.savedCents += cents; saveSettings(); renderPlans(); toast('Guardado ' + fmt(cents)); }
  closeDeposit();
}
function depositGoal(id) { openDeposit(id); }

/* ═══════════════════════════════════════════
   ALERTAS
   ═══════════════════════════════════════════ */
function computeAlerts() {
  const out = [];
  const today = todayStr();
  const tomorrow = localDateStr(new Date(Date.now() + 86400000));
  const scope = items.filter(i => !i.date || !isMonthClosed(i.date.slice(0, 7)));
  const todayItems = scope.filter(i => i.type === 'expense' && !i.paid && i.date === today);
  const tomorrowItems = scope.filter(i => i.type === 'expense' && !i.paid && i.date === tomorrow);
  const overdue = scope.filter(i => i.type === 'expense' && !i.paid && i.date && i.date < today);

  if (settings.alerts.due) {
    if (overdue.length) out.push({ key: 'overdue:' + today, type: 'danger', text: `${overdue.length} conta(s) vencida(s) — ${fmt(sum(overdue))}.` });
    if (todayItems.length) out.push({ key: 'due-today:' + today, type: 'warn', text: `${todayItems.length} conta(s) vencem hoje — ${fmt(sum(todayItems))}.` });
    if (tomorrowItems.length) out.push({ key: 'due-tom:' + today, type: 'info', text: `${tomorrowItems.length} conta(s) vencem amanhã.` });
  }

  if (settings.alerts.budget && !isMonthClosed(currentMonthStr())) {
    EXPENSE_CATEGORIES.forEach(cat => {
      const limit = budgetLimit(cat);
      if (!limit) return;
      const spent = categorySpent(currentMonthStr(), cat);
      if (spent > limit) out.push({ key: 'budget:' + cat + ':' + currentMonthStr(), type: 'danger', text: `Orçamento de ${cat} estourou (${fmt(spent)} de ${fmt(limit)}).` });
    });
  }

  if (settings.alerts.cashflow) {
    const advance = Math.max(0, Number(settings.cashflowAdvanceDays) || 0);
    const monthsAhead = Math.max(3, Math.ceil(advance / 30) + 1);
    const negative = monthlyProjection(monthsAhead).find(m => m.negativeDate);
    if (negative) {
      const label = monthLabel(negative.month);
      const daysUntil = Math.round((new Date(negative.negativeDate + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000);
      if (daysUntil <= advance) {
        const text = daysUntil < 0
          ? `Saldo previsto negativo desde ${fmtDate(negative.negativeDate)} (${label}).`
          : daysUntil === 0
            ? `Saldo previsto negativo hoje (${label}).`
            : `Saldo previsto negativo em ${fmtDate(negative.negativeDate)} (${label}) — em ${daysUntil} dia(s).`;
        out.push({ key: 'cashflow:' + negative.negativeDate, type: 'danger', text });
      }
    }
  }

  return out.filter(a => !settings.dismissed[a.key]);
}

function renderAlerts() {
  const el = document.getElementById('alertsBanner');
  const allAlerts = computeAlerts();
  const alerts = allAlerts.slice(0, 3);
  alertRefs = alerts;
  FintrackNotifications.notify(allAlerts, settings.notification);
  if (!alerts.length) { el.style.display = 'none'; return; }
  el.style.display = 'flex';
  el.innerHTML = alerts.map((a, i) =>
    `<div class="alert-item ${a.type}"><span style="flex:1">${a.text}</span><button data-action="dismiss-alert" data-index="${i}" aria-label="Dispensar">✕</button></div>`
  ).join('');
}

/* ═══════════════════════════════════════════
   MENU / CONFIGURAÇÕES / SNAPSHOTS
   ═══════════════════════════════════════════ */
function openMenu() { updateMenuInfo(); updateCloseMonthButton(); document.getElementById('menuPanel').classList.add('open'); }
function closeMenu() { document.getElementById('menuPanel').classList.remove('open'); }
function closeMenuOnBg(e) { if (e.target === document.getElementById('menuPanel')) closeMenu(); }
function openPanel(id) { document.getElementById(id).classList.add('open'); }
function closePanel(id) { document.getElementById(id).classList.remove('open'); }
function closeOnBg2(e, id) { if (e.target === document.getElementById(id)) closePanel(id); }

function updateCloseMonthButton() {
  const btn = document.getElementById('menuCloseMonth');
  if (!btn) return;
  const cur = currentMonthStr();
  const name = MONTHS[Number(cur.slice(5, 7)) - 1];
  btn.textContent = isMonthClosed(cur) ? `🔓 Reabrir ${name} (mês atual)` : `🔒 Fechar ${name} (mês atual)`;
}

function toggleCloseMonth() {
  const cur = currentMonthStr();
  const name = monthLabel(cur);
  if (isMonthClosed(cur)) {
    settings.closedMonths = settings.closedMonths.filter(m => m !== cur);
    saveSettings(); closeMenu(); render();
    toast(`${name} reaberto`);
    return;
  }
  const openLeft = items.filter(i => i.type === 'expense' && !i.paid && inMonth(i.date, cur)).length;
  const warn = openLeft > 0 ? ` Ainda há ${openLeft} conta(s) em aberto neste mês.` : '';
  if (!confirm(`Fechar ${name} agora? Os lançamentos deste mês ficam no histórico do mês.${warn}`)) return;
  settings.closedMonths.push(cur);
  saveSettings(); closeMenu(); render();
  toast(`${name} fechado 🔒`);
}

function updateMenuInfo() {
  const el = document.getElementById('menuInfo');
  if (!items.length) { el.textContent = 'Nenhum lançamento para fazer backup ainda.'; el.className = 'menu-info'; return; }
  const last = localStorage.getItem('fintrack_lastBackup');
  if (!last) { el.textContent = '⚠️ Você ainda não fez backup dos seus dados.'; el.className = 'menu-info warn'; return; }
  const days = Math.floor((Date.now() - Number(last)) / 86400000);
  if (days >= 30) { el.textContent = `⚠️ Último backup há ${days} dias. Recomendado exportar.`; el.className = 'menu-info warn'; }
  else { el.textContent = `Último backup: ${days === 0 ? 'hoje' : `há ${days} dia(s)`}.`; el.className = 'menu-info'; }
}

function openSnapshots() {
  closeMenu();
  const list = document.getElementById('snapshotList');
  if (!snapshots.length) {
    list.innerHTML = '<div class="empty-mini">Nenhuma versão salva ainda.</div>';
  } else {
    list.innerHTML = snapshots.map((s, i) => `
      <div class="snap-item">
        <div class="snap-info">
          <div class="snap-label">${escapeHtml(s.label)}</div>
          <div class="snap-date">${new Date(s.at).toLocaleString('pt-BR')} · ${s.items.length} lançamento(s)</div>
        </div>
        <button class="btn-mini" data-action="restore-snapshot" data-index="${i}">Restaurar</button>
      </div>`).join('');
  }
  openPanel('snapshotPanel');
}

function restoreSnapshot(i) {
  const s = snapshots[i];
  if (!s) return;
  if (!confirm(`Restaurar a versão "${s.label}"? Os dados atuais serão substituídos.`)) return;
  pushSnapshot('Antes de restaurar');
  items = FintrackCore.migrateItems(s.items, newId);
  save(); closePanel('snapshotPanel'); render();
  toast('Versão restaurada');
}

function openSettings() {
  closeMenu();
  document.getElementById('setDue').checked = !!settings.alerts.due;
  document.getElementById('setBudget').checked = !!settings.alerts.budget;
  document.getElementById('setCashflow').checked = !!settings.alerts.cashflow;
  document.getElementById('setNotification').checked = !!settings.notification;
  document.getElementById('setCashflowDays').value = settings.cashflowAdvanceDays;
  updateCashflowAdvanceVisibility();
  document.getElementById('setTheme').checked = settings.theme === 'light';
  const hasPin = !!(settings.pin || settings.pinHash);
  document.getElementById('pinRemoveBtn').style.display = hasPin ? 'inline-block' : 'none';
  document.getElementById('pinCurrentWrap').hidden = !hasPin;
  openPanel('settingsPanel');
}
function closeSettings() { closePanel('settingsPanel'); }

function toggleAlert(key, val) {
  settings.alerts[key] = !!val;
  saveSettings();
  if (key === 'cashflow') updateCashflowAdvanceVisibility();
  renderAlerts();
}

function updateCashflowAdvanceVisibility() {
  const wrap = document.getElementById('cashflowAdvanceWrap');
  if (wrap) wrap.hidden = !settings.alerts.cashflow;
}

function setCashflowAdvance(value) {
  const days = Math.min(60, Math.max(0, Math.round(Number(value) || 0)));
  settings.cashflowAdvanceDays = days;
  const input = document.getElementById('setCashflowDays');
  if (input) input.value = days;
  saveSettings();
  renderAlerts();
}

function toggleNotification(val) {
  if (!val) {
    settings.notification = false;
    saveSettings();
    return;
  }
  FintrackNotifications.requestPermission().then(permission => {
    settings.notification = permission === 'granted';
    document.getElementById('setNotification').checked = settings.notification;
    saveSettings();
    if (!settings.notification) toast(permission === 'unsupported' ? 'Notificações não são compatíveis com este navegador' : 'Permissão de notificação não concedida');
    else { toast('Notificações ativadas'); renderAlerts(); }
  });
}

function toggleTheme(val) {
  settings.theme = val ? 'light' : 'dark';
  applyTheme();
  saveSettings();
}
function applyTheme() { document.documentElement.classList.toggle('light', settings.theme === 'light'); }

/* ─── PIN ────────────────────────────────── */
function bytesToHex(bytes) {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function randomHex(size = 16) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

async function derivePin(pin, salt, iterations = 210000) {
  if (!crypto?.subtle) throw new Error('Criptografia segura indisponível');
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations }, material, 256);
  return bytesToHex(new Uint8Array(bits));
}

async function legacyHashPin(pin) {
  const value = 'fintrack:' + pin;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(buf));
}

function legacyWeakHashPin(pin) {
  const value = 'fintrack:' + pin;
  let hash = 5381;
  for (let i = 0; i < value.length; i++) hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
  return 'x' + (hash >>> 0).toString(16);
}

async function verifyPin(pin) {
  if (settings.pin) return (await derivePin(pin, settings.pin.salt, settings.pin.iterations)) === settings.pin.hash;
  if (settings.pinHash?.startsWith('x')) return legacyWeakHashPin(pin) === settings.pinHash;
  if (settings.pinHash && crypto?.subtle) return (await legacyHashPin(pin)) === settings.pinHash;
  return false;
}

async function savePin() {
  const pin = document.getElementById('pinNew').value.trim();
  if (!/^\d{4,6}$/.test(pin)) { showSnackbar('PIN deve ter de 4 a 6 dígitos', null, null, 2500); return; }
  try {
    if (settings.pin || settings.pinHash) {
      const current = document.getElementById('pinCurrent').value.trim();
      if (!(await verifyPin(current))) { markInvalid(document.getElementById('pinCurrent'), 'PIN atual incorreto'); return; }
    }
    const salt = randomHex();
    settings.pin = { salt, iterations: 210000, hash: await derivePin(pin, salt, 210000) };
    settings.pinHash = null;
    saveSettings();
    document.getElementById('pinNew').value = '';
    document.getElementById('pinCurrent').value = '';
    document.getElementById('pinRemoveBtn').style.display = 'inline-block';
    document.getElementById('pinCurrentWrap').hidden = false;
    toast('Bloqueio de privacidade definido 🔒');
  } catch { toast('Este navegador não oferece criptografia segura para o PIN'); }
}

async function removePin() {
  const current = document.getElementById('pinCurrent').value.trim();
  if (!(await verifyPin(current))) { markInvalid(document.getElementById('pinCurrent'), 'Informe o PIN atual para remover'); return; }
  settings.pin = null;
  settings.pinHash = null;
  saveSettings();
  document.getElementById('pinCurrent').value = '';
  document.getElementById('pinRemoveBtn').style.display = 'none';
  document.getElementById('pinCurrentWrap').hidden = true;
  toast('PIN removido');
}

async function tryUnlock() {
  if (Date.now() < lockedUntil) {
    const seconds = Math.ceil((lockedUntil - Date.now()) / 1000);
    document.getElementById('lockError').textContent = `Aguarde ${seconds}s para tentar novamente.`;
    return;
  }
  const pin = document.getElementById('pinInput').value.trim();
  if (await verifyPin(pin)) {
    if (!settings.pin && settings.pinHash && crypto?.subtle) {
      const salt = randomHex();
      settings.pin = { salt, iterations: 210000, hash: await derivePin(pin, salt, 210000) };
      settings.pinHash = null;
      saveSettings();
    }
    unlocked = true;
    lockAttempts = 0;
    document.getElementById('lockScreen').hidden = true;
    document.getElementById('pinInput').value = '';
    document.getElementById('lockError').textContent = '';
  } else {
    lockAttempts++;
    if (lockAttempts >= 5) {
      lockedUntil = Date.now() + Math.min(300000, 30000 * Math.pow(2, Math.floor((lockAttempts - 5) / 2)));
      document.getElementById('lockError').textContent = 'Muitas tentativas. Aguarde 30 segundos.';
    } else document.getElementById('lockError').textContent = `PIN incorreto. Restam ${5 - lockAttempts} tentativa(s).`;
    document.getElementById('pinInput').value = '';
  }
}

function applyLock() {
  if (settings.pin || settings.pinHash) {
    unlocked = false;
    document.getElementById('lockScreen').hidden = false;
    setTimeout(() => document.getElementById('pinInput').focus(), 200);
  } else {
    document.getElementById('lockScreen').hidden = true;
  }
}

/* ═══════════════════════════════════════════
   Backup
   ═══════════════════════════════════════════ */
function exportBackup() {
  const backup = FintrackCore.createBackup(items, settings, snapshots);
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `fintrack-backup-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  try { localStorage.setItem('fintrack_lastBackup', Date.now().toString()); } catch {}
  closeMenu();
  toast('Backup exportado');
}

function triggerImport() { document.getElementById('importFile').click(); }

function importBackup(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = FintrackCore.parseBackup(reader.result, defaultSettings, newId);
      if (confirm(`Importar ${data.items.length} lançamentos? Isso substitui os dados atuais.`)) {
        pushSnapshot('Antes de importar');
        items = data.items;
        if (data.settings) settings = data.settings;
        if (data.snapshots.length) snapshots = data.snapshots;
        save(); queuePersist([['snapshots', snapshots]]); applyTheme(); updateBalanceToggle(); render(); closeMenu();
        toast(data.legacy ? 'Backup antigo importado e atualizado' : 'Backup importado');
      }
    } catch {
      showSnackbar('Arquivo inválido. Use um backup do Fintrack.', null, null, 4000);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

/* ═══════════════════════════════════════════
   Boot
   ═══════════════════════════════════════════ */
function setupEvents() {
  const actions = {
    'open-menu': () => openMenu(),
    'hero-view': el => setHeroView(el.dataset.view),
    'toggle-balance': () => toggleBalanceVisibility(),
    'switch-tab': el => switchTab(el.dataset.tab),
    'open-sheet': el => openSheet(el.dataset.id),
    'switch-view': el => switchView(el.dataset.view),
    'quick-add': () => applyQuickAdd(),
    'use-name-suggestion': el => useNameSuggestion(Number(el.dataset.index)),
    'quick-date': el => setQuickDate(Number(el.dataset.days) || 0, Number(el.dataset.months) || 0),
    'clear-search': () => clearSearch(),
    'set-type': el => setType(el.dataset.type),
    'toggle-categories': () => toggleCategoryChips(),
    'set-category': el => { setCategory(el.dataset.cat, true); document.getElementById('categoryChips').style.display = 'none'; },
    'show-date': () => showDateField(),
    'toggle-recurrence': () => toggleRecurrence(),
    'toggle-paid-sheet': () => togglePaidFromSheet(),
    'save-item': () => saveItem(),
    'duplicate-item': () => duplicateFromSheet(),
    'delete-sheet': () => deleteFromSheet(),
    'toggle-paid': el => togglePaid(el.dataset.id),
    'delete-item': el => deleteItem(el.dataset.id),
    'cancel-delete': () => cancelDelete(),
    'confirm-delete': () => confirmDelete(),
    'quick-deposit': el => quickDep(Number(el.dataset.value)),
    'close-deposit': () => closeDeposit(),
    'apply-deposit': () => applyDeposit(),
    'export-backup': () => exportBackup(),
    'trigger-import': () => triggerImport(),
    'open-snapshots': () => openSnapshots(),
    'open-settings': () => openSettings(),
    'clear-all': () => clearAll(),
    'save-pin': () => savePin(),
    'remove-pin': () => removePin(),
    'export-settings': () => { exportBackup(); closeSettings(); },
    'unlock': () => tryUnlock(),
    'snackbar-action': () => runSnackbarAction(),
    'change-month': el => changeMonth(Number(el.dataset.delta)),
    'home-month': el => changeHomeMonth(Number(el.dataset.delta)),
    'select-month': el => selectHomeMonth(el.dataset.month),
    'toggle-close-month': () => toggleCloseMonth(),
    'set-projection-horizon': el => setProjectionHorizon(Number(el.dataset.months)),
    'show-day': el => showDay(el.dataset.date),
    'accept-recurrence': el => acceptRecurrence(Number(el.dataset.index)),
    'dismiss-suggestion': el => dismissSuggestion(Number(el.dataset.index)),
    'delete-goal': el => deleteGoal(el.dataset.id),
    'deposit-goal': el => depositGoal(el.dataset.id),
    'add-goal': () => addGoal(),
    'dismiss-alert': el => dismissAlert(Number(el.dataset.index)),
    'restore-snapshot': el => restoreSnapshot(Number(el.dataset.index))
  };

  document.addEventListener('click', event => {
    const control = event.target.closest('[data-action]');
    if (control) {
      const handler = actions[control.dataset.action];
      if (handler) { event.preventDefault(); handler(control, event); }
      return;
    }
    if (event.target.id === 'overlay') closeSheet();
    else if (event.target.id === 'confirmPanel') cancelDelete();
    else if (event.target.id === 'depositSheet') closeDeposit();
    else if (event.target.id === 'menuPanel') closeMenu();
    else if (event.target.id === 'snapshotPanel') closePanel('snapshotPanel');
    else if (event.target.id === 'settingsPanel') closeSettings();
  });

  document.addEventListener('input', event => {
    if (event.target.id === 'searchInput') onSearch();
    else if (event.target.id === 'fName') {
      suggestCategory();
      applyNameAutoFill();
      renderNameSuggestions(event.target.value);
    }
  });

  document.addEventListener('change', event => {
    const target = event.target;
    if (target.dataset.settingAlert) toggleAlert(target.dataset.settingAlert, target.checked);
    else if (target.id === 'setNotification') toggleNotification(target.checked);
    else if (target.id === 'setCashflowDays') setCashflowAdvance(target.value);
    else if (target.id === 'setTheme') toggleTheme(target.checked);
    else if (target.id === 'budgetRollover') toggleRollover(target.checked);
    else if (target.dataset.budgetCat) setBudget(target.dataset.budgetCat, target.value);
    else if (target.id === 'importFile') importBackup(event);
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      closeSheet(); cancelDelete(); closeDeposit(); closeMenu(); closePanel('snapshotPanel'); closeSettings();
      return;
    }
    if (event.key !== 'Enter') return;
    if (event.target.id === 'quickAdd') { event.preventDefault(); applyQuickAdd(); }
    else if (event.target.id === 'pinInput') { event.preventDefault(); tryUnlock(); }
  });
}

async function boot() {
  await loadData();
  applyTheme();
  updateBalanceToggle();
  setupEvents();
  setupCurrencyMask(document.getElementById('fValue'));

  ['fName', 'fValue'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); saveItem(); }
    });
  });

  render();
  applyLock();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && (settings.pin || settings.pinHash)) applyLock();
  });

  const updateOnline = () => { const b = document.getElementById('offlineBadge'); if (b) b.hidden = navigator.onLine; };
  window.addEventListener('online', updateOnline);
  window.addEventListener('offline', updateOnline);
  updateOnline();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      const hadController = !!navigator.serviceWorker.controller;
      let notified = false;
      navigator.serviceWorker.register('sw.js').catch(() => {});
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (notified || !hadController) return;
        notified = true;
        showSnackbar('Nova versão disponível', 'Recarregar', () => location.reload(), 12000);
      });
    });
  }
}

boot();
