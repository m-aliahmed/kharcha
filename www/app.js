'use strict';

/* =========================================================
   Kharcha — simple expense & budget tracker (PKR)
   All data lives in localStorage on this device.
   ========================================================= */

const STORE_KEY = 'kharcha.v1';
// Capacitor plugins (www/native.js) when running as the Android app; null in a browser.
const Native = window.Native && window.Native.Capacitor.isNativePlatform() ? window.Native : null;
const PALETTE = ['#0f9d76', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#64748b', '#84cc16', '#06b6d4', '#a855f7'];
const DEFAULT_CATEGORIES = [
  ['Groceries', '🛒'], ['Food & Dining', '🍔'], ['Transport & Fuel', '⛽'], ['Bills & Utilities', '💡'],
  ['Rent', '🏠'], ['Mobile & Internet', '📱'], ['Health', '💊'], ['Shopping', '🛍️'],
  ['Education', '📚'], ['Other', '📦'],
];
const EMOJIS = ['🛒', '🍔', '☕', '⛽', '🚗', '🚌', '💡', '🔥', '💧', '🏠', '📱', '🌐', '💊', '🏥', '🛍️', '👕',
  '📚', '🎓', '🎁', '🎉', '✈️', '💼', '👶', '🐾', '💳', '🧾', '🔧', '🎮', '💇', '🕌', '❤️', '📦'];

/* ---------- Small helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const pad = n => String(n).padStart(2, '0');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const round2 = n => Math.round(n * 100) / 100;
const fmt = n => 'Rs ' + round2(n).toLocaleString('en-PK', { maximumFractionDigits: 2 });

const monthKey = d => d.getFullYear() + '-' + pad(d.getMonth() + 1);
const dateKey = d => monthKey(d) + '-' + pad(d.getDate());
const curMonth = () => monthKey(new Date());
const todayKey = () => dateKey(new Date());
const parseMonth = k => { const [y, m] = k.split('-').map(Number); return new Date(y, m - 1, 1); };
const parseDate = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addMonths = (k, n) => { const d = parseMonth(k); d.setMonth(d.getMonth() + n); return monthKey(d); };
const daysInMonth = k => { const d = parseMonth(k); return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); };
const monthLabel = (k, opts = { month: 'long', year: 'numeric' }) => parseMonth(k).toLocaleDateString('en-GB', opts);

function parseAmount(str) {
  const n = parseFloat(String(str).replace(/[,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? round2(n) : null;
}

function dayLabel(k) {
  const today = todayKey();
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (k === today) return 'Today';
  if (k === dateKey(y)) return 'Yesterday';
  return parseDate(k).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

/* ---------- Storage ---------- */
function freshState() {
  return {
    version: 1,
    categories: DEFAULT_CATEGORIES.map(([name, icon], i) => ({
      id: 'c' + i + uid(), name, icon, color: PALETTE[i % PALETTE.length], budget: 0, archived: false,
    })),
    budgets: {},      // { 'YYYY-MM': { catId: amount } } — snapshot of budgets for each month
    expenses: [],     // { id, amount, catId, note, date: 'YYYY-MM-DD', createdAt }
    credits: [],      // { id, amount, note, date: 'YYYY-MM-DD', createdAt } — money received
    lastCat: null,
    lastBackup: null,
  };
}

function isValidState(s) {
  return s && typeof s === 'object' && Array.isArray(s.categories) && Array.isArray(s.expenses)
    && s.budgets && typeof s.budgets === 'object';
}

// Data and backups from before v1.1 have no credits list.
function migrate(s) {
  if (!Array.isArray(s.credits)) s.credits = [];
  return s;
}

function load() {
  let raw = null;
  try { raw = localStorage.getItem(STORE_KEY); } catch (e) { /* storage blocked */ }
  if (!raw) return freshState();
  try {
    const s = JSON.parse(raw);
    if (isValidState(s)) return migrate(s);
  } catch (e) { /* fall through */ }
  // Keep the unreadable copy rather than silently overwriting it.
  try { localStorage.setItem(STORE_KEY + '.broken.' + Date.now(), raw); } catch (e) { /* ignore */ }
  return freshState();
}

function save() {
  const json = JSON.stringify(state);
  try {
    localStorage.setItem(STORE_KEY, json);
  } catch (e) {
    if (!Native) toast('Could not save. Phone storage may be full.');
  }
  // In the Android app, Preferences (native storage) is the main copy.
  if (Native) Native.Preferences.set({ key: STORE_KEY, value: json }).catch(() => toast('Could not save. Phone storage may be full.'));
}

async function loadNative() {
  if (!Native) return;
  try {
    const { value } = await Native.Preferences.get({ key: STORE_KEY });
    if (!value) return save(); // first run: copy anything already in localStorage over
    const s = JSON.parse(value);
    if (isValidState(s)) state = migrate(s);
  } catch (e) { /* keep the localStorage copy */ }
}

let state = load();

/* ---------- Budget model ----------
   Each month keeps its own snapshot of category budgets, so changing a
   budget today never rewrites what last month's budget was. */
function defaultBudgets() {
  const map = {};
  for (const c of state.categories) if (!c.archived) map[c.id] = c.budget;
  return map;
}

function monthBudgets(k) {
  if (state.budgets[k]) return state.budgets[k];
  if (k >= curMonth()) return defaultBudgets();
  // A past month the app was never opened in: inherit the closest earlier snapshot.
  const earlier = Object.keys(state.budgets).filter(m => m < k).sort().pop();
  return earlier ? state.budgets[earlier] : defaultBudgets();
}

function ensureMonth(k) {
  if (!state.budgets[k]) state.budgets[k] = { ...monthBudgets(k) };
  return state.budgets[k];
}

function setBudget(catId, k, amount) {
  ensureMonth(k)[catId] = amount;
  if (k >= curMonth()) {
    const cat = getCat(catId);
    if (cat) cat.budget = amount;
    for (const m of Object.keys(state.budgets)) if (m > k) state.budgets[m][catId] = amount;
  }
}

function addCategory(name, icon, amount, k) {
  const c = { id: uid(), name, icon, color: PALETTE[state.categories.length % PALETTE.length], budget: amount, archived: false };
  state.categories.push(c);
  ensureMonth(k)[c.id] = amount;
  for (const m of Object.keys(state.budgets)) if (m >= curMonth()) state.budgets[m][c.id] = amount;
  return c;
}

const getCat = id => state.categories.find(c => c.id === id);
const activeCats = () => state.categories.filter(c => !c.archived);
const monthExpenses = k => state.expenses.filter(e => e.date.startsWith(k));
const monthCredits = k => state.credits.filter(c => c.date.startsWith(k));

function monthStats(k) {
  const exps = monthExpenses(k);
  const byCat = {};
  let spent = 0;
  for (const e of exps) { byCat[e.catId] = (byCat[e.catId] || 0) + e.amount; spent += e.amount; }
  const mb = monthBudgets(k);
  const rows = state.categories
    .filter(c => !c.archived || byCat[c.id] || (k < curMonth() && mb[c.id] > 0))
    .map(c => ({ cat: c, spent: byCat[c.id] || 0, budget: mb[c.id] || 0 }));
  // Expenses whose category no longer exists (e.g. from an edited backup).
  const known = new Set(state.categories.map(c => c.id));
  const orphan = exps.filter(e => !known.has(e.catId)).reduce((a, e) => a + e.amount, 0);
  if (orphan) rows.push({ cat: { id: '_', name: 'Uncategorised', icon: '❔', color: '#64748b' }, spent: orphan, budget: 0 });
  const budget = rows.reduce((a, r) => a + r.budget, 0);
  const credit = monthCredits(k).reduce((a, c) => a + c.amount, 0);
  return { exps, rows, spent: round2(spent), budget: round2(budget), count: exps.length, credit: round2(credit) };
}

function status(spent, budget) {
  if (!budget) return 'none';
  const p = spent / budget;
  return p > 1 ? 'over' : p >= 0.85 ? 'warn' : 'ok';
}

/* ---------- UI state ---------- */
const ui = { tab: 'home', month: curMonth(), filter: 'all', sheetOpen: false, ignorePop: false };

/* ---------- Rendering ---------- */
function render() {
  const titles = { home: 'Kharcha', expenses: 'Expenses', credits: 'Credit', budgets: 'Budgets', history: 'History' };
  $('#title').textContent = titles[ui.tab];
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('on', b.dataset.tab === ui.tab));

  const isCur = ui.month === curMonth();
  $('#monthbar').classList.toggle('hidden', ui.tab === 'history');
  $('#monthLabel').innerHTML = esc(monthLabel(ui.month)) + (isCur ? '' : '<small>Tap for this month</small>');
  $('#nextMonth').disabled = ui.month >= curMonth();
  $('#fab').classList.toggle('hidden', ui.tab === 'history' || ui.tab === 'budgets');
  $('#fab').dataset.act = ui.tab === 'credits' ? 'add-credit' : 'add-expense';
  $('#fab').setAttribute('aria-label', ui.tab === 'credits' ? 'Add credit' : 'Add expense');

  const view = $('#view');
  view.innerHTML = ({ home: viewHome, expenses: viewExpenses, credits: viewCredits, budgets: viewBudgets, history: viewHistory })[ui.tab]();
}

