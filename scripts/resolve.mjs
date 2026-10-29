#!/usr/bin/env node
// Shows which TMDB entry every CSV row resolves to, so matches can be reviewed.
//   npm run resolve                 list rows that have no TMDB ID yet
//   npm run resolve -- --all        also list rows with an explicit ID
//   npm run resolve -- --write      write the found IDs into the CSV, pinning them
import fs from 'node:fs';
import { setup, resolveAll } from './lib/pipeline.mjs';
import { formatRefs } from './lib/resolver.mjs';
import { parseCsv, formatCsv } from './lib/csv.mjs';

const args = new Set(process.argv.slice(2));
const { csvFile, csv, tmdb, ctx } = setup();
const rows = args.has('--all') ? csv.rows : csv.rows.filter(r => !r.tmdb);
const resolved = await resolveAll(tmdb, ctx, rows);
tmdb.save();

const mark = { exact: ' ', fuzzy: '?', none: '!' };
for (const { row, result, error } of resolved) {
  const flag = error ? '!' : mark[result.confidence];
  const refs = result ? formatRefs(result.entries) : '';
  console.log(`${flag} ${String(row.line).padStart(4)}  ${row.title.padEnd(45)} ${(error ?? result.label).padEnd(60)} ${refs}`);
}
const count = c => resolved.filter(r => r.result?.confidence === c).length;
console.log(`\n${resolved.length} rows: ${count('exact')} matched, ${count('fuzzy')} uncertain (?), ${count('none') + resolved.filter(r => r.error).length} not found (!)`);

if (args.has('--write')) {
  const { header, rows: raw } = parseCsv(fs.readFileSync(csvFile, 'utf8'));
  let col = csv.index.tmdb;
  if (col < 0) {
    col = header.length;
    header.push('TMDB ID');
  }
  const byLine = new Map(resolved.filter(r => r.result?.entries.length).map(r => [r.row.line, formatRefs(r.result.entries)]));
  const out = raw.map(({ line, fields }) => {
    const f = [...fields];
    while (f.length < header.length) f.push('');
    if (!f[col] && byLine.has(line)) f[col] = byLine.get(line);
    return f;
  });
  fs.writeFileSync(csvFile, formatCsv(header, out));
  console.log(`Wrote ${byLine.size} IDs to ${csvFile}`);
}
