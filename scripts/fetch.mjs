#!/usr/bin/env node
// Weekly stats fetcher: reads players.json, pulls per-competition stats from
// Highlightly (via RapidAPI), and writes docs/data.json for the static dashboard.
//
// Env:
//   RAPIDAPI_KEY       (required) RapidAPI key subscribed to Highlightly "All Sports"
//   SEASONS            optional, start years, e.g. "2025,2024" (default: current + previous)
//   ONLY               optional, comma-separated player names to fetch; others keep their last data
//   NEW_ONLY           optional, fetch only players missing from data.json (used when players.json is pushed)
//   REQUEST_DELAY_MS   optional, pause between calls (default 1500)
//   API_BASE           optional, for testing against a mock

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLAYERS_FILE = path.join(ROOT, 'players.json');
const DATA_FILE = path.join(ROOT, 'docs', 'data.json');

const API_BASE = process.env.API_BASE ?? 'https://sport-highlights-api.p.rapidapi.com/football';
const API_KEY = process.env.RAPIDAPI_KEY;
const DELAY_MS = Number(process.env.REQUEST_DELAY_MS ?? 1500);
const MAX_CANDIDATES = 3; // stats lookups spent disambiguating a name

export class ApiError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind; // 'quota' | 'auth' | 'other'
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;
let callCount = 0;
let quota = null; // from RapidAPI rate-limit headers on the latest response
export const getQuota = () => quota;

export async function api(endpoint, params = {}, attempt = 1) {
  const wait = lastCall + DELAY_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  callCount++;

  const url = new URL(API_BASE.replace(/\/$/, '') + endpoint);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers = { 'x-rapidapi-key': API_KEY };
  if (url.hostname.endsWith('rapidapi.com')) headers['x-rapidapi-host'] = url.hostname;

  const res = await fetch(url, { headers });
  const remaining = res.headers.get('x-ratelimit-requests-remaining');
  if (remaining !== null) {
    quota = {
      remaining: Number(remaining),
      limit: Number(res.headers.get('x-ratelimit-requests-limit')),
      resetSeconds: Number(res.headers.get('x-ratelimit-requests-reset')),
    };
  }
  if (res.ok) return res.json();

  const text = await res.text();
  let msg;
  try {
    msg = JSON.parse(text).message;
  } catch {}
  msg = `HTTP ${res.status} for ${url.pathname}: ${msg ?? text.slice(0, 200)}`;
  if (res.status === 429) {
    // Per-second throttling clears quickly; a daily quota doesn't.
    if (attempt < 3 && !/quota|exceeded the (daily|monthly)/i.test(msg)) {
      await sleep(5000 * attempt);
      return api(endpoint, params, attempt + 1);
    }
    throw new ApiError(msg, 'quota');
  }
  throw new ApiError(msg, res.status === 401 || res.status === 403 ? 'auth' : 'other');
}

export function defaultSeasons(now = new Date()) {
  // European seasons start in summer; a season is keyed by its start year.
  const current = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return [current, current - 1];
}

// "26/27" → 2026. A bare calendar year ("2025", e.g. the Club World Cup played
// June–July 2025) is counted in the season that was ending, i.e. 2024.
export function seasonStartYear(label) {
  const split = /^(\d{2}|\d{4})\/(\d{2}|\d{4})$/.exec(label);
  if (split) return split[1].length === 2 ? 2000 + Number(split[1]) : Number(split[1]);
  if (/^\d{4}$/.test(label)) return Number(label) - 1;
  return null;
}

export function categorize(row) {
  if (/Club World Cup/i.test(row.league)) return 'cup';
  if (row.type === 'national league') return 'league';
  if (row.type === 'national cup') return 'cup';
  if (/international/i.test(row.type)) return 'europe';
  return null;
}

export const normalize = (s) =>
  s.normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/ı/g, 'i').toLowerCase().replace(/[^a-z\s.-]/g, '').trim();

const tokens = (s) => normalize(s).split(/[\s-]+/).filter(Boolean);

// Short names look like "C. Palmer" or "Rodri"; match them against a full name.
export function shortNameMatches(fullName, shortName) {
  const wanted = tokens(fullName);
  const parts = tokens(shortName);
  if (!parts.length) return false;
  return parts.every((t) => {
    if (/^[a-z]\.$/.test(t)) return wanted.some((w) => w[0] === t[0]);
    return wanted.includes(t.replace(/\.$/, ''));
  });
}