function barHTML(spent, budget, st) {
  const pct = budget ? Math.min(100, (spent / budget) * 100) : 0;
  return `<div class="bar"><span class="${st}" style="width:${pct.toFixed(1)}%"></span></div>`;
}

function leftHTML(spent, budget) {
  if (!budget) return `<span class="left-none">No budget</span>`;
  const left = budget - spent;
  const st = status(spent, budget);
  if (left < 0) return `<span class="left-over">${fmt(-left)} over</span>`;
  return `<span class="left-${st}">${fmt(left)} left</span>`;
}

function txHTML(e) {
  const c = getCat(e.catId) || { name: 'Uncategorised', icon: '❔', color: '#64748b' };
  const title = e.note ? esc(e.note) : esc(c.name);
  const sub = e.note ? esc(c.name) : '';
  return `<button class="row" data-act="edit-expense" data-id="${esc(e.id)}">
    <span class="ico" style="--c:${esc(c.color)}">${esc(c.icon)}</span>
    <span class="grow"><span class="name" style="display:block">${title}</span>${sub ? `<span class="sub">${sub}</span>` : ''}</span>
    <span class="amt">${fmt(e.amount)}</span>
  </button>`;
}

function creditHTML(c) {
  return `<button class="row" data-act="edit-credit" data-id="${esc(c.id)}">
    <span class="ico">💰</span>
    <span class="grow"><span class="name" style="display:block">${esc(c.note || 'Credit')}</span><span class="sub">${esc(dayLabel(c.date))}</span></span>
    <span class="amt in">+ ${fmt(c.amount)}</span>
  </button>`;
}

function sortedByDate(list) {
  return list.slice().sort((a, b) => (b.date.localeCompare(a.date)) || (b.createdAt - a.createdAt));
}

