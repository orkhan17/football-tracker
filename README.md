# Player Tracker

Daily-updated dashboard of appearances, starts, minutes, goals and assists for a group of players,
split by competition (league / cup / Europe) for the current and previous season.

- **Data:** [Highlightly](https://highlightly.net/) "All Sports" API via RapidAPI, free Basic plan
  (`GET /football/players/{id}/statistics` — one call per player returns every season and competition)
- **Update:** GitHub Actions, daily 06:17 UTC, on manual dispatch, and on any push to `players.json`.
  A run only commits when stats actually changed (a timestamp-only change is skipped).
- **Hosting:** GitHub Pages from `docs/`

## Managing players

Edit `players.json`:

```json
{ "name": "Cole Palmer", "club": "Chelsea" }
```

On the next run the fetcher searches the name, checks up to 3 matching candidates against the club
(based on their last two seasons), and writes the Highlightly `id` back. If no candidate plays for that
club, the run logs what it checked and the dashboard shows the error on that player — set `id` by hand.
Removing a player = deleting the entry.

### Groups

Tag players with one or more groups; the dashboard gets a group filter (plus "Ungrouped" for the rest):

```json
{ "name": "Rafa Silva", "club": "Benfica", "id": 92407, "groups": ["Former Beşiktaş"] }
```

Pushing `players.json` runs the fetcher with `NEW_ONLY=1`: only players without data yet are fetched;
everyone else is copied with their name, club and groups refreshed. So regrouping, renaming or removing
costs no API requests, and adding a player costs only that player's lookup.

### Finding an id by hand

Automatic matching fails for nicknames (the API lists Rafa Silva only as "Rafa"), free agents, and
very common names. Look the player up and set `id` yourself:

```sh
npm run find -- "Rafa"              # search: id, short name, full name (1 request)
npm run find -- "Rafa" --clubs 3    # + recent clubs of the first 3 results (+1 request each)
npm run find -- --id 92407          # recent clubs of one id (1 request)
```

The search is fuzzy and returns at most 10 results — if the player isn't there, try the nickname,
the surname, or the full legal name. Then add `"id": 92407` to the entry and fetch just that player:
`ONLY="Rafa Silva" npm run fetch`.

## Dashboard

- **What's new:** per-competition changes from the latest run that found new stats (goals, assists,
  appearances), plus players added since. Follows the group and search filters.
- **Search** by player name, listed club, or the club they last played for.
- **Group filter**; "All players" is one list sorted across groups, or with **Split by group** one section per group with group totals.
- **Played only** hides players with no appearances for the selected season and competitions.
- **▲/▼** next to per-90 values compare with last season (both seasons need 270+ minutes).
- **Badges:** "no data yet" (not fetched), "no stats in API" (fetched, empty), "stale" (last fetch failed);
  "last played: X" when the data shows a different club than `players.json`.
- **Shareable URLs:** filters, sort and compared players are kept in the address, e.g.
  `?group=Former+Beşiktaş&season=2025&played=1&compare=92407,585872`.

## Setup

1. Push this repo to GitHub (public — Pages on free accounts requires it; the key stays a secret).
2. **Settings → Secrets and variables → Actions → New repository secret:** `RAPIDAPI_KEY`.
3. **Settings → Pages:** source = *Deploy from a branch*, branch `main`, folder `/docs`.
4. **Actions → Update stats → Run workflow** for the first fetch.

## Local

Requires Node 22+. No dependencies to install.

```sh
echo 'RAPIDAPI_KEY=...' > .env      # gitignored
npm start                           # dashboard at http://localhost:8000 (PORT=... to change)
npm run fetch                       # refresh docs/data.json (1 call per player; +2–4 to resolve a new one)
npm test                            # unit tests
SEASONS=2024,2023 npm run fetch     # override seasons (start years)
ONLY="Rafa Silva" npm run fetch     # fetch just these players (comma-separated); others keep their data
NEW_ONLY=1 npm run fetch            # fetch only players missing from data.json (0 requests after regrouping)
```

## Notes

- Free plan: 100 requests/day. A daily run uses 1 per player (~23 now), so up to ~90 players fit.
- Starts = games played − times substituted in.
- Seasons are keyed by start year (`"26/27"` → 2026). Summer tournaments reported as a calendar year
  (e.g. the 2025 Club World Cup) count toward the season that was ending (2024/25), under Cups.
- National-team games aren't provided by the API.
- Per-90 values are greyed out under 270 minutes.
- If a run fails for a player, their last good data is kept and marked "stale".
