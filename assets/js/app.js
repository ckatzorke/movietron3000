import Fuse from '../vendor/fuse.min.mjs';

const IMG = 'https://image.tmdb.org/t/p/';
const LOCALE = 'de-DE';
const dateShort = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' });
const dateLong = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' });
const monthShort = new Intl.DateTimeFormat(LOCALE, { month: 'short' });
const collator = new Intl.Collator('de', { sensitivity: 'base', numeric: true });

const SORTS = [
  { key: 'purchase', label: 'Kaufdatum', desc: true, value: m => m.latest.date ?? '' },
  { key: 'title', label: 'Titel', desc: false, value: m => m.title },
  { key: 'year', label: 'Erscheinungsjahr', desc: true, value: m => m.year ?? 0 },
  { key: 'rating', label: 'Bewertung', desc: true, value: m => m.rating ?? 0 },
  { key: 'runtime', label: 'Laufzeit', desc: true, value: m => m.runtime ?? 0 },
];

const TYPE_LABELS = { movie: 'Filme', tv: 'Serien', unknown: 'Ohne Treffer' };

const emptyFilters = () => ({
  platforms: [],
  types: [],
  genres: [],
  decades: [],
  boughtYears: [],
  minRating: 0,
  uhd: false,
  person: '',
});

// Getters are re-evaluated on every access; this keeps expensive results until their inputs change.
const memo = new Map();
function remember(name, key, compute) {
  const hit = memo.get(name);
  if (hit && hit.key === key) return hit.value;
  const value = compute();
  memo.set(name, { key, value });
  return value;
}

function prepare(item) {
  const purchases = item.purchases;
  const people = [...(item.directors ?? []), ...(item.writers ?? []), ...(item.composers ?? []), ...(item.cast ?? []).map(c => c.name)];
  return {
    ...item,
    genres: item.genres ?? [],
    latest: purchases[purchases.length - 1],
    platformSet: [...new Set(purchases.map(p => p.platform))],
    boughtYears: [...new Set(purchases.map(p => p.date?.slice(0, 4)).filter(Boolean))],
    decade: item.year ? String(Math.floor(item.year / 10) * 10) : null,
    uhd: purchases.some(p => /4k|uhd/i.test(p.quality ?? '')),
    people: new Set(people),
    castNames: (item.cast ?? []).map(c => c.name),
    purchaseTitles: purchases.map(p => p.title),
  };
}

function countBy(items, pick) {
  const counts = new Map();
  for (const item of items) for (const v of [pick(item)].flat()) if (v != null) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].map(([name, count]) => ({ name, count }));
}

function niceTicks(max) {
  if (max <= 0) return [];
  const raw = max / 3;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map(f => f * pow).find(s => s >= raw));
  const ticks = [];
  for (let t = step; t <= max; t += step) ticks.push(t);
  return ticks;
}

