// Weight Logger
// Plain JS module, no build step. Weigh-ins are kept in localStorage; the chart is SVG drawn here.

const els = {
  logForm: document.getElementById('log-form'),
  logWeight: document.getElementById('log-weight'),
  logError: document.getElementById('log-error'),
  logWhenToggle: document.getElementById('log-when-toggle'),
  logWhen: document.getElementById('log-when'),
  logNote: document.getElementById('log-note'),
  stats: document.getElementById('stats'),
  chartPanel: document.getElementById('chart-panel'),
  rangeButtons: document.querySelectorAll('[data-range]'),
  legendGoal: document.getElementById('legend-goal'),
  chart: document.getElementById('chart'),
  chartSvg: document.getElementById('chart-svg'),
  chartTip: document.getElementById('chart-tip'),
  chartEmpty: document.getElementById('chart-empty'),
  historyEmpty: document.getElementById('history-empty'),
  history: document.getElementById('history'),
  entries: document.getElementById('entries'),
  showMore: document.getElementById('show-more'),
  entryDialog: document.getElementById('entry-dialog'),
  entryForm: document.getElementById('entry-form'),
  entryWeight: document.getElementById('entry-weight'),
  entryWhen: document.getElementById('entry-when'),
  entryNote: document.getElementById('entry-note'),
  entryError: document.getElementById('entry-error'),
  entryDelete: document.getElementById('entry-delete'),
  goalDialog: document.getElementById('goal-dialog'),
  goalForm: document.getElementById('goal-form'),
  goalWeight: document.getElementById('goal-weight'),
  goalError: document.getElementById('goal-error'),
  goalRemove: document.getElementById('goal-remove'),
  settingsButton: document.getElementById('settings-button'),
  settingsDialog: document.getElementById('settings-dialog'),
  unitButtons: document.querySelectorAll('[data-unit]'),
  themeButtons: document.querySelectorAll('[data-theme-choice]'),
  dataSummary: document.getElementById('data-summary'),
  backupSave: document.getElementById('backup-save'),
  backupLoad: document.getElementById('backup-load'),
  backupFile: document.getElementById('backup-file'),
  csvExport: document.getElementById('csv-export'),
  toast: document.getElementById('toast'),
  toastText: document.getElementById('toast-text'),
  toastAction: document.getElementById('toast-action'),
  updateBar: document.getElementById('update-bar'),
  updateReload: document.getElementById('update-reload'),
  themeColor: document.querySelector('meta[name="theme-color"]'),
};

const STORAGE_KEY = 'weightlogger:v1';
const BACKUP_FORMAT = 'weightlogger-backup';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const KG_PER_LB = 0.45359237;
const LB_PER_ST = 14;
const MINUS = '−';
const MIN_KG = 10;
const MAX_KG = 400;
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const DEFAULT_SETTINGS = {
  unit: 'kg',         // how weights are shown and typed: 'kg' | 'st' (stone & lb) | 'lb'. Always stored as kg.
  goalKg: null,       // the goal weight (set from the Goal tile, openGoal), or null for none
  theme: 'dark',      // Settings → Theme: 'dark' | 'light'
  chartRange: '91',   // the chart's range: a number of days ('7', '30', '91', '365') or 'all'
};

const state = {
  points: [],         // the weigh-ins, oldest first, each with its trend (withTrend)
  historyAll: false,  // History shows every weigh-in, by month (Show all), not just the RECENT ones
  openMonths: new Set(), // the open months while it does: 'YYYY-MM'
  editingId: null,    // the weigh-in open in the edit dialog
};

// ---------- storage ----------

// Everything is one JSON object under STORAGE_KEY:
//   settings: merged over DEFAULT_SETTINGS (getSettings), so a new setting gets its default
//   entries:  the weigh-ins, oldest first: { id, at (ms since 1970), kg, note? }
let storeCache = null;
window.addEventListener('storage', (e) => {
  if (e.key !== STORAGE_KEY) return;
  storeCache = null; // another tab wrote the store
  applyTheme();
  renderWeightFields(els.logWeight);
  render();
});

function loadStore() {
  if (!storeCache) {
    try {
      storeCache = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch {
      storeCache = {};
    }
    if (!Array.isArray(storeCache.entries)) storeCache.entries = [];
    storeCache.entries.sort((a, b) => a.at - b.at); // saved in order, but a hand-edited store may not be
  }
  return storeCache;
}

function saveStore(store) {
  storeCache = store;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    toast("Couldn't save: this browser's storage is full or blocked");
  }
}

function getSettings() {
  const settings = { ...DEFAULT_SETTINGS, ...(loadStore().settings || {}) };
  // A value from an old or hand-edited backup that the app doesn't know gets the default.
  if (!['kg', 'st', 'lb'].includes(settings.unit)) settings.unit = DEFAULT_SETTINGS.unit;
  if (!['dark', 'light'].includes(settings.theme)) settings.theme = DEFAULT_SETTINGS.theme;
  if (!['7', '30', '91', '365', 'all'].includes(settings.chartRange)) settings.chartRange = DEFAULT_SETTINGS.chartRange;
  if (!(Number.isFinite(settings.goalKg) && settings.goalKg > 0)) settings.goalKg = null;
  return settings;
}

function setSetting(key, value) {
  const store = loadStore();
  store.settings = { ...(store.settings || {}), [key]: value };
  saveStore(store);
}

