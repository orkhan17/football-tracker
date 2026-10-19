const CATEGORY_LABELS = { league: 'League', cup: 'Cup', europe: 'Europe', international: 'National team' };
const CLUB_CATEGORIES = ['league', 'cup', 'europe'];
const LOW_MINUTES = 270; // below this, per-90 numbers are noisy
const MAX_COMPARE = 4;
const WHATSNEW_LIMIT = 8;
const LAST30 = 'last30'; // pseudo-season: change over the last 30 days, from history.json
const WINDOW_DAYS = 30;

// Broad position groups for filtering, from Transfermarkt-style positions ("Right Winger", ...).
const POSITION_GROUPS = [
  ['gk', 'Goalkeepers', /goalkeeper/i],
  ['def', 'Defenders', /back|defen|sweeper/i],
  ['mid', 'Midfielders', /midfield/i],
  ['fwd', 'Forwards', /wing|forward|striker/i],
];
const positionGroup = (p) => POSITION_GROUPS.find(([, , re]) => re.test(p.position ?? ''))?.[0] ?? null;

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
  history: {}, // history.json: { season: { id: [[date, { category: [apps, starts, min, g, a] }], ...] } }
  profiles: {}, // profiles.json: { id: { birthDate, citizenship, height, foot, club, joinedAt, contractExpiry, ... } }
  season: null, // a season start year, or LAST30
  category: 'club',
  group: 'all', // 'all' | 'none' (ungrouped) | a group name
  position: 'all', // 'all' | a POSITION_GROUPS key
  query: '',
  playedOnly: false,
  split: false, // "All players" as one list (sorts across groups) or one section per group
  sort: { key: 'ga', desc: true },
  selected: new Set(),
  expanded: new Set(),
  whatsNewAll: false,
  player: null, // id of the player page being shown
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const seasonLabel = (s) => (s === LAST30 ? 'Last 30 days' : `${s}/${String((Number(s) + 1) % 100).padStart(2, '0')}`);
const fmt90 = (v) => (v == null ? '–' : v.toFixed(2));
const fmtDate = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const fmtKickoff = (iso) =>
  new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
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

// Section stripes and dots sit on the (always dark) card: a near-black group color would vanish,
// so draw it in the light text color instead (black ↔ white, Beşiktaş-friendly).
function markColor(name) {
  const color = groupColor(name);
  return luminance(color) < 0.03 ? '#e7e9ee' : color;
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
  if (season === LAST30) return windowTotals(p, category);
  return { ...sum(competitionsOf(p, season, category)), stale: p.seasons?.[season]?.stale };
}

// --- history (form over time) ------------------------------------------------

const latestSeason = () => state.data.seasons[0];
const pointsOf = (p) => state.history[latestSeason()]?.[p.id] ?? [];
const isoDay = (d) => d.toISOString().slice(0, 10);

// Counts for one history point, summed over the categories in the competition filter.
function pointCounts(point, category = state.category) {
  const t = { apps: 0, starts: 0, minutes: 0, goals: 0, assists: 0 };
  for (const [cat, v] of Object.entries(point?.[1] ?? {})) {
    if (!inCategory({ category: cat }, category)) continue;
    ['apps', 'starts', 'minutes', 'goals', 'assists'].forEach((k, i) => (t[k] += v[i]));
  }
  return t;
}

// First day the "last 30 days" view can count from: 30 days ago, or when history starts if later.
function windowStart() {
  const cutoff = isoDay(new Date(Date.now() - WINDOW_DAYS * 864e5));
  const first = Object.values(state.history[latestSeason()] ?? {})
    .map((pts) => pts[0]?.[0])
    .filter(Boolean)
    .sort()[0];
  return first && first > cutoff ? first : cutoff;
}

// Change since the window start: latest point minus the last point on or before the start.
// Points are only stored when totals change, so "no point before the start" means "unchanged since".
function windowTotals(p, category = state.category) {
  const pts = pointsOf(p);
  const start = windowStart();
  const base = [...pts].reverse().find(([d]) => d <= start) ?? pts[0];
  const now = pointCounts(pts.at(-1), category);
  const was = pointCounts(base, category);
  return sum([Object.fromEntries(Object.keys(now).map((k) => [k, now[k] - was[k]]))]);
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
  return state.data.players.filter(
    (p) =>
      inGroup(p) &&
      matchesQuery(p) &&
      (state.position === 'all' || positionGroup(p) === state.position) &&
      (!state.playedOnly || totals(p).apps > 0),
  );
}

