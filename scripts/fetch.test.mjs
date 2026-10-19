import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categorize, nameMatches, clubMatches, defaultSeasons, seasonStartYear, toSeasons } from './fetch.mjs';

test('defaultSeasons keys seasons by start year', () => {
  assert.deepEqual(defaultSeasons(new Date('2026-10-17')), [2026, 2025]);
  assert.deepEqual(defaultSeasons(new Date('2027-03-01')), [2026, 2025]);
  assert.deepEqual(defaultSeasons(new Date('2026-07-01')), [2026, 2025]);
});

test('seasonStartYear', () => {
  assert.equal(seasonStartYear('26/27'), 2026);
  assert.equal(seasonStartYear('2025/2026'), 2025);
  assert.equal(seasonStartYear('2025'), 2024); // summer tournament → season that was ending
  assert.equal(seasonStartYear('?'), null);
});

test('categorize', () => {
  assert.equal(categorize({ type: 'national league', league: 'Süper Lig' }), 'league');
  assert.equal(categorize({ type: 'national cup', league: 'Türkiye Kupasi' }), 'cup');
  assert.equal(categorize({ type: 'national cup', league: 'Community Shield' }), 'cup');
  assert.equal(categorize({ type: 'international competition', league: 'UEFA Europa League Qualifying' }), 'europe');
  assert.equal(categorize({ type: 'international cup', league: 'UEFA Champions League' }), 'europe');
  assert.equal(categorize({ type: 'international competition', league: 'FIFA Club World Cup' }), 'cup');
});

test('nameMatches', () => {
  assert.ok(nameMatches('Cole Palmer', { name: 'C. Palmer', fullName: 'Cole Jermaine Palmer' }));
  assert.ok(nameMatches('Orkun Kökçü', { name: 'O. Kökçü', fullName: 'Orkun Kökçü' }));
  assert.ok(nameMatches('Orkun Kokcu', { name: 'O. Kökçü', fullName: 'Orkun Kökçü' }));
  assert.ok(nameMatches('Rodri', { name: 'Rodri', fullName: 'Rodrigo Hernández Cascante' }));
  assert.ok(!nameMatches('Cole Palmer', { name: 'B. Palmer', fullName: 'Bailey Palmer' }));
  assert.ok(!nameMatches('Orkun Kökçü', { name: 'O. Kökçü', fullName: 'Ozan Can Kökçü' }));
  assert.ok(nameMatches('Cumali Gürsel', { name: 'Cumali Gürsel', fullName: null }));
  assert.ok(nameMatches('Moatasem Al-Musrati', { name: 'Moatasem Al-Musrati', fullName: 'Al Moatasembellah Ali Mohamed Al Musrati' }));
  assert.ok(!nameMatches('Jean Onana', { name: 'Jean', fullName: 'Jean de Melo Pereira' }));
});

test('clubMatches', () => {
  assert.ok(clubMatches('Chelsea FC', 'Chelsea'));
  assert.ok(clubMatches('Beşiktaş JK', 'Besiktas'));
  assert.ok(clubMatches('SL Benfica', 'Benfica'));
  assert.ok(clubMatches('Bandırmaspor', 'Bandirma Spor'));
  assert.ok(clubMatches('Bodrumspor', 'Bodrum FK'));
  assert.ok(clubMatches('İstanbulspor', 'Istanbulspor'));
  assert.ok(clubMatches('1. FC Union Berlin', 'Union Berlin'));
  assert.ok(clubMatches('Çaykur Rizespor', 'Rizespor'));
  assert.ok(clubMatches('Gençlerbirliği SK', 'Genclerbirligi'));
  assert.ok(!clubMatches('Manchester City', 'Manchester United'));
});

test('toSeasons maps rows, derives starts, drops empty rows', () => {
  const row = (season, type, league, gamesPlayed, substitutedIn) => ({
    season, type, league, club: 'Chelsea FC', gamesPlayed, substitutedIn,
    minutesPlayed: gamesPlayed * 80, goals: 1, assists: 2,
  });
  const out = toSeasons(
    {
      perCompetition: [
        row('26/27', 'national league', 'Premier League', 6, 1),
        row('25/26', 'national cup', 'EFL Cup', 0, 0),
        row('2025', 'international competition', 'FIFA Club World Cup', 6, 0),
        row('23/24', 'national league', 'Premier League', 33, 4),
      ],
    },
    [2026, 2025],
  );
  assert.deepEqual(Object.keys(out), ['2025', '2026']);
  assert.equal(out[2026].competitions.length, 1);
  assert.equal(out[2026].competitions[0].starts, 5);
  assert.equal(out[2025].competitions.length, 0);
});

