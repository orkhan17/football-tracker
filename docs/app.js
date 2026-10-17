const CATEGORY_LABELS = { league: 'League', cup: 'Cup', europe: 'Europe', international: 'National team' };
const CLUB_CATEGORIES = ['league', 'cup', 'europe'];
const LOW_MINUTES = 270; // below this, per-90 numbers are noisy
const MAX_COMPARE = 4;
const WHATSNEW_LIMIT = 8;

const COLUMNS = [
  { key: 'apps', label: 'Apps', title: 'Appearances' },
  { key: 'starts', label: 'Starts', title: 'Matches started' },
  { key: 'minutes', label: 'Min', title: 'Minutes played' },
  { key: 'goals', label: 'G', title: 'Goals' },
  { key: 'assists', label: 'A', title: 'Assists' },
  { key: 'ga', label: 'G+A', title: 'Goals + assists' },
  { key: 'g90', label: 'G/90', title: 'Goals per 90 minutes', per90: true },
  { key: 'a90', label: 'A/90', title: 'Assists per 90 minutes', per90: true },
  { key: 'ga90', label: 'G+A/90', title: 'Goals + assists per 90 minutes', per90: true },
];

const state = {
  data: null,
  season: null,
  category: 'club',
  group: 'all', // 'all' | 'none' (ungrouped) | a group name
  query: '',
  playedOnly: false,
  split: false, // "All players" as one list (sorts across groups) or one section per group
  sort: { key: 'ga', desc: true },
  selected: new Set(),
  expanded: new Set(),
  whatsNewAll: false,
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const seasonLabel = (s) => `${s}/${String((Number(s) + 1) % 100).padStart(2, '0')}`;
const fmt90 = (v) => (v == null ? '–' : v.toFixed(2));
const fmtDate = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const keyOf = (p) => String(p.id ?? p.name);
const normalize = (s) =>
  String(s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/ı/g, 'i').toLowerCase();

// --- player helpers ---------------------------------------------------------

const groupsOf = (p) => p.groups ?? [];

// Groups without a color in players.json "groupColors" take the next palette color, in group order.
const GROUP_PALETTE = ['#2563eb', '#d97706', '#7c3aed', '#0d9488', '#db2777', '#65a30d'];

function groupColor(name) {
  const configured = state.data.groupColors ?? {};
  if (configured[name]) return configured[name];
  const auto = groupNames().filter((g) => !configured[g]);
  return GROUP_PALETTE[Math.max(0, auto.indexOf(name)) % GROUP_PALETTE.length];
}

// WCAG relative luminance of a #rrggbb color: 0 (black) … 1 (white).
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// White or black text, whichever contrasts more with the background.
const textOn = (hex) => (luminance(hex) > 0.179 ? '#000' : '#fff');

// Section stripes and dots sit on the page background: a near-black group color would vanish in
// dark mode, so draw it in the light text color there instead (black ↔ white, Beşiktaş-friendly).
function markColor(name) {
  const color = groupColor(name);
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  return dark && luminance(color) < 0.03 ? '#e7e9ee' : color;
}

const tagStyle = (g) => `background:${groupColor(g)};color:${textOn(groupColor(g))}`;

function inGroup(p, group = state.group) {
  if (group === 'all') return true;
  if (group === 'none') return groupsOf(p).length === 0;
  return groupsOf(p).includes(group);
}

// 'pending' = not fetched yet, 'empty' = fetched but the API has no stats, 'ok' otherwise.
function statusOf(p) {
  const seasons = Object.values(p.seasons ?? {});
  if (!seasons.length) return 'pending';
  return seasons.some((s) => s.competitions.length) ? 'ok' : 'empty';
}

// Team of the most recent season with appearances, as reported by the API.
function lastTeam(p) {
  const season = Object.keys(p.seasons ?? {})
    .filter((s) => p.seasons[s].competitions.length)
    .sort()
    .at(-1);
  return season ? p.seasons[season].competitions[0].team : null;
}

const CLUB_NOISE = new Set(['fc', 'cf', 'afc', 'fk', 'sk', 'jk', 'sl', 'ac', 'as', 'sc', 'pfc', 'club', 'the']);
const clubKey = (s) =>
  normalize(s)
    .replace(/[^a-z\s-]/g, '')
    .split(/[\s-]+/)
    .filter((t) => t && !CLUB_NOISE.has(t) && t !== 'spor')
    .join('')
    .replace(/spor$/, '');
const sameClub = (a, b) => {
  const x = clubKey(a);
  const y = clubKey(b);
  return Boolean(x && y) && (x.includes(y) || y.includes(x));
};

function matchesQuery(p) {
  if (!state.query) return true;
  const q = normalize(state.query);
  return [p.name, p.fullName, p.club, lastTeam(p)].some((s) => normalize(s).includes(q));
}

function sum(competitions) {
  const t = { apps: 0, starts: 0, minutes: 0, goals: 0, assists: 0 };
  for (const c of competitions) for (const k in t) t[k] += c[k];
  const per90 = (v) => (t.minutes ? (v * 90) / t.minutes : null);
  return { ...t, ga: t.goals + t.assists, g90: per90(t.goals), a90: per90(t.assists), ga90: per90(t.goals + t.assists) };
}

function inCategory(c, category) {
  return category === 'club' ? CLUB_CATEGORIES.includes(c.category) : c.category === category;
}

function competitionsOf(p, season = state.season, category = state.category) {
  return (p.seasons?.[season]?.competitions ?? []).filter((c) => inCategory(c, category));
}

function totals(p, season = state.season, category = state.category) {
  return { ...sum(competitionsOf(p, season, category)), stale: p.seasons?.[season]?.stale };
}

// ▲/▼ against last season, only when viewing the latest season and both have enough minutes.
function trend(p, key, t) {
  const [latest, previous] = state.data.seasons;
  if (state.season !== latest || previous == null || t.minutes < LOW_MINUTES) return '';
  const prev = totals(p, previous);
  if (prev.minutes < LOW_MINUTES || prev[key] == null || t[key] == null) return '';
  const diff = t[key] - prev[key];
  if (Math.abs(diff) < 0.005) return '';
  const label = `${seasonLabel(previous)}: ${fmt90(prev[key])}`;
  return diff > 0
    ? ` <span class="trend up" title="${label}">▲</span>`
    : ` <span class="trend down" title="${label}">▼</span>`;
}

function visiblePlayers() {
  return state.data.players.filter((p) => inGroup(p) && matchesQuery(p) && (!state.playedOnly || totals(p).apps > 0));
}

// --- URL state ----------------------------------------------------------------

function readUrl() {
  const q = new URLSearchParams(location.search);
  const season = Number(q.get('season'));
  if (state.data.seasons.includes(season)) state.season = season;
  if (['club', 'league', 'cup', 'europe'].includes(q.get('comp'))) state.category = q.get('comp');
  if (q.get('group')) state.group = q.get('group');
  state.query = q.get('q') ?? '';
  state.playedOnly = q.get('played') === '1';
  state.split = q.get('split') === '1';
  if (q.get('sort')) state.sort = { key: q.get('sort'), desc: q.get('dir') !== 'asc' };
  for (const id of (q.get('compare') ?? '').split(',').filter(Boolean)) state.selected.add(id);
}

function writeUrl() {
  const q = new URLSearchParams();
  if (state.season !== state.data.seasons[0]) q.set('season', state.season);
  if (state.category !== 'club') q.set('comp', state.category);
  if (state.group !== 'all') q.set('group', state.group);
  if (state.query) q.set('q', state.query);
  if (state.playedOnly) q.set('played', '1');
  if (state.split) q.set('split', '1');
  if (state.sort.key !== 'ga' || !state.sort.desc) {
    q.set('sort', state.sort.key);
    q.set('dir', state.sort.desc ? 'desc' : 'asc');
  }
  if (state.selected.size) q.set('compare', [...state.selected].join(','));
  const qs = q.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

// --- rendering ----------------------------------------------------------------

function renderHeader() {
  const { generatedAt, seasons, seasonErrors } = state.data;
  $('#updated').textContent = generatedAt
    ? `Stats last changed ${new Date(generatedAt).toLocaleString()} · checked daily`
    : 'Not updated yet';

  $('#season-seg').innerHTML = seasons
    .map((s) => `<button data-season="${s}" aria-pressed="${s === state.season}">${seasonLabel(s)}</button>`)
    .join('');
  $('#category').value = state.category;
  $('#search').value = state.query;
  $('#played').checked = state.playedOnly;
  $('#split').checked = state.split;

  const notices = Object.entries(seasonErrors ?? {}).map(
    ([s, msg]) => `<div class="notice"><strong>${seasonLabel(s)} unavailable from the API:</strong> ${esc(msg)}</div>`,
  );
  $('#notices').innerHTML = notices.join('');

  // Group options in first-seen order from players.json; hidden when nobody is grouped.
  const players = state.data.players;
  const names = groupNames();
  const count = (g) => players.filter((p) => inGroup(p, g)).length;
  const options = [['all', 'All players'], ...names.map((n) => [n, n])];
  if (names.length && count('none')) options.push(['none', 'Ungrouped']);
  if (!options.some(([v]) => v === state.group)) state.group = 'all';
  const select = $('#group');
  select.hidden = names.length === 0;
  $('#split-label').hidden = names.length === 0 || state.group !== 'all';
  select.innerHTML = options
    .map(([v, label]) => `<option value="${esc(v)}"${v === state.group ? ' selected' : ''}>${esc(label)} (${count(v)})</option>`)
    .join('');
}

const groupNames = () => [...new Set(state.data.players.flatMap(groupsOf))];

function renderWhatsNew() {
  const changes = state.data.changes;
  const inView = (id) => state.data.players.some((p) => String(p.id) === String(id) && inGroup(p) && matchesQuery(p));
  const items = (changes?.items ?? []).filter((i) => inView(i.id) && (i.apps > 0 || i.goals || i.assists));
  const added = (changes?.added ?? []).filter((n) => state.data.players.some((p) => p.name === n && inGroup(p) && matchesQuery(p)));
  $('#whatsnew').hidden = !items.length && !added.length;
  if ($('#whatsnew').hidden) return;

  $('#whatsnew-range').textContent = changes.since
    ? `${fmtDate(changes.since)} → ${fmtDate(changes.until)}`
    : `up to ${fmtDate(changes.until)}`;

  const byPlayer = new Map();
  for (const i of items) byPlayer.set(i.id, [...(byPlayer.get(i.id) ?? []), i]);
  // Goal involvements first, then by minutes.
  const rows = [...byPlayer.values()].sort(
    (a, b) =>
      b.reduce((s, i) => s + i.goals + i.assists, 0) - a.reduce((s, i) => s + i.goals + i.assists, 0) ||
      b.reduce((s, i) => s + i.minutes, 0) - a.reduce((s, i) => s + i.minutes, 0),
  );
  const shown = state.whatsNewAll ? rows : rows.slice(0, WHATSNEW_LIMIT);
  const signed = (n, unit) => (n ? `${n > 0 ? '+' : '−'}${Math.abs(n)}${unit}` : '');
  const list = shown
    .map((lines) => {
      const parts = lines
        .map((i) => {
          const bits = [
            i.goals && `<b>${signed(i.goals, ' G')}</b>`,
            i.assists && `<b>${signed(i.assists, ' A')}</b>`,
            i.apps > 0 && `${i.apps} app${i.apps > 1 ? 's' : ''}, ${i.minutes}'`,
          ].filter(Boolean);
          return `${bits.join(' · ')} <span class="muted">${esc(i.competition)}</span>`;
        })
        .join('<br>');
      return `<li><span class="wn-name">${esc(lines[0].name)}</span> <span class="muted small">${esc(lines[0].team)}</span><div>${parts}</div></li>`;
    })
    .join('');
  const more =
    rows.length > WHATSNEW_LIMIT
      ? `<button class="link" id="whatsnew-toggle">${state.whatsNewAll ? 'Show less' : `Show all ${rows.length}`}</button>`
      : '';
  const addedLine = added.length ? `<p class="muted small">Now tracking: ${added.map(esc).join(', ')}</p>` : '';
  $('#whatsnew-body').innerHTML = `${list ? `<ul class="wn">${list}</ul>` : ''}${more}${addedLine}`;
}

// `section` is the group heading the row sits under; its tag would only repeat the heading.
function playerCell(p, section) {
  const status = statusOf(p);
  const team = lastTeam(p);
  const moved = team && p.club && !sameClub(team, p.club) ? `<span class="moved" title="Most recent appearances in the data">last played: ${esc(team)}</span>` : '';
  const tags = groupsOf(p)
    .filter((g) => g !== section)
    .map((g) => `<span class="tag" style="${tagStyle(g)}">${esc(g)}</span>`).join('');
  const badge =
    status === 'pending'
      ? '<span class="badge" title="Will be fetched on the next run">no data yet</span>'
      : status === 'empty'
        ? '<span class="badge" title="The API has no stats for this player">no stats in API</span>'
        : '';
  const stale = state.data.players && totals(p).stale ? '<span class="badge warn" title="Last update failed; showing previous data">stale</span>' : '';
  const err = p.error ? `<div class="err">${esc(p.error)}</div>` : '';
  return `<div class="player"><div class="name">${esc(p.name)}${badge}${stale}</div>
    <div class="sub">${esc(p.club ?? '')}${moved}${tags}</div>${err}</div>`;
}

function statCells(t, p, { dim = false } = {}) {
  const low = t.minutes < LOW_MINUTES;
  return COLUMNS.map((c, i) => {
    const cls = [(i === 0 || i === 6) && 'group-start', c.per90 && low && 'lowmin', dim && 'dim'].filter(Boolean).join(' ');
    if (dim) return `<td class="${cls}">–</td>`;
    const v = c.per90 ? fmt90(t[c.key]) + (p ? trend(p, c.key, t) : '') : t[c.key];
    return `<td class="${cls}">${v}</td>`;
  }).join('');
}

function sortRows(rows) {
  const { key, desc } = state.sort;
  return rows.sort((a, b) => {
    if (key === 'name') return desc ? b.p.name.localeCompare(a.p.name) : a.p.name.localeCompare(b.p.name);
    const av = a.pending ? -Infinity : (a.t[key] ?? -1);
    const bv = b.pending ? -Infinity : (b.t[key] ?? -1);
    return desc ? bv - av : av - bv;
  });
}

function renderRows(players, section) {
  const rows = sortRows(players.map((p) => ({ p, t: totals(p), pending: statusOf(p) === 'pending' })));
  return rows
    .map(({ p, t, pending }) => {
      const id = keyOf(p);
      const checked = state.selected.has(id) ? 'checked' : '';
      const row = `<tr class="row" data-id="${esc(id)}">
        <td class="sticky c0"><input type="checkbox" data-select="${esc(id)}" ${checked} aria-label="Compare ${esc(p.name)}"></td>
        <td class="sticky c1">${playerCell(p, section)}</td>${statCells(t, p, { dim: pending })}</tr>`;
      return state.expanded.has(id) ? row + `<tr class="detail"><td colspan="${COLUMNS.length + 2}">${breakdown(p)}</td></tr>` : row;
    })
    .join('');
}

function renderTable() {
  const { key, desc } = state.sort;
  const sorted = (k) => (key === k ? `sorted${desc ? '' : ' asc'}` : '');
  $('#overview thead').innerHTML = `<tr>
    <th class="sticky c0" aria-label="Compare"></th>
    <th class="sticky c1 ${sorted('name')}" data-sort="name">Player</th>
    ${COLUMNS.map((c, i) => {
      const cls = [sorted(c.key), (i === 0 || i === 6) && 'group-start'].filter(Boolean).join(' ');
      return `<th data-sort="${c.key}" class="${cls}" title="${c.title}">${c.label}</th>`;
    }).join('')}
  </tr>`;

  const players = visiblePlayers();
  const names = groupNames();
  let html;
  if (state.split && state.group === 'all' && names.length) {
    // One section per group (a player in two groups appears in both), then ungrouped players.
    const sections = names.map((g) => [g, players.filter((p) => groupsOf(p).includes(g))]);
    sections.push(['Ungrouped', players.filter((p) => !groupsOf(p).length)]);
    html = sections
      .filter(([, ps]) => ps.length)
      .map(([name, ps]) => {
        const withData = ps.filter((p) => statusOf(p) !== 'pending');
        const total = sum(withData.flatMap((p) => competitionsOf(p)));
        const color = name === 'Ungrouped' ? null : markColor(name);
        const stripe = color ? ` style="box-shadow: inset 4px 0 0 ${color}"` : '';
        const dot = color ? `<span class="dot" style="background:${color}"></span>` : '';
        return `<tr class="section"><td class="sticky c0"${stripe}></td><td class="sticky c1">${dot}<b>${esc(name)}</b> <span class="muted small">${ps.length}</span></td>${statCells(total, null)}</tr>${renderRows(ps, name)}`;
      })
      .join('');
  } else {
    html = renderRows(players, state.group);
  }
  $('#overview tbody').innerHTML = html;

  const empty = $('#empty');
  empty.hidden = players.length > 0;
  empty.textContent = state.data.players.length ? 'No players match the current filters.' : 'No players yet — add some to players.json.';
}

function breakdown(p) {
  return `<div class="breakdown">${state.data.seasons
    .map((season) => {
      const s = p.seasons?.[season];
      if (!s || !s.competitions.length) return `<div><h3>${seasonLabel(season)}</h3><p class="muted">No appearances.</p></div>`;
      const order = ['league', 'cup', 'europe', 'international'];
      const comps = [...s.competitions].sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
      const row = (label, t, cls = '') =>
        `<tr class="${cls}"><td>${label}</td><td>${t.apps}</td><td>${t.starts}</td><td>${t.minutes}</td><td>${t.goals}</td><td>${t.assists}</td></tr>`;
      const multiTeam = new Set(comps.map((c) => c.team)).size > 1;
      return `<div><h3>${seasonLabel(season)}${s.stale ? ' <span class="badge warn">stale</span>' : ''}</h3>
        <table>
          <thead><tr><th>Competition</th><th>Apps</th><th>Starts</th><th>Min</th><th>G</th><th>A</th></tr></thead>
          <tbody>
            ${comps
              .map((c) =>
                row(
                  `${esc(c.name)}${multiTeam ? ` <span class="cat">(${esc(c.team)})</span>` : ''} <span class="cat">${CATEGORY_LABELS[c.category]}</span>`,
                  c,
                ),
              )
              .join('')}
            ${row('Club total', sum(comps.filter((c) => CLUB_CATEGORIES.includes(c.category))), 'total')}
          </tbody>
        </table></div>`;
    })
    .join('')}</div>`;
}

function renderCompare() {
  const players = state.data.players.filter((p) => state.selected.has(keyOf(p)));
  $('#compare').hidden = players.length < 2;
  if (players.length < 2) return;

  const ts = players.map((p) => totals(p));
  $('#compare-body').innerHTML = `<div class="compare-grid" style="grid-template-columns: 70px repeat(${players.length}, minmax(90px, 1fr))">
    <div></div>${players.map((p) => `<div class="colhead">${esc(p.name)}</div>`).join('')}
    ${COLUMNS.map((c) => {
      const vals = ts.map((t) => t[c.key] ?? 0);
      const max = Math.max(...vals);
      return `<div class="label" title="${c.title}">${c.label}</div>${vals
        .map((v) => {
          const pct = max ? (v / max) * 100 : 0;
          const best = max > 0 && v === max ? ' best' : '';
          return `<div class="bar-cell${best}"><span class="val">${c.per90 ? fmt90(v) : v}</span><div class="bar" style="width:${pct}%"></div></div>`;
        })
        .join('')}`;
    }).join('')}
  </div>`;
}

function render() {
  renderHeader();
  renderWhatsNew();
  renderTable();
  renderCompare();
  writeUrl();
}

// --- events -------------------------------------------------------------------

function bindEvents() {
  $('#season-seg').addEventListener('click', (e) => {
    const s = e.target.closest('button')?.dataset.season;
    if (s) {
      state.season = Number(s);
      render();
    }
  });
  $('#category').addEventListener('change', (e) => {
    state.category = e.target.value;
    render();
  });
  $('#group').addEventListener('change', (e) => {
    state.group = e.target.value;
    render(); // compare keeps its selection across groups
  });
  $('#search').addEventListener('input', (e) => {
    state.query = e.target.value.trim();
    renderWhatsNew();
    renderTable();
    writeUrl();
  });
  $('#split').addEventListener('change', (e) => {
    state.split = e.target.checked;
    render();
  });
  $('#played').addEventListener('change', (e) => {
    state.playedOnly = e.target.checked;
    render();
  });
  $('#whatsnew').addEventListener('click', (e) => {
    if (e.target.id !== 'whatsnew-toggle') return;
    state.whatsNewAll = !state.whatsNewAll;
    renderWhatsNew();
  });
  $('#overview thead').addEventListener('click', (e) => {
    const key = e.target.closest('th')?.dataset.sort;
    if (!key) return;
    state.sort = { key, desc: state.sort.key === key ? !state.sort.desc : key !== 'name' };
    renderTable();
    writeUrl();
  });
  $('#overview tbody').addEventListener('click', (e) => {
    const sel = e.target.closest('[data-select]');
    if (sel) {
      const id = sel.dataset.select;
      if (sel.checked && state.selected.size >= MAX_COMPARE) {
        sel.checked = false;
        return;
      }
      sel.checked ? state.selected.add(id) : state.selected.delete(id);
      // A player in two groups has two rows; keep both checkboxes in sync.
      for (const box of document.querySelectorAll(`[data-select="${CSS.escape(id)}"]`)) box.checked = sel.checked;
      renderCompare();
      writeUrl();
      return;
    }
    const row = e.target.closest('tr.row');
    if (row) {
      const id = row.dataset.id;
      state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id);
      renderTable();
    }
  });
  $('#clear-compare').addEventListener('click', () => {
    state.selected.clear();
    render();
  });
}

async function init() {
  try {
    const res = await fetch('data.json', { cache: 'no-cache' });
    state.data = res.ok ? await res.json() : null;
  } catch {
    state.data = null;
  }
  state.data ??= { seasons: [], players: [] };
  state.season = state.data.seasons[0] ?? null;
  readUrl();
  bindEvents();
  render();
}

init();