const getEntries = () => loadStore().entries;

function saveEntries(entries) {
  const store = loadStore();
  store.entries = [...entries].sort((a, b) => a.at - b.at); // stable: same-time weigh-ins keep their order
  saveStore(store);
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const roundKg = (kg) => Math.round(kg * 10_000) / 10_000;

// ---------- units ----------

const toLb = (kg) => kg / KG_PER_LB;

// A weight as its unit's parts: ['81.2'] (kg), ['179'] (lb) or ['12', '11.5'] (st & lb), to one
// decimal place, without a trailing '.0' (for the inputs).
function weightParts(kg, unit) {
  const trim = (n) => n.toFixed(1).replace(/\.0$/, '');
  if (unit === 'kg') return [trim(kg)];
  const lb = Math.round(toLb(kg) * 10) / 10;
  if (unit === 'lb') return [trim(lb)];
  const st = Math.floor(lb / LB_PER_ST);
  return [String(st), trim(Math.max(0, lb - st * LB_PER_ST))];
}

function formatWeight(kg, unit = getSettings().unit) {
  if (unit === 'kg') return `${kg.toFixed(1)} kg`;
  const lb = Math.round(toLb(kg) * 10) / 10;
  if (unit === 'lb') return `${lb.toFixed(1)} lb`;
  const st = Math.floor(lb / LB_PER_ST);
  return `${st} st ${Math.max(0, lb - st * LB_PER_ST).toFixed(1)} lb`;
}

// A difference: kg, or lb for both lb and st & lb (a change of "0 st 1.2 lb" reads badly).
function formatAmount(kg, unit = getSettings().unit) {
  return unit === 'kg' ? `${Math.abs(kg).toFixed(1)} kg` : `${Math.abs(toLb(kg)).toFixed(1)} lb`;
}

function formatDelta(kg, unit = getSettings().unit) {
  const shown = Math.round((unit === 'kg' ? kg : toLb(kg)) * 10);
  return `${shown > 0 ? '+' : shown < 0 ? MINUS : ''}${formatAmount(kg, unit)}`;
}

// The inputs for a weight in `box` (a .weight-fields): one box for kg or lb, two for st & lb.
function renderWeightFields(box, kg = null) {
  const unit = getSettings().unit;
  const parts = unit === 'st' ? [['st', 'stone'], ['lb', 'pounds']] : [[unit, unit === 'kg' ? 'kilograms' : 'pounds']];
  const values = kg == null ? null : weightParts(kg, unit);
  const error = box.closest('form')?.querySelector('.field-error');
  box.replaceChildren(...parts.map(([short, name], i) => {
    const wrap = document.createElement('label');
    wrap.className = 'weight-box';
    const input = document.createElement('input');
    input.className = 'input';
    input.type = 'text';
    input.inputMode = short === 'st' ? 'numeric' : 'decimal';
    input.autocomplete = 'off';
    input.setAttribute('aria-label', `${box.dataset.label} in ${name}`);
    if (error?.id) input.setAttribute('aria-describedby', error.id); // its message is read again on return to it
    input.addEventListener('input', () => keepNumeric(input));
    if (values) input.value = values[i];
    const unitText = document.createElement('span');
    unitText.className = 'unit';
    unitText.textContent = short;
    wrap.append(input, unitText);
    return wrap;
  }));
}

// What a weight box lets in: digits and one decimal point. A comma becomes a point (some keyboards
// and locales type one), and anything else is taken out as it's typed or pasted ('82.4 kg' → '82.4').
// Not type="number": it lets in 'e', '+' and '-', the scroll wheel changes it, and browsers treat a
// decimal comma differently.
function cleanNumber(text) {
  const s = text.replace(/,/g, '.').replace(/[^\d.]/g, '');
  const dot = s.indexOf('.');
  return dot < 0 ? s : s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, '');
}

// On each change to a weight box: clean it, keeping the caret in its place.
function keepNumeric(input) {
  const value = input.value;
  const clean = cleanNumber(value);
  if (clean === value) return;
  const caret = cleanNumber(value.slice(0, input.selectionStart ?? value.length)).length;
  input.value = clean;
  input.setSelectionRange(caret, caret);
}

function setWeightPlaceholders(box, kg) {
  const parts = kg == null ? [] : weightParts(kg, getSettings().unit);
  box.querySelectorAll('input').forEach((input, i) => { input.placeholder = parts[i] ?? ''; });
}

// What's typed in `box`: { kg }, { empty: true }, or { error }. A comma works as the decimal point.
function readWeight(box) {
  const unit = getSettings().unit;
  const inputs = [...box.querySelectorAll('input')];
  inputs.forEach((input) => input.removeAttribute('aria-invalid'));
  const texts = inputs.map((input) => input.value.trim().replace(',', '.'));
  if (texts.every((t) => t === '')) return { empty: true };
  const nums = texts.map((t) => (t === '' ? 0 : /^(\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) : NaN));
  const bad = nums.findIndex((n) => Number.isNaN(n));
  if (bad >= 0) {
    inputs[bad].setAttribute('aria-invalid', 'true');
    return { error: 'Enter a number, like 81.5' };
  }
  const kg = unit === 'kg' ? nums[0] : unit === 'lb' ? nums[0] * KG_PER_LB : (nums[0] * LB_PER_ST + nums[1]) * KG_PER_LB;
  if (kg < MIN_KG || kg > MAX_KG) {
    inputs.forEach((input) => input.setAttribute('aria-invalid', 'true'));
    return { error: `Enter a weight between ${formatWeight(MIN_KG, unit)} and ${formatWeight(MAX_KG, unit)}` };
  }
  return { kg: roundKg(kg) };
}