// --- URL state ----------------------------------------------------------------

// Rebuilds the view state from the URL (also on back/forward), falling back to defaults.
function readUrl() {
  const q = new URLSearchParams(location.search);
  const season = q.get('season') === LAST30 ? LAST30 : Number(q.get('season'));
  state.season = season === LAST30 || state.data.seasons.includes(season) ? season : latestSeason();
  state.category = ['club', 'league', 'cup', 'europe'].includes(q.get('comp')) ? q.get('comp') : 'club';
  state.group = q.get('group') ?? 'all';
  state.position = POSITION_GROUPS.some(([k]) => k === q.get('pos')) ? q.get('pos') : 'all';
  state.query = q.get('q') ?? '';
  state.playedOnly = q.get('played') === '1';
  state.split = q.get('split') === '1';
  state.sort = q.get('sort') ? { key: q.get('sort'), desc: q.get('dir') !== 'asc' } : { key: 'ga', desc: true };
  state.selected = new Set((q.get('compare') ?? '').split(',').filter(Boolean));
  state.player = q.get('player');
}

// Filters update the URL in place; opening or closing a player page adds a history entry,
// so the browser's back button returns to the list.
function writeUrl({ push = false } = {}) {
  const q = new URLSearchParams();
  if (state.player) q.set('player', state.player);
  if (state.season !== latestSeason()) q.set('season', state.season);
  if (state.category !== 'club') q.set('comp', state.category);
  if (state.group !== 'all') q.set('group', state.group);
  if (state.position !== 'all') q.set('pos', state.position);
  if (state.query) q.set('q', state.query);
  if (state.playedOnly) q.set('played', '1');
  if (state.split) q.set('split', '1');
  if (state.sort.key !== 'ga' || !state.sort.desc) {
    q.set('sort', state.sort.key);
    q.set('dir', state.sort.desc ? 'desc' : 'asc');
  }
  if (state.selected.size) q.set('compare', [...state.selected].join(','));
  const qs = q.toString();
  history[push ? 'pushState' : 'replaceState'](null, '', qs ? `?${qs}` : location.pathname);
}

// --- rendering ----------------------------------------------------------------

