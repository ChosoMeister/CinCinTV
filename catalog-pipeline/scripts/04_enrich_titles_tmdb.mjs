import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR = path.resolve(__dirname, '..');

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJjZjdhNGFiZWZkZTU4MzVjNTM5OTNhNDcyYTM0YmViMSIsIm5iZiI6MTc5MjUyNDQxMi4zNjIsInN1YiI6IjZhZDdjMDdjMjEyNGYwMDMxZTdjZTI3NCIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.Ozv3z64IDDNM_0LRnOvUOSjBy0iIgf3_txUOMBjYvrc";

const genreMap = {
  16: "Animation",
  10751: "Family",
  10762: "Kids",
  10759: "Action & Adventure",
  12: "Adventure",
  28: "Action",
  35: "Comedy",
  18: "Drama",
  14: "Fantasy",
  10765: "Sci-Fi & Fantasy",
  878: "Science Fiction",
  10402: "Music",
  9648: "Mystery",
  99: "Documentary",
  10770: "TV Movie"
};

const langFolderMap = {
  "انگلیسی": "English (انگلیسی)",
  "چینی": "Chinese (چینی)",
  "فرانسوی": "French (فرانسوی)",
  "آلمانی": "German (آلمانی)",
  "عربی": "Arabic (عربی)"
};

function sanitizeFileName(name) {
  return name
    .replace(/[\/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanQueryVariants(titleEn, titleFa, metaDesc) {
  const variants = [];
  if (!titleEn) return variants;

  // Base clean: remove language suffixes & trailing season numbers
  const v1 = titleEn
    .replace(/\b(Chinese|French|Français|Francais|German|Deutsch|Arabic|Spanish|Russian|Turkish|Italian|Korean|Japanese|English)\b/gi, "")
    .replace(/\b(Season|Series|Part|Vol|Volume)\s*\d+\b/gi, "")
    .replace(/\s+\d+$/, "")
    .replace(/\s*[-–—:]\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (v1) variants.push(v1);

  // If title has colon or dash, also try the part before colon/dash if main query fails
  if (v1.includes(":")) {
    const beforeColon = v1.split(":")[0].trim();
    if (beforeColon.length > 3 && !variants.includes(beforeColon)) {
      variants.push(beforeColon);
    }
  }

  // Also check if metaDesc has original foreign name in parentheses e.g. (به چینی: 爹地宝贝之神奇哈酷)
  if (metaDesc) {
    const parenMatch = metaDesc.match(/[:：]\s*([^\)\]]+)[\)\]]/);
    if (parenMatch && parenMatch[1].trim().length >= 2) {
      variants.push(parenMatch[1].trim());
    }
  }

  if (!variants.includes(titleEn.trim())) {
    variants.push(titleEn.trim());
  }

  return variants;
}

async function tmdbFetch(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          accept: "application/json"
        }
      });
      if (r.status === 429) {
        await new Promise(res => setTimeout(res, 1500));
        continue;
      }
      if (r.ok) return await r.json();
      return null;
    } catch (e) {
      if (i === retries - 1) return null;
      await new Promise(res => setTimeout(res, 600));
    }
  }
  return null;
}