function showError(el, message) {
  el.textContent = message || '';
  el.hidden = !message;
}

// ---------- dates ----------

const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

function formatDay(t) {
  const thisYear = new Date(t).getFullYear() === new Date().getFullYear();
  return new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(thisYear ? {} : { year: 'numeric' }) });
}

const formatTime = (t) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

function formatWhen(t) {
  const day = sameDay(t, Date.now()) ? 'Today' : sameDay(t, Date.now() - DAY) ? 'Yesterday' : formatDay(t);
  return `${day}, ${formatTime(t)}`;
}

const formatDate = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

// <input type="datetime-local"> values are local time, 'YYYY-MM-DDTHH:MM'.
function toLocalInput(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fromLocalInput(value) {
  const t = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
}

// A time typed for a weigh-in: { at } or { error }.
function checkWhen(value) {
  const at = fromLocalInput(value);
  if (at == null) return { error: 'Enter a date and time' };
  if (at > Date.now() + 5 * MINUTE) return { error: "That time hasn't happened yet" };
  return { at };
}

// ---------- trend ----------

// The trend is a smoothed weight that each weigh-in pulls part of the way towards itself, as in
// The Hacker's Diet (10% a day). The pull depends on the time since the previous weigh-in: after a
// missed day it's larger, and a second weigh-in on the same day only moves it a little. Each value
// uses only the weigh-ins up to and including its own, so a new weigh-in never changes the past.
const TREND_PER_DAY = 0.1;

function withTrend(entries) {
  let trend = null;
  let prevAt = null;
  return entries.map((e) => {
    if (trend == null) {
      trend = e.kg;
    } else {
      const days = Math.max(0, (e.at - prevAt) / DAY);
      trend += (1 - (1 - TREND_PER_DAY) ** days) * (e.kg - trend);
    }
    prevAt = e.at;
    return { ...e, trend };
  });
}

// The trend as it stood at time `t`: that of the last weigh-in at or before it, or null if none.
function trendAt(points, t) {
  for (let i = points.length - 1; i >= 0; i--) if (points[i].at <= t) return points[i].trend;
  return null;
}

// ---------- render ----------

function render() {
  state.points = withTrend(getEntries());
  const any = state.points.length > 0;
  els.stats.hidden = !any;
  els.chartPanel.hidden = !any;
  els.historyEmpty.hidden = any;
  setWeightPlaceholders(els.logWeight, any ? state.points.at(-1).kg : null);
  if (any) {
    renderStats();
    renderChart();
  }
  renderHistory();
  if (els.settingsDialog.open) renderSettings();
}

// A summary tile; with `onClick`, the whole tile is a button.
function stat(label, value, sub, cls = '', onClick = null) {
  const tile = document.createElement(onClick ? 'button' : 'div');
  tile.className = `stat ${cls}`;
  if (onClick) {
    tile.type = 'button';
    tile.addEventListener('click', onClick);
  }
  for (const [c, text] of [['stat-label', label], ['stat-value', value], ['stat-sub', sub]]) {
    if (!text) continue;
    const div = document.createElement('div');
    div.className = c;
    div.textContent = text;
    tile.append(div);
  }
  return tile;
}

function renderStats() {
  const { points } = state;
  const { goalKg } = getSettings();
  const last = points.at(-1);
  const change = (days) => {
    const before = trendAt(points, last.at - days * DAY);
    return before == null ? stat(`${days} days`, '—', 'not enough weigh-ins yet', 'pair')
                          : stat(`${days} days`, formatDelta(last.trend - before), 'change in trend', 'pair');
  };
  // The Goal tile is where the goal is set and changed: a tap opens the goal dialog.
  let goal;
  if (goalKg == null) {
    goal = stat('Goal', '—', 'Set a goal', 'top goal-tile unset', openGoal);
  } else {
    // Losing or gaining is read from the first weigh-in: it started above the goal or below it.
    const losing = points[0].kg >= goalKg;
    const reached = losing ? last.kg <= goalKg : last.kg >= goalKg;
    goal = stat('Goal', formatWeight(goalKg), reached ? 'reached' : `${formatAmount(last.kg - goalKg)} to go`, 'top goal-tile', openGoal);
  }
  goal.title = goalKg == null ? 'Set a goal' : 'Change the goal';
  goal.setAttribute('aria-haspopup', 'dialog');
  goal.insertAdjacentHTML('beforeend', '<svg class="line-icon stat-edit" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>');
  els.stats.replaceChildren(
    goal,
    stat('Latest', formatWeight(last.kg), formatWhen(last.at), 'top hero'),
    stat('Trend', formatWeight(last.trend), 'smoothed weight', 'top'),
    change(7),
    change(30),
  );
}

// History shows the last RECENT weigh-ins. Show all switches it to every weigh-in in sections by
// month, newest first, each with its count and average; a month's rows are only drawn once it's
// opened, so years of weigh-ins stay a short list of headings.
const RECENT = 10;

const monthKey = (t) => toLocalInput(t).slice(0, 7); // 'YYYY-MM'

// A <ol> of History rows for the weigh-ins at `indices` (into state.points), in that order.
function entryList(indices) {
  const { points } = state;
  const ol = document.createElement('ol');
  ol.className = 'entries';
  for (const i of indices) {
    const p = points[i];
    const li = document.createElement('li');
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'entry';
    row.dataset.id = p.id;
    const when = document.createElement('span');
    when.className = 'entry-when';
    const time = document.createElement('span');
    time.className = 'entry-time';
    time.textContent = ` · ${formatTime(p.at)}`;
    when.append(formatDay(p.at), time);
    const weight = document.createElement('span');
    weight.className = 'entry-weight';
    weight.textContent = formatWeight(p.kg);
    const delta = document.createElement('span');
    delta.className = 'entry-delta';
    delta.textContent = i > 0 ? formatDelta(p.kg - points[i - 1].kg) : 'first';
    row.append(when, weight, delta);
    if (p.note) {
      const note = document.createElement('span');
      note.className = 'entry-note';
      note.textContent = p.note;
      row.append(note);
    }
    row.setAttribute('aria-label', `${formatDay(p.at)} ${formatTime(p.at)}, ${formatWeight(p.kg)}. Edit`);
    li.append(row);
    ol.append(li);
  }
  return ol;
}

function monthSection(key, indices) {
  const { points } = state;
  const details = document.createElement('details');
  details.className = 'month';
  const summary = document.createElement('summary');
  const name = document.createElement('span');
  name.className = 'month-name';
  name.textContent = new Date(points[indices[0]].at).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const info = document.createElement('span');
  info.className = 'month-info';
  const avg = indices.reduce((sum, i) => sum + points[i].kg, 0) / indices.length;
  info.textContent = `${indices.length} weigh-in${indices.length === 1 ? '' : 's'} · avg ${formatWeight(avg)}`;
  summary.append(name, info);
  details.append(summary);
  const fill = () => { if (!details.querySelector('.entries')) details.append(entryList(indices)); };
  if (state.openMonths.has(key)) {
    details.open = true;
    fill();
  }
  details.addEventListener('toggle', () => {
    if (details.open) {
      state.openMonths.add(key);
      fill();
    } else {
      state.openMonths.delete(key);
    }
  });
  return details;
}

function renderHistory() {
  const { points } = state;
  const all = state.historyAll && points.length > RECENT;
  const newestFirst = points.map((_, i) => i).reverse();
  if (all) {
    const months = new Map();
    for (const i of newestFirst) {
      const key = monthKey(points[i].at);
      if (!months.has(key)) months.set(key, []);
      months.get(key).push(i);
    }
    els.entries.replaceChildren(...[...months].map(([key, indices]) => monthSection(key, indices)));
  } else {
    els.entries.replaceChildren(entryList(newestFirst.slice(0, RECENT)));
  }
  els.showMore.hidden = points.length <= RECENT;
  els.showMore.textContent = all ? 'Show recent only' : `Show all ${points.length} by month`;
}

// ---------- chart ----------

const CHART_PAD = { top: 14, right: 14, bottom: 28 }; // and left, by unit (chartLeft)
const chartLeft = (unit) => (unit === 'st' ? 60 : 44);  // room for the y labels: '12 st 10' is the widest
const Y_STEPS = { kg: [0.2, 0.5, 1, 2, 5, 10, 20, 50], lb: [0.5, 1, 2, 5, 10, 20, 50, 100], st: [1, 2, 7, 14, 28, 70] }; // st: in lb
const chart = { shown: [], sel: null }; // what's drawn, for the hover layer (renderChart sets the rest)

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Clean y ticks covering lo..hi, at most about `max` of them. Values are in the axis unit (kg or lb).
function yTicks(lo, hi, max, unit) {
  const steps = Y_STEPS[unit];
  const step = steps.find((s) => Math.ceil(hi / s) - Math.floor(lo / s) + 1 <= max) ?? steps.at(-1);
  const ticks = [];
  for (let k = Math.floor(lo / step); k <= Math.ceil(hi / step); k++) ticks.push(k * step);
  return { ticks, step };
}

function yLabel(v, step, unit) {
  if (unit !== 'st') return step < 1 ? v.toFixed(1) : String(Math.round(v));
  const lb = Math.round(v);
  const st = Math.floor(lb / LB_PER_ST);
  return lb % LB_PER_ST ? `${st} st ${lb - st * LB_PER_ST}` : `${st} st`;
}

// The x axis's steps: [how many, days or months, the least room in px its labels need]. Single days
// are labelled by weekday ('Mon'), so they fit closer together than dates ('12 Oct').
const TIME_STEPS = [[1, 'd', 34], [2, 'd', 56], [7, 'd', 56], [14, 'd', 56], [1, 'm', 44], [2, 'm', 44],
                    [3, 'm', 44], [6, 'm', 44], [12, 'm', 44], [24, 'm', 44], [60, 'm', 44], [120, 'm', 44]];

// Dates for the x axis between x0 and x1, `plotW` px wide: days, weeks (from Mondays), months or
// years, the finest whose labels have room.
function timeTicks(x0, x1, plotW) {
  const pxPerDay = plotW / ((x1 - x0) / DAY);
  const [n, kind] = TIME_STEPS.find(([n, kind, room]) => (kind === 'd' ? n : n * 30.4) * pxPerDay >= room) ?? TIME_STEPS.at(-1);
  const d = new Date(x0);
  d.setHours(0, 0, 0, 0);
  if (kind === 'd') {
    if (d.getTime() < x0) d.setDate(d.getDate() + 1);
    if (n >= 7) while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
  } else {
    d.setDate(1);
    if (d.getTime() < x0) d.setMonth(d.getMonth() + 1);
    while ((d.getFullYear() * 12 + d.getMonth()) % n) d.setMonth(d.getMonth() + 1);
  }
  const ticks = [];
  while (d.getTime() <= x1) {
    let label;
    if (kind === 'd' && n === 1) label = d.toLocaleDateString(undefined, pxPerDay >= 60 ? { weekday: 'short', day: 'numeric' } : { weekday: 'short' });
    else if (kind === 'd') label = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    else if (n < 12 && d.getMonth() !== 0) label = d.toLocaleDateString(undefined, { month: 'short' });
    else label = String(d.getFullYear());
    ticks.push({ t: d.getTime(), label });
    if (kind === 'd') d.setDate(d.getDate() + n);
    else d.setMonth(d.getMonth() + n);
  }
  return ticks;
}

function renderChart() {
  const { points } = state;
  const settings = getSettings();
  const { unit, chartRange } = settings;
  for (const b of els.rangeButtons) b.setAttribute('aria-pressed', String(b.dataset.range === chartRange));
  if (!points.length) return;
  const selId = chart.sel == null ? null : chart.shown[chart.sel]?.id; // kept selected through a redraw

  // x: the range, up to now. 'All' starts a little before the first weigh-in.
  const x1 = Math.max(Date.now(), points.at(-1).at);
  const x0 = chartRange === 'all'
    ? x1 - Math.max(x1 - points[0].at, 7 * DAY) * 1.03
    : x1 - Number(chartRange) * DAY;
  const firstShown = points.findIndex((p) => p.at >= x0);
  const shown = firstShown < 0 ? [] : points.slice(firstShown);
  els.chartEmpty.hidden = shown.length > 0;
  els.chart.hidden = !shown.length;
  chart.shown = shown;
  if (!shown.length) {
    hidePoint();
    return;
  }

  const W = els.chart.clientWidth;
  const H = els.chart.clientHeight;
  if (!W || !H) return;
  const pad = { ...CHART_PAD, left: chartLeft(unit) };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  // y: in kg, or lb for st & lb and lb. It covers the weigh-ins and the trend, and the goal when
  // it's near enough not to squash them.
  const conv = unit === 'kg' ? (kg) => kg : toLb;
  const values = shown.flatMap((p) => [conv(p.kg), conv(p.trend)]);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  const minSpan = unit === 'kg' ? 1 : 2;
  const goal = settings.goalKg == null ? null : conv(settings.goalKg);
  if (goal != null) {
    const reach = Math.max(hi - lo, minSpan) * 1.5;
    if (goal >= lo - reach && goal <= hi + reach) {
      lo = Math.min(lo, goal);
      hi = Math.max(hi, goal);
    }
  }
  if (hi - lo < minSpan) {
    const mid = (lo + hi) / 2;
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
  }
  const { ticks, step } = yTicks(lo, hi, Math.max(3, Math.floor(plotH / 40)), unit);
  const y0 = ticks[0];
  const y1 = ticks.at(-1);

  const sx = (t) => pad.left + ((t - x0) / (x1 - x0)) * plotW;
  const sy = (v) => pad.top + (1 - (v - y0) / (y1 - y0)) * plotH;
  const f = (n) => n.toFixed(1);
  const crisp = (n) => Math.round(n) + 0.5; // 1px lines on whole pixels

  let svg = `<defs><clipPath id="plot-clip"><rect x="${pad.left - 6}" y="0" width="${plotW + pad.right + 6}" height="${H}"/></clipPath></defs>`;
  for (const v of ticks) {
    const y = crisp(sy(v));
    svg += `<line class="grid" x1="${pad.left}" x2="${W - pad.right}" y1="${y}" y2="${y}"/>`
         + `<text class="tick" x="${pad.left - 8}" y="${y}" dy="0.32em" text-anchor="end">${esc(yLabel(v, step, unit))}</text>`;
  }
  for (const { t, label } of timeTicks(x0, x1, plotW)) {
    const x = sx(t);
    const anchor = x + 26 > W ? 'end' : 'middle';
    svg += `<text class="tick" x="${f(x)}" y="${H - 8}" text-anchor="${anchor}">${esc(label)}</text>`;
  }
  const goalShown = goal != null && goal >= y0 && goal <= y1;
  if (goalShown) {
    const y = f(sy(goal));
    svg += `<line class="goal" x1="${pad.left}" x2="${W - pad.right}" y1="${y}" y2="${y}"/>`
         + `<text class="goal-label" x="${pad.left + 4}" y="${y}" dy="-5">Goal</text>`;
  }
  els.legendGoal.hidden = !goalShown;

  // Dots for the weigh-ins (smaller and without their ring when there are a lot of them), and the
  // trend on top. The trend comes in from the left edge if there's a weigh-in before the range.
  const dense = shown.length > plotW / 9;
  for (const p of shown) {
    svg += `<circle class="dot${dense ? ' dense' : ''}" cx="${f(sx(p.at))}" cy="${f(sy(conv(p.kg)))}" r="${dense ? 2.5 : 4}"/>`;
  }
  const line = (firstShown > 0 ? points.slice(firstShown - 1) : shown).map((p) => `${f(sx(p.at))},${f(sy(conv(p.trend)))}`);
  if (line.length > 1) svg += `<polyline class="trend" clip-path="url(#plot-clip)" points="${line.join(' ')}"/>`;
  svg += '<g id="chart-hover"></g>';

  els.chartSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  els.chartSvg.innerHTML = svg;
  const first = shown[0];
  const last = shown.at(-1);
  els.chartSvg.setAttribute('aria-label', `Weight chart: ${shown.length} weigh-in${shown.length === 1 ? '' : 's'}, `
    + `from ${formatWeight(first.kg, unit)} on ${formatDate(first.at)} to ${formatWeight(last.kg, unit)} on ${formatDate(last.at)}. `
    + `Trend ${formatWeight(last.trend, unit)}. The History list has every weigh-in.`);

  Object.assign(chart, { shown, sx, sy, conv, pad, W, H, sel: null });
  const keep = shown.findIndex((p) => p.id === selId);
  if (keep >= 0) showPoint(keep);
  else hidePoint();
}

// The hover layer: a crosshair on weigh-in `i` of the drawn ones, its two values marked, and the
// tooltip beside it.
function showPoint(i) {
  const { shown, sx, sy, conv, pad, W, H } = chart;
  const p = shown[i];
  if (!p) return;
  chart.sel = i;
  const x = sx(p.at);
  const hover = els.chartSvg.querySelector('#chart-hover');
  hover.innerHTML = `<line class="cross" x1="${x}" x2="${x}" y1="${pad.top}" y2="${H - pad.bottom}"/>`
    + `<circle class="hi-trend" cx="${x}" cy="${sy(conv(p.trend))}" r="4"/>`
    + `<circle class="hi-dot" cx="${x}" cy="${sy(conv(p.kg))}" r="5"/>`;

  const tip = els.chartTip;
  const div = (cls, text) => Object.assign(document.createElement('div'), { className: cls, textContent: text });
  const row = (key, value, label) => {
    const r = div('tip-row', '');
    const k = document.createElement('span');
    k.className = `key ${key}`;
    r.append(k, Object.assign(document.createElement('strong'), { textContent: value }), Object.assign(document.createElement('span'), { textContent: label }));
    return r;
  };
  tip.replaceChildren(
    div('tip-when', `${formatDay(p.at)}, ${formatTime(p.at)}`),
    row('key-dot', formatWeight(p.kg), 'weigh-in'),
    row('key-line', formatWeight(p.trend), 'trend'),
  );
  if (p.note) tip.append(div('tip-note', p.note));
  tip.hidden = false;
  const tw = tip.offsetWidth;
  let left = x + 14;
  if (left + tw > W) left = x - 14 - tw;
  tip.style.left = `${Math.max(0, left)}px`;
}

function hidePoint() {
  chart.sel = null;
  els.chartTip.hidden = true;
  const hover = els.chartSvg.querySelector('#chart-hover');
  if (hover) hover.innerHTML = '';
}

// The pointer picks the weigh-in nearest it along x: readers aim at a date, not at a dot.
function pickAt(clientX) {
  if (!chart.shown.length || !chart.sx) return;
  const x = clientX - els.chart.getBoundingClientRect().left;
  let best = 0;
  chart.shown.forEach((p, i) => {
    if (Math.abs(chart.sx(p.at) - x) < Math.abs(chart.sx(chart.shown[best].at) - x)) best = i;
  });
  if (best !== chart.sel) showPoint(best);
}

function bindChart() {
  els.chart.addEventListener('pointerdown', (e) => pickAt(e.clientX));
  els.chart.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse' || e.buttons) pickAt(e.clientX);
  });
  els.chart.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') hidePoint();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!els.chart.contains(e.target)) hidePoint();
  });
  els.chart.addEventListener('keydown', (e) => {
    const n = chart.shown.length;
    if (!n) return;
    const sel = chart.sel;
    let i;
    if (e.key === 'ArrowLeft') i = sel == null ? n - 1 : Math.max(0, sel - 1);
    else if (e.key === 'ArrowRight') i = sel == null ? n - 1 : Math.min(n - 1, sel + 1);
    else if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = n - 1;
    else if (e.key === 'Escape') { hidePoint(); return; }
    else return;
    e.preventDefault();
    showPoint(i);
  });
  els.chart.addEventListener('blur', hidePoint);
  for (const b of els.rangeButtons) {
    b.addEventListener('click', () => {
      setSetting('chartRange', b.dataset.range);
      renderChart();
    });
  }
  new ResizeObserver(() => renderChart()).observe(els.chartPanel);
}