function viewHome() {
  const k = ui.month;
  const s = monthStats(k);
  const isCur = k === curMonth();
  const left = s.budget - s.spent;
  const over = s.budget && left < 0;

  let stat1, stat2;
  if (!s.budget) {
    stat1 = `<b>${s.count}</b><span>expense${s.count === 1 ? '' : 's'}</span>`;
    stat2 = `<b>${fmt(s.count ? s.spent / (isCur ? new Date().getDate() : daysInMonth(k)) : 0)}</b><span>avg per day</span>`;
  } else if (isCur) {
    const daysLeft = daysInMonth(k) - new Date().getDate() + 1;
    stat1 = over ? `<b>${fmt(-left)}</b><span>over budget</span>` : `<b>${fmt(left)}</b><span>left to spend</span>`;
    stat2 = `<b>${fmt(Math.max(0, left) / daysLeft)}</b><span>per day · ${daysLeft} day${daysLeft === 1 ? '' : 's'} left</span>`;
  } else {
    stat1 = over ? `<b>${fmt(-left)}</b><span>over budget</span>` : `<b>${fmt(left)}</b><span>saved</span>`;
    stat2 = `<b>${s.count}</b><span>expense${s.count === 1 ? '' : 's'}</span>`;
  }

  const pct = s.budget ? Math.round((s.spent / s.budget) * 100) : 0;
  let html = `<section class="summary ${over ? 'over' : ''}">
    <div class="lbl">${isCur ? 'Spent this month' : 'Spent in ' + esc(monthLabel(k, { month: 'long' }))}</div>
    <div class="big">${fmt(s.spent)}</div>
    <div class="of">${s.budget ? `of ${fmt(s.budget)} budget · ${pct}%` : 'No budget set'}</div>
    <div class="bar"><span style="width:${s.budget ? Math.min(100, pct) : 0}%"></span></div>
    <div class="stats"><div class="stat">${stat1}</div><div class="stat">${stat2}</div></div>
  </section>`;

  const bal = round2(s.credit - s.spent);
  html += `<div class="list credit-row"><button class="row" data-act="${s.credit ? 'goto' : 'add-credit'}" data-tab="credits">
    <span class="ico">💰</span>
    <span class="grow">
      <span class="line1"><span class="name">Credit</span>${s.credit ? `<span class="amt in">+ ${fmt(s.credit)}</span>` : ''}</span>
      <span class="sub">${!s.credit ? 'Tap to add money that came in' : bal < 0 ? `<span class="neg">Overspent by ${fmt(-bal)}</span>` : `Balance ${fmt(bal)}`}</span>
    </span>
    <span class="chev">›</span>
  </button></div>`;

  if (!s.budget && activeCats().length) {
    html += `<button class="banner" data-act="goto" data-tab="budgets">
      <span class="em">🎯</span><span><b>Set your monthly budgets</b><span>Give each category a PKR limit to track how much is left.</span></span>
    </button>`;
  }

  html += `<div class="section-head"><h2>Categories</h2></div><div class="list">`;
  const rows = s.rows.filter(r => r.budget || r.spent);
  if (!rows.length) {
    html += `<div class="empty"><span class="em">🧾</span>No spending yet. Tap <b>+</b> to add an expense.</div>`;
  }
  for (const r of rows) {
    const st = status(r.spent, r.budget);
    html += `<button class="row" data-act="filter-cat" data-id="${esc(r.cat.id)}">
      <span class="ico" style="--c:${esc(r.cat.color)}">${esc(r.cat.icon)}</span>
      <span class="grow">
        <span class="line1"><span class="name">${esc(r.cat.name)}</span>${leftHTML(r.spent, r.budget)}</span>
        ${r.budget ? barHTML(r.spent, r.budget, st) : ''}
        <span class="sub">${fmt(r.spent)}${r.budget ? ' of ' + fmt(r.budget) : ' spent'}</span>
      </span>
    </button>`;
  }
  html += `</div>`;

  const recent = sortedByDate(s.exps).slice(0, 5);
  if (recent.length) {
    html += `<div class="section-head"><h2>Recent</h2><button class="link" data-act="goto" data-tab="expenses">See all</button></div>
      <div class="list">${recent.map(txHTML).join('')}</div>`;
  }
  return html;
}

function viewExpenses() {
  const k = ui.month;
  const s = monthStats(k);
  const usedCats = s.rows.filter(r => r.spent).map(r => r.cat);
  if (ui.filter !== 'all' && !usedCats.some(c => c.id === ui.filter)) {
    const c = getCat(ui.filter);
    if (c) usedCats.push(c); else ui.filter = 'all';
  }
  const list = sortedByDate(ui.filter === 'all' ? s.exps : s.exps.filter(e => e.catId === ui.filter));
  const total = list.reduce((a, e) => a + e.amount, 0);

  let html = `<div class="chips">
    <button class="chip ${ui.filter === 'all' ? 'on' : ''}" data-act="filter" data-id="all">All</button>
    ${usedCats.map(c => `<button class="chip ${ui.filter === c.id ? 'on' : ''}" data-act="filter" data-id="${esc(c.id)}">${esc(c.icon)} ${esc(c.name)}</button>`).join('')}
  </div>
  <div class="total-line"><span class="muted">${list.length} expense${list.length === 1 ? '' : 's'}</span><b>${fmt(total)}</b></div>`;

  if (!list.length) {
    return html + `<div class="card empty"><span class="em">📭</span>No expenses in ${esc(monthLabel(k))}.</div>`;
  }
  let day = null, group = [];
  const flush = () => {
    if (!group.length) return;
    const dayTotal = group.reduce((a, e) => a + e.amount, 0);
    html += `<div class="day-head"><span>${esc(dayLabel(day))}</span><span>${fmt(dayTotal)}</span></div>
      <div class="list">${group.map(txHTML).join('')}</div>`;
    group = [];
  };
  for (const e of list) {
    if (e.date !== day) { flush(); day = e.date; }
    group.push(e);
  }
  flush();
  return html;
}

