import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = fs.existsSync(path.join(PIPELINE_DIR, 'app', 'build.gradle.kts'))
  ? PIPELINE_DIR
  : path.resolve(PIPELINE_DIR, '..');
const DATA_DIR = fs.existsSync(path.join(PIPELINE_DIR, 'data'))
  ? path.join(PIPELINE_DIR, 'data')
  : PIPELINE_DIR;

function readJsonMaybeGz(gzPath, jsonPath) {
  if (fs.existsSync(gzPath)) {
    return JSON.parse(zlib.gunzipSync(fs.readFileSync(gzPath)).toString('utf8'));
  }
  return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
}

function writeJsonGz(gzPath, data) {
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(data), 'utf8'), { level: 9 });
  fs.writeFileSync(gzPath, gz);
}

const CATALOG_GZ_PATH = path.join(DATA_DIR, 'hamechizdan_full_catalog.json.gz');
const CATALOG_JSON_PATH = path.join(PIPELINE_DIR, 'hamechizdan_full_catalog.json');
const ITOONS_GZ_PATH = path.join(DATA_DIR, 'itoons_packs_resolved.json.gz');
const ITOONS_JSON_PATH = path.join(PIPELINE_DIR, 'itoons-raw', 'itoons_packs_resolved.json');
const WRITE_VERBOSE_ARCHIVE = process.env.WRITE_VERBOSE_ARCHIVE === 'true';

const TOKEN = process.env.TMDB_BEARER_TOKEN || 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJjZjdhNGFiZWZkZTU4MzVjNTM5OTNhNDcyYTM0YmViMSIsIm5iZiI6MTc5MjUyNDQxMi4zNjIsInN1YiI6IjZhZDdjMDdjMjEyNGYwMDMxZTdjZTI3NCIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.Ozv3z64IDDNM_0LRnOvUOSjBy0iIgf3_txUOMBjYvrc';

const genreMap = {
  16: 'Animation',
  10751: 'Family',
  10762: 'Kids',
  10759: 'Action & Adventure',
  12: 'Adventure',
  28: 'Action',
  35: 'Comedy',
  18: 'Drama',
  14: 'Fantasy',
  10765: 'Sci-Fi & Fantasy',
  878: 'Science Fiction',
  10402: 'Music',
  9648: 'Mystery',
  99: 'Documentary',
  10770: 'TV Movie',
};

const langFolderMap = {
  'انگلیسی': 'English (انگلیسی)',
  'چینی': 'Chinese (چینی)',
  'فرانسوی': 'French (فرانسوی)',
  'آلمانی': 'German (آلمانی)',
  'عربی': 'Arabic (عربی)',
};

const tmdbLangCodeMap = {
  'فرانسوی': 'fr-FR',
  'آلمانی': 'de-DE',
  'چینی': 'zh-CN',
  'عربی': 'ar-SA',
};