// ---------- logging and editing ----------

function setLogWhen(custom) {
  els.logWhen.hidden = !custom;
  els.logWhenToggle.textContent = custom ? 'Use now' : 'Now · change';
  els.logWhenToggle.setAttribute('aria-expanded', String(custom));
  if (custom) els.logWhen.value = toLocalInput(Date.now());
}

function bindLog() {
  els.logWhenToggle.addEventListener('click', () => {
    setLogWhen(els.logWhen.hidden);
    if (!els.logWhen.hidden) els.logWhen.focus();
  });
  els.logForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const weight = readWeight(els.logWeight);
    if (weight.empty || weight.error) {
      showError(els.logError, weight.error || 'Enter your weight');
      els.logWeight.querySelector('input').focus();
      return;
    }
    let at = Date.now();
    if (!els.logWhen.hidden) {
      const when = checkWhen(els.logWhen.value);
      if (when.error) {
        showError(els.logError, when.error);
        return;
      }
      at = when.at;
    }
    showError(els.logError, '');
    const entry = { id: newId(), at, kg: weight.kg };
    const note = els.logNote.value.trim();
    if (note) entry.note = note;
    saveEntries([...getEntries(), entry]);
    els.logWeight.querySelectorAll('input').forEach((input) => { input.value = ''; });
    els.logNote.value = '';
    setLogWhen(false);
    document.activeElement?.blur(); // a phone's keyboard goes away
    render();
    toast(`Logged ${formatWeight(entry.kg)}`, 'Undo', () => removeEntry(entry.id));
  });
}