function viewCredits() {
  const k = ui.month;
  const s = monthStats(k);
  const bal = round2(s.credit - s.spent);
  const list = sortedByDate(monthCredits(k));

  const html = `<div class="card">
    <div class="settings-row"><span class="muted">Credit</span><b class="in">${fmt(s.credit)}</b></div>
    <div class="settings-row"><span class="muted">Spent</span><b>${fmt(s.spent)}</b></div>
    <div class="settings-row"><span class="muted">Balance</span><b class="${bal < 0 ? 'neg' : ''}">${bal < 0 ? '-' : ''}${fmt(Math.abs(bal))}</b></div>
  </div>`;

  if (!list.length) {
    return html + `<div class="card empty"><span class="em">💰</span>No credit in ${esc(monthLabel(k))}. Tap <b>+</b> to add money that came in.</div>`;
  }
  return html + `<div class="list">${list.map(creditHTML).join('')}</div>`;
}

function viewBudgets() {
  const k = ui.month;
  const mb = monthBudgets(k);
  const cats = activeCats();
  const total = cats.reduce((a, c) => a + (mb[c.id] || 0), 0);
  const isPast = k < curMonth();

  let html = `<div class="card">
    <div class="muted" style="font-size:14px">Total budget · ${esc(monthLabel(k))}</div>
    <div style="font-size:30px;font-weight:750;letter-spacing:-.02em">${fmt(total)}</div>
    <div class="hint">${isPast ? `You're editing a past month. Changes only affect ${esc(monthLabel(k))}.` : 'Changes apply to this month and the months after it. Past months keep their own budgets.'}</div>
  </div>
  <div class="list">`;
  for (const c of cats) {
    const b = mb[c.id] || 0;
    html += `<button class="row" data-act="edit-cat" data-id="${esc(c.id)}">
      <span class="ico" style="--c:${esc(c.color)}">${esc(c.icon)}</span>
      <span class="grow"><span class="name" style="display:block">${esc(c.name)}</span></span>
      <span class="${b ? 'amt' : 'left-none'}">${b ? fmt(b) : 'Set budget'}</span>
      <span class="chev">›</span>
    </button>`;
  }
  if (!cats.length) html += `<div class="empty">No categories yet.</div>`;
  html += `</div><button class="btn dashed" data-act="add-cat">+ Add category</button>`;

  const archived = state.categories.filter(c => c.archived);
  if (archived.length) {
    html += `<div class="section-head"><h2>Removed categories</h2></div><div class="list">
      ${archived.map(c => `<div class="row">
        <span class="ico" style="--c:${esc(c.color)}">${esc(c.icon)}</span>
        <span class="grow"><span class="name" style="display:block">${esc(c.name)}</span><span class="sub">Kept so old expenses still show</span></span>
        <button class="link" data-act="restore-cat" data-id="${esc(c.id)}">Restore</button>
      </div>`).join('')}
    </div>`;
  }
  return html;
}

function historyMonths() {
  const cur = curMonth();
  let first = cur;
  for (const e of [...state.expenses, ...state.credits]) if (e.date.slice(0, 7) < first) first = e.date.slice(0, 7);
  for (const m of Object.keys(state.budgets)) if (m < first) first = m;
  const months = [];
  for (let m = cur; m >= first; m = addMonths(m, -1)) months.push(m);
  return months;
}

function viewHistory() {
  const months = historyMonths();
  const stats = months.map(m => ({ m, ...monthStats(m) }));
  const cur = curMonth();

  // Chart: last 6 months, oldest on the left.
  const chartData = stats.slice(0, 6).reverse();
  const max = Math.max(1, ...chartData.map(s => Math.max(s.spent, s.budget)));
  let html = `<div class="card">
    <div class="line1"><b>Last ${chartData.length} month${chartData.length === 1 ? '' : 's'}</b></div>
    <div class="chart">
      ${chartData.map(s => `<div class="col ${s.m === cur ? 'cur' : ''}">
        <div class="bars">
          ${s.budget ? `<div class="b-budget" style="height:${(s.budget / max * 100).toFixed(1)}%"></div>` : ''}
          <div class="b-spent ${s.budget && s.spent > s.budget ? 'over' : ''}" style="height:${(s.spent / max * 100).toFixed(1)}%"></div>
        </div>
        <span>${esc(monthLabel(s.m, { month: 'short' }))}</span>
      </div>`).join('')}
    </div>
    <div class="legend"><span><i style="background:var(--primary)"></i>Spent</span><span><i style="background:var(--chip)"></i>Budget</span><span><i style="background:var(--danger)"></i>Over</span></div>
  </div>`;

  const past = stats.filter(s => s.m < cur && s.count);
  if (past.length) {
    const avg = past.reduce((a, s) => a + s.spent, 0) / past.length;
    html += `<div class="card line1"><span class="muted">Average per month<br><small>${past.length} past month${past.length === 1 ? '' : 's'}</small></span><b style="font-size:20px">${fmt(avg)}</b></div>`;
  }

  html += `<div class="section-head"><h2>All months</h2></div><div class="list">`;
  for (const s of stats) {
    const st = status(s.spent, s.budget);
    const diff = s.budget - s.spent;
    let note;
    if (!s.budget) note = `<span class="left-none">${s.count} expense${s.count === 1 ? '' : 's'}</span>`;
    else if (diff < 0) note = `<span class="left-over">${fmt(-diff)} over</span>`;
    else note = `<span class="left-${st}">${fmt(diff)} ${s.m === cur ? 'left' : 'saved'}</span>`;
    html += `<button class="row" data-act="open-month" data-month="${s.m}">
      <span class="grow">
        <span class="line1"><span class="name">${esc(monthLabel(s.m))}${s.m === cur ? ' <small class="muted">(now)</small>' : ''}</span>${note}</span>
        ${s.budget ? barHTML(s.spent, s.budget, st) : ''}
        <span class="sub">${fmt(s.spent)} spent${s.budget ? ' of ' + fmt(s.budget) : ''}</span>
        ${s.credit ? `<span class="sub in" style="display:block">+ ${fmt(s.credit)} credit</span>` : ''}
      </span>
      <span class="chev">›</span>
    </button>`;
  }
  html += `</div>`;
  return html;
}

/* ---------- Bottom sheets ----------
   In a browser, opening a sheet pushes a history entry so Back closes it.
   The Android app handles its back button directly (see Navigation). */
function openSheet(html) {
  if (!ui.sheetOpen && !Native) history.pushState({ sheet: 1 }, '');
  ui.sheetOpen = true;
  $('#sheet-root').innerHTML = `<div class="overlay" data-act="overlay"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
  return $('#sheet-root .sheet');
}

