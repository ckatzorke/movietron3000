// Small TMDB client with a file cache, retries and a concurrency limit.
import fs from 'node:fs';
import path from 'node:path';

const API = 'https://api.themoviedb.org/3';
const DAY = 24 * 60 * 60 * 1000;

export class Tmdb {
  constructor({ key, cacheFile, concurrency = 8 }) {
    if (!key) throw new Error('TMDB_API_KEY is not set');
    // v4 read access tokens are JWTs, v3 keys are 32 hex chars
    this.bearer = key.length > 40 ? key : null;
    this.key = key;
    this.cacheFile = cacheFile;
    this.cache = {};
    this.stats = { cached: 0, fetched: 0 };
    this.active = 0;
    this.queue = [];
    this.concurrency = concurrency;
    if (cacheFile && fs.existsSync(cacheFile)) {
      try {
        this.cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      } catch {
        console.warn(`Ignoring unreadable cache ${cacheFile}`);
      }
    }
  }

  save() {
    if (!this.cacheFile) return;
    fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
    fs.writeFileSync(this.cacheFile, JSON.stringify(this.cache));
  }

  async get(endpoint, params = {}, { ttlDays = 14 } = {}) {
    const query = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').sort(),
    ).toString();
    const cacheKey = `${endpoint}?${query}`;
    const hit = this.cache[cacheKey];
    if (hit && Date.now() - hit.t < ttlDays * DAY) {
      this.stats.cached++;
      return hit.d;
    }
    const data = await this.limit(() => this.fetch(endpoint, query));
    this.stats.fetched++;
    this.cache[cacheKey] = { t: Date.now(), d: data };
    return data;
  }

  async fetch(endpoint, query, attempt = 0) {
    const auth = this.bearer ? '' : `${query ? '&' : ''}api_key=${this.key}`;
    const url = `${API}${endpoint}?${query}${auth}`;
    const headers = { accept: 'application/json' };
    if (this.bearer) headers.authorization = `Bearer ${this.bearer}`;

    let res;
    try {
      res = await fetch(url, { headers });
    } catch (err) {
      if (attempt < 4) return this.retry(endpoint, query, attempt, 1000);
      throw err;
    }
    if (res.ok) return res.json();
    if (res.status === 404) return null;
    if (res.status === 401) {
      throw Object.assign(new Error('TMDB rejected the API key (401). Check the TMDB_API_KEY secret.'), { fatal: true });
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const wait = Number(res.headers.get('retry-after')) * 1000 || 1000 * 2 ** attempt;
      return this.retry(endpoint, query, attempt, wait);
    }
    throw new Error(`TMDB ${res.status} for ${endpoint}?${query}`);
  }

  async retry(endpoint, query, attempt, wait) {
    await new Promise(r => setTimeout(r, wait));
    return this.fetch(endpoint, query, attempt + 1);
  }

  limit(task) {
    return new Promise((resolve, reject) => {
      const run = async () => {
        this.active++;
        try {
          resolve(await task());
        } catch (err) {
          reject(err);
        } finally {
          this.active--;
          this.queue.shift()?.();
        }
      };
      if (this.active < this.concurrency) run();
      else this.queue.push(run);
    });
  }
}