function removeEntry(id) {
  saveEntries(getEntries().filter((e) => e.id !== id));
  render();
}

function openEntry(id) {
  const entry = getEntries().find((e) => e.id === id);
  if (!entry) return;
  state.editingId = id;
  renderWeightFields(els.entryWeight, entry.kg);
  els.entryWhen.value = toLocalInput(entry.at);
  els.entryNote.value = entry.note || '';
  showError(els.entryError, '');
  els.entryDialog.showModal();
}

function bindEntryDialog() {
  els.entries.addEventListener('click', (e) => {
    const row = e.target.closest('.entry');
    if (row) openEntry(row.dataset.id);
  });
  els.showMore.addEventListener('click', () => {
    state.historyAll = !state.historyAll;
    if (state.historyAll) {
      state.openMonths = new Set([monthKey(state.points.at(-1).at)]); // the newest month starts open
    } else {
      els.history.scrollIntoView({ block: 'start' }); // back from the foot of a long list
    }
    renderHistory();
  });
  els.entryForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const entries = getEntries();
    const entry = entries.find((x) => x.id === state.editingId);
    if (!entry) return els.entryDialog.close();
    const weight = readWeight(els.entryWeight);
    if (weight.empty || weight.error) return showError(els.entryError, weight.error || 'Enter the weight');
    // An unchanged time keeps its seconds, so it stays in its place among same-minute weigh-ins.
    let at = entry.at;
    if (els.entryWhen.value !== toLocalInput(entry.at)) {
      const when = checkWhen(els.entryWhen.value);
      if (when.error) return showError(els.entryError, when.error);
      at = when.at;
    }
    const note = els.entryNote.value.trim();
    const updated = { id: entry.id, at, kg: weight.kg, ...(note ? { note } : {}) };
    saveEntries(entries.map((x) => (x.id === entry.id ? updated : x)));
    els.entryDialog.close();
    render();
    toast('Saved');
  });
  els.entryDelete.addEventListener('click', () => {
    const entry = getEntries().find((x) => x.id === state.editingId);
    els.entryDialog.close();
    if (!entry) return;
    removeEntry(entry.id);
    toast('Weigh-in deleted', 'Undo', () => {
      saveEntries([...getEntries(), entry]);
      render();
    });
  });
}

