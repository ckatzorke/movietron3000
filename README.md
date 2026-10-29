# MovieTron 3000

A static website for my digital movie purchases (Apple, Amazon). The purchase list lives in
[`data/movies-digital.csv`](data/movies-digital.csv). A GitHub workflow looks up every title on
[TMDB](https://www.themoviedb.org/), builds the site and publishes it to the `gh-pages` branch.

## Adding a purchase

Add a line to the CSV and push to `master`:

```csv
Title;Purchase Date;Platform;TMDB ID;Quality
Heat;28.10.2026;Apple;;4K
```

| Column | Required | Notes |
|---|---|---|
| Title | yes | Searched on TMDB (German or English title both work) |
| Purchase Date | yes | `DD.MM.YYYY` |
| Platform | yes | `Apple` or `Amazon Prime`; other values work, they show without a logo (configure in `src/config.json`) |
| TMDB ID | no | Pins the row to an exact TMDB entry, see below |
| Quality | no | e.g. `4K`; shown as a badge and filterable |

Trailing empty columns can be left out.

### Title conventions

When there is no TMDB ID, the title is searched. These patterns are understood:

| Title | Meaning |
|---|---|
| `Pet Sematary (1989)`, `Superman 2025` | Year hint for remakes |
| `Fast & Furious 3` | If no movie has that exact title: part 3 of the collection, or season 3 of a series |
| `Jurassic World 1&2`, `Scream 1-3` | Several parts of a collection |
| `Alien Collection` | All parts of a collection released before the purchase date |
| `Hubert und Staller Staffel 7` | A season of a series |
| `Blade Runner (Final Cut)` | Text in parentheses is ignored for the search |

### Pinning the TMDB match

If a title matches the wrong entry, put the TMDB ID in the `TMDB ID` column. You find the ID in the
TMDB URL, e.g. `themoviedb.org/movie/603-the-matrix` → `603`.

| Value | Meaning |
|---|---|
| `603` or `movie:603` | Movie |
| `tv:4087` | Series |
| `collection:119` | All movies of a collection |
| `collection:119:1-3` | Parts 1–3 of a collection |
| `603,604,605` | Several entries for one purchase |

Every workflow run lists titles that were not found or matched with low confidence in the run summary.

## Local development

Requires Node.js 20+. There are no npm dependencies.

```sh
export TMDB_API_KEY=...      # v3 API key or v4 read access token
npm run resolve              # show which TMDB entry each unpinned row matches
npm run resolve -- --all     # include rows that already have an ID
npm run resolve -- --write   # write the matches into the TMDB ID column
npm run build                # build into dist/
npm run serve                # preview on http://localhost:8080
```

TMDB responses are cached in `.cache/` (searches 60 days, details 14 days).

## Repository layout

```
data/movies-digital.csv      purchase list
src/config.json              language, region, store names, logos and colors
src/templates/index.html     page template (Alpine.js markup)
src/assets/                  CSS, JS, icons, vendored Alpine.js and Fuse.js
scripts/build.mjs            CSV + TMDB → dist/
scripts/resolve.mjs          review and pin TMDB matches
.github/workflows/build.yml  build and publish to gh-pages
```

## GitHub setup

1. Add the repository secret **`TMDB_API_KEY`** (Settings → Secrets and variables → Actions).
2. Push to `master`. The first run creates the `gh-pages` branch.
3. Settings → Pages → Source: *Deploy from a branch*, branch `gh-pages`, folder `/ (root)`.

The workflow runs on every push to `master`, weekly to refresh ratings, and manually via *Run workflow*.

## Credits

This product uses the TMDB API but is not endorsed or certified by TMDB. Store logos from
[Simple Icons](https://simpleicons.org/) (CC0); the brands belong to their owners.
