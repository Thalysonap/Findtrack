const STORAGE_KEY = 'fintrack_v1';
let items = [];
let currentTab = 'all';
let currentType = 'expense';
let editId = null;
let pendingDeleteId = null;
let heroView = 'today';
let heroBalances = { today: 0, all: 0 };

function load() {
  try { items = JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
  catch { items = []; }
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

function fmt(n) {
  return 'R$ ' + Math.abs(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(d) {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  return `${day}/${m}`;
}

function fmtDateFull(d) {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  const months = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
  return `${day} ${months[parseInt(m,10)-1]}`;
}

function dueStatus(d) {
  if (!d) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  const due = new Date(d + 'T00:00:00');
  const diff = Math.round((due - today) / 86400000);
  if (diff < 0)  return { label: diff === -1 ? 'Venceu ontem' : `Venceu há ${Math.abs(diff)}d`, cls: 'badge-red',    urgency: 0, diff };
  if (diff === 0) return { label: 'Hoje',                                                          cls: 'badge-today',  urgency: 1, diff };
  if (diff === 1) return { label: 'Amanhã',                                                        cls: 'badge-yellow', urgency: 2, diff };
  if (diff <= 3)  return { label: `Em ${diff}d`,                                                   cls: 'badge-yellow', urgency: 3, diff };
  return { label: fmtDateFull(d), cls: 'badge-muted', urgency: 4, diff };
}

/* Urgency para ordenação: vencida(0) < hoje(1) < amanhã(2) < 3d(3) < normal(4) < sem data(5) < pago(6) */
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
    // mesmo nível: ordenar por data
    if (a.date && b.date) return a.date.localeCompare(b.date);
    if (a.date) return -1;
    if (b.date) return 1;
    return b.createdAt - a.createdAt;
  });
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function calcTotals() {
  const expenses = items.filter(i => i.type === 'expense');
  const income   = items.filter(i => i.type === 'income');

  const totalI   = income.reduce((s, i) => s + i.value, 0);
  const paidE    = expenses.filter(i => i.paid).reduce((s, i) => s + i.value, 0);
  const pendingE = expenses.filter(i => !i.paid).reduce((s, i) => s + i.value, 0);
  const totalE   = paidE + pendingE;

  // Saldo hoje = entradas - o que já saiu (pago)
  const balanceToday = totalI - paidE;
  // Saldo se pagar tudo = entradas - todas as despesas
  const balanceAll   = totalI - totalE;

  heroBalances.today = balanceToday;
  heroBalances.all   = balanceAll;
  updateHeroDisplay();

  document.getElementById('totalExpense').textContent = fmt(pendingE);
  document.getElementById('totalIncome').textContent  = fmt(totalI);

  const paidCount = expenses.filter(i => i.paid).length;
  const total     = expenses.length;
  const pct       = total ? Math.round(paidCount / total * 100) : 0;
  document.getElementById('paidCount').textContent   = `${paidCount} de ${total} pagas`;
  document.getElementById('paidPercent').textContent = `${pct}%`;

  const fill = document.getElementById('progressFill');
  fill.style.width = pct + '%';
  fill.style.background = pct === 100 ? 'var(--green)' : pct > 50 ? 'var(--yellow)' : 'var(--red)';

  renderTodayBadge();
}

function updateHeroDisplay() {
  const value = heroView === 'today' ? heroBalances.today : heroBalances.all;
  const el = document.getElementById('heroBalance');
  const sub = document.getElementById('heroSublabel');
  el.textContent = fmt(value);
  el.className = 'hero-balance ' + (value > 0 ? 'positive' : value < 0 ? 'negative' : 'zero');
  sub.textContent = heroView === 'today' ? 'após contas já pagas' : 'incluindo pendentes';
}

function setHeroView(view) {
  heroView = view;
  document.getElementById('toggleToday').classList.toggle('active', view === 'today');
  document.getElementById('toggleAll').classList.toggle('active', view === 'all');
  updateHeroDisplay();
}

function renderTodayBadge() {
  const today = todayStr();
  const todayItems = items.filter(i => i.type === 'expense' && !i.paid && i.date === today);
  const badge = document.getElementById('todayBadge');
  if (todayItems.length > 0) {
    badge.textContent = todayItems.length;
    badge.style.display = 'inline-flex';
  } else {
    badge.style.display = 'none';
  }
}

function render() {
  calcTotals();
  const wrap = document.getElementById('listWrap');

  let filtered;
  if (currentTab === 'open') filtered = items.filter(i => i.type === 'expense' && !i.paid);
  else if (currentTab === 'done') filtered = items.filter(i => i.type === 'expense' && i.paid);
  else if (currentTab === 'in')  filtered = items.filter(i => i.type === 'income');
  else filtered = [...items];

  if (!filtered.length) {
    wrap.innerHTML = `
      <div class="empty">
        <div class="empty-icon">📭</div>
        <p>Nada por aqui ainda.<br>Toque em <b>Adicionar</b> para começar.</p>
      </div>`;
    return;
  }

  // Ordenar por urgência
  const sorted = sortByUrgency(filtered);

  // Na aba "todas" e "em aberto": mostrar seção "Hoje" separada
  const today = todayStr();
  let html = '';

  if (currentTab === 'all' || currentTab === 'open') {
    const todayItems = sorted.filter(i => i.type === 'expense' && !i.paid && i.date === today);
    const overdueItems = sorted.filter(i => i.type === 'expense' && !i.paid && i.date && i.date < today);
    const otherItems = sorted.filter(i => !(i.type === 'expense' && !i.paid && i.date === today) && !(i.type === 'expense' && !i.paid && i.date && i.date < today));

    if (overdueItems.length) {
      html += renderSection('🔴 Vencidas', overdueItems, 'section-overdue');
    }
    if (todayItems.length) {
      html += renderTodaySection(todayItems);
    }
    if (otherItems.length) {
      if (overdueItems.length || todayItems.length) {
        html += renderSection('Próximas', otherItems, 'section-normal');
      } else {
        html += renderItemsList(otherItems);
      }
    }
  } else {
    html += renderItemsList(sorted);
  }

  wrap.innerHTML = html;

  // Adicionar listeners de swipe para marcar como pago
  setupSwipeListeners();
}

function renderTodaySection(items) {
  const total = items.reduce((s, i) => s + i.value, 0);
  let html = `
    <div class="today-section">
      <div class="today-header">
        <div class="today-title">
          <span class="today-dot"></span>
          <span>Vencem hoje</span>
        </div>
        <span class="today-total">${fmt(total)}</span>
      </div>
      <div class="today-list">
  `;
  items.forEach(it => { html += renderItem(it, true); });
  html += `</div></div>`;
  return html;
}

function renderSection(title, items, cls) {
  let html = `<div class="section-group ${cls || ''}">
    <div class="section-title-row"><span class="section-title-text">${title}</span></div>`;
  items.forEach(it => { html += renderItem(it); });
  html += `</div>`;
  return html;
}

function renderItemsList(items) {
  return items.map(it => renderItem(it)).join('');
}

function renderItem(it, isToday) {
  const status    = dueStatus(it.date);
  const isExpense = it.type === 'expense';
  const icon      = (it.category || '📦 Outros').split(' ')[0];

  // Badge principal: status urgente ou data futura
  let badgeCls, badgeLabel, subLabel;
  if (it.paid) {
    badgeCls = 'badge-green';
    badgeLabel = 'Paga';
    // Info secundária: quando venceu
    subLabel = it.date ? (status ? status.label.replace('Venceu', 'venceu').replace('Hoje', 'hoje') : fmtDateFull(it.date)) : '';
  } else if (status) {
    badgeCls = status.cls; badgeLabel = status.label; subLabel = '';
  } else {
    badgeCls = ''; badgeLabel = ''; subLabel = '';
  }

  const urgencyClass = !it.paid && isExpense ? getUrgencyItemClass(it) : '';
  const todayClass   = isToday ? 'item-today' : '';
  const paidClass    = it.paid ? 'paid' : '';

  return `
    <div class="item ${paidClass} ${urgencyClass} ${todayClass}" id="item-${it.id}" onclick="openSheet('${it.id}')">
      <div class="item-icon" style="background:${isExpense ? 'var(--red-dim)' : 'var(--green-dim)'}">
        ${icon}
      </div>
      <div class="item-info">
        <div class="item-name">${it.name}</div>
        <div class="item-meta">
          ${badgeLabel ? `<span class="badge ${badgeCls}">${badgeLabel}</span>` : ''}
          ${subLabel ? `<span class="meta-sub">${subLabel}</span>` : ''}
        </div>
      </div>
      <div class="item-right">
        <div class="item-value ${isExpense ? 'red' : 'green'}">${isExpense ? '−' : '+'}${fmt(it.value)}</div>
        <div class="item-actions">
          ${isExpense ? `
            <button class="btn-action btn-done ${it.paid ? 'btn-done-active' : ''}"
              onclick="event.stopPropagation(); togglePaid('${it.id}')"
              title="${it.paid ? 'Desmarcar' : 'Marcar paga'}">
              ${it.paid ? '✓' : '○'}
            </button>` : ''}
          <button class="btn-action btn-del" onclick="event.stopPropagation(); deleteItem('${it.id}')" title="Excluir">✕</button>
        </div>
      </div>
    </div>`;
}

function getUrgencyItemClass(it) {
  if (it.paid) return '';
  const s = dueStatus(it.date);
  if (!s) return '';
  if (s.diff < 0)  return 'item-overdue';
  if (s.diff === 0) return 'item-duetoday';
  if (s.diff <= 3)  return 'item-duenear';
  return '';
}

function setupSwipeListeners() {
  // Usa delegação no container para evitar acumular listeners a cada render()
  const wrap = document.getElementById('listWrap');
  if (wrap._swipeReady) return;
  wrap._swipeReady = true;

  let startX = 0, startY = 0, moved = false, targetId = null;

  wrap.addEventListener('touchstart', e => {
    const item = e.target.closest('.item');
    if (!item) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    moved = false;
    targetId = item.id.replace('item-', '');
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

function togglePaid(id) {
  const it = items.find(i => i.id === id);
  if (!it) return;
  it.paid = !it.paid;
  save(); render();
}

function deleteItem(id) {
  const it = items.find(i => i.id === id);
  if (!it) return;
  pendingDeleteId = id;
  document.getElementById('confirmText').textContent =
    `Tem certeza que deseja excluir "${it.name}"? Essa ação não pode ser desfeita.`;
  document.getElementById('confirmPanel').classList.add('open');
}

function confirmDelete() {
  if (!pendingDeleteId) return;
  const idx = items.findIndex(i => i.id === pendingDeleteId);
  if (idx === -1) { closeConfirm(); return; }
  items.splice(idx, 1);
  save(); render();
  closeConfirm();
}

function cancelDelete() {
  closeConfirm();
}

function closeConfirm() {
  pendingDeleteId = null;
  document.getElementById('confirmPanel').classList.remove('open');
}

function closeConfirmOnBg(e) {
  if (e.target === document.getElementById('confirmPanel')) cancelDelete();
}

function clearAll() {
  if (confirm('Apagar tudo? Esta ação não pode ser desfeita.')) {
    items = []; save(); render(); closeMenu();
  }
}

function switchTab(tab) {
  currentTab = tab;
  ['all','open','done','in'].forEach(t => {
    document.getElementById('tab-' + t).classList.toggle('active', t === tab);
  });
  render();
}

function digitsToCurrency(digits) {
  if (!digits) digits = '0';
  digits = digits.replace(/^0+(?=\d)/, '');
  while (digits.length < 3) digits = '0' + digits;
  const cents = digits.slice(-2);
  let intPart = digits.slice(0, -2);
  intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `R$ ${intPart},${cents}`;
}

function currencyToNumber(digits) {
  if (!digits) return 0;
  return parseInt(digits, 10) / 100;
}

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

function getValueNumber() {
  const input = document.getElementById('fValue');
  return currencyToNumber(input.dataset.raw || '');
}

function setValueDisplay(num) {
  const input = document.getElementById('fValue');
  const digits = Math.round((num || 0) * 100).toString();
  input.dataset.raw = digits;
  input.value = digitsToCurrency(digits);
}

const ALL_CATEGORIES = ['🏠 Moradia','🛒 Mercado','🚗 Transporte','💊 Saúde','🎓 Educação','🎮 Lazer','💳 Cartão','📱 Assinatura','💼 Trabalho','💵 Salário','📦 Outros'];

const CATEGORY_RULES = [
  { cat: '🏠 Moradia',    words: ['aluguel','condominio','condomínio','iptu','luz','energia','agua','água','gas','gás','internet','wifi','financiamento casa','prestacao casa'] },
  { cat: '🛒 Mercado',    words: ['mercado','supermercado','feira','acougue','açougue','padaria','hortifruti','atacadao','atacadão','assai','assaí'] },
  { cat: '🚗 Transporte', words: ['uber','99','combustivel','combustível','gasolina','alcool','álcool','estacionamento','pedagio','pedágio','ipva','onibus','ônibus','metro','metrô','oficina','mecanico','mecânico'] },
  { cat: '💊 Saúde',      words: ['farmacia','farmácia','remedio','remédio','medico','médico','consulta','plano de saude','plano de saúde','dentista','academia','exame','psicologo','psicólogo'] },
  { cat: '🎓 Educação',   words: ['faculdade','curso','escola','mensalidade','livro','material escolar','ingles','inglês','udemy'] },
  { cat: '🎮 Lazer',      words: ['cinema','show','viagem','bar','balada','ifood','restaurante','lanchonete','passeio','jogo','game'] },
  { cat: '💳 Cartão',     words: ['fatura','cartao','cartão','nubank','inter fatura','itau fatura','itaú fatura'] },
  { cat: '📱 Assinatura', words: ['netflix','spotify','amazon prime','disney','hbo','youtube premium','assinatura','icloud','google one'] },
  { cat: '💼 Trabalho',   words: ['freela','freelance','projeto','cliente','consultoria'] },
  { cat: '💵 Salário',    words: ['salario','salário','pagamento','holerite','pro labore','pró-labore'] },
];

function normalize(str) {
  return str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function guessCategory(name) {
  const n = normalize(name);
  if (!n.trim()) return null;
  for (const rule of CATEGORY_RULES) {
    for (const w of rule.words) {
      if (n.includes(normalize(w))) return rule.cat;
    }
  }
  return null;
}

function renderChips() {
  const wrap = document.getElementById('categoryChips');
  wrap.innerHTML = ALL_CATEGORIES.map(cat =>
    `<button type="button" class="chip" data-cat="${cat}" onclick="setCategory('${cat}', true); document.getElementById('categoryChips').style.display='none';">${cat}</button>`
  ).join('');
}

function setCategory(cat, manual) {
  document.getElementById('fCategory').value = cat;
  document.getElementById('categoryPill').textContent = cat;
  // Recriar o ::after via dataset
  document.getElementById('categoryPill').dataset.label = 'trocar';
  document.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c.dataset.cat === cat));
  if (manual) categoryManuallySet = true;
}

function toggleCategoryChips() {
  const chips = document.getElementById('categoryChips');
  chips.style.display = chips.style.display === 'none' ? 'flex' : 'none';
}

let categoryManuallySet = false;

function suggestCategory() {
  if (categoryManuallySet) return;
  const name = document.getElementById('fName').value;
  const guess = guessCategory(name);
  if (guess) setCategory(guess, false);
}

function openSheet(id) {
  editId = id || null;
  categoryManuallySet = false;
  renderChips();
  document.getElementById('categoryChips').style.display = 'none';
  document.getElementById('dateGroup').style.display = 'none';
  document.getElementById('dateToggle').textContent = '📅 Adicionar vencimento';

  if (editId) {
    const it = items.find(i => i.id === editId);
    if (!it) return;
    document.getElementById('sheetTitle').textContent = 'Editar lançamento';
    document.getElementById('fName').value = it.name;
    setValueDisplay(it.value);
    document.getElementById('fDate').value = it.date || '';
    setCategory(it.category, true);
    setType(it.type);
    document.getElementById('btnDeleteFull').style.display = 'block';

    // Botão de marcar pago direto no sheet
    const paidBtn = document.getElementById('btnTogglePaid');
    if (it.type === 'expense') {
      paidBtn.style.display = 'block';
      paidBtn.textContent = it.paid ? '↩ Desmarcar pagamento' : '✓ Marcar como paga';
      paidBtn.className = it.paid ? 'btn-toggle-paid btn-toggle-unpaid' : 'btn-toggle-paid btn-toggle-done';
    } else {
      paidBtn.style.display = 'none';
    }

    if (it.date) {
      document.getElementById('dateGroup').style.display = 'block';
      document.getElementById('dateToggle').style.display = 'none';
    } else {
      document.getElementById('dateToggle').style.display = 'block';
    }
  } else {
    document.getElementById('sheetTitle').textContent = 'Nova entrada';
    document.getElementById('fName').value = '';
    setValueDisplay(0);
    document.getElementById('fDate').value = new Date().toISOString().split('T')[0];
    setCategory('🏠 Moradia', false);
    setType('expense');
    document.getElementById('btnDeleteFull').style.display = 'none';
    document.getElementById('btnTogglePaid').style.display = 'none';
    document.getElementById('dateToggle').style.display = 'block';
  }

  document.getElementById('overlay').classList.add('open');
  setTimeout(() => document.getElementById('fValue').focus(), 300);
}

function showDateField() {
  document.getElementById('dateGroup').style.display = 'block';
  document.getElementById('dateToggle').style.display = 'none';
}

function closeSheet() {
  document.getElementById('overlay').classList.remove('open');
}

function closeOnBg(e) {
  if (e.target === document.getElementById('overlay')) closeSheet();
}

function setType(type) {
  currentType = type;
  document.getElementById('btnExpense').className = 'type-btn' + (type === 'expense' ? ' active-expense' : '');
  document.getElementById('btnIncome').className  = 'type-btn' + (type === 'income'  ? ' active-income'  : '');
  if (type === 'income' && !editId) {
    setCategory('💵 Salário', false);
  }
}

function saveItem() {
  const name  = document.getElementById('fName').value.trim();
  const value = getValueNumber();
  const date  = document.getElementById('fDate').value;
  const cat   = document.getElementById('fCategory').value;

  if (!name) { document.getElementById('fName').focus(); return; }
  if (!value || value <= 0) { document.getElementById('fValue').focus(); return; }

  if (editId) {
    const it = items.find(i => i.id === editId);
    if (it) {
      it.name = name; it.value = value; it.date = date;
      it.category = cat; it.type = currentType;
    }
  } else {
    items.unshift({
      id: Date.now().toString(),
      name, value, date, category: cat,
      type: currentType,
      paid: false,
      createdAt: Date.now()
    });
  }

  save();
  closeSheet();
  render();
}

function togglePaidFromSheet() {
  if (!editId) return;
  const it = items.find(i => i.id === editId);
  if (!it) return;
  it.paid = !it.paid;
  save();
  closeSheet();
  render();
}

function deleteFromSheet() {
  if (!editId) return;
  closeSheet();
  deleteItem(editId);
}

function openMenu() {
  document.getElementById('menuPanel').classList.add('open');
}

function closeMenu() {
  document.getElementById('menuPanel').classList.remove('open');
}

function closeMenuOnBg(e) {
  if (e.target === document.getElementById('menuPanel')) closeMenu();
}

function exportBackup() {
  const blob = new Blob([JSON.stringify(items, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const date = new Date().toISOString().split('T')[0];
  a.href = url;
  a.download = `fintrack-backup-${date}.json`;
  a.click();
  URL.revokeObjectURL(url);
  closeMenu();
}

function triggerImport() {
  document.getElementById('importFile').click();
}

function importBackup(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data)) throw new Error('formato inválido');
      if (confirm(`Importar ${data.length} lançamentos? Isso substitui os dados atuais.`)) {
        items = data;
        save();
        render();
        closeMenu();
      }
    } catch {
      alert('Arquivo inválido. Selecione um backup exportado pelo próprio Fintrack.');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

load();
setupCurrencyMask(document.getElementById('fValue'));
render();