// ---------- goal ----------

function openGoal() {
  const { goalKg } = getSettings();
  renderWeightFields(els.goalWeight, goalKg);
  els.goalRemove.hidden = goalKg == null;
  showError(els.goalError, '');
  els.goalDialog.showModal();
}

function bindGoalDialog() {
  els.goalForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const weight = readWeight(els.goalWeight);
    if (weight.empty || weight.error) return showError(els.goalError, weight.error || 'Enter a goal weight');
    setSetting('goalKg', weight.kg);
    els.goalDialog.close();
    render();
    toast(`Goal set to ${formatWeight(weight.kg)}`);
  });
  els.goalRemove.addEventListener('click', () => {
    const old = getSettings().goalKg;
    setSetting('goalKg', null);
    els.goalDialog.close();
    render();
    toast('Goal removed', 'Undo', () => {
      setSetting('goalKg', old);
      render();
    });
  });
}

// ---------- settings ----------

function applyTheme() {
  const light = getSettings().theme === 'light';
  if (light) document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
  els.themeColor.setAttribute('content', light ? '#f5f4f0' : '#0f1115');
}

function openSettings() {
  renderSettings();
  els.settingsDialog.showModal();
}

function renderSettings() {
  const { unit, theme } = getSettings();
  for (const b of els.unitButtons) b.setAttribute('aria-checked', String(b.dataset.unit === unit));
  for (const b of els.themeButtons) b.setAttribute('aria-checked', String(b.dataset.themeChoice === theme));
  const entries = getEntries();
  els.dataSummary.textContent = entries.length
    ? `${entries.length} weigh-in${entries.length === 1 ? '' : 's'}, from ${formatDate(entries[0].at)} to ${formatDate(entries.at(-1).at)}.`
    : 'No weigh-ins yet.';
}