// "Cole Palmer" matches "Cole Jermaine Palmer"; not "Bailey Palmer". Without a full-name match,
// a short name with initials is only trusted when there is no full name ("O. Kökçü" is both
// Orkun and Ozan Can), and one without initials must cover the whole wanted name ("Rodri", not "Jean").
export function nameMatches(wanted, candidate) {
  const want = tokens(wanted);
  const have = tokens(candidate.fullName ?? '');
  if (have.length && want.every((t) => have.includes(t))) return true;
  const short = candidate.name ?? '';
  if (/(^|\s)\p{L}\./u.test(short)) return !have.length && shortNameMatches(wanted, short);
  const shortTokens = tokens(short);
  return want.every((t) => shortTokens.includes(t));
}

const CLUB_NOISE = new Set(['fc', 'cf', 'afc', 'fk', 'sk', 'jk', 'sl', 'ac', 'as', 'sc', 'pfc', 'club', 'kulubu', 'the']);
// Spaces and a trailing "spor" are dropped: "Bandirma Spor" ≈ "Bandırmaspor", "Bodrum FK" ≈ "Bodrumspor".
const clubKey = (s) =>
  tokens(s)
    .filter((t) => !CLUB_NOISE.has(t) && t !== 'spor')
    .join('')
    .replace(/spor$/, '');

export function clubMatches(a, b) {
  const x = clubKey(a);
  const y = clubKey(b);
  return Boolean(x && y) && (x.includes(y) || y.includes(x));
}

export const latestClubs = (stats) => {
  const rows = stats.perCompetition ?? [];
  const latest = Math.max(...rows.map((r) => seasonStartYear(r.season) ?? -Infinity));
  return rows.filter((r) => seasonStartYear(r.season) >= latest - 1).map((r) => r.club);
};

export async function getStats(id) {
  const res = await api(`/players/${id}/statistics`);
  return Array.isArray(res) ? res[0] : res;
}

// Returns { id, stats } so the stats call made while disambiguating isn't repeated.
async function resolvePlayer(player) {
  const { data = [] } = await api('/players', { name: player.name });
  const candidates = data.filter((c) => nameMatches(player.name, c)).slice(0, MAX_CANDIDATES);
  if (!candidates.length) throw new Error(`No player named "${player.name}" found`);

  const checked = [];
  for (const c of candidates) {
    const stats = await getStats(c.id);
    const clubs = [...new Set(latestClubs(stats ?? {}))];
    if (clubs.some((club) => clubMatches(club, player.club))) return { id: c.id, stats };
    checked.push({ id: c.id, stats, label: `${c.fullName ?? c.name} (id ${c.id}, ${clubs.join('/') || 'no recent club'})` });
  }
  // A unique name is enough when the club can't confirm it (free agent, retired, no games for the new club yet).
  if (checked.length === 1) {
    console.warn(`${player.name}: club "${player.club}" not confirmed by recent stats; using only name match ${checked[0].label}`);
    return checked[0];
  }
  throw new Error(
    `No "${player.name}" found at ${player.club}; checked ${checked.map((c) => c.label).join(', ')}. Set "id" in players.json.`,
  );
}

const COUNTS = ['apps', 'starts', 'minutes', 'goals', 'assists'];
const hasData = (p) => Object.values(p?.seasons ?? {}).some((s) => !s.stale);

// What changed between two data.json player lists: per-competition deltas for players that had
// data before, and the names of players that got data for the first time. Stale entries are skipped.
export function diffPlayers(before, after, seasons) {
  const prevById = new Map(before.filter((p) => p.id).map((p) => [p.id, p]));
  const items = [];
  const added = [];
  for (const p of after) {
    if (!hasData(p)) continue;
    const prev = prevById.get(p.id);
    if (!hasData(prev)) {
      added.push(p.name);
      continue;
    }
    for (const season of seasons) {
      const now = p.seasons[season];
      const was = prev.seasons[season];
      if (!now || now.stale || was?.stale) continue;
      const key = (c) => `${c.name}|${c.team}`;
      const old = new Map((was?.competitions ?? []).map((c) => [key(c), c]));
      for (const c of now.competitions) {
        const o = old.get(key(c));
        const delta = Object.fromEntries(COUNTS.map((k) => [k, c[k] - (o?.[k] ?? 0)]));
        if (COUNTS.some((k) => delta[k] !== 0)) {
          items.push({ id: p.id, name: p.name, season, competition: c.name, team: c.team, category: c.category, ...delta });
        }
      }
    }
  }
  return { items, added };
}