function renderHeader() {
  const { generatedAt, seasons, seasonErrors } = state.data;
  $('#updated').textContent = generatedAt
    ? `Stats last changed ${new Date(generatedAt).toLocaleString()} · checked daily`
    : 'Not updated yet';

  const hasHistory = Object.keys(state.history[latestSeason()] ?? {}).length > 0;
  const since = hasHistory ? windowStart() : null;
  $('#season-seg').innerHTML = [...seasons, ...(hasHistory ? [LAST30] : [])]
    .map((s) => {
      const label = s === LAST30 ? '30 days' : seasonLabel(s);
      const title = s === LAST30 ? ` title="Change since ${fmtDate(since)} (history starts ${fmtDate(since)} if that's later than 30 days ago)"` : '';
      return `<button data-season="${s}" aria-pressed="${s === state.season}"${title}>${label}</button>`;
    })
    .join('');
  $('#category').value = state.category;
  $('#position').value = state.position;

  // Upcoming matches for players.json "nextMatchTeams".
  $('#next-matches').innerHTML = Object.values(state.data.nextMatches ?? {})
    .filter(Boolean)
    .map((m) => `<span>Next: <b>${esc(m.home)}</b> vs <b>${esc(m.away)}</b> · ${esc(m.competition ?? '')} · ${fmtKickoff(m.date)}</span>`)
    .join('');
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
      return `<li><a class="wn-name plink" href="?player=${esc(lines[0].id)}" data-player="${esc(lines[0].id)}">${esc(lines[0].name)}</a> <span class="muted small">${esc(lines[0].team)}</span><div>${parts}</div></li>`;
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
  const age = ageOf(p);
  const sub = [p.club, p.position, age != null && `${age}`].filter(Boolean).map(esc).join(' · ');
  return `<div class="player"><div class="name"><a class="plink" href="?player=${esc(keyOf(p))}" data-player="${esc(keyOf(p))}">${esc(p.name)}</a>${badge}${stale}</div>
    <div class="sub">${sub}${moved}${tags}</div>${err}</div>`;
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
        const total = sum(withData.map((p) => totals(p)));
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

// Per-competition detail for the selected season (follows the season switch like the table).
// History has no per-competition split, so the 30-day view shows the current season's detail.
function breakdown(p, seasons = [state.season === LAST30 ? latestSeason() : state.season]) {
  return `<div class="breakdown">${seasons
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

// Cumulative goals and assists this season from history.json, as step lines (counts only change
// on match days). Follows the competition filter.
function formChart(p) {
  const pts = pointsOf(p).map(([date, v]) => ({ date, ...pointCounts([date, v]) }));
  if (pts.length < 2) {
    return `<p class="muted small">The form chart fills in as match days are recorded${pts.length ? ` (tracking since ${fmtDate(pts[0].date)})` : ''}.</p>`;
  }
  const W = 640, H = 170, L = 28, R = 12, T = 12, B = 22;
  const t0 = Date.parse(pts[0].date);
  const t1 = Math.max(Date.parse(pts.at(-1).date), Date.parse(isoDay(new Date())));
  const max = Math.max(1, ...pts.map((d) => Math.max(d.goals, d.assists)));
  const x = (date) => L + ((Date.parse(date) - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const y = (v) => T + (1 - v / max) * (H - T - B);
  const series = (key) => {
    let d = '';
    pts.forEach((pt, i) => (d += i ? ` H${x(pt.date)} V${y(pt[key])}` : `M${x(pt.date)} ${y(pt[key])}`));
    return d + ` H${x(isoDay(new Date(t1)))}`;
  };
  const ticks = [...new Set([0, Math.round(max / 2), max])];
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative goals and assists this season">
    ${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('')}
    <path d="${series('goals')}" class="line goals"/>
    <path d="${series('assists')}" class="line assists"/>
    <text x="${L}" y="${H - 6}">${fmtDate(pts[0].date)}</text>
    <text x="${W - R}" y="${H - 6}" text-anchor="end">${fmtDate(new Date(t1).toISOString())}</text>
  </svg>
  <div class="legend small"><span class="key goals"></span>Goals <span class="key assists"></span>Assists
    <span class="muted">· ${seasonLabel(latestSeason())}, cumulative</span></div>`;
}

// --- profiles -------------------------------------------------------------------

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// Profile dates look like "May 17, 1993"; parsed by hand since Date.parse on that format varies by browser.
function parseProfileDate(s) {
  const m = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4})$/.exec(s ?? '');
  if (!m || !(m[1].toLowerCase() in MONTHS)) return null;
  return new Date(Date.UTC(Number(m[3]), MONTHS[m[1].toLowerCase()], Number(m[2])));
}

const profileOf = (p) => state.profiles[p.id] ?? null;

function ageOf(p) {
  const born = parseProfileDate(profileOf(p)?.birthDate);
  if (!born) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - born.getUTCFullYear();
  if (now.getUTCMonth() < born.getUTCMonth() || (now.getUTCMonth() === born.getUTCMonth() && now.getUTCDate() < born.getUTCDate())) age--;
  return age;
}

const fmtProfileDate = (s) =>
  parseProfileDate(s)?.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) ?? s;

// Facts row on the player page; months left on the contract are shown when it ends within a year.
function profileFacts(p) {
  const pr = profileOf(p);
  if (!pr) return '';
  const age = ageOf(p);
  const expiry = parseProfileDate(pr.contractExpiry);
  const monthsLeft = expiry ? Math.round((expiry - Date.now()) / (30.44 * 864e5)) : null;
  const facts = [
    age != null && ['Age', `${age}${pr.birthDate ? ` (born ${fmtProfileDate(pr.birthDate)})` : ''}`],
    pr.citizenship && ['Nationality', pr.citizenship],
    pr.height && ['Height', pr.height],
    pr.foot && ['Foot', pr.foot],
    pr.club && ['Club', `${pr.club}${pr.joinedAt ? ` since ${fmtProfileDate(pr.joinedAt)}` : ''}`],
    pr.contractExpiry && [
      'Contract until',
      `${fmtProfileDate(pr.contractExpiry)}${monthsLeft != null && monthsLeft >= 0 && monthsLeft <= 12 ? ` · ${monthsLeft} month${monthsLeft === 1 ? '' : 's'} left` : ''}`,
    ],
  ].filter(Boolean);
  if (!facts.length) return '';
  return `<dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`;
}