function bindSettings() {
  els.settingsButton.addEventListener('click', openSettings);
  for (const b of els.unitButtons) {
    b.addEventListener('click', () => {
      setSetting('unit', b.dataset.unit);
      renderWeightFields(els.logWeight);
      showError(els.logError, '');
      render();
    });
  }
  for (const b of els.themeButtons) {
    b.addEventListener('click', () => {
      setSetting('theme', b.dataset.themeChoice);
      applyTheme();
      renderSettings();
    });
  }
  els.backupSave.addEventListener('click', saveBackup);
  els.backupLoad.addEventListener('click', () => els.backupFile.click());
  els.backupFile.addEventListener('change', () => {
    const file = els.backupFile.files[0];
    els.backupFile.value = '';
    if (file) loadBackup(file);
  });
  els.csvExport.addEventListener('click', exportCsv);
}

// Dialogs close from their ✕ and Cancel buttons, and from a click on the backdrop.
function bindDialogs() {
  for (const dialog of [els.entryDialog, els.goalDialog, els.settingsDialog]) {
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog || e.target.closest('[data-close]')) dialog.close();
    });
  }
}

// ---------- backup and export ----------

// iPhone: the share sheet ("Save to Files"), since a download link just opens the file there.
async function saveFile(file, title) {
  if (IS_IOS && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
    } catch (e) {
      if (e.name !== 'AbortError') toast("Couldn't share the file");
    }
    return;
  }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: file.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  toast(`Saved ${file.name}`);
}

