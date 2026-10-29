// Fetches TMDB details for a movie or series and reduces them to what the page needs.

// TV genres that combine two movie genres are split, so filters work across movies and series.
const TV_GENRE_MAP = { 10759: [28, 12], 10765: [878, 14], 10768: [10752], 10762: [10751] };

export async function loadGenres(tmdb, ctx) {
  const [movie, tv] = await Promise.all([
    tmdb.get('/genre/movie/list', { language: ctx.language }, { ttlDays: 30 }),
    tmdb.get('/genre/tv/list', { language: ctx.language }, { ttlDays: 30 }),
  ]);
  const names = {};
  for (const g of [...(tv?.genres ?? []), ...(movie?.genres ?? [])]) names[g.id] = g.name;
  return names;
}

export async function loadDetails(tmdb, ctx, { type, id }) {
  const append = type === 'tv'
    ? 'aggregate_credits,videos,content_ratings,external_ids'
    : 'credits,videos,release_dates,external_ids';
  const params = { language: ctx.language, append_to_response: append, include_video_language: `${ctx.language.slice(0, 2)},en,null` };
  const d = await tmdb.get(`/${type}/${id}`, params);
  if (!d) return null;

  let { overview, tagline } = d;
  if (!overview && ctx.fallbackLanguage) {
    const fb = await tmdb.get(`/${type}/${id}`, { language: ctx.fallbackLanguage });
    overview = fb?.overview ?? '';
    tagline ||= fb?.tagline ?? '';
  }

  const genreIds = (d.genres ?? []).flatMap(g => (type === 'tv' && TV_GENRE_MAP[g.id]) || [g.id]);
  const date = (type === 'tv' ? d.first_air_date : d.release_date) || null;
  const credits = type === 'tv' ? d.aggregate_credits : d.credits;
  const crew = credits?.crew ?? [];
  const jobsOf = person => (type === 'tv' ? (person.jobs ?? []).map(j => j.job) : [person.job]);
  const crewWith = (jobs, max) =>
    unique(crew.filter(p => jobsOf(p).some(j => jobs.includes(j))).map(p => p.name)).slice(0, max);

  return {
    type,
    tmdbId: d.id,
    title: (type === 'tv' ? d.name : d.title) || '',
    originalTitle: (type === 'tv' ? d.original_name : d.original_title) || '',
    year: date ? +date.slice(0, 4) : null,
    releaseDate: date,
    runtime: type === 'tv' ? d.episode_run_time?.[0] ?? null : d.runtime || null,
    seasons: type === 'tv' ? d.number_of_seasons ?? null : undefined,
    rating: d.vote_count ? Math.round(d.vote_average * 10) / 10 : null,
    votes: d.vote_count ?? 0,
    genreIds: unique(genreIds),
    overview: overview || '',
    tagline: tagline || '',
    poster: d.poster_path || null,
    backdrop: d.backdrop_path || null,
    certification: certification(d, type, ctx.region),
    directors: type === 'tv' ? (d.created_by ?? []).map(p => p.name) : crewWith(['Director'], 3),
    writers: crewWith(['Screenplay', 'Writer', 'Story', 'Novel', 'Author'], 4),
    composers: crewWith(['Original Music Composer', 'Music'], 2),
    cast: (credits?.cast ?? []).slice(0, 12).map(p => ({
      name: p.name,
      character: type === 'tv' ? p.roles?.[0]?.character ?? '' : p.character ?? '',
      profile: p.profile_path || null,
    })),
    trailer: trailer(d.videos?.results ?? [], ctx.language.slice(0, 2)),
    imdbId: d.external_ids?.imdb_id || d.imdb_id || null,
  };
}

function certification(d, type, region) {
  if (type === 'tv') return d.content_ratings?.results?.find(r => r.iso_3166_1 === region)?.rating || null;
  const dates = d.release_dates?.results?.find(r => r.iso_3166_1 === region)?.release_dates ?? [];
  return dates.map(r => r.certification).find(Boolean) || null;
}

function trailer(videos, lang) {
  const yt = videos.filter(v => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'));
  const rank = v => (v.type === 'Trailer' ? 0 : 2) + (v.iso_639_1 === lang ? 0 : 1) + (v.official ? 0 : 0.5);
  return yt.sort((a, b) => rank(a) - rank(b))[0]?.key ?? null;
}

const unique = list => [...new Set(list)];