function closeSheet() {
  if (!ui.sheetOpen) return;
  ui.sheetOpen = false;
  $('#sheet-root').innerHTML = '';
  if (!Native) {
    ui.ignorePop = true;
    history.back();
  }
}

function sheetHead(title) {
  return `<div class="sheet-head"><h2>${esc(title)}</h2>
    <button class="icon-btn" data-act="close-sheet" aria-label="Close">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
    </button></div>`;
}

function shake(el) { el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); }

function emojiGridHTML(icon) {
  return `<div class="emoji-grid" id="emojiGrid">
    ${[...new Set([icon, ...EMOJIS])].map(e => `<button type="button" class="${e === icon ? 'on' : ''}" data-emoji="${esc(e)}">${esc(e)}</button>`).join('')}
  </div>`;
}

function onEmojiPick(sheet, pick) {
  $('#emojiGrid', sheet).addEventListener('click', ev => {
    const b = ev.target.closest('button[data-emoji]');
    if (!b) return;
    pick(b.dataset.emoji);
    sheet.querySelectorAll('#emojiGrid button').forEach(x => x.classList.toggle('on', x === b));
  });
}

// New entries default to today, or the last day of the past month being viewed.
const defaultDate = () => (ui.month === curMonth() ? todayKey() : ui.month + '-' + pad(daysInMonth(ui.month)));

function expenseSheet(exp) {
  const editing = !!exp;
  const cats = activeCats();
  let catId = exp ? exp.catId : (getCat(state.lastCat) && !getCat(state.lastCat).archived ? state.lastCat : cats[0]?.id);
  let date = exp ? exp.date : defaultDate();
  let isNewCat = false;
  let newIcon = '📦';
  // Show an archived category in the picker if this expense uses it.
  const pickable = exp && getCat(exp.catId)?.archived ? [...cats, getCat(exp.catId)] : cats;

  const sheet = openSheet(`${sheetHead(editing ? 'Edit expense' : 'Add expense')}
    <form id="expForm" autocomplete="off">
      <label class="amount-field"><span>Rs</span>
        <input id="fAmount" inputmode="decimal" enterkeyhint="done" placeholder="0" value="${exp ? exp.amount : ''}" aria-label="Amount in rupees">
      </label>
      <div class="field-label">Category</div>
      <div class="cat-grid" id="catGrid">
        ${pickable.map(c => `<button type="button" class="cat-chip ${c.id === catId ? 'on' : ''}" data-cat="${esc(c.id)}">
          <span class="e">${esc(c.icon)}</span>${esc(c.name)}</button>`).join('')}
        <button type="button" class="cat-chip add" data-new="1"><span class="e">＋</span>New</button>
      </div>
      <div id="newCat" hidden>
        <div class="field-label">New category</div>
        <input class="input" id="nName" maxlength="30" placeholder="Category name">
        <div class="field-label">Icon</div>
        ${emojiGridHTML(newIcon)}
      </div>
      <div class="field-label">Details</div>
      <div class="two">
        <input class="input" id="fNote" maxlength="80" placeholder="Note (optional)" value="${esc(exp?.note)}">
        <input class="input" id="fDate" type="date" value="${date}" max="${todayKey()}" required>
      </div>
      <div class="sheet-actions">
        ${editing ? `<button type="button" class="btn danger" data-act="delete-expense" data-id="${esc(exp.id)}">Delete</button>` : ''}
        <button type="submit" class="btn primary">${editing ? 'Save changes' : 'Save expense'}</button>
      </div>
    </form>`);

  const amountEl = $('#fAmount', sheet);
  if (!editing) amountEl.focus();

  $('#catGrid', sheet).addEventListener('click', ev => {
    const chip = ev.target.closest('.cat-chip');
    if (!chip) return;
    isNewCat = !!chip.dataset.new;
    catId = chip.dataset.cat;
    sheet.querySelectorAll('.cat-chip').forEach(c => c.classList.toggle('on', c === chip));
    $('#newCat', sheet).hidden = !isNewCat;
    if (isNewCat) $('#nName', sheet).focus();
  });
  onEmojiPick(sheet, e => { newIcon = e; });

  $('#expForm', sheet).addEventListener('submit', ev => {
    ev.preventDefault();
    const amount = parseAmount(amountEl.value);
    if (!amount) { shake($('.amount-field', sheet)); amountEl.focus(); return toast('Enter an amount'); }
    const newName = isNewCat ? $('#nName', sheet).value.trim() : '';
    if (isNewCat && !newName) { shake($('#nName', sheet)); $('#nName', sheet).focus(); return toast('Give the category a name'); }
    if (!isNewCat && !catId) { shake($('#catGrid', sheet)); return toast('Pick a category'); }
    const d = $('#fDate', sheet).value || todayKey();
    const note = $('#fNote', sheet).value.trim();
    ensureMonth(d.slice(0, 7));
    if (isNewCat) {
      const same = activeCats().find(c => c.name.toLowerCase() === newName.toLowerCase());
      catId = (same || addCategory(newName, newIcon, 0, d.slice(0, 7))).id;
    }
    if (editing) {
      Object.assign(exp, { amount, catId, note, date: d });
    } else {
      state.expenses.push({ id: uid(), amount, catId, note, date: d, createdAt: Date.now() });
      state.lastCat = catId;
    }
    save();
    closeSheet();
    if (d.slice(0, 7) !== ui.month) ui.month = d.slice(0, 7);
    render();
    toast(`${editing ? 'Updated' : 'Added'} ${fmt(amount)} · ${getCat(catId)?.name ?? ''}`);
  });
}