function sanitizeFileName(name) {
  return (name || '')
    .replace(/[\/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeStr(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’`"_.,!?:;()\[\]\-–—\/\\&+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function similarityScore(a, b) {
  const s1 = normalizeStr(a);
  const s2 = normalizeStr(b);
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1.0;
  if (s1.replace(/\s+/g, '') === s2.replace(/\s+/g, '')) return 0.98;

  const w1 = s1.split(' ').filter((w) => w.length > 1);
  const w2 = s2.split(' ').filter((w) => w.length > 1);
  if (w1.length > 0 && w2.length > 0) {
    const set2 = new Set(w2);
    const common = w1.filter((w) => set2.has(w)).length;
    const wordScore = (2 * common) / (w1.length + w2.length);
    if (wordScore >= 0.85) return wordScore;
  }

  const bg1 = [];
  const bg2 = [];
  const c1 = s1.replace(/\s+/g, '');
  const c2 = s2.replace(/\s+/g, '');
  for (let i = 0; i < c1.length - 1; i++) bg1.push(c1.slice(i, i + 2));
  for (let i = 0; i < c2.length - 1; i++) bg2.push(c2.slice(i, i + 2));
  if (bg1.length === 0 || bg2.length === 0) return 0;

  let intersection = 0;
  const used = new Array(bg2.length).fill(false);
  for (const x of bg1) {
    for (let j = 0; j < bg2.length; j++) {
      if (!used[j] && x === bg2[j]) {
        intersection++;
        used[j] = true;
        break;
      }
    }
  }
  return (2.0 * intersection) / (bg1.length + bg2.length);
}

async function tmdbFetch(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          accept: 'application/json',
        },
      });
      if (r.status === 429) {
        await new Promise((res) => setTimeout(res, 1500));
        continue;
      }
      if (r.ok) return await r.json();
      return null;
    } catch {
      if (i === retries - 1) return null;
      await new Promise((res) => setTimeout(res, 500));
    }
  }
  return null;
}

function cleanShowTitle(enTitle, isMovie) {
  let t = (enTitle || '').trim();
  if (isMovie) return t.replace(/\s+\b(19\d\d|20\d\d)\b$/, '').trim();
  return t
    .replace(/\s*-\s*(?:Season|Volume|Part|Vol\.?|Series)\s*\d+.*$/i, '')
    .replace(/\s+(?:Season|Volume|Part|Vol\.?)\s*\d+.*$/i, '')
    .replace(/\s*-\s*S\d+.*$/i, '')
    .replace(/\s+S\d+(?:E\d+)?$/i, '')
    .replace(/\s*-\s*All\s+(?:Volumes|Seasons).*$/i, '')
    .replace(/\s+\((?:Season|Volume|Part)[^)]*\)$/i, '')
    .trim();
}

function normEn(str) {
  return (str || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an|disney|disneys|dreamworks|marvels|nickelodeon|nick|jr|junior|show|series|tv|animations?|cartoons?|movies?|films?)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normFa(str) {
  return (str || '')
    .replace(/[ي]/g, 'ی')
    .replace(/[ك]/g, 'ک')
    .replace(/‌/g, ' ')
    .replace(/\s*-\s*(?:فصل|بخش)\s+.*$/, '')
    .replace(/\s+(?:فصل|بخش)\s+(?:اول|دوم|سوم|چهارم|پنجم|ششم|هفتم|هشتم|نهم|دهم|یازدهم|دوازدهم|سیزدهم|چهاردهم|پانزدهم|شانزدهم|هفدهم|هجدهم|نوزدهم|بیستم|\d+).*$/, '')
    .replace(/[^\u0600-\u06FF0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function mapItoonsAgeGroup(ageRaw) {
  const num = parseInt((ageRaw || '').replace(/\D+/g, ''), 10);
  if (isNaN(num)) return '3 تا 7 سال';
  if (num <= 2) return '1 تا 3 سال';
  if (num === 3) return '2 تا 5 سال';
  if (num === 4) return '3 تا 7 سال';
  if (num === 5 || num === 6) return '5 تا 7 سال';
  return '7 سال';
}

function mapItoonsAccent(countryRaw) {
  const c = (countryRaw || '').trim();
  if (c.includes('بریتانیا') || c.includes('انگلیس')) return 'لهجه بریتانیایی';
  if (c.includes('استرالیا')) return 'لهجه استرالیایی';
  if (c.includes('آمریکا') || c.includes('کانادا')) return 'لهجه آمریکایی';
  return 'لهجه آمریکایی';
}

function mapItoonsLang(langRaw) {
  const l = (langRaw || '').trim();
  if (l === 'فرانسوی') return 'فرانسوی';
  if (l === 'آلمانی') return 'آلمانی';
  if (l === 'چینی') return 'چینی';
  if (l === 'عربی') return 'عربی';
  return 'انگلیسی';
}

function parsePackSeasonNumber(enTitle, faTitle, packIndex) {
  let m;
  if ((m = (enTitle || '').match(/(?:Season|S)\s*0*(\d+)/i))) return parseInt(m[1], 10);
  if ((m = (enTitle || '').match(/(?:Volume|Vol\.?|Part)\s*0*(\d+)/i))) return parseInt(m[1], 10);
  return packIndex + 1;
}

function parseEpisodeSeasonAndNum(epTitle, defaultSeason, epIdxInPack, showBaseEn) {
  const raw = (epTitle || '').trim();
  let s = defaultSeason;
  let e = epIdxInPack + 1;
  let clean = raw;

  // Check S01E02 or S01E02E03
  const seMatch = raw.match(/\bS(\d+)E(\d+)(?:E\d+|\s*-\s*E?\d+)?\b/i);
  if (seMatch) {
    s = parseInt(seMatch[1], 10);
    e = parseInt(seMatch[2], 10);
    clean = raw.slice(seMatch.index + seMatch[0].length).replace(/^\s*[-–:]\s*/, '').trim();
  } else {
    // Strip showBaseEn prefix if present
    const baseWords = (showBaseEn || '').split(/\s+/).filter(Boolean);
    let rest = raw;
    if (baseWords.length > 0) {
      const prefixRe = new RegExp('^' + baseWords.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s.:-]+') + '\\s*', 'i');
      rest = rest.replace(prefixRe, '');
    }
    const numMatch = rest.match(/^0*(\d{1,3})(?:\s*-\s*\d{1,3})?\s*[-–.]?\s+(.*)$/);
    if (numMatch) {
      e = parseInt(numMatch[1], 10);
      clean = numMatch[2].trim();
    } else if (rest && rest.length >= 2) {
      clean = rest.trim();
    }
  }
  if (!clean) clean = `Episode ${e}`;
  return { season: s || 1, episode: e || (epIdxInPack + 1), cleanTitle: clean };
}

function parseDurationMinutes(durStr) {
  if (!durStr) return null;
  const parts = durStr.split(':').map((x) => parseInt(x, 10));
  if (parts.length === 3) return parts[0] * 60 + parts[1];
  if (parts.length === 2) return Math.max(1, parts[0]);
  return null;
}

function pickBestResult(results, query) {
  if (!results || results.length === 0) return null;
  const qLower = query.toLowerCase();
  let best = results[0];
  let bestScore = -999;

  for (const r of results) {
    let score = 0;
    const title = (r.name || r.title || '').toLowerCase();
    const origTitle = (r.original_name || r.original_title || '').toLowerCase();

    if (title === qLower || origTitle === qLower) score += 50;
    else if (title.startsWith(qLower) || origTitle.startsWith(qLower)) score += 25;
    else if (title.includes(qLower) || qLower.includes(title)) score += 10;

    const gIds = r.genre_ids || [];
    if (gIds.includes(16)) score += 30;
    if (gIds.includes(10762) || gIds.includes(10751)) score += 20;

    if (r.poster_path) score += 5;
    if (r.backdrop_path) score += 5;
    score += Math.min(10, (r.popularity || 0) * 0.5);

    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

async function matchItemWithTmdb(item) {
  const baseQuery = (item.title_en || '')
    .replace(/\b(Chinese|French|Français|Francais|German|Deutsch|Arabic|English)\b/gi, '')
    .replace(/\b(Season|Series|Part|Vol|Volume)\s*\d+\b/gi, '')
    .replace(/\s*[-–—:]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const queries = [baseQuery];
  if (baseQuery.includes(':')) queries.push(baseQuery.split(':')[0].trim());
  item.tmdb_query = queries[0] || item.title_en;

  const primaryType = item.content_type === 'movie' ? 'movie' : 'tv';
  const secondaryType = primaryType === 'movie' ? 'tv' : 'movie';

  let matched = null;
  let matchedMediaType = primaryType;

  for (const q of queries) {
    if (!q) continue;
    const data = await tmdbFetch(`https://api.themoviedb.org/3/search/${primaryType}?query=${encodeURIComponent(q)}&include_adult=false`);
    if (data?.results?.length > 0) {
      matched = pickBestResult(data.results, q);
      matchedMediaType = primaryType;
      break;
    }
  }
  if (!matched && queries[0]) {
    const data = await tmdbFetch(`https://api.themoviedb.org/3/search/${secondaryType}?query=${encodeURIComponent(queries[0])}&include_adult=false`);
    if (data?.results?.length > 0) {
      matched = pickBestResult(data.results, queries[0]);
      matchedMediaType = secondaryType;
    }
  }
  if (!matched) {
    item.tmdb = null;
    return false;
  }

  const details = await tmdbFetch(`https://api.themoviedb.org/3/${matchedMediaType}/${matched.id}?append_to_response=external_ids`);
  const d = details || matched;
  const releaseDate = d.first_air_date || d.release_date || matched.first_air_date || matched.release_date || '';
  const releaseYear = releaseDate ? releaseDate.slice(0, 4) : item.year || '';
  const genres = d.genres ? d.genres.map((g) => g.name) : (matched.genre_ids || []).map((id) => genreMap[id]).filter(Boolean);
  const posterPath = d.poster_path || matched.poster_path || null;
  const backdropPath = d.backdrop_path || matched.backdrop_path || null;

  item.tmdb = {
    tmdb_id: matched.id,
    imdb_id: d.external_ids?.imdb_id || d.imdb_id || null,
    media_type: matchedMediaType,
    title: d.name || d.title || matched.name || matched.title || '',
    original_title: d.original_name || d.original_title || matched.original_name || matched.original_title || '',
    original_language: d.original_language || matched.original_language || '',
    origin_country: d.origin_country || matched.origin_country || [],
    release_date: releaseDate,
    release_year: releaseYear,
    rating: d.vote_average ? Number(d.vote_average.toFixed(1)) : 0,
    vote_count: d.vote_count || 0,
    popularity: d.popularity || 0,
    genres,
    networks: (d.networks || []).map((n) => n.name),
    production_companies: (d.production_companies || []).map((p) => p.name).slice(0, 4),
    status: d.status || '',
    number_of_seasons: d.number_of_seasons || null,
    number_of_episodes: d.number_of_episodes || null,
    runtime_minutes: d.runtime || (d.episode_run_time && d.episode_run_time[0]) || null,
    overview_en: (d.overview || matched.overview || '').replace(/\s+/g, ' ').trim(),
    poster_url: posterPath ? `https://image.tmdb.org/t/p/w500${posterPath}` : null,
    poster_original_url: posterPath ? `https://image.tmdb.org/t/p/original${posterPath}` : null,
    backdrop_url: backdropPath ? `https://image.tmdb.org/t/p/w1280${backdropPath}` : null,
    backdrop_original_url: backdropPath ? `https://image.tmdb.org/t/p/original${backdropPath}` : null,
    tmdb_url: `https://www.themoviedb.org/${matchedMediaType}/${matched.id}`,
  };
  return true;
}

async function alignSeriesEpisodesOnTmdb(item) {
  if (!item.tmdb || item.tmdb.media_type !== 'tv' || !item.episodes || item.episodes.length === 0) return;
  const tmdbId = item.tmdb.tmdb_id;
  const siteSeasons = [...new Set(item.episodes.map((e) => e.season_number || 1))].filter((s) => s > 0 && s <= 50);
  const maxTmdbSeasons = Math.min(item.tmdb.number_of_seasons || 1, 10);
  for (let s = 1; s <= maxTmdbSeasons; s++) {
    if (!siteSeasons.includes(s)) siteSeasons.push(s);
  }

  const allTmdbEpisodes = [];
  const localizedLang = tmdbLangCodeMap[item.language];

  await Promise.all(
    siteSeasons.map(async (sNum) => {
      const [enData, locData] = await Promise.all([
        tmdbFetch(`https://api.themoviedb.org/3/tv/${tmdbId}/season/${sNum}?language=en-US`),
        localizedLang ? tmdbFetch(`https://api.themoviedb.org/3/tv/${tmdbId}/season/${sNum}?language=${localizedLang}`) : Promise.resolve(null),
      ]);
      if (enData && Array.isArray(enData.episodes)) {
        const locMap = new Map();
        if (locData && Array.isArray(locData.episodes)) {
          for (const le of locData.episodes) locMap.set(le.id, le);
        }
        for (const ep of enData.episodes) {
          const locEp = locMap.get(ep.id);
          allTmdbEpisodes.push({
            ...ep,
            season_number: sNum,
            localized_name: locEp?.name || '',
            localized_overview: locEp?.overview || '',
          });
        }
      }
    })
  );

  if (allTmdbEpisodes.length === 0) return;

  for (const ep of item.episodes) {
    if (ep.tmdb_episode) continue; // Already aligned
    const siteSeason = ep.season_number || 1;
    const siteEpNum = ep.episode_number || 1;
    const siteClean = ep.clean_title || '';
    const isGenericSiteTitle = /^episode\s*\d+$/i.test(siteClean) || /^\d+$/.test(siteClean) || siteClean.length < 2;

    let bestMatch = null;
    let matchMethod = 'none';

    if (!isGenericSiteTitle) {
      let bestSim = 0;
      let candidate = null;
      for (const te of allTmdbEpisodes) {
        const simEn = similarityScore(siteClean, te.name);
        const simLoc = te.localized_name ? similarityScore(siteClean, te.localized_name) : 0;
        let sim = Math.max(simEn, simLoc);
        if (te.season_number === siteSeason && te.episode_number === siteEpNum) sim += 0.08;
        else if (te.season_number === siteSeason) sim += 0.03;
        if (sim > bestSim) {
          bestSim = sim;
          candidate = te;
        }
      }
      if (candidate && bestSim >= 0.62) {
        bestMatch = candidate;
        matchMethod = bestSim >= 0.9 ? 'exact_title' : 'fuzzy_title_corrected';
      }
    }

    if (!bestMatch) {
      const byNum = allTmdbEpisodes.find((te) => te.season_number === siteSeason && te.episode_number === siteEpNum);
      if (byNum) {
        bestMatch = byNum;
        matchMethod = 'season_episode_number';
      }
    }

    if (bestMatch) {
      const officialTitle =
        localizedLang && bestMatch.localized_name && !/^episode\s*\d+/i.test(bestMatch.localized_name)
          ? bestMatch.localized_name
          : bestMatch.name || ep.clean_title;
      ep.site_raw_title = ep.title;
      ep.site_season_number = ep.season_number;
      ep.site_episode_number = ep.episode_number;
      ep.season_number = bestMatch.season_number;
      ep.episode_number = bestMatch.episode_number;
      ep.display_title = !/^episode\s*\d+$/i.test(officialTitle) ? officialTitle : ep.clean_title;
      ep.match_method = matchMethod;
      ep.tmdb_episode = {
        tmdb_episode_id: bestMatch.id,
        season_number: bestMatch.season_number,
        episode_number: bestMatch.episode_number,
        name: bestMatch.name || '',
        localized_name: bestMatch.localized_name || '',
        overview: (bestMatch.overview || bestMatch.localized_overview || '').replace(/\s+/g, ' ').trim(),
        air_date: bestMatch.air_date || '',
        runtime: bestMatch.runtime || ep.runtime || item.tmdb.runtime_minutes || null,
        rating: bestMatch.vote_average ? Number(bestMatch.vote_average.toFixed(1)) : 0,
        still_url: bestMatch.still_path ? `https://image.tmdb.org/t/p/w500${bestMatch.still_path}` : null,
        still_original_url: bestMatch.still_path ? `https://image.tmdb.org/t/p/original${bestMatch.still_path}` : null,
      };
    } else {
      ep.display_title = ep.clean_title;
      ep.match_method = 'site_only';
    }
  }

  // Ensure unique (season_number, episode_number) after alignment
  const usedPairs = new Set();
  for (const ep of item.episodes) {
    let s = ep.season_number || 1;
    let e = ep.episode_number || 1;
    while (usedPairs.has(`${s}:${e}`)) e++;
    ep.season_number = s;
    ep.episode_number = e;
    usedPairs.add(`${s}:${e}`);
  }

  item.episodes.sort((a, b) => {
    if ((a.season_number || 1) !== (b.season_number || 1)) return (a.season_number || 1) - (b.season_number || 1);
    return (a.episode_number || 1) - (b.episode_number || 1);
  });
}

function normalizeSizeToEn(sz) {
  if (!sz) return null;
  return String(sz)
    .replace(/مگابایت/g, 'MB')
    .replace(/گیگابایت/g, 'GB')
    .replace(/کیلوبایت/g, 'KB')
    .replace(/\s+/g, ' ')
    .trim();
}

async function main() {
  const rawCatalog = readJsonMaybeGz(CATALOG_GZ_PATH, CATALOG_JSON_PATH);
  const existingItoonsByKey = new Map();
  for (const c of rawCatalog) {
    if (c.id >= 2000 && c.tmdb) {
      const k = (c.language !== 'انگلیسی' ? c.language + ':' : '') + (c.content_type === 'movie' ? 'movie:' + normEn(c.title_en) : 'series:' + (normFa(c.title_fa) || normEn(c.title_en)));
      existingItoonsByKey.set(k, c);
    }
  }

  // Keep only original Hamechizdan items (id < 2000) in case script is re-run, and strip previously merged iToons episodes (episode_id >= 100000) and backup fields
  const catalog = rawCatalog.filter((c) => c.id < 2000);
  for (const c of catalog) {
    c.episodes = (c.episodes || []).filter((e) => (e.episode_id || 0) < 100000);
    for (const ep of c.episodes) {
      if (ep.sources) delete ep.sources.itoons_720p;
      if (ep.file_sizes) delete ep.file_sizes.itoons_720p;
    }
    c.total_episodes_count = c.episodes.length;
    c.episodes_count = c.episodes.length;
  }

  const packs = readJsonMaybeGz(ITOONS_GZ_PATH, ITOONS_JSON_PATH);

  // Group iToons packs into unified shows/movies
  const shows = new Map();
  for (const p of packs) {
    const validEps = (p.episodes || []).filter((e) => e.directUrl);
    if (validEps.length === 0) continue;
    const isMovie = /^\d{4}$/.test(p.label) || /Movie|Special|Short/i.test(p.label) || validEps.length === 1;
    const baseEn = cleanShowTitle(p.enTitle, isMovie);
    const baseFa = normFa(p.faTitle);
    const lang = mapItoonsLang(p.lang);
    const key = (lang !== 'انگلیسی' ? lang + ':' : '') + (isMovie ? 'movie:' + normEn(baseEn) : 'series:' + (baseFa || normEn(baseEn)));
    if (!shows.has(key)) {
      shows.set(key, {
        key,
        baseEn,
        baseFa,
        rawFa: (p.faTitle || '').replace(/\s*-\s*(?:فصل|بخش)\s+.*$/, '').trim(),
        isMovie,
        lang,
        packs: [],
      });
    }
    shows.get(key).packs.push({ ...p, episodes: validEps });
  }

  // Sort packs inside each show chronologically (oldest pack first = Season 1 / Volume 1 first)
  for (const g of shows.values()) {
    g.packs.reverse();
    g.packs.sort((a, b) => {
      const sA = parsePackSeasonNumber(a.enTitle, a.faTitle, 0);
      const sB = parsePackSeasonNumber(b.enTitle, b.faTitle, 0);
      return sA - sB;
    });
  }

  let nextCollectionId = 2001;
  let nextEpisodeId = 100001;
  const newItemsToEnrich = [];
  const expandedExistingItems = [];
  let addedNewEpisodesToExisting = 0;
  let attachedBackupStreamsToMovies = 0;
  let attachedBackupStreamsToSeriesEps = 0;

  for (const g of shows.values()) {
    const kEn = normEn(g.baseEn);
    const kFa = g.baseFa;
    const candidates = catalog.filter((h) => {
      if (h.id >= 2000) return false; // Only match against original Hamechizdan items
      const hIsMovie = h.content_type === 'movie';
      if (hIsMovie !== g.isMovie) return false;
      if (h.language !== g.lang) return false;
      const hEn = normEn(h.title_en);
      const hFa = normFa(h.title_fa);
      const hTmdb = h.tmdb && h.tmdb.title ? normEn(h.tmdb.title) : '';
      if (hEn === kEn || hFa === kFa || (hTmdb && hTmdb === kEn)) return true;
      if (g.isMovie) return false; // Movies must match exact normalized title (avoid matching Part 1 with Part 2)
      const w1 = kEn.split(' ').filter(Boolean);
      const w2 = hEn.split(' ').filter(Boolean);
      if (w1.length >= 2 && w2.length >= 2) {
        const common = w1.filter((w) => w2.includes(w));
        if (common.length === Math.min(w1.length, w2.length) && common.join('').length >= 8) return true;
      }
      return false;
    });

    // Build flat list of episodes from iToons packs
    const itoonsEpisodes = [];
    g.packs.forEach((pack, pIdx) => {
      const packSeason = g.isMovie ? 0 : parsePackSeasonNumber(pack.enTitle, pack.faTitle, pIdx);
      pack.episodes.forEach((ep, eIdx) => {
        const parsed = parseEpisodeSeasonAndNum(ep.title, packSeason, eIdx, g.baseEn);
        const q = ep.quality || '720p';
        const sources = { '720p': ep.directUrl };
        if (q !== '720p') sources[q] = ep.directUrl;
        const file_sizes = { '720p': ep.fileSize || 'HD' };
        if (q !== '720p' && ep.fileSize) file_sizes[q] = ep.fileSize;

        itoonsEpisodes.push({
          episode_id: nextEpisodeId++,
          title: ep.title,
          thumbnail: ep.thumb || pack.cover || pack.poster || '',
          upload_date: '1405-08-02',
          sources,
          file_sizes,
          season_number: g.isMovie ? 0 : parsed.season,
          episode_number: g.isMovie ? 1 : parsed.episode,
          clean_title: g.isMovie ? g.baseEn : parsed.cleanTitle,
          display_title: g.isMovie ? g.baseEn : parsed.cleanTitle,
          runtime: parseDurationMinutes(ep.duration),
        });
      });
    });

    if (candidates.length === 0) {
      // Brand new title from iToons!
      const refPack = g.packs[g.packs.length - 1]; // latest pack for poster/cover
      const firstPack = g.packs[0];
      const ageGroup = mapItoonsAgeGroup(refPack.ageRaw || firstPack.ageRaw);
      const accent = g.lang === 'انگلیسی' ? mapItoonsAccent(refPack.country || firstPack.country) : '';
      const badges = [g.lang, accent, 'دخترانه | پسرانه', ageGroup].filter(Boolean);

      // Ensure unique (season_number, episode_number) across packs
      const usedSE = new Set();
      for (const ie of itoonsEpisodes) {
        if (g.isMovie) continue;
        while (usedSE.has(`${ie.season_number}:${ie.episode_number}`)) {
          ie.episode_number++;
        }
        usedSE.add(`${ie.season_number}:${ie.episode_number}`);
      }

      const bulk720 = itoonsEpisodes.map((e) => e.sources['720p']).filter(Boolean);
      const cachedOld = existingItoonsByKey.get(g.key);
      if (cachedOld && cachedOld.episodes && cachedOld.episodes.length === itoonsEpisodes.length) {
        for (let i = 0; i < itoonsEpisodes.length; i++) {
          if (cachedOld.episodes[i]?.tmdb_episode) {
            itoonsEpisodes[i].tmdb_episode = cachedOld.episodes[i].tmdb_episode;
            if (cachedOld.episodes[i].display_title) itoonsEpisodes[i].display_title = cachedOld.episodes[i].display_title;
            if (cachedOld.episodes[i].season_number != null) itoonsEpisodes[i].season_number = cachedOld.episodes[i].season_number;
            if (cachedOld.episodes[i].episode_number != null) itoonsEpisodes[i].episode_number = cachedOld.episodes[i].episode_number;
          }
        }
      }
      const newItem = {
        id: nextCollectionId++,
        url: firstPack.href,
        title_en: g.baseEn,
        title_fa: g.rawFa,
        thumbnail: refPack.poster || firstPack.poster || refPack.cover || '',
        badges,
        last_updated: '1405-08-02',
        episodes_count: itoonsEpisodes.length,
        episodes: itoonsEpisodes,
        breadcrumb_type: g.isMovie ? 'سینمایی' : 'سریالی',
        meta_description: refPack.descriptionFa || firstPack.descriptionFa || `دانلود کارتون ${g.rawFa} (${g.baseEn})`,
        total_sizes: {},
        bulk_sources: { '720p': bulk720 },
        content_type: g.isMovie ? 'movie' : 'series',
        content_type_fa: g.isMovie ? 'فیلم (سینمایی)' : 'سریال',
        language: g.lang,
        accent,
        age_group: ageGroup,
        gender: 'دخترانه | پسرانه',
        tmdb_query: g.baseEn,
        total_episodes_count: itoonsEpisodes.length,
        year: refPack.year || firstPack.year || '',
        tmdb: cachedOld?.tmdb || null,
      };
      catalog.push(newItem);
      if (!newItem.tmdb) {
        newItemsToEnrich.push(newItem);
      }
    } else if (g.isMovie) {
      // Existing movie in Hamechizdan! Attach iToons backup stream to the movie episode
      const target = candidates[0];
      const firstItoons = itoonsEpisodes[0];
      const firstTargetEp = (target.episodes || [])[0];
      if (firstItoons && firstTargetEp) {
        const itoonsUrl = firstItoons.sources['720p'] || Object.values(firstItoons.sources || {})[0];
        const itoonsSize = firstItoons.file_sizes['720p'] || Object.values(firstItoons.file_sizes || {})[0];
        if (itoonsUrl) {
          if (!firstTargetEp.sources) firstTargetEp.sources = {};
          firstTargetEp.sources['itoons_720p'] = itoonsUrl;
          if (!firstTargetEp.file_sizes) firstTargetEp.file_sizes = {};
          if (itoonsSize) firstTargetEp.file_sizes['itoons_720p'] = itoonsSize;
          attachedBackupStreamsToMovies++;
        }
      }
    } else {
      // Existing series in Hamechizdan!
      // 1) Attach iToons backup stream (itoons_720p) to any matching existing episodes
      // 2) Add any missing episodes from iToons
      const target = candidates[0];
      const existingTitlesMap = new Map();
      const existingSEMap = new Map();
      const existingSE = new Set();
      const existingTitles = new Set();

      for (const e of target.episodes) {
        const normT = normalizeStr(e.display_title || e.clean_title || e.title);
        if (normT && normT.length >= 3) {
          existingTitles.add(normT);
          if (!existingTitlesMap.has(normT)) existingTitlesMap.set(normT, e);
        }
        const seKey = `${e.season_number || 1}:${e.episode_number || 1}`;
        existingSE.add(seKey);
        if (!existingSEMap.has(seKey)) existingSEMap.set(seKey, e);
      }

      let addedHere = 0;

      for (const ie of itoonsEpisodes) {
        const normT = normalizeStr(ie.clean_title);
        const isGeneric = /^episode\s*\d+$/i.test(ie.clean_title) || normT.length < 3;
        let matchedExistingEp = null;

        if (!isGeneric) {
          if (existingTitlesMap.has(normT)) {
            matchedExistingEp = existingTitlesMap.get(normT);
          } else {
            let bestSim = 0;
            for (const exEp of target.episodes) {
              if ((exEp.episode_id || 0) >= 100000) continue; // Only match against original Hamechizdan episodes
              const sim = similarityScore(ie.clean_title, exEp.display_title || exEp.clean_title || '');
              if (sim >= 0.78 && sim > bestSim) {
                bestSim = sim;
                matchedExistingEp = exEp;
              }
            }
          }
        }
        if (!matchedExistingEp) {
          const seCandidate = existingSEMap.get(`${ie.season_number}:${ie.episode_number}`);
          if (seCandidate && (seCandidate.episode_id || 0) < 100000) {
            if (isGeneric || similarityScore(ie.clean_title, seCandidate.display_title || seCandidate.clean_title || '') >= 0.5) {
              matchedExistingEp = seCandidate;
            } else if (itoonsEpisodes.length <= target.episodes.length) {
              // When iToons has equal or fewer episodes than Hamechizdan and same S:E, pair as backup
              matchedExistingEp = seCandidate;
            }
          }
        }

        if (matchedExistingEp) {
          const itoonsUrl = ie.sources['720p'] || Object.values(ie.sources || {})[0];
          const itoonsSize = ie.file_sizes['720p'] || Object.values(ie.file_sizes || {})[0];
          if (itoonsUrl && !matchedExistingEp.sources?.['itoons_720p']) {
            if (!matchedExistingEp.sources) matchedExistingEp.sources = {};
            matchedExistingEp.sources['itoons_720p'] = itoonsUrl;
            if (!matchedExistingEp.file_sizes) matchedExistingEp.file_sizes = {};
            if (itoonsSize) matchedExistingEp.file_sizes['itoons_720p'] = itoonsSize;
            attachedBackupStreamsToSeriesEps++;
          }
        } else if (itoonsEpisodes.length > target.episodes.length || !isGeneric) {
          while (existingSE.has(`${ie.season_number}:${ie.episode_number}`)) {
            ie.episode_number++;
          }
          existingSE.add(`${ie.season_number}:${ie.episode_number}`);
          if (!isGeneric) existingTitles.add(normT);
          target.episodes.push(ie);
          if (!target.bulk_sources) target.bulk_sources = {};
          if (!target.bulk_sources['720p']) target.bulk_sources['720p'] = [];
          target.bulk_sources['720p'].push(ie.sources['720p']);
          addedHere++;
          addedNewEpisodesToExisting++;
        }
      }

      if (addedHere > 0) {
        target.episodes.sort((a, b) => {
          if ((a.season_number || 1) !== (b.season_number || 1)) return (a.season_number || 1) - (b.season_number || 1);
          return (a.episode_number || 1) - (b.episode_number || 1);
        });
        target.total_episodes_count = target.episodes.length;
        target.episodes_count = target.episodes.length;
        expandedExistingItems.push(target);
      }
    }
  }

  console.log(`Added ${newItemsToEnrich.length} brand-new titles from iToons!`);
  console.log(`Expanded ${expandedExistingItems.length} existing series with +${addedNewEpisodesToExisting} new episodes from iToons!`);
  console.log(`Attached iToons backup streams to ${attachedBackupStreamsToMovies} shared movies and ${attachedBackupStreamsToSeriesEps} shared series episodes!`);

  // Step 2: Enrich all new titles on TMDB (concurrency 12)
  console.log(`Enriching ${newItemsToEnrich.length} new titles on TMDB...`);
  let matchedNew = 0;
  for (let i = 0; i < newItemsToEnrich.length; i += 12) {
    const batch = newItemsToEnrich.slice(i, i + 12);
    const res = await Promise.all(batch.map((item) => matchItemWithTmdb(item)));
    matchedNew += res.filter(Boolean).length;
    if ((i + 12) % 60 === 0 || i + 12 >= newItemsToEnrich.length) {
      console.log(`  TMDB Title Match: ${Math.min(i + 12, newItemsToEnrich.length)}/${newItemsToEnrich.length} (Matched: ${matchedNew})`);
    }
  }

  // Step 3: Align episodes on TMDB for new TV series + expanded existing TV series
  const seriesToAlign = [...newItemsToEnrich.filter((x) => x.content_type === 'series' && x.tmdb), ...expandedExistingItems.filter((x) => x.tmdb)];
  console.log(`Aligning episodes with TMDB seasons for ${seriesToAlign.length} series...`);
  for (let i = 0; i < seriesToAlign.length; i += 10) {
    const batch = seriesToAlign.slice(i, i + 10);
    await Promise.all(batch.map((item) => alignSeriesEpisodesOnTmdb(item)));
    if ((i + 10) % 50 === 0 || i + 10 >= seriesToAlign.length) {
      console.log(`  TMDB Episode Align: ${Math.min(i + 10, seriesToAlign.length)}/${seriesToAlign.length}`);
    }
  }

  // Step 4: Save compressed hamechizdan_full_catalog.json.gz, CSV, and optional verbose archive
  console.log(`Writing updated catalog files (${catalog.length} total titles, ${catalog.reduce((s, c) => s + c.episodes.length, 0)} total episodes)...`);

  writeJsonGz(CATALOG_GZ_PATH, catalog);
  if (fs.existsSync(CATALOG_JSON_PATH)) {
    fs.writeFileSync(CATALOG_JSON_PATH, JSON.stringify(catalog, null, 2), 'utf8');
  }

  const csvEsc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csvHeader = 'id,title_en,tmdb_search_query,title_fa,content_type,language,badges,episodes_count,tmdb_id,imdb_id,release_year,rating,last_updated,thumbnail,url';
  const csvRows = catalog.map((c) =>
    [
      c.id,
      csvEsc(c.title_en),
      csvEsc(c.tmdb_query || c.title_en),
      csvEsc(c.title_fa),
      csvEsc(c.content_type),
      csvEsc(c.language),
      csvEsc((c.badges || []).join(' | ')),
      c.episodes.length,
      c.tmdb?.tmdb_id || '',
      csvEsc(c.tmdb?.imdb_id || ''),
      csvEsc(c.tmdb?.release_year || c.year || ''),
      c.tmdb?.rating || '',
      csvEsc(c.last_updated),
      csvEsc(c.tmdb?.poster_url || c.thumbnail),
      csvEsc(c.url),
    ].join(',')
  );
  fs.writeFileSync(path.join(DATA_DIR, 'hamechizdan_titles_metadata.csv'), [csvHeader, ...csvRows].join('\n'), 'utf8');

  if (WRITE_VERBOSE_ARCHIVE) {
    const archiveRoot = path.join(PIPELINE_DIR, 'organized-archive');
    for (const item of catalog) {
      const langFolder = langFolderMap[item.language] || `Other (${item.language})`;
      const typeFolder = item.content_type === 'movie' ? 'Movies (فیلم)' : 'Series (سریال)';
      const targetDir = path.join(archiveRoot, langFolder, typeFolder);
      fs.mkdirSync(targetDir, { recursive: true });
      const safeTitle = sanitizeFileName(item.title_en || `Collection-${item.id}`);
      fs.writeFileSync(path.join(targetDir, `${safeTitle}.txt`), `${item.title_en} (${item.episodes.length} episodes)\n`, 'utf8');
    }
  }

  // Step 5: Build compact GZIP binary catalog (hamechizdan_catalog.bin) for CinCin TV Android TV app
  const compactItems = catalog.map((c) => {
    const t = c.tmdb || {};
    const compactEps = (c.episodes || []).map((ep) => {
      const te = ep.tmdb_episode || {};
      const u720 = ep.sources?.['720p'] || ep.sources?.['480p'] || ep.sources?.['576p'] || Object.values(ep.sources || {})[0] || null;
      const s720 = normalizeSizeToEn(ep.file_sizes?.['720p'] || ep.file_sizes?.['480p'] || ep.file_sizes?.['576p'] || Object.values(ep.file_sizes || {})[0]);
      const u360 = ep.sources?.['360p'] || null;
      const s360 = normalizeSizeToEn(ep.file_sizes?.['360p']);
      const uAlt = ep.sources?.['itoons_720p'] || null;
      const sAlt = normalizeSizeToEn(ep.file_sizes?.['itoons_720p']);
      const epObj = {
        id: ep.episode_id || 0,
        s: ep.season_number ?? 1,
        e: ep.episode_number ?? 1,
        t: ep.display_title || ep.clean_title || ep.title || null,
        th: te.still_url || ep.thumbnail || null,
        ov: te.overview || null,
        air: te.air_date || null,
        rt: te.runtime || ep.runtime || t.runtime_minutes || null,
        u720,
        s720,
        u360,
        s360,
      };
      if (uAlt && uAlt !== u720) {
        epObj.uAlt = uAlt;
        if (sAlt) epObj.sAlt = sAlt;
      }
      return epObj;
    });

    return {
      id: c.id,
      type: c.content_type || 'series',
      en: t.title || c.title_en || '',
      fa: c.title_fa || null,
      lang: c.language || 'انگلیسی',
      acc: c.accent || null,
      age: c.age_group || null,
      badges: c.badges || [],
      poster: t.poster_url || c.thumbnail || null,
      bg: t.backdrop_url || t.poster_url || c.thumbnail || null,
      thumb: c.thumbnail || t.poster_url || null,
      ovFa: c.meta_description || null,
      ovEn: t.overview_en || null,
      year: t.release_year || c.year || null,
      rel: t.release_date || null,
      rating: t.rating || null,
      runtime: t.runtime_minutes || null,
      imdb: t.imdb_id || null,
      tmdbId: t.tmdb_id || null,
      genres: t.genres || [],
      eps: compactEps,
    };
  });

  const bundle = {
    version: 2,
    count: compactItems.length,
    items: compactItems,
  };
  const gzBuffer = zlib.gzipSync(Buffer.from(JSON.stringify(bundle), 'utf8'), { level: 9 });
  const assetBinPath = fs.existsSync(path.join(REPO_ROOT, 'app', 'src', 'main', 'assets'))
    ? path.join(REPO_ROOT, 'app', 'src', 'main', 'assets', 'hamechizdan_catalog.bin')
    : path.join(REPO_ROOT, 'NuvioTV', 'app', 'src', 'main', 'assets', 'hamechizdan_catalog.bin');
  fs.writeFileSync(assetBinPath, gzBuffer);
  console.log(`Built ${assetBinPath} (${(gzBuffer.length / (1024 * 1024)).toFixed(2)} MB) with ${compactItems.length} titles!`);
}

main().catch(console.error);
