const CATEGORY_LABELS = { league: 'League', cup: 'Cup', europe: 'Europe', international: 'National team' };
const CLUB_CATEGORIES = ['league', 'cup', 'europe'];
const LOW_MINUTES = 270; // below this, per-90 numbers are noisy
const MAX_COMPARE = 4;

const COLUMNS = [
  { key: 'apps', label: 'Apps' },
  { key: 'starts', label: 'Starts' },
  { key: 'minutes', label: 'Min' },
  { key: 'goals', label: 'G' },
  { key: 'assists', label: 'A' },
  { key: 'ga', label: 'G+A' },
  { key: 'g90', label: 'G/90', per90: true },
  { key: 'a90', label: 'A/90', per90: true },
  { key: 'ga90', label: 'G+A/90', per90: true },
];

const state = {
  data: null,
  season: null,
  category: 'club',
  sort: { key: 'ga', desc: true },
  selected: new Set(),
  expanded: new Set(),
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const seasonLabel = (s) => `${s}/${String((Number(s) + 1) % 100).padStart(2, '0')}`;
const fmt90 = (v) => (v == null ? '–' : v.toFixed(2));

function sum(competitions) {
  const t = { apps: 0, starts: 0, minutes: 0, goals: 0, assists: 0 };
  for (const c of competitions) for (const k in t) t[k] += c[k];
  const per90 = (v) => (t.minutes ? (v * 90) / t.minutes : null);
  return { ...t, ga: t.goals + t.assists, g90: per90(t.goals), a90: per90(t.assists), ga90: per90(t.goals + t.assists) };
}

function inCategory(c, category) {
  return category === 'club' ? CLUB_CATEGORIES.includes(c.category) : c.category === category;
}

function totals(player, season = state.season, category = state.category) {
  const s = player.seasons?.[season];
  return { ...sum((s?.competitions ?? []).filter((c) => inCategory(c, category))), stale: s?.stale, missing: !s };
}

function renderHeader() {
  const { generatedAt, seasons, seasonErrors } = state.data;
  $('#updated').textContent = generatedAt ? `Updated ${new Date(generatedAt).toLocaleString()}` : 'Not updated yet';

  $('#season-seg').innerHTML = seasons
    .map((s) => `<button data-season="${s}" aria-pressed="${s === state.season}">${seasonLabel(s)}</button>`)
    .join('');

  const notices = Object.entries(seasonErrors ?? {}).map(
    ([s, msg]) => `<div class="notice"><strong>${seasonLabel(s)} unavailable from the API:</strong> ${esc(msg)}</div>`,
  );
  $('#notices').innerHTML = notices.join('');
}

function playerCell(p) {
  const sub = [p.club, p.position].filter(Boolean).map(esc).join(' · ');
  const err = p.error ? `<div class="err">${esc(p.error)}</div>` : '';
  return `<div class="player"><div>${esc(p.name)}</div><div class="sub">${sub}</div>${err}</div>`;
}

function renderTable() {
  const { key, desc } = state.sort;
  $('#overview thead').innerHTML = `<tr>
    <th aria-label="Compare"></th>
    <th data-sort="name" class="${key === 'name' ? `sorted${desc ? '' : ' asc'}` : ''}">Player</th>
    ${COLUMNS.map((c, i) => {
      const cls = [key === c.key && `sorted${desc ? '' : ' asc'}`, (i === 0 || i === 6) && 'group-start'].filter(Boolean).join(' ');
      return `<th data-sort="${c.key}" class="${cls}">${c.label}</th>`;
    }).join('')}
  </tr>`;

  const rows = state.data.players.map((p) => ({ p, t: totals(p) }));
  rows.sort((a, b) => {
    if (key === 'name') return desc ? b.p.name.localeCompare(a.p.name) : a.p.name.localeCompare(b.p.name);
    const av = a.t[key] ?? -1;
    const bv = b.t[key] ?? -1;
    return desc ? bv - av : av - bv;
  });

  $('#overview tbody').innerHTML = rows
    .map(({ p, t }) => {
      const id = String(p.id ?? p.name);
      const low = t.minutes < LOW_MINUTES;
      const cells = COLUMNS.map((c, i) => {
        const v = c.per90 ? fmt90(t[c.key]) : t[c.key];
        const cls = [(i === 0 || i === 6) && 'group-start', c.per90 && low && 'lowmin'].filter(Boolean).join(' ');
        return `<td class="${cls}">${v}</td>`;
      }).join('');
      const stale = t.stale ? '<span class="stale" title="Last update failed; showing previous data">stale</span>' : '';
      const checked = state.selected.has(id) ? 'checked' : '';
      const row = `<tr class="row" data-id="${esc(id)}">
        <td><input type="checkbox" data-select="${esc(id)}" ${checked} aria-label="Compare ${esc(p.name)}"></td>
        <td>${playerCell(p)}${stale}</td>${cells}</tr>`;
      return state.expanded.has(id) ? row + `<tr class="detail"><td colspan="${COLUMNS.length + 2}">${breakdown(p)}</td></tr>` : row;
    })
    .join('');

  $('#empty').hidden = state.data.players.length > 0;
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
      return `<div><h3>${seasonLabel(season)}${s.stale ? ' <span class="stale">stale</span>' : ''}</h3>
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
  const players = state.data.players.filter((p) => state.selected.has(String(p.id ?? p.name)));
  $('#compare').hidden = players.length < 2;
  if (players.length < 2) return;

  const ts = players.map((p) => totals(p));
  const grid = `<div class="compare-grid" style="grid-template-columns: 90px repeat(${players.length}, minmax(110px, 1fr))">
    <div></div>${players.map((p) => `<div class="colhead">${esc(p.name)}</div>`).join('')}
    ${COLUMNS.map((c) => {
      const vals = ts.map((t) => t[c.key] ?? 0);
      const max = Math.max(...vals);
      return `<div class="label">${c.label}</div>${vals
        .map((v) => {
          const pct = max ? (v / max) * 100 : 0;
          const best = max > 0 && v === max ? ' best' : '';
          return `<div class="bar-cell${best}"><span class="val">${c.per90 ? fmt90(v) : v}</span><div class="bar" style="width:${pct}%"></div></div>`;
        })
        .join('')}`;
    }).join('')}
  </div>`;
  $('#compare-body').innerHTML = grid;
}

function render() {
  renderHeader();
  renderTable();
  renderCompare();
}

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
  $('#overview thead').addEventListener('click', (e) => {
    const key = e.target.closest('th')?.dataset.sort;
    if (!key) return;
    state.sort = { key, desc: state.sort.key === key ? !state.sort.desc : key !== 'name' };
    renderTable();
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
      renderCompare();
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
  bindEvents();
  render();
}

init();