document.addEventListener('alpine:init', () => {
  window.Alpine.data('app', () => ({
    ready: false,
    items: [],
    platforms: {},
    generatedAt: '',
    view: 'shelf',
    query: '',
    filtersOpen: false,
    sort: { key: 'purchase', desc: true },
    sorts: SORTS,
    timeGrain: 'year',
    filters: emptyFilters(),
    current: null,
    tooltip: { text: '', x: 0, y: 0 },
    pushedHash: false,

    async init() {
      try {
        const saved = localStorage.getItem('mt3000.view');
        if (saved === 'stats' || saved === 'shelf') this.view = saved;
      } catch {}
      this.$watch('view', v => {
        try { localStorage.setItem('mt3000.view', v); } catch {}
      });
      this.$watch('sort.key', key => (this.sort.desc = SORTS.find(s => s.key === key).desc));

      const res = await fetch('data/movies.json');
      const data = await res.json();
      this.platforms = data.platforms;
      this.generatedAt = data.generatedAt;
      this.items = data.items.map(prepare);
      this.fuse = new Fuse(this.items, {
        keys: [
          { name: 'title', weight: 3 },
          { name: 'originalTitle', weight: 2 },
          { name: 'purchaseTitles', weight: 2 },
          { name: 'castNames', weight: 1 },
          { name: 'directors', weight: 1 },
        ],
        threshold: 0.3,
        ignoreLocation: true,
      });
      this.ready = true;
      window.addEventListener('hashchange', () => this.syncHash());
      this.syncHash();
    },

    get stateKey() {
      return JSON.stringify([this.items.length, this.query.trim(), this.filters]);
    },

    get filtered() {
      return remember('filtered', this.stateKey, () => {
        const f = this.filters;
        const q = this.query.trim();
        const hits = q ? new Set(this.fuse.search(q).map(r => r.item.key)) : null;
        return this.items.filter(m =>
          (!hits || hits.has(m.key)) &&
          (!f.platforms.length || m.platformSet.some(p => f.platforms.includes(p))) &&
          (!f.types.length || f.types.includes(m.type)) &&
          (!f.genres.length || f.genres.every(g => m.genres.includes(g))) &&
          (!f.decades.length || f.decades.includes(m.decade)) &&
          (!f.boughtYears.length || m.boughtYears.some(y => f.boughtYears.includes(y))) &&
          (!f.minRating || (m.rating ?? 0) >= f.minRating) &&
          (!f.uhd || m.uhd) &&
          (!f.person || m.people.has(f.person)),
        );
      });
    },

    get visible() {
      return remember('visible', this.stateKey + JSON.stringify(this.sort), () => {
        const { value } = SORTS.find(s => s.key === this.sort.key);
        const dir = this.sort.desc ? -1 : 1;
        return [...this.filtered].sort((a, b) => {
          const va = value(a), vb = value(b);
          const cmp = typeof va === 'string' ? collator.compare(va, vb) : va - vb;
          return cmp * dir || collator.compare(a.title, b.title);
        });
      });
    },

    get facets() {
      return remember('facets', this.items.length, () => {
        const order = Object.keys(this.platforms);
        return {
          platforms: countBy(this.items, m => m.platformSet).sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name)),
          types: countBy(this.items, m => m.type).sort((a, b) => b.count - a.count),
          genres: countBy(this.items, m => m.genres).sort((a, b) => collator.compare(a.name, b.name)),
          decades: countBy(this.items, m => m.decade).sort((a, b) => a.name.localeCompare(b.name)),
          boughtYears: countBy(this.items, m => m.boughtYears).sort((a, b) => b.name.localeCompare(a.name)),
        };
      });
    },

    get activeFilterCount() {
      const f = this.filters;
      return ['platforms', 'types', 'genres', 'decades', 'boughtYears'].filter(k => f[k].length).length +
        (f.minRating ? 1 : 0) + (f.uhd ? 1 : 0) + (f.person ? 1 : 0);
    },

    get resultLine() {
      if (!this.ready) return 'Lade Sammlung …';
      const n = this.visible.length;
      return n === this.items.length ? `${n} Titel` : `${n} von ${this.items.length} Titeln`;
    },

    get stats() {
      return remember('stats', this.stateKey + this.timeGrain, () => this.computeStats(this.filtered));
    },

    computeStats(items) {
      const fmt1 = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
      const rated = items.filter(m => m.rating);
      const minutes = items.filter(m => m.type === 'movie').reduce((sum, m) => sum + (m.runtime ?? 0), 0);
      const order = Object.keys(this.platforms);

      const storeCounts = countBy(items, m => m.platformSet).sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
      const storeMax = Math.max(1, ...storeCounts.map(s => s.count));
      const stores = storeCounts.map(s => ({
        ...s,
        pct: (s.count / storeMax) * 100,
        share: Math.round((s.count / Math.max(1, items.length)) * 100),
      }));

      const genreCounts = countBy(items, m => m.genres).sort((a, b) => b.count - a.count || collator.compare(a.name, b.name));
      const genreMax = Math.max(1, ...genreCounts.map(g => g.count));
      const genres = genreCounts.map(g => ({ ...g, pct: (g.count / genreMax) * 100 }));

      return {
        titles: items.length.toLocaleString(LOCALE),
        hours: Math.round(minutes / 60).toLocaleString(LOCALE),
        avgRating: rated.length ? fmt1.format(rated.reduce((s, m) => s + m.rating, 0) / rated.length) : '–',
        stores,
        genres,
        timeline: this.timeline(items, order),
      };
    },

    timeline(items, order) {
      const purchases = items.flatMap(m => m.purchases).filter(p => p.date);
      const series = order.filter(name => purchases.some(p => p.platform === name));
      for (const p of purchases) if (!series.includes(p.platform)) series.push(p.platform);
      if (!purchases.length) return { series, buckets: [], ticks: [], max: 1, bulk: '' };

      const byMonth = this.timeGrain === 'month';
      const keyOf = date => (byMonth ? date.slice(0, 7) : date.slice(0, 4));
      const dates = purchases.map(p => p.date).sort();
      const keys = [];
      let [y, m] = dates[0].split('-').map(Number);
      const [lastY, lastM] = dates[dates.length - 1].split('-').map(Number);
      while (y < lastY || (y === lastY && (!byMonth || m <= lastM))) {
        keys.push(byMonth ? `${y}-${String(m).padStart(2, '0')}` : String(y));
        if (byMonth && m < 12) m++;
        else { y++; m = 1; }
      }

      const buckets = keys.map(key => ({ key, bySeries: {}, total: 0 }));
      const index = new Map(buckets.map(b => [b.key, b]));
      for (const p of purchases) {
        const b = index.get(keyOf(p.date));
        b.bySeries[p.platform] = (b.bySeries[p.platform] ?? 0) + 1;
        b.total++;
      }
      for (const b of buckets) {
        const date = new Date(`${b.key.length === 4 ? `${b.key}-01` : b.key}-01T12:00:00`);
        b.longLabel = byMonth ? `${monthShort.format(date)} ${b.key.slice(0, 4)}` : b.key;
        b.label = byMonth ? (b.key.endsWith('-01') ? b.key.slice(0, 4) : '') : b.key;
        b.segments = series.filter(s => b.bySeries[s]).map(s => ({ name: s, count: b.bySeries[s] }));
        b.tooltip = b.total
          ? `${b.longLabel}: ${b.total} ${b.total === 1 ? 'Kauf' : 'Käufe'} (${b.segments.map(s => `${this.platformLabel(s.name)} ${s.count}`).join(', ')})`
          : `${b.longLabel}: keine Käufe`;
      }

      const max = Math.max(...buckets.map(b => b.total));
      const perDay = countBy(purchases, p => p.date).sort((a, b) => b.count - a.count)[0];
      const bulk = perDay && perDay.count >= Math.max(10, purchases.length * 0.15)
        ? `Am ${this.formatDate(perDay.name, true)} sind ${perDay.count} Käufe auf einmal eingetragen, deshalb ragt dieser Zeitraum heraus.`
        : '';
      return { series, buckets, ticks: niceTicks(max), max, bulk };
    },

    toggle(group, value) {
      const list = this.filters[group];
      this.filters[group] = list.includes(value) ? list.filter(v => v !== value) : [...list, value];
    },

    resetFilters() {
      this.filters = emptyFilters();
      this.query = '';
    },

    filterPerson(name) {
      this.filters.person = name;
      this.query = '';
      this.showShelf();
    },

    filterGenre(genre) {
      if (!this.filters.genres.includes(genre)) this.filters.genres = [...this.filters.genres, genre];
      this.filtersOpen = true;
      this.showShelf();
    },

    showShelf() {
      this.$refs.dialog.open && this.$refs.dialog.close();
      this.view = 'shelf';
      this.untip();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },

    open(item) {
      this.pushedHash = true;
      location.hash = `t/${item.key}`;
    },

    syncHash() {
      const key = location.hash.match(/^#t\/(.+)$/)?.[1];
      const item = key && this.items.find(i => i.key === decodeURIComponent(key));
      const dialog = this.$refs.dialog;
      if (item) {
        this.current = item;
        if (!dialog.open) dialog.showModal();
        dialog.scrollTop = 0;
      } else if (dialog.open) {
        dialog.close();
      }
    },

    onDialogClose() {
      this.current = null;
      if (!location.hash.startsWith('#t/')) return;
      if (this.pushedHash) history.back();
      else history.replaceState(null, '', location.pathname + location.search);
      this.pushedHash = false;
    },

    onKey(event) {
      const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName);
      if (event.key === '/' && !typing && !this.$refs.dialog.open) {
        event.preventDefault();
        this.$refs.search.focus();
      }
    },

    tip(event, text) {
      const x = Math.min(event.clientX + 14, window.innerWidth - 260);
      this.tooltip = { text, x: Math.max(8, x), y: event.clientY + 16 };
    },

    untip() {
      this.tooltip.text = '';
    },

    crewRows(m) {
      const rows = m.type === 'tv'
        ? [{ label: 'Idee', names: m.directors }]
        : [{ label: 'Regie', names: m.directors }];
      rows.push({ label: 'Drehbuch', names: m.writers }, { label: 'Musik', names: m.composers });
      return rows.filter(r => r.names?.length);
    },

    img: (path, size) => `${IMG}${size}${path}`,

    platformLabel(name) {
      return this.platforms[name]?.label ?? name;
    },

    platformColor(name) {
      return this.platforms[name]?.color ?? '#7d8b93';
    },

    iconStyle(name) {
      const icon = this.platforms[name]?.icon;
      return icon ? `--icon: url(${new URL(`assets/icons/${icon}`, document.baseURI)})` : '--icon: none';
    },

    typeLabel: type => TYPE_LABELS[type] ?? type,

    hasUhd: m => m.uhd,

    formatDate(iso, long = false) {
      if (!iso) return 'unbekannt';
      const date = new Date(`${iso}T12:00:00`);
      return (long ? dateLong : dateShort).format(date);
    },

    formatRating: r => (r == null ? '' : Number(r).toLocaleString(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 })),

    formatRuntime(minutes) {
      const h = Math.floor(minutes / 60), m = minutes % 60;
      return h ? `${h} Std.${m ? ` ${m} Min.` : ''}` : `${m} Min.`;
    },

    initials: name => name.split(/\s+/).map(w => w[0]).slice(0, 2).join(''),
  }));
});
