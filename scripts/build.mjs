#!/usr/bin/env node
// Builds the static site into dist/: resolves every CSV row on TMDB, fetches details,
// writes data/movies.json and renders the HTML template.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setup, resolveAll, ROOT } from './lib/pipeline.mjs';
import { loadGenres, loadDetails } from './lib/details.mjs';

const DIST = path.join(ROOT, 'dist');

const { config, csv, tmdb, ctx } = setup();
const genreNames = await loadGenres(tmdb, ctx);
const resolved = await resolveAll(tmdb, ctx, csv.rows);

const items = new Map();
const problems = { errors: [...csv.warnings], unmatched: [], fuzzy: [] };

await Promise.all(
  resolved.flatMap(({ row, result, error }) => {
    if (error) problems.errors.push(`line ${row.line} "${row.title}": ${error}`);
    if (result?.confidence === 'fuzzy') problems.fuzzy.push({ row, label: result.label });
    if (error || !result.entries.length) {
      problems.unmatched.push(row);
      addPurchase(`unmatched-${row.line}`, { type: 'unknown', title: row.title }, row);
      return [];
    }
    const group = result.entries.length > 1 ? row.title : null;
    return result.entries.map(async entry => {
      const key = `${entry.type}-${entry.id}`;
      const details = items.get(key) ?? (await loadDetails(tmdb, ctx, entry));
      if (!details) {
        problems.errors.push(`line ${row.line} "${row.title}": TMDB ${key} not found`);
        return;
      }
      addPurchase(key, details, row, { note: entry.note, group });
    });
  }),
);

function addPurchase(key, details, row, extra = {}) {
  const item = items.get(key) ?? { key, ...details, purchases: [] };
  item.purchases.push({
    title: row.title,
    date: row.date,
    platform: row.platform,
    quality: row.quality || null,
    note: extra.note || null,
    group: extra.group || null,
  });
  items.set(key, item);
}

const list = [...items.values()].map(({ genreIds = [], ...item }) => {
  item.purchases.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
  return { ...item, genres: genreIds.map(id => genreNames[id]).filter(Boolean) };
});
list.sort((a, b) => (b.purchases[0].date ?? '').localeCompare(a.purchases[0].date ?? '') || a.title.localeCompare(b.title));

const platforms = { ...config.platforms };
for (const name of new Set(csv.rows.map(r => r.platform))) {
  platforms[name] ??= { label: name, icon: null, color: config.fallbackPlatformColor };
}

const data = { generatedAt: new Date().toISOString(), platforms, items: list };

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(path.join(DIST, 'data'), { recursive: true });
fs.cpSync(path.join(ROOT, 'src/assets'), path.join(DIST, 'assets'), { recursive: true });
const json = JSON.stringify(data);
fs.writeFileSync(path.join(DIST, 'data/movies.json'), json);
fs.writeFileSync(path.join(DIST, '.nojekyll'), '');

const version = crypto.createHash('sha1').update(json).update(fs.readFileSync(path.join(ROOT, 'src/assets/js/app.js'))).update(fs.readFileSync(path.join(ROOT, 'src/assets/css/style.css'))).digest('hex').slice(0, 10);
const vars = { title: config.title, version, count: String(list.filter(i => i.type !== 'unknown').length), lang: config.language.slice(0, 2) };
const template = fs.readFileSync(path.join(ROOT, 'src/templates/index.html'), 'utf8');
fs.writeFileSync(path.join(DIST, 'index.html'), template.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => vars[k] ?? m));

tmdb.save();
writeReport();

function writeReport() {
  const lines = [
    `## ${config.title} build`,
    '',
    `${csv.rows.length} CSV rows → ${list.length} titles on the page. TMDB requests: ${tmdb.stats.fetched} fetched, ${tmdb.stats.cached} from cache.`,
    '',
  ];
  if (problems.errors.length) lines.push('### Errors', '', ...problems.errors.map(e => `- ${e}`), '');
  if (problems.unmatched.length) {
    lines.push('### Not found on TMDB', '', 'Fix the title or set the `TMDB ID` column for these rows.', '');
    lines.push(...problems.unmatched.map(r => `- line ${r.line}: ${r.title}`), '');
  }
  if (problems.fuzzy.length) {
    lines.push('### Uncertain matches', '', 'Check these and pin the right one with the `TMDB ID` column (`npm run resolve -- --write` does it for all rows).', '');
    lines.push('| Line | CSV title | Matched |', '|---|---|---|');
    lines.push(...problems.fuzzy.map(({ row, label }) => `| ${row.line} | ${row.title} | ${label} |`), '');
  }
  const report = lines.join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n');
  console.log(report);
}