export function toSeasons(stats, seasons) {
  const out = Object.fromEntries(seasons.map((s) => [s, { competitions: [] }]));
  for (const row of stats?.perCompetition ?? []) {
    const season = seasonStartYear(row.season);
    const category = categorize(row);
    if (!out[season] || !category || !row.gamesPlayed) continue;
    out[season].competitions.push({
      name: row.league,
      category,
      team: row.club,
      apps: row.gamesPlayed,
      starts: Math.max(0, row.gamesPlayed - (row.substitutedIn ?? 0)),
      minutes: row.minutesPlayed ?? 0,
      goals: row.goals ?? 0,
      assists: row.assists ?? 0,
    });
  }
  return out;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function main() {
  if (!API_KEY) {
    console.error('RAPIDAPI_KEY is not set.');
    process.exit(1);
  }
  const seasons = process.env.SEASONS ? process.env.SEASONS.split(',').map(Number) : defaultSeasons();
  const playersDoc = await readJson(PLAYERS_FILE, { players: [] });
  const previous = await readJson(DATA_FILE, { players: [] });
  const previousById = new Map(previous.players.filter((p) => p.id).map((p) => [p.id, p]));
  // ONLY="Name A,Name B" fetches just those players; NEW_ONLY=1 fetches just players with no data yet.
  // Everyone else is copied from the last data.json, with name/club/groups refreshed from players.json.
  const only = process.env.ONLY ? new Set(process.env.ONLY.split(',').map((n) => normalize(n))) : null;
  const newOnly = Boolean(process.env.NEW_ONLY);

  const out = [];
  const fetched = [];
  let playersChanged = false;
  let stopReason = null;

  for (const player of playersDoc.players) {
    const meta = { name: player.name, club: player.club, groups: player.groups ?? [] };
    const old = previousById.get(player.id);
    const skip = only ? !only.has(normalize(player.name)) : newOnly && Boolean(old);
    if (skip) {
      out.push({ ...(old ?? { id: player.id ?? null, seasons: {} }), ...meta });
      continue;
    }
    const entry = { ...meta, id: player.id ?? null, seasons: {} };
    out.push(entry);
    fetched.push(entry);
    if (stopReason) {
      entry.error = `Skipped: ${stopReason}`;
    } else {
      try {
        let stats;
        if (entry.id) {
          stats = await getStats(entry.id);
        } else {
          ({ id: entry.id, stats } = await resolvePlayer(player));
          player.id = entry.id;
          playersChanged = true;
          console.log(`Resolved ${player.name} → ${entry.id}`);
        }
        entry.fullName = stats?.fullName ?? null;
        entry.seasons = toSeasons(stats, seasons);
      } catch (err) {
        if (err.kind === 'quota') stopReason = 'request quota reached';
        if (err.kind === 'auth') stopReason = 'API key rejected';
        entry.error = err.message;
        console.error(`${player.name}: ${err.message}`);
      }
    }

    // Keep last good data when this run couldn't fetch the player.
    const last = previousById.get(entry.id);
    if (entry.error && last) {
      for (const season of seasons) {
        if (last.seasons?.[season]) entry.seasons[season] = { ...last.seasons[season], stale: true };
      }
      entry.fullName ??= last.fullName;
    }
  }

  // A run with no new stats keeps the previous change list, so data.json differs only in
  // generatedAt and the workflow skips the commit.
  const now = new Date().toISOString();
  const { items, added } = diffPlayers(previous.players, out, seasons);
  const changes =
    items.length || added.length ? { since: previous.generatedAt ?? null, until: now, items, added } : (previous.changes ?? null);

  if (playersChanged) await writeFile(PLAYERS_FILE, JSON.stringify(playersDoc, null, 2) + '\n');
  await writeFile(DATA_FILE, JSON.stringify({ generatedAt: now, seasons, groupColors: playersDoc.groupColors ?? {}, changes, players: out }, null, 2) + '\n');
  if (items.length || added.length) console.log(`Changes: ${items.length} stat lines, ${added.length} newly added players.`);

  if (only && fetched.length < only.size) console.warn(`ONLY matched ${fetched.length} of ${only.size} names in players.json.`);
  console.log(`Done: ${fetched.length} of ${out.length} players fetched, ${callCount} API calls.`);
  if (quota) {
    const reset = new Date(Date.now() + quota.resetSeconds * 1000).toISOString().slice(0, 16).replace('T', ' ');
    console.log(`Quota: ${quota.remaining}/${quota.limit} requests left, resets ${reset} UTC.`);
  }
  if (fetched.length && fetched.every((p) => p.error)) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