function deleteExpense(id) {
  const idx = state.expenses.findIndex(e => e.id === id);
  if (idx < 0) return;
  const [removed] = state.expenses.splice(idx, 1);
  save();
  closeSheet();
  render();
  toast(`Deleted ${fmt(removed.amount)}`, () => {
    state.expenses.splice(idx, 0, removed);
    save();
    render();
  });
}

function creditSheet(credit) {
  const editing = !!credit;
  const date = credit ? credit.date : defaultDate();

  const sheet = openSheet(`${sheetHead(editing ? 'Edit credit' : 'Add credit')}
    <form id="creditForm" autocomplete="off">
      <label class="amount-field"><span>Rs</span>
        <input id="crAmount" inputmode="decimal" enterkeyhint="done" placeholder="0" value="${credit ? credit.amount : ''}" aria-label="Amount received in rupees">
      </label>
      <div class="field-label">Date received</div>
      <input class="input" id="crDate" type="date" value="${date}" max="${todayKey()}" required>
      <div class="field-label">From</div>
      <input class="input" id="crNote" maxlength="80" placeholder="e.g. Salary (optional)" value="${esc(credit?.note)}">
      <div class="sheet-actions">
        ${editing ? `<button type="button" class="btn danger" data-act="delete-credit" data-id="${esc(credit.id)}">Delete</button>` : ''}
        <button type="submit" class="btn primary">${editing ? 'Save changes' : 'Save credit'}</button>
      </div>
    </form>`);

  const amountEl = $('#crAmount', sheet);
  if (!editing) amountEl.focus();

  $('#creditForm', sheet).addEventListener('submit', ev => {
    ev.preventDefault();
    const amount = parseAmount(amountEl.value);
    if (!amount) { shake($('.amount-field', sheet)); amountEl.focus(); return toast('Enter an amount'); }
    const d = $('#crDate', sheet).value || todayKey();
    const note = $('#crNote', sheet).value.trim();
    if (editing) {
      Object.assign(credit, { amount, note, date: d });
    } else {
      state.credits.push({ id: uid(), amount, note, date: d, createdAt: Date.now() });
    }
    save();
    closeSheet();
    if (d.slice(0, 7) !== ui.month) ui.month = d.slice(0, 7);
    render();
    toast(`${editing ? 'Updated' : 'Added'} credit ${fmt(amount)}`);
  });
}

function deleteCredit(id) {
  const idx = state.credits.findIndex(c => c.id === id);
  if (idx < 0) return;
  const [removed] = state.credits.splice(idx, 1);
  save();
  closeSheet();
  render();
  toast(`Deleted credit ${fmt(removed.amount)}`, () => {
    state.credits.splice(idx, 0, removed);
    save();
    render();
  });
}

function categorySheet(cat) {
  const editing = !!cat;
  const k = ui.month;
  let icon = cat ? cat.icon : '📦';
  const budget = cat ? (monthBudgets(k)[cat.id] || 0) : 0;
  const isPast = k < curMonth();

  const sheet = openSheet(`${sheetHead(editing ? 'Edit category' : 'New category')}
    <form id="catForm" autocomplete="off">
      <div class="field-label">Monthly budget</div>
      <label class="amount-field"><span>Rs</span>
        <input id="cBudget" inputmode="decimal" enterkeyhint="done" placeholder="0" value="${budget || ''}" aria-label="Monthly budget in rupees">
      </label>
      <p class="hint">${isPast ? `Only changes the budget for ${esc(monthLabel(k))}.` : `Applies from ${esc(monthLabel(k))} onward.`} Leave empty for no limit.</p>
      <div class="field-label">Name</div>
      <input class="input" id="cName" maxlength="30" placeholder="e.g. Groceries" value="${esc(cat?.name)}">
      <div class="field-label">Icon</div>
      ${emojiGridHTML(icon)}
      <div class="sheet-actions">
        ${editing ? `<button type="button" class="btn danger" data-act="delete-cat" data-id="${esc(cat.id)}">Remove</button>` : ''}
        <button type="submit" class="btn primary">${editing ? 'Save' : 'Add category'}</button>
      </div>
    </form>`);

  if (editing) {
    // Select the current budget so typing replaces it instead of appending digits.
    $('#cBudget', sheet).focus();
    $('#cBudget', sheet).select();
  } else {
    $('#cName', sheet).focus();
  }

  onEmojiPick(sheet, e => { icon = e; });

  $('#catForm', sheet).addEventListener('submit', ev => {
    ev.preventDefault();
    const name = $('#cName', sheet).value.trim();
    if (!name) { shake($('#cName', sheet)); $('#cName', sheet).focus(); return toast('Give the category a name'); }
    const raw = $('#cBudget', sheet).value.trim();
    const amount = raw === '' || raw === '0' ? 0 : parseAmount(raw);
    if (amount === null) { shake($('#cBudget', sheet).parentElement); return toast('Budget must be a number'); }

    if (editing) {
      cat.name = name;
      cat.icon = icon;
      setBudget(cat.id, k, amount);
    } else {
      addCategory(name, icon, amount, k);
    }
    save();
    closeSheet();
    render();
    toast(editing ? 'Category saved' : `Added ${name}`);
  });
}

