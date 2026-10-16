# Player Tracker

Weekly-updated dashboard of appearances, starts, minutes, goals and assists for a group of players,
split by competition (league / cup / Europe) for the current and previous season.

- **Data:** [Highlightly](https://highlightly.net/) "All Sports" API via RapidAPI, free Basic plan
  (`GET /football/players/{id}/statistics` — one call per player returns every season and competition)
- **Update:** GitHub Actions, Mondays 06:00 UTC, on manual dispatch, and on any push to `players.json`
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
```

## Notes

- Free plan: 100 requests/day. A weekly run for 20 players uses ~20.
- Starts = games played − times substituted in.
- Seasons are keyed by start year (`"26/27"` → 2026). Summer tournaments reported as a calendar year
  (e.g. the 2025 Club World Cup) count toward the season that was ending (2024/25), under Cups.
- National-team games aren't provided by the API.
- Per-90 values are greyed out under 270 minutes.
- If a run fails for a player, their last good data is kept and marked "stale".