const today = () => toLocalInput(Date.now()).slice(0, 10);

function saveBackup() {
  const backup = { format: BACKUP_FORMAT, version: 1, exported: new Date().toISOString(), data: loadStore() };
  const name = `weightlogger-backup-${today()}.json`;
  saveFile(new File([JSON.stringify(backup, null, 1)], name, { type: 'application/json' }), 'Weight Logger backup');
}

async function loadBackup(file) {
  let backup;
  try {
    backup = JSON.parse(await file.text());
  } catch {
    backup = null;
  }
  const data = backup?.data;
  const valid = backup?.format === BACKUP_FORMAT && data && Array.isArray(data.entries)
    && (data.settings == null || (typeof data.settings === 'object' && !Array.isArray(data.settings)))
    && data.entries.every((e) => e && Number.isFinite(e.at) && Number.isFinite(e.kg) && e.kg > 0
                                 && (e.note == null || typeof e.note === 'string'));
  if (!valid) {
    toast("That file isn't a Weight Logger backup");
    return;
  }
  const when = backup.exported ? formatDate(Date.parse(backup.exported)) : 'an unknown date';
  const count = (n) => `${n} weigh-in${n === 1 ? '' : 's'}`;
  if (!confirm(`Load the backup from ${when}, with ${count(data.entries.length)}?\n\nIt replaces the ${count(getEntries().length)} and the settings on this device.`)) return;
  const entries = data.entries.map((e) => ({ id: typeof e.id === 'string' ? e.id : newId(), at: e.at, kg: e.kg, ...(e.note ? { note: e.note } : {}) }));
  saveStore({ settings: data.settings || {}, entries: entries.sort((a, b) => a.at - b.at) });
  els.settingsDialog.close();
  applyTheme();
  renderWeightFields(els.logWeight);
  render();
  toast('Backup loaded');
}

function exportCsv() {
  const quote = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = ['date,time,weight_kg,weight_lb,trend_kg,note'];
  for (const p of withTrend(getEntries())) {
    const [date, time] = toLocalInput(p.at).split('T');
    lines.push([date, time, p.kg.toFixed(2), toLb(p.kg).toFixed(2), p.trend.toFixed(2), quote(p.note || '')].join(','));
  }
  const name = `weightlogger-${today()}.csv`;
  saveFile(new File([lines.join('\n') + '\n'], name, { type: 'text/csv' }), 'Weight Logger export');
}

// ---------- toast ----------

// A message along the bottom, with an optional action (Undo). It's a popover where the browser has
// them, so it shows above an open dialog too.
let toastTimer = null;

function toast(text, actionLabel = null, action = null) {
  els.toastText.textContent = text;
  els.toastAction.hidden = !action;
  els.toastAction.textContent = actionLabel || '';
  els.toastAction.onclick = action ? () => { hideToast(); action(); } : null;
  const t = els.toast;
  t.hidden = false;
  if (t.showPopover) {
    if (t.matches(':popover-open')) t.hidePopover();
    t.showPopover(); // again, to come above a dialog opened since
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? 6000 : 2500);
}

function hideToast() {
  const t = els.toast;
  if (t.hidePopover && t.matches(':popover-open')) t.hidePopover();
  t.hidden = true;
}

// ---------- offline ----------

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return; // also absent over plain http on a LAN address
  // The app opens from the saved copy; sw.js checks for a new version in the background and says
  // so when it has stored one, and a reload then shows it.
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'update-ready') els.updateBar.hidden = false;
  });
  els.updateReload.addEventListener('click', () => location.reload());
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker failed:', e));
}

// ---------- boot ----------

function init() {
  applyTheme();
  document.addEventListener('touchstart', () => {}, { passive: true }); // iOS shows :active only with one
  renderWeightFields(els.logWeight);
  bindLog();
  bindChart();
  bindEntryDialog();
  bindGoalDialog();
  bindSettings();
  bindDialogs();
  render();
  registerServiceWorker();
}

init();
