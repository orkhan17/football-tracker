#!/usr/bin/env node
// Look up a player's Highlightly id by hand, for when automatic matching fails
// (nicknames like "Rafa", free agents, common names).
//
//   npm run find -- "Rafa"              search only (1 request)
//   npm run find -- "Rafa" --clubs 3    also show recent clubs of the first 3 results (+1 request each)
//   npm run find -- --id 92407          show one player's recent clubs (1 request)
//
// Put the chosen id in players.json: { "name": "Rafa Silva", "club": "Benfica", "id": 92407 }

import { api, getStats, latestClubs, getQuota, seasonStartYear } from './fetch.mjs';

function usage() {
  console.error('Usage: npm run find -- "<name>" [--clubs N]   or   npm run find -- --id <id>');
  process.exit(1);
}

async function clubsOf(id) {
  const stats = await getStats(id);
  const rows = stats?.perCompetition ?? [];
  if (!rows.length) return 'no stats in the API';
  // latestClubs covers the latest season and the one before it.
  const from = Math.max(...rows.map((r) => seasonStartYear(r.season) ?? -Infinity)) - 1;
  const label = `${from}/${String((from + 1) % 100).padStart(2, '0')}`;
  return `since ${label}: ${[...new Set(latestClubs(stats))].join(', ')}`;
}

async function main() {
  if (!process.env.RAPIDAPI_KEY) {
    console.error('RAPIDAPI_KEY is not set (add it to .env).');
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args.splice(i, 2)[1];
  };
  const id = flag('--id');
  const clubs = Number(flag('--clubs') ?? 0);

  if (id) {
    console.log(`${id}: ${await clubsOf(id)}`);
  } else {
    const name = args.join(' ').trim();
    if (!name) usage();
    const { data = [] } = await api('/players', { name });
    if (!data.length) console.log(`No results for "${name}". Try a nickname, the surname, or the full legal name.`);
    for (const [i, p] of data.entries()) {
      const extra = i < clubs ? `  — ${await clubsOf(p.id)}` : '';
      console.log(`${String(p.id).padStart(9)}  ${p.name}${p.fullName && p.fullName !== p.name ? ` (${p.fullName})` : ''}${extra}`);
    }
  }

  const q = getQuota();
  if (q) console.log(`\nQuota: ${q.remaining}/${q.limit} requests left today.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
