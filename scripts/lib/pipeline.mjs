// Shared setup for build and resolve: config, CSV rows, TMDB client and row resolution.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRows } from './rows.mjs';
import { Tmdb } from './tmdb.mjs';
import { resolveRow } from './resolver.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function setup() {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/config.json'), 'utf8'));
  const csvFile = path.join(ROOT, config.csv);
  const csv = readRows(csvFile);
  const tmdb = new Tmdb({
    key: process.env.TMDB_API_KEY?.trim(),
    cacheFile: path.join(ROOT, '.cache/tmdb-cache.json'),
  });
  const ctx = { language: config.language, fallbackLanguage: config.fallbackLanguage, region: config.region };
  return { config, csvFile, csv, tmdb, ctx };
}

export function resolveAll(tmdb, ctx, rows) {
  return Promise.all(
    rows.map(async row => {
      try {
        return { row, result: await resolveRow(tmdb, ctx, row) };
      } catch (err) {
        if (err.fatal) throw err;
        return { row, error: err.message };
      }
    }),
  );
}