function removeCategory(id) {
  const cat = getCat(id);
  if (!cat) return;
  const used = state.expenses.some(e => e.catId === id);
  const msg = used
    ? `Remove "${cat.name}"? Its past expenses stay in your history, and you can restore it later.`
    : `Delete "${cat.name}"?`;
  if (!confirm(msg)) return;
  if (used) {
    cat.archived = true;
    for (const m of Object.keys(state.budgets)) if (m >= curMonth()) delete state.budgets[m][id];
  } else {
    state.categories = state.categories.filter(c => c.id !== id);
    for (const m of Object.keys(state.budgets)) delete state.budgets[m][id];
  }
  if (state.lastCat === id) state.lastCat = null;
  if (ui.filter === id) ui.filter = 'all';
  save();
  closeSheet();
  render();
  toast(used ? `Removed ${cat.name}` : `Deleted ${cat.name}`);
}

function restoreCategory(id) {
  const cat = getCat(id);
  if (!cat) return;
  cat.archived = false;
  for (const m of Object.keys(state.budgets)) if (m >= curMonth()) state.budgets[m][id] = cat.budget;
  save();
  render();
  toast(`Restored ${cat.name}`);
}

/* ---------- Settings & backup ---------- */
function backupBlob() {
  return new Blob([JSON.stringify({ app: 'kharcha', exportedAt: new Date().toISOString(), data: state }, null, 2)], { type: 'application/json' });
}
const backupName = () => `kharcha-backup-${todayKey()}.json`;

function markBackedUp() {
  state.lastBackup = new Date().toISOString();
  save();
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// Android app: write a file with the Filesystem plugin and return its URI.
async function writeNativeFile(path, text, directory) {
  const { uri } = await Native.Filesystem.writeFile({ path, data: text, directory, encoding: Native.Encoding.UTF8, recursive: true });
  return uri;
}

async function shareNativeFile(name, text, title) {
  const uri = await writeNativeFile(name, text, Native.Directory.Cache);
  await Native.Share.share({ title, files: [uri] });
}

const isCancel = e => /cancel|abort/i.test(String(e && (e.message || e.name)));

function settingsSheet() {
  const last = state.lastBackup ? new Date(state.lastBackup).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Never';
  const canShare = !!Native || !!(navigator.canShare && navigator.canShare({ files: [new File(['{}'], 'x.json', { type: 'application/json' })] }));
  openSheet(`${sheetHead('Settings & backup')}
    <p class="hint" style="margin-top:0">Your data is saved only on this phone. Save a backup now and then, and keep it somewhere safe like Google Drive or WhatsApp.</p>
    <div class="settings-row"><span class="muted">Last backup</span><b>${esc(last)}</b></div>
    <div class="settings-row"><span class="muted">Expenses saved</span><b>${state.expenses.length}</b></div>
    <div class="settings-row"><span class="muted">Credits saved</span><b>${state.credits.length}</b></div>
    ${canShare ? `<button class="btn primary block" data-act="share-backup">Share backup (Drive, WhatsApp…)</button>` : ''}
    <button class="btn ${canShare ? 'ghost' : 'primary'} block" data-act="download-backup">${Native ? 'Save backup to phone' : 'Download backup file'}</button>
    <button class="btn ghost block" data-act="restore-backup">Restore from backup</button>
    <button class="btn ghost block" data-act="export-csv">Export to CSV (Excel)</button>
    <div class="field-label" style="margin-top:26px">Danger zone</div>
    <button class="btn danger block" style="width:100%" data-act="erase-all">Erase all data</button>
    <p class="hint" style="text-align:center;margin-top:18px">Kharcha · works offline</p>`);
}

async function shareBackup() {
  try {
    if (Native) {
      await shareNativeFile(backupName(), await backupBlob().text(), 'Kharcha backup');
    } else {
      await navigator.share({ files: [new File([backupBlob()], backupName(), { type: 'application/json' })], title: 'Kharcha backup' });
    }
    markBackedUp();
    closeSheet();
    toast('Backup shared');
  } catch (e) {
    if (!isCancel(e)) toast(Native ? 'Sharing failed. Try Save instead.' : 'Sharing failed. Try Download instead.');
  }
}

async function saveBackup() {
  if (!Native) {
    download(backupBlob(), backupName());
    markBackedUp();
    closeSheet();
    return toast('Backup saved to Downloads');
  }
  try {
    await writeNativeFile('Kharcha/' + backupName(), await backupBlob().text(), Native.Directory.Documents);
    markBackedUp();
    closeSheet();
    toast('Saved to Documents/Kharcha');
  } catch (e) {
    toast('Could not save here. Use Share backup instead.');
  }
}

async function exportCSV() {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Date', 'Type', 'Category', 'Amount (PKR)', 'Note'].map(q).join(',')];
  const entries = [
    ...state.expenses.map(e => ({ ...e, type: 'Expense', cat: getCat(e.catId)?.name ?? 'Uncategorised' })),
    ...state.credits.map(c => ({ ...c, type: 'Credit', cat: '' })),
  ];
  for (const e of sortedByDate(entries).reverse()) {
    lines.push([e.date, e.type, e.cat, e.amount, e.note].map(q).join(','));
  }
  const csv = '﻿' + lines.join('\r\n');
  const name = `kharcha-export-${todayKey()}.csv`;
  if (!Native) {
    download(new Blob([csv], { type: 'text/csv' }), name);
    return toast('CSV exported');
  }
  try {
    await shareNativeFile(name, csv, 'Kharcha export');
  } catch (e) {
    if (!isCancel(e)) toast('Could not export CSV');
  }
}

function restoreFromFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try { parsed = JSON.parse(reader.result); } catch (e) { return toast('That file is not a valid backup'); }
    const data = parsed && parsed.app === 'kharcha' ? parsed.data : parsed;
    if (!isValidState(data)) return toast('That file is not a Kharcha backup');
    migrate(data);
    if (!confirm(`Restore this backup with ${data.expenses.length} expenses and ${data.credits.length} credits? It replaces everything currently in the app.`)) return;
    state = data;
    ensureMonth(curMonth());
    save();
    ui.filter = 'all';
    closeSheet();
    render();
    toast('Backup restored');
  };
  reader.readAsText(file);
}

