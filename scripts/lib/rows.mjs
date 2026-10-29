// Reads the purchase CSV into normalized rows and reports problems with individual lines.
import fs from 'node:fs';
import { parseCsv } from './csv.mjs';

const COLUMNS = {
  title: ['title', 'titel'],
  date: ['purchase date', 'kaufdatum', 'date'],
  platform: ['platform', 'plattform', 'store'],
  tmdb: ['tmdb id', 'tmdb', 'tmdb_id'],
  quality: ['quality', 'qualität'],
};

export function readRows(file) {
  const text = fs.readFileSync(file, 'utf8');
  const { header, rows } = parseCsv(text);
  const lower = header.map(h => h.toLowerCase());
  const index = Object.fromEntries(
    Object.entries(COLUMNS).map(([key, names]) => [key, lower.findIndex(h => names.includes(h))]),
  );
  for (const key of ['title', 'date', 'platform']) {
    if (index[key] < 0) throw new Error(`${file}: column "${COLUMNS[key][0]}" is missing in the header`);
  }

  const warnings = [];
  const result = rows.map(({ line, fields }) => {
    const get = key => (index[key] >= 0 ? fields[index[key]] ?? '' : '');
    const row = {
      line,
      title: get('title'),
      date: parseDate(get('date')),
      rawDate: get('date'),
      platform: get('platform'),
      tmdb: get('tmdb'),
      quality: get('quality'),
    };
    if (!row.title) warnings.push(`line ${line}: empty title`);
    if (!row.date) warnings.push(`line ${line}: cannot read purchase date "${row.rawDate}" (expected DD.MM.YYYY)`);
    return row;
  });
  return { header, index, rows: result.filter(r => r.title), warnings };
}

// DD.MM.YYYY, D.M.YYYY or DD.MM.YY -> YYYY-MM-DD
export function parseDate(value) {
  const m = value.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  const year = y.length === 2 ? `20${y}` : y;
  const iso = `${year}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}
