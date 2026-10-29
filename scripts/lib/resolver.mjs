// Maps a CSV row to one or more TMDB entries.
//
// The "TMDB ID" column pins a row explicitly (comma separated for multiple entries):
//   603                   movie 603
//   movie:603             same
//   tv:4087               TV series
//   collection:119        all movies of a collection released before the purchase date
//   collection:119:1-3    parts 1 to 3 of that collection (ordered by release date)
//
// Without an ID the title is searched. Supported title conventions:
//   "Pet Sematary (1989)", "Superman 2025"  year hint
//   "Fast & Furious 3"                      part 3 of the collection, or season 3 of a series
//   "Jurassic World 1&2", "Scream 1-3"      parts of a collection (or seasons of a series)
//   "Alien Collection"                      whole collection
//   "Hubert und Staller Staffel 7"          season of a series

const ROMAN = { ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9' };
const ARTICLES = /^(the|a|an|der|die|das)\s+/;
const COLLECTION_WORDS = /\s+(collection|filmreihe|reihe|trilogie|trilogy|saga)$/i;

export function normalize(text = '') {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’‘`´]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .map(w => ROMAN[w] ?? w)
    .join(' ')
    .replace(ARTICLES, '');
}

const compact = text => normalize(text).replaceAll(' ', '');

export function parseRefs(value) {
  if (!value?.trim()) return null;
  return value.split(/[,|]/).map(token => {
    const t = token.trim().toLowerCase();
    let m;
    if ((m = t.match(/^(?:movie:)?(\d+)$/))) return { type: 'movie', id: +m[1] };
    if ((m = t.match(/^tv:(\d+)$/))) return { type: 'tv', id: +m[1] };
    if ((m = t.match(/^collection:(\d+)(?::(\d+)-(\d+))?$/))) {
      return { type: 'collection', id: +m[1], range: m[2] ? [+m[2], +m[3]] : null };
    }
    throw new Error(`invalid TMDB ID "${token.trim()}"`);
  });
}

export function parseTitle(title) {
  let t = title.trim();
  let year = null;
  // parenthesised year is a hint, any other parenthesised text ("Final Cut") is noise
  t = t.replace(/\s*\(([^)]*)\)/g, (_, inner) => {
    if (/^(19|20)\d\d$/.test(inner.trim())) year = +inner.trim();
    return '';
  }).trim();

  let season = null;
  let m = t.match(/^(.*?)\s+(?:staffel|season)\s+(\d+)$/i);
  if (m) [t, season] = [m[1], +m[2]];

  let all = false;
  if (COLLECTION_WORDS.test(t)) {
    t = t.replace(COLLECTION_WORDS, '');
    all = true;
  }

  let range = null;
  m = t.match(/^(.*?)\s+(\d{1,2})\s*(?:-|–|\+|&)\s*(\d{1,2})$/);
  if (m) [t, range] = [m[1], [+m[2], +m[3]]];

  let number = null;
  let base = t;
  m = t.match(/^(.*\D)\s+(\d{1,2})$/);
  if (m && !range && !all) [base, number] = [m[1], +m[2]];

  const queries = [t];
  m = t.match(/^(.+?)\s+((?:19|20)\d\d)$/);
  if (m) {
    year ??= +m[2];
    queries.unshift(m[1]);
  }
  // TMDB search finds nothing for some titles when they contain a spaced dash
  if (/\s[-–]\s/.test(t)) queries.push(t.replace(/\s+[-–]\s+/g, ' '));
  // halves of "Title - Subtitle" help finding candidates but never count as an exact match
  const parts = t.split(/\s+-\s+|:\s+/).filter(part => part !== t && part.length > 3);
  return { base: range || all ? t : base, queries: [...new Set(queries)], parts, year, season, all, range, number };
}

function releaseDate(entry) {
  return entry.release_date || entry.first_air_date || '';
}

function scoreCandidate(c, queries, parts, { year, purchaseDate, preferTv }) {
  const names = [c.title ?? c.name, c.original_title ?? c.original_name].filter(Boolean).map(compact);
  const date = releaseDate(c);
  let score = Math.log10(1 + (c.vote_count || 0)) * 10;
  let exact = false;
  let prefix = false;
  for (const q of queries.map(compact)) {
    if (names.includes(q)) exact = true;
    else if (names.some(n => n.startsWith(q))) prefix = true;
  }
  const partial = !exact && !prefix && parts.map(compact).some(p => names.some(n => n === p || n.startsWith(p)));
  if (exact) score += 60;
  else if (prefix) score += 20;
  else if (partial) score += 10;
  if (year && date.startsWith(String(year))) score += 80;
  if (!date) score -= 30;
  // compared by year: many rows carry a placeholder date like 01.01.2021
  else if (purchaseDate && date.slice(0, 4) > purchaseDate.slice(0, 4)) score -= 200;
  if (c.media === 'tv') score += preferTv ? 40 : -10;
  return { ...c, score, exact, prefix };
}

async function search(tmdb, ctx, queries, opts, parts = []) {
  const lookups = [];
  for (const query of [...queries, ...parts]) {
    lookups.push(tmdb.get('/search/movie', { query, language: ctx.language }, { ttlDays: 60 }).then(r => tag(r, 'movie')));
    lookups.push(tmdb.get('/search/tv', { query, language: ctx.language }, { ttlDays: 60 }).then(r => tag(r, 'tv')));
    if (opts.year) {
      lookups.push(
        tmdb.get('/search/movie', { query, language: ctx.language, primary_release_year: opts.year }, { ttlDays: 60 })
          .then(r => tag(r, 'movie')),
      );
    }
  }
  const seen = new Map();
  for (const c of (await Promise.all(lookups)).flat()) seen.set(`${c.media}-${c.id}`, c);
  return [...seen.values()].map(c => scoreCandidate(c, queries, parts, opts)).sort((a, b) => b.score - a.score);
}

const tag = (res, media) => (res?.results ?? []).slice(0, 10).map(r => ({ ...r, media }));

async function findCollection(tmdb, ctx, base) {
  const res = await tmdb.get('/search/collection', { query: base, language: ctx.language }, { ttlDays: 60 });
  const wanted = compact(base);
  const stripped = r => compact((r.name ?? '').replace(COLLECTION_WORDS, ''));
  const results = res?.results ?? [];
  const pick =
    results.find(r => stripped(r) === wanted || compact((r.original_name ?? '').replace(COLLECTION_WORDS, '')) === wanted) ??
    results.find(r => stripped(r).startsWith(wanted));
  return pick ? tmdb.get(`/collection/${pick.id}`, { language: ctx.language }) : null;
}

// Released parts of a collection, ordered by release date. If the collection is broader than
// the searched name ("Jurassic World" inside "Jurassic Park"), only parts named like it count.
export function collectionParts(collection, purchaseDate, base) {
  if (!collection) return [];
  const limit = purchaseDate ?? new Date().toISOString().slice(0, 10);
  let parts = (collection.parts ?? [])
    .filter(p => p.release_date && p.release_date <= limit)
    .sort((a, b) => a.release_date.localeCompare(b.release_date));
  if (base) {
    const wanted = compact(base);
    if (!compact(collection.name ?? '').startsWith(wanted)) {
      const named = parts.filter(p => [p.title, p.original_title].some(n => compact(n).startsWith(wanted)));
      if (named.length) parts = named;
    }
  }
  return parts;
}

// Movies whose title starts with the name, oldest first: finds "Jurassic World" films that TMDB
// files inside the broader "Jurassic Park" collection.
async function titleSeries(tmdb, ctx, base, purchaseDate) {
  const res = await tmdb.get('/search/movie', { query: base, language: ctx.language }, { ttlDays: 60 });
  const wanted = compact(base);
  const limit = (purchaseDate ?? new Date().toISOString()).slice(0, 4);
  return (res?.results ?? [])
    .filter(c => c.vote_count >= 100 && c.release_date && c.release_date.slice(0, 4) <= limit)
    .filter(c => [c.title, c.original_title].some(n => compact(n).startsWith(wanted)))
    .sort((a, b) => a.release_date.localeCompare(b.release_date));
}

function pickParts(parts, range) {
  return range ? parts.slice(range[0] - 1, range[1]) : parts;
}

const seasonNote = (from, to = from) => (from === to ? `Staffel ${from}` : `Staffel ${from}–${to}`);

const describe = c => `${c.title ?? c.name} (${releaseDate(c).slice(0, 4) || '?'})`;

/**
 * @returns {{ entries: {type, id, note?}[], method: 'explicit'|'auto', confidence: 'exact'|'fuzzy'|'none', label: string }}
 */
export async function resolveRow(tmdb, ctx, row) {
  const parsed = parseTitle(row.title);
  const explicit = parseRefs(row.tmdb);
  if (explicit) {
    const entries = [];
    for (const ref of explicit) {
      if (ref.type === 'collection') {
        const col = await tmdb.get(`/collection/${ref.id}`, { language: ctx.language });
        if (!col) throw new Error(`collection ${ref.id} not found`);
        entries.push(...pickParts(collectionParts(col, row.date), ref.range).map(p => ({ type: 'movie', id: p.id })));
      } else {
        const note = ref.type === 'tv' && (parsed.season ?? parsed.number) ? seasonNote(parsed.season ?? parsed.number) : undefined;
        entries.push({ type: ref.type, id: ref.id, note });
      }
    }
    return { entries, method: 'explicit', confidence: 'exact', label: `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}` };
  }

  const opts = { year: parsed.year, purchaseDate: row.date, preferTv: parsed.season != null };

  if (parsed.all || parsed.range) {
    const col = await findCollection(tmdb, ctx, parsed.base);
    const parts = pickParts(collectionParts(col, row.date, parsed.base), parsed.range);
    if (parts.length) {
      return {
        entries: parts.map(p => ({ type: 'movie', id: p.id })),
        method: 'auto',
        confidence: 'exact',
        label: `${col.name}: ${parts.map(describe).join(', ')}`,
      };
    }
    if (parsed.range) {
      const series = pickParts(await titleSeries(tmdb, ctx, parsed.base, row.date), parsed.range);
      if (series.length === parsed.range[1] - parsed.range[0] + 1) {
        return { entries: series.map(p => ({ type: 'movie', id: p.id })), method: 'auto', confidence: 'fuzzy', label: series.map(describe).join(', ') };
      }
      const show = (await search(tmdb, ctx, [parsed.base], { ...opts, preferTv: true })).find(c => c.media === 'tv' && c.exact);
      if (show) {
        return {
          entries: [{ type: 'tv', id: show.id, note: seasonNote(...parsed.range) }],
          method: 'auto',
          confidence: 'exact',
          label: `${describe(show)}, ${seasonNote(...parsed.range)}`,
        };
      }
    }
  }

  const candidates = await search(tmdb, ctx, parsed.queries, opts, parsed.parts);
  const best = candidates[0];
  const entryOf = c => ({
    type: c.media,
    id: c.id,
    note: c.media === 'tv' && parsed.season ? seasonNote(parsed.season) : undefined,
  });
  if (best?.exact) return { entries: [entryOf(best)], method: 'auto', confidence: 'exact', label: describe(best) };

  if (parsed.number) {
    if (best?.prefix && best.media === 'movie') {
      return { entries: [entryOf(best)], method: 'auto', confidence: 'exact', label: describe(best) };
    }
    const col = await findCollection(tmdb, ctx, parsed.base);
    const part = collectionParts(col, row.date, parsed.base)[parsed.number - 1];
    if (part) return { entries: [{ type: 'movie', id: part.id }], method: 'auto', confidence: 'exact', label: `${col.name}: ${describe(part)}` };
    const sequel = (await titleSeries(tmdb, ctx, parsed.base, row.date))[parsed.number - 1];
    if (sequel) return { entries: [{ type: 'movie', id: sequel.id }], method: 'auto', confidence: 'fuzzy', label: describe(sequel) };
    const show =(await search(tmdb, ctx, [parsed.base], { ...opts, preferTv: true })).find(c => c.media === 'tv' && c.exact);
    if (show) {
      return {
        entries: [{ type: 'tv', id: show.id, note: seasonNote(parsed.number) }],
        method: 'auto',
        confidence: 'exact',
        label: `${describe(show)}, ${seasonNote(parsed.number)}`,
      };
    }
  }

  if (best) return { entries: [entryOf(best)], method: 'auto', confidence: 'fuzzy', label: describe(best) };
  return { entries: [], method: 'auto', confidence: 'none', label: 'no match' };
}

// Serializes resolved entries back into the "TMDB ID" column format.
export function formatRefs(entries) {
  return entries.map(e => (e.type === 'tv' ? `tv:${e.id}` : String(e.id))).join(',');
}