test('diffPlayers reports per-competition deltas and newly added players', async () => {
  const { diffPlayers } = await import('./fetch.mjs');
  const comp = (name, apps, goals) => ({ name, team: 'Beşiktaş JK', category: 'league', apps, starts: apps, minutes: apps * 90, goals, assists: 0 });
  const before = [
    { id: 1, name: 'A', seasons: { 2026: { competitions: [comp('Süper Lig', 5, 2)] } } },
    { id: 2, name: 'B', seasons: {} },
    { id: 3, name: 'C', seasons: { 2026: { competitions: [comp('Süper Lig', 5, 2)] } } },
  ];
  const after = [
    { id: 1, name: 'A', seasons: { 2026: { competitions: [comp('Süper Lig', 6, 3), comp('UEFA Europa League', 1, 0)] } } },
    { id: 2, name: 'B', seasons: { 2026: { competitions: [comp('Süper Lig', 1, 0)] } } },
    { id: 3, name: 'C', seasons: { 2026: { competitions: [comp('Süper Lig', 9, 9)], stale: true } } },
  ];
  const { items, added } = diffPlayers(before, after, [2026]);
  assert.deepEqual(added, ['B']);
  assert.equal(items.length, 2);
  assert.deepEqual(
    items.map((i) => [i.name, i.competition, i.apps, i.goals, i.minutes]),
    [['A', 'Süper Lig', 1, 1, 90], ['A', 'UEFA Europa League', 1, 0, 90]],
  );
  assert.deepEqual(diffPlayers(after, after, [2026]), { items: [], added: [] });
});

test('isYouthOrReserve', async () => {
  const { isYouthOrReserve } = await import('./fetch.mjs');
  assert.ok(isYouthOrReserve({ club: 'Besiktas JK U19', league: 'U19 Süper Lig' }));
  assert.ok(isYouthOrReserve({ club: 'RSCA Futures', league: 'Challenger Pro League' }));
  assert.ok(isYouthOrReserve({ club: 'Chelsea FC', league: 'Premier League International Cup U21' }));
  assert.ok(isYouthOrReserve({ club: 'Jong Ajax', league: 'Eerste Divisie' }));
  assert.ok(!isYouthOrReserve({ club: 'Beşiktaş JK', league: 'Süper Lig' }));
  assert.ok(!isYouthOrReserve({ club: 'Bayer 04 Leverkusen', league: 'Bundesliga' }));
  assert.ok(!isYouthOrReserve({ club: 'ETO FC', league: 'Nemzeti Bajnokság' }));
  assert.ok(!isYouthOrReserve({ club: 'FC Schalke 04', league: '2. Bundesliga' }));
});

test('updateHistory adds a point only when totals change', async () => {
  const { updateHistory } = await import('./fetch.mjs');
  const player = (goals) => ({
    id: 7,
    seasons: { 2026: { competitions: [{ category: 'league', apps: 5, starts: 5, minutes: 450, goals, assists: 1 }] } },
  });
  const h = {};
  assert.equal(updateHistory(h, [player(2)], 2026, '2026-10-18'), true);
  assert.equal(updateHistory(h, [player(2)], 2026, '2026-10-19'), false);
  assert.equal(updateHistory(h, [player(3)], 2026, '2026-10-20'), true);
  assert.equal(updateHistory(h, [player(4)], 2026, '2026-10-20'), true); // same day: replaced
  assert.deepEqual(h[2026][7], [
    ['2026-10-18', { league: [5, 5, 450, 2, 1] }],
    ['2026-10-20', { league: [5, 5, 450, 4, 1] }],
  ]);
  assert.equal(updateHistory(h, [{ ...player(9), error: 'x' }], 2026, '2026-10-21'), false);
});

test('nextChanges keeps, extends or replaces the change list', async () => {
  const { nextChanges } = await import('./fetch.mjs');
  const previous = { generatedAt: 'T1', changes: { since: 'T0', until: 'T1', items: [{ id: 1 }], added: ['A'] } };
  const none = { items: [], added: [] };
  assert.equal(nextChanges(previous, none, { partial: false, now: 'T2' }), previous.changes);
  assert.deepEqual(nextChanges(previous, { items: [], added: ['B'] }, { partial: true, now: 'T2' }), {
    since: 'T0', until: 'T2', items: [{ id: 1 }], added: ['A', 'B'],
  });
  assert.deepEqual(nextChanges(previous, { items: [{ id: 2 }], added: [] }, { partial: false, now: 'T2' }), {
    since: 'T1', until: 'T2', items: [{ id: 2 }], added: [],
  });
  assert.deepEqual(nextChanges({ generatedAt: 'T1' }, { items: [], added: ['B'] }, { partial: true, now: 'T2' }), {
    since: 'T1', until: 'T2', items: [], added: ['B'],
  });
});