function renderPlayer() {
  const card = $('#player');
  const p = state.player && state.data.players.find((x) => keyOf(x) === state.player);
  card.hidden = !p;
  for (const id of ['#whatsnew', '#overview-card', '#compare']) if (p) $(id).hidden = true;
  if (!p) {
    $('#overview-card').hidden = false;
    return;
  }

  const team = lastTeam(p);
  const tags = groupsOf(p).map((g) => `<span class="tag" style="${tagStyle(g)}">${esc(g)}</span>`).join('');
  const next = Object.entries(state.data.nextMatches ?? {}).find(([t, m]) => m && (sameClub(t, p.club ?? '') || sameClub(t, team ?? '')))?.[1];
  const periods = [...state.data.seasons, ...(pointsOf(p).length ? [LAST30] : [])];
  const head = `<tr><th>Period</th>${COLUMNS.map((c) => `<th title="${c.title}">${c.label}</th>`).join('')}</tr>`;
  const rows = periods
    .map((s) => {
      const label = s === LAST30 ? `Since ${fmtDate(windowStart())}` : seasonLabel(s);
      return `<tr><td>${label}</td>${statCells(totals(p, s), null)}</tr>`;
    })
    .join('');

  card.innerHTML = `
    <div class="card-head">
      <button class="link" id="player-back">← All players</button>
      <span class="muted small">${esc(CATEGORY_LABELS[state.category] ?? 'All club competitions')}</span>
    </div>
    <h2 class="player-title">${esc(p.name)}</h2>
    <p class="muted">${[p.fullName !== p.name && p.fullName, p.club, p.position].filter(Boolean).map(esc).join(' · ')}
      ${team && p.club && !sameClub(team, p.club) ? `<span class="moved">last played: ${esc(team)}</span>` : ''} ${tags}</p>
    ${profileFacts(p)}
    ${next ? `<p class="small">Next: <b>${esc(next.home)}</b> vs <b>${esc(next.away)}</b> · ${esc(next.competition ?? '')} · ${fmtKickoff(next.date)}</p>` : ''}
    <div class="table-wrap player-summary"><table>${head}${rows}</table></div>
    <h3>Form</h3>
    ${formChart(p)}
    <h3>By competition</h3>
    ${breakdown(p, state.data.seasons)}`;
}

function renderCompare() {
  if (state.player) return; // the player page hides the compare card
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

function render({ push = false } = {}) {
  renderHeader();
  if (state.player) {
    renderPlayer();
  } else {
    renderPlayer(); // hides the player card and shows the overview again
    renderWhatsNew();
    renderTable();
    renderCompare();
  }
  writeUrl({ push });
}

function openPlayer(id) {
  state.player = id;
  render({ push: true });
  scrollTo(0, 0);
}

// --- events -------------------------------------------------------------------

function bindEvents() {
  $('#season-seg').addEventListener('click', (e) => {
    const s = e.target.closest('button')?.dataset.season;
    if (s) {
      state.season = s === LAST30 ? LAST30 : Number(s);
      render();
    }
  });
  $('#position').addEventListener('change', (e) => {
    state.position = e.target.value;
    render();
  });
  // Player names (table and What's new) open the player page; the back link and the
  // browser's back button return to the list.
  document.addEventListener('click', (e) => {
    const link = e.target.closest('.plink');
    if (link && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      e.stopPropagation();
      openPlayer(link.dataset.player);
    }
    if (e.target.id === 'player-back') {
      state.player = null;
      render({ push: true });
    }
    // The title returns to the default view in place (no page load, so no browser caching quirks).
    if (e.target.closest('a.home') && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      history.pushState(null, '', location.pathname);
      readUrl();
      state.expanded.clear();
      state.whatsNewAll = false;
      render();
      scrollTo(0, 0);
    }
  }, true);
  addEventListener('popstate', () => {
    readUrl();
    render();
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

async function loadJson(file) {
  try {
    const res = await fetch(file, { cache: 'no-cache' });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function init() {
  const [data, hist, profiles] = await Promise.all([loadJson('data.json'), loadJson('history.json'), loadJson('profiles.json')]);
  state.data = data ?? { seasons: [], players: [] };
  state.history = hist ?? {};
  state.profiles = profiles ?? {};
  readUrl();
  bindEvents();
  render();
}

init();
