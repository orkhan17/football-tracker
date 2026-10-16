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