function eraseAll() {
  if (!confirm('Erase ALL expenses, credits, categories and budgets? This cannot be undone.')) return;
  if (!confirm('Are you sure? Consider downloading a backup first.')) return;
  state = freshState();
  ensureMonth(curMonth());
  save();
  ui.month = curMonth();
  ui.filter = 'all';
  closeSheet();
  render();
  toast('All data erased');
}

/* ---------- Toast ---------- */
let toastTimer;
function toast(msg, undo) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button type="button">Undo</button>' : ''}`;
  if (undo) el.querySelector('button').onclick = () => { el.classList.remove('show'); undo(); };
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), undo ? 5000 : 2200);
}

/* ---------- Navigation ----------
   Back closes an open sheet, then returns to Home, then leaves the app.
   Browser: leaving Home pushes one history entry. Android app: the back button
   is handled here directly. */
function setTab(tab) {
  if (tab === ui.tab) return;
  if (!Native) {
    if (ui.tab === 'home' && tab !== 'home') history.pushState({ tab }, '');
    else if (tab === 'home') { ui.ignorePop = true; history.back(); }
  }
  ui.tab = tab;
  render();
  window.scrollTo(0, 0);
}

if (Native) {
  Native.App.addListener('backButton', () => {
    if (ui.sheetOpen) closeSheet();
    else if (ui.tab !== 'home') setTab('home');
    else Native.App.minimizeApp();
  });
}

window.addEventListener('popstate', () => {
  if (ui.ignorePop) { ui.ignorePop = false; return; }
  if (ui.sheetOpen) {
    ui.sheetOpen = false;
    $('#sheet-root').innerHTML = '';
    return;
  }
  if (ui.tab !== 'home') {
    ui.tab = 'home';
    render();
  }
});

/* ---------- Events ---------- */
document.addEventListener('click', ev => {
  const tabBtn = ev.target.closest('.tabbar button');
  if (tabBtn) return setTab(tabBtn.dataset.tab);

  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (act === 'overlay' && ev.target !== el) return; // clicks inside the sheet

  switch (act) {
    case 'overlay':
    case 'close-sheet': closeSheet(); break;
    case 'prev-month': ui.month = addMonths(ui.month, -1); render(); break;
    case 'next-month': if (ui.month < curMonth()) { ui.month = addMonths(ui.month, 1); render(); } break;
    case 'this-month': if (ui.month !== curMonth()) { ui.month = curMonth(); render(); } break;
    case 'add-expense': expenseSheet(null); break;
    case 'edit-expense': { const e = state.expenses.find(x => x.id === el.dataset.id); if (e) expenseSheet(e); break; }
    case 'delete-expense': deleteExpense(el.dataset.id); break;
    case 'add-credit': creditSheet(null); break;
    case 'edit-credit': { const c = state.credits.find(x => x.id === el.dataset.id); if (c) creditSheet(c); break; }
    case 'delete-credit': deleteCredit(el.dataset.id); break;
    case 'goto': setTab(el.dataset.tab); break;
    case 'filter-cat': ui.filter = el.dataset.id === '_' ? 'all' : el.dataset.id; setTab('expenses'); break;
    case 'filter': ui.filter = el.dataset.id; render(); break;
    case 'add-cat': categorySheet(null); break;
    case 'edit-cat': { const c = getCat(el.dataset.id); if (c) categorySheet(c); break; }
    case 'delete-cat': removeCategory(el.dataset.id); break;
    case 'restore-cat': restoreCategory(el.dataset.id); break;
    case 'open-month': ui.month = el.dataset.month; setTab('home'); break;
    case 'settings': settingsSheet(); break;
    case 'share-backup': shareBackup(); break;
    case 'download-backup': saveBackup(); break;
    case 'restore-backup': $('#restoreInput').click(); break;
    case 'export-csv': exportCSV(); break;
    case 'erase-all': eraseAll(); break;
  }
});

$('#restoreInput').addEventListener('change', ev => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (file) restoreFromFile(file);
});

// If the app stays open across midnight on the 1st, roll over to the new month.
let lastSeenMonth = curMonth();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const now = curMonth();
  if (now !== lastSeenMonth) {
    if (ui.month === lastSeenMonth) ui.month = now;
    lastSeenMonth = now;
    ensureMonth(now);
    save();
  }
  render();
});

/* ---------- Start ---------- */
render();
loadNative().then(() => {
  ensureMonth(curMonth());
  save();
  render();
});

if (!Native && 'serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support unavailable */ });
}
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().catch(() => {});
}