function pickBestResult(results, query, preferAnimation = true) {
  if (!results || results.length === 0) return null;
  const qLower = query.toLowerCase();

  // Score each candidate
  let best = results[0];
  let bestScore = -999;

  for (const r of results) {
    let score = 0;
    const title = (r.name || r.title || "").toLowerCase();
    const origTitle = (r.original_name || r.original_title || "").toLowerCase();

    if (title === qLower || origTitle === qLower) score += 50;
    else if (title.startsWith(qLower) || origTitle.startsWith(qLower)) score += 25;
    else if (title.includes(qLower) || qLower.includes(title)) score += 10;

    const gIds = r.genre_ids || [];
    if (gIds.includes(16)) score += 30; // Animation
    if (gIds.includes(10762) || gIds.includes(10751)) score += 20; // Kids / Family

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
  const queries = cleanQueryVariants(item.title_en, item.title_fa, item.meta_description);
  item.tmdb_query = queries[0] || item.title_en;

  const primaryType = item.content_type === "movie" ? "movie" : "tv";
  const secondaryType = primaryType === "movie" ? "tv" : "movie";

  let matched = null;
  let matchedMediaType = primaryType;

  // 1. Try primary type with main query
  for (const q of queries.slice(0, 2)) {
    const data = await tmdbFetch(`https://api.themoviedb.org/3/search/${primaryType}?query=${encodeURIComponent(q)}&include_adult=false`);
    if (data?.results?.length > 0) {
      matched = pickBestResult(data.results, q);
      matchedMediaType = primaryType;
      break;
    }
  }

  // 2. Try secondary type (e.g. a TV special listed under movies, or a movie listed under series)
  if (!matched && queries[0]) {
    const data = await tmdbFetch(`https://api.themoviedb.org/3/search/${secondaryType}?query=${encodeURIComponent(queries[0])}&include_adult=false`);
    if (data?.results?.length > 0) {
      matched = pickBestResult(data.results, queries[0]);
      matchedMediaType = secondaryType;
    }
  }

  // 3. Try fallback variants (e.g. before colon or Chinese characters)
  if (!matched && queries.length > 2) {
    for (const q of queries.slice(2)) {
      const data = await tmdbFetch(`https://api.themoviedb.org/3/search/multi?query=${encodeURIComponent(q)}&include_adult=false`);
      const valid = (data?.results || []).filter(r => r.media_type === "tv" || r.media_type === "movie");
      if (valid.length > 0) {
        matched = pickBestResult(valid, q);
        matchedMediaType = matched.media_type || primaryType;
        break;
      }
    }
  }

  if (!matched) {
    item.tmdb = null;
    return false;
  }

  // Fetch full details (for IMDB ID, runtime, seasons, networks, exact genres)
  const details = await tmdbFetch(`https://api.themoviedb.org/3/${matchedMediaType}/${matched.id}?append_to_response=external_ids`);
  const d = details || matched;

  const releaseDate = d.first_air_date || d.release_date || matched.first_air_date || matched.release_date || "";
  const releaseYear = releaseDate ? releaseDate.slice(0, 4) : "";

  const genres = d.genres
    ? d.genres.map(g => g.name)
    : (matched.genre_ids || []).map(id => genreMap[id]).filter(Boolean);

  const posterPath = d.poster_path || matched.poster_path || null;
  const backdropPath = d.backdrop_path || matched.backdrop_path || null;

  item.tmdb = {
    tmdb_id: matched.id,
    imdb_id: d.external_ids?.imdb_id || d.imdb_id || null,
    media_type: matchedMediaType,
    title: d.name || d.title || matched.name || matched.title || "",
    original_title: d.original_name || d.original_title || matched.original_name || matched.original_title || "",
    original_language: d.original_language || matched.original_language || "",
    origin_country: d.origin_country || matched.origin_country || [],
    release_date: releaseDate,
    release_year: releaseYear,
    rating: d.vote_average ? Number(d.vote_average.toFixed(1)) : 0,
    vote_count: d.vote_count || 0,
    popularity: d.popularity || 0,
    genres,
    networks: (d.networks || []).map(n => n.name),
    production_companies: (d.production_companies || []).map(p => p.name).slice(0, 4),
    status: d.status || "",
    number_of_seasons: d.number_of_seasons || null,
    number_of_episodes: d.number_of_episodes || null,
    runtime_minutes: d.runtime || (d.episode_run_time && d.episode_run_time[0]) || null,
    overview_en: (d.overview || matched.overview || "").replace(/\s+/g, " ").trim(),
    poster_url: posterPath ? `https://image.tmdb.org/t/p/w500${posterPath}` : null,
    poster_original_url: posterPath ? `https://image.tmdb.org/t/p/original${posterPath}` : null,
    backdrop_url: backdropPath ? `https://image.tmdb.org/t/p/w1280${backdropPath}` : null,
    backdrop_original_url: backdropPath ? `https://image.tmdb.org/t/p/original${backdropPath}` : null,
    tmdb_url: `https://www.themoviedb.org/${matchedMediaType}/${matched.id}`
  };

  return true;
}

async function main() {
  const baseDir = BASE_DIR;
  const catalog = JSON.parse(fs.readFileSync(`${baseDir}/hamechizdan_full_catalog.json`, "utf8"));

  console.log(`Starting TMDB metadata enrichment for ${catalog.length} titles...`);
  const concurrency = 15;
  let completed = 0;
  let matchedCount = 0;

  for (let i = 0; i < catalog.length; i += concurrency) {
    const batch = catalog.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(item => matchItemWithTmdb(item)));
    matchedCount += results.filter(Boolean).length;
    completed += batch.length;
    if (completed % 150 === 0 || completed === catalog.length) {
      console.log(`Progress: ${completed}/${catalog.length} | Matched on TMDB: ${matchedCount} (${((matchedCount / completed) * 100).toFixed(1)}%)`);
    }
  }

  // Rewrite all organized .txt files and metadata.txt files with complete TMDB metadata
  const archiveRoot = path.join(baseDir, "organized-archive");
  const groupedMetadata = {};
  let totalLinksCount = 0;

  for (const item of catalog) {
    const langFolder = langFolderMap[item.language] || `Other (${item.language})`;
    const typeFolder = item.content_type === "movie" ? "Movies (فیلم)" : "Series (سریال)";
    const targetDir = path.join(archiveRoot, langFolder, typeFolder);
    fs.mkdirSync(targetDir, { recursive: true });

    const groupKey = `${langFolder}/${typeFolder}`;
    if (!groupedMetadata[groupKey]) {
      groupedMetadata[groupKey] = { dir: targetDir, items: [] };
    }
    groupedMetadata[groupKey].items.push(item);

    const safeTitle = sanitizeFileName(item.title_en || `Collection-${item.id}`);
    const filePath = path.join(targetDir, `${safeTitle}.txt`);

    const t = item.tmdb || {};
    const lines = [
      `================================================================================`,
      `[HAMECHIZDAN INFO]`,
      `Title (EN)          : ${item.title_en}`,
      `Title (FA)          : ${item.title_fa}`,
      `Collection ID       : ${item.id}`,
      `Type                : ${item.content_type.toUpperCase()} (${item.content_type_fa})`,
      `Language            : ${item.language}${item.accent ? ` (${item.accent})` : ""}`,
      `Age Group           : ${item.age_group || "-"}`,
      `Target Gender       : ${item.gender || "-"}`,
      `Total Episodes      : ${item.total_episodes_count}`,
      `Last Updated        : ${item.last_updated || "-"}`,
      `Site Poster URL     : ${item.thumbnail}`,
      `Site Page URL       : ${item.url}`,
      `Description (FA)    : ${item.meta_description || "-"}`,
      `--------------------------------------------------------------------------------`,
      `[TMDB METADATA]`,
      `TMDB Matched        : ${item.tmdb ? "YES" : "NO"}`,
      `TMDB ID             : ${t.tmdb_id || "-"}`,
      `IMDB ID             : ${t.imdb_id || "-"}`,
      `TMDB Media Type     : ${t.media_type ? t.media_type.toUpperCase() : "-"}`,
      `TMDB Official Title : ${t.title || "-"}`,
      `Original Title      : ${t.original_title || "-"}`,
      `Release Year        : ${t.release_year || "-"}`,
      `Release Date        : ${t.release_date || "-"}`,
      `TMDB Rating         : ${t.rating ? `${t.rating} / 10 (${t.vote_count} votes)` : "-"}`,
      `Genres              : ${(t.genres && t.genres.length) ? t.genres.join(", ") : "-"}`,
      `Origin Country      : ${(t.origin_country && t.origin_country.length) ? t.origin_country.join(", ") : "-"}`,
      `Original Language   : ${t.original_language || "-"}`,
      `Networks / Studio   : ${(t.networks && t.networks.length) ? t.networks.join(", ") : ((t.production_companies && t.production_companies.length) ? t.production_companies.join(", ") : "-")}`,
      `Runtime (Minutes)   : ${t.runtime_minutes ? `${t.runtime_minutes} min` : "-"}`,
      `TMDB Seasons/Eps    : ${t.number_of_seasons ? `${t.number_of_seasons} Seasons / ${t.number_of_episodes || "-"} Episodes` : "-"}`,
      `Status              : ${t.status || "-"}`,
      `TMDB Poster (w500)  : ${t.poster_url || "-"}`,
      `TMDB Poster (Orig)  : ${t.poster_original_url || "-"}`,
      `TMDB Backdrop (TV)  : ${t.backdrop_url || "-"}`,
      `TMDB Backdrop (4K)  : ${t.backdrop_original_url || "-"}`,
      `TMDB Page URL       : ${t.tmdb_url || "-"}`,
      `Overview (EN)       : ${t.overview_en || "-"}`,
      `================================================================================`,
      ``
    ];

    const qualitiesOrder = ["720p", "480p", "360p", ...Object.keys(item.bulk_sources || {}).filter(q => !["720p", "480p", "360p"].includes(q))];
    for (const q of qualitiesOrder) {
      const urls = item.bulk_sources[q];
      if (!urls || urls.length === 0) continue;
      totalLinksCount += urls.length;
      const totalSizeStr = item.total_sizes?.[q] ? ` | Total Size: ${item.total_sizes[q]}` : "";
      lines.push(`### Quality: ${q.toUpperCase()} (${urls.length} files${totalSizeStr})`);
      for (const u of urls) {
        lines.push(u);
      }
      lines.push(``);
    }

    fs.writeFileSync(filePath, lines.join("\n"), "utf8");
  }

  // Write metadata.txt in each folder + master metadata.txt
  const masterMetaLines = [
    `# HAMECHIZDAN + TMDB ENRICHED METADATA CATALOG (FOR ANDROID TV)`,
    `# Total Collections: ${catalog.length} | TMDB Matched: ${matchedCount} | Direct Video Links: ${totalLinksCount}`,
    `================================================================================`,
    ``
  ];

  for (const [groupKey, group] of Object.entries(groupedMetadata)) {
    const folderMatched = group.items.filter(x => x.tmdb).length;
    const folderMetaLines = [
      `# METADATA LIST: ${groupKey}`,
      `# Count: ${group.items.length} (TMDB Matched: ${folderMatched})`,
      `================================================================================`,
      ``
    ];

    for (const it of group.items) {
      const t = it.tmdb || {};
      const entryBlock = [
        `[ID: ${it.id}]`,
        `Title_EN            = ${it.title_en}`,
        `Title_FA            = ${it.title_fa}`,
        `Type                = ${it.content_type} (${it.content_type_fa})`,
        `Language            = ${it.language}`,
        `Accent              = ${it.accent || "-"}`,
        `Age_Group           = ${it.age_group || "-"}`,
        `Gender              = ${it.gender || "-"}`,
        `Episodes_Count      = ${it.total_episodes_count}`,
        `Available_Qualities = ${Object.keys(it.bulk_sources || {}).join(", ") || "-"}`,
        `Total_Sizes         = ${Object.entries(it.total_sizes || {}).map(([k, v]) => `${k}: ${v}`).join(" | ") || "-"}`,
        `Last_Updated        = ${it.last_updated || "-"}`,
        `Site_Poster_URL     = ${it.thumbnail}`,
        `Site_Page_URL       = ${it.url}`,
        `Description_FA      = ${it.meta_description || "-"}`,
        `TMDB_Matched        = ${it.tmdb ? "YES" : "NO"}`,
        `TMDB_ID             = ${t.tmdb_id || "-"}`,
        `IMDB_ID             = ${t.imdb_id || "-"}`,
        `TMDB_Title          = ${t.title || "-"}`,
        `Original_Title      = ${t.original_title || "-"}`,
        `Release_Year        = ${t.release_year || "-"}`,
        `Release_Date        = ${t.release_date || "-"}`,
        `TMDB_Rating         = ${t.rating ? `${t.rating}/10 (${t.vote_count} votes)` : "-"}`,
        `Genres              = ${(t.genres && t.genres.length) ? t.genres.join(", ") : "-"}`,
        `Origin_Country      = ${(t.origin_country && t.origin_country.length) ? t.origin_country.join(", ") : "-"}`,
        `Networks_Studio     = ${(t.networks && t.networks.length) ? t.networks.join(", ") : ((t.production_companies && t.production_companies.length) ? t.production_companies.join(", ") : "-")}`,
        `Runtime_Minutes     = ${t.runtime_minutes || "-"}`,
        `TMDB_Seasons_Eps    = ${t.number_of_seasons ? `${t.number_of_seasons}S / ${t.number_of_episodes || "-"}E` : "-"}`,
        `TMDB_Poster_URL     = ${t.poster_url || "-"}`,
        `TMDB_Backdrop_URL   = ${t.backdrop_url || "-"}`,
        `TMDB_Backdrop_4K    = ${t.backdrop_original_url || "-"}`,
        `Overview_EN         = ${t.overview_en || "-"}`,
        `File_Name           = ${sanitizeFileName(it.title_en || `Collection-${it.id}`)}.txt`,
        `--------------------------------------------------------------------------------`
      ].join("\n");

      folderMetaLines.push(entryBlock);
      masterMetaLines.push(entryBlock);
    }

    fs.writeFileSync(path.join(group.dir, "metadata.txt"), folderMetaLines.join("\n"), "utf8");
  }

  fs.writeFileSync(path.join(archiveRoot, "metadata.txt"), masterMetaLines.join("\n"), "utf8");
  fs.writeFileSync(`${baseDir}/hamechizdan_full_catalog.json`, JSON.stringify(catalog, null, 2), "utf8");

  // Also update lightweight summary json
  const summary = catalog.map(c => ({
    id: c.id,
    title_en: c.title_en,
    title_fa: c.title_fa,
    content_type: c.content_type,
    language: c.language,
    accent: c.accent,
    age_group: c.age_group,
    gender: c.gender,
    total_episodes_count: c.total_episodes_count,
    thumbnail: c.thumbnail,
    meta_description: c.meta_description,
    tmdb: c.tmdb
  }));
  fs.writeFileSync(`${baseDir}/hamechizdan_titles_metadata.json`, JSON.stringify(summary, null, 2), "utf8");

  console.log(`ALL DONE! Matched ${matchedCount}/${catalog.length} titles on TMDB.`);
}

main().catch(console.error);
