import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR = path.resolve(__dirname, '..');

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJjZjdhNGFiZWZkZTU4MzVjNTM5OTNhNDcyYTM0YmViMSIsIm5iZiI6MTc5MjUyNDQxMi4zNjIsInN1YiI6IjZhZDdjMDdjMjEyNGYwMDMxZTdjZTI3NCIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.Ozv3z64IDDNM_0LRnOvUOSjBy0iIgf3_txUOMBjYvrc";

const langFolderMap = {
  "انگلیسی": "English (انگلیسی)",
  "چینی": "Chinese (چینی)",
  "فرانسوی": "French (فرانسوی)",
  "آلمانی": "German (آلمانی)",
  "عربی": "Arabic (عربی)"
};

const tmdbLangCodeMap = {
  "فرانسوی": "fr-FR",
  "آلمانی": "de-DE",
  "چینی": "zh-CN",
  "عربی": "ar-SA"
};

function sanitizeFileName(name) {
  return name
    .replace(/[\/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeStr(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’`"_.,!?:;()\[\]\-–—\/\\&+]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function similarityScore(a, b) {
  const s1 = normalizeStr(a);
  const s2 = normalizeStr(b);
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1.0;
  if (s1.replace(/\s+/g, "") === s2.replace(/\s+/g, "")) return 0.98;

  const w1 = s1.split(" ").filter(w => w.length > 1);
  const w2 = s2.split(" ").filter(w => w.length > 1);
  if (w1.length > 0 && w2.length > 0) {
    const set2 = new Set(w2);
    const common = w1.filter(w => set2.has(w)).length;
    const wordScore = (2 * common) / (w1.length + w2.length);
    if (wordScore >= 0.85) return wordScore;
  }

  const bg1 = [];
  const bg2 = [];
  const c1 = s1.replace(/\s+/g, "");
  const c2 = s2.replace(/\s+/g, "");
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
      await new Promise(res => setTimeout(res, 500));
    }
  }
  return null;
}

async function fetchTmdbObject(mediaType, tmdbId) {
  const d = await tmdbFetch(`https://api.themoviedb.org/3/${mediaType}/${tmdbId}?append_to_response=external_ids`);
  if (!d) return null;

  const releaseDate = d.first_air_date || d.release_date || "";
  const releaseYear = releaseDate ? releaseDate.slice(0, 4) : "";
  const genres = (d.genres || []).map(g => g.name);
  const posterPath = d.poster_path || null;
  const backdropPath = d.backdrop_path || null;

  return {
    tmdb_id: d.id,
    imdb_id: d.external_ids?.imdb_id || d.imdb_id || null,
    media_type: mediaType,
    title: d.name || d.title || "",
    original_title: d.original_name || d.original_title || "",
    original_language: d.original_language || "",
    origin_country: d.origin_country || [],
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
    overview_en: (d.overview || "").replace(/\s+/g, " ").trim(),
    poster_url: posterPath ? `https://image.tmdb.org/t/p/w500${posterPath}` : null,
    poster_original_url: posterPath ? `https://image.tmdb.org/t/p/original${posterPath}` : null,
    backdrop_url: backdropPath ? `https://image.tmdb.org/t/p/w1280${backdropPath}` : null,
    backdrop_original_url: backdropPath ? `https://image.tmdb.org/t/p/original${backdropPath}` : null,
    tmdb_url: `https://www.themoviedb.org/${mediaType}/${d.id}`
  };
}

async function alignSeriesEpisodes(item) {
  if (!item.tmdb || item.tmdb.media_type !== "tv" || !item.episodes || item.episodes.length === 0) return;

  const tmdbId = item.tmdb.tmdb_id;
  const siteSeasons = [...new Set(item.episodes.map(e => e.site_season_number || e.season_number || 1))].filter(s => s > 0 && s <= 50);
  const maxTmdbSeasons = Math.min(item.tmdb.number_of_seasons || 1, 8);
  for (let s = 1; s <= maxTmdbSeasons; s++) {
    if (!siteSeasons.includes(s)) siteSeasons.push(s);
  }

  const allTmdbEpisodes = [];
  const localizedLang = tmdbLangCodeMap[item.language];

  await Promise.all(siteSeasons.map(async (sNum) => {
    const [enData, locData] = await Promise.all([
      tmdbFetch(`https://api.themoviedb.org/3/tv/${tmdbId}/season/${sNum}?language=en-US`),
      localizedLang ? tmdbFetch(`https://api.themoviedb.org/3/tv/${tmdbId}/season/${sNum}?language=${localizedLang}`) : Promise.resolve(null)
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
          localized_name: locEp?.name || "",
          localized_overview: locEp?.overview || ""
        });
      }
    }
  }));

  for (const ep of item.episodes) {
    const siteSeason = ep.site_season_number || ep.season_number || 1;
    const siteEpNum = ep.site_episode_number || ep.episode_number || 1;
    const siteClean = ep.clean_title || "";
    const isGenericSiteTitle = /^episode\s*\d+$/i.test(siteClean) || /^\d+$/.test(siteClean) || siteClean.length < 2;

    let bestMatch = null;
    let matchMethod = "none";

    if (!isGenericSiteTitle && allTmdbEpisodes.length > 0) {
      let bestSim = 0;
      let candidate = null;

      for (const te of allTmdbEpisodes) {
        const simEn = similarityScore(siteClean, te.name);
        const simLoc = te.localized_name ? similarityScore(siteClean, te.localized_name) : 0;
        let sim = Math.max(simEn, simLoc);

        if (te.season_number === siteSeason && te.episode_number === siteEpNum) {
          sim += 0.08;
        } else if (te.season_number === siteSeason) {
          sim += 0.03;
        }

        if (sim > bestSim) {
          bestSim = sim;
          candidate = te;
        }
      }

      if (candidate && bestSim >= 0.62) {
        bestMatch = candidate;
        matchMethod = bestSim >= 0.9 ? "exact_title" : "fuzzy_title_corrected";
      }
    }

    if (!bestMatch && allTmdbEpisodes.length > 0) {
      const byNum = allTmdbEpisodes.find(te => te.season_number === siteSeason && te.episode_number === siteEpNum);
      if (byNum) {
        bestMatch = byNum;
        matchMethod = "season_episode_number";
      }
    }

    if (bestMatch) {
      const officialTitle = (localizedLang && bestMatch.localized_name && !/^episode\s*\d+/i.test(bestMatch.localized_name))
        ? bestMatch.localized_name
        : (bestMatch.name || ep.clean_title);

      ep.site_raw_title = ep.site_raw_title || ep.title;
      ep.site_season_number = siteSeason;
      ep.site_episode_number = siteEpNum;

      ep.season_number = bestMatch.season_number;
      ep.episode_number = bestMatch.episode_number;
      ep.display_title = (!/^episode\s*\d+$/i.test(officialTitle)) ? officialTitle : ep.clean_title;
      ep.match_method = matchMethod;

      ep.tmdb_episode = {
        tmdb_episode_id: bestMatch.id,
        season_number: bestMatch.season_number,
        episode_number: bestMatch.episode_number,
        name: bestMatch.name || "",
        localized_name: bestMatch.localized_name || "",
        overview: (bestMatch.overview || bestMatch.localized_overview || "").replace(/\s+/g, " ").trim(),
        air_date: bestMatch.air_date || "",
        runtime: bestMatch.runtime || item.tmdb.runtime_minutes || null,
        rating: bestMatch.vote_average ? Number(bestMatch.vote_average.toFixed(1)) : 0,
        still_url: bestMatch.still_path ? `https://image.tmdb.org/t/p/w500${bestMatch.still_path}` : null,
        still_original_url: bestMatch.still_path ? `https://image.tmdb.org/t/p/original${bestMatch.still_path}` : null
      };
    } else {
      ep.season_number = siteSeason;
      ep.episode_number = siteEpNum;
      ep.display_title = ep.clean_title || ep.title;
      ep.match_method = "site_only";
      delete ep.tmdb_episode;
    }
  }

  item.episodes.sort((a, b) => {
    if ((a.season_number || 1) !== (b.season_number || 1)) {
      return (a.season_number || 1) - (b.season_number || 1);
    }
    return (a.episode_number || 1) - (b.episode_number || 1);
  });
}

function resetEpisodesToSiteOnly(item) {
  if (!item.episodes) return;
  item.episodes.forEach((ep, idx) => {
    ep.season_number = item.content_type === "movie" ? 0 : (ep.site_season_number || ep.season_number || 1);
    ep.episode_number = item.content_type === "movie" ? (idx + 1) : (ep.site_episode_number || ep.episode_number || (idx + 1));
    ep.display_title = ep.clean_title || ep.title;
    ep.match_method = "site_only";
    delete ep.tmdb_episode;
  });
}

async function main() {
  const catalogPath = path.join(BASE_DIR, "hamechizdan_full_catalog.json");
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));

  // 1. Exact TMDB ID overrides for mis-scored or Chinese-character titles
  const exactFixes = {
    306: { type: "movie", id: 675445 },   // PAW Patrol: The Movie (2021)
    436: { type: "movie", id: 779796 },   // The Magic School Bus Rides Again: In the Zone (2020)
    529: { type: "tv", id: 328344 },      // Milo (2003)
    1027: { type: "tv", id: 96023 },      // Yoko (2016)
    895: { type: "tv", id: 72473 },       // Tina & Tony (2015)
    860: { type: "tv", id: 288048 },      // Rocket Girl (2020)
    558: { type: "tv", id: 16673 },       // Kleine Prinzessin -> Little Princess (2007)
    548: { type: "tv", id: 70272 },       // Conni -> Meine Freundin Conni (2012)
    500: { type: "tv", id: 275521 },      // Daddy Baby -> 爹地宝贝之神奇哈酷
    482: { type: "tv", id: 77379 },       // Pinkalicious & Peterrific (2018)
    646: { type: "tv", id: 319579 },      // Siraj -> سراج (2022)
    369: { type: "tv", id: 215768 },      // BabyTiger -> 开心贝乐虎 (2021)
    1063: { type: "tv", id: 211994 },     // Mengsaike -> 萌赛可 (2022)
    420: { type: "tv", id: 242285 },      // Panda and Springbok -> 熊猫和小跳羚 (2021)
    118: { type: "tv", id: 102562 },      // Little Baby Bum (2011)
    330: { type: "tv", id: 102562 }       // Little Baby Bum Chinese (2011)
  };

  // 2. False positive IDs (adult/unrelated movies/anime matched to thematic/YouTube compilations) -> set tmdb = null
  const clearIds = new Set([
    30,   // Disney Junior compilation (matched to Disney Junior Ariel)
    1093, // Dim and Dam (matched to 1965 French doc)
    1065, // Pirate School (matched to 1991 anime Be-Bop High School)
    1034, // Let's Go See (matched to Nuclear Reactor doc)
    1032, // Tip Top (matched to 1961 Top Cat)
    900,  // The Carter Family (matched to CMF: The Carter Mafia Family)
    873,  // The Magic Kitchen (matched to Honkai: Star Rail)
    819,  // Tam Tam TV (matched to Lupin the Third)
    718,  // Hoot Hoot Go (matched to 1973 short The Shoe Must Go On)
    696,  // Rayan Arabic (matched to Jack & Rayane)
    692,  // My Big Big World (matched to French adult drama)
    620,  // Baba BaoBao (matched to Mrs. Doubtfire)
    519,  // Lets Play (matched to French show Kiwi)
    518,  // Baobei Chinese (matched to Dinosaur Baby Holy Heroes)
    481,  // AliMiMi (matched to Muhammad Ali doc)
    404,  // Little Inventor (matched to 1958 short)
    402,  // Bob The Train (matched to Bob the Builder)
    399,  // Doggy (matched to Doggyworld)
    367,  // Deer Blue (matched to Kauyumari)
    337,  // BabyClay (matched to How to make THE CLAY BABY)
    272,  // Kids Meet (matched to Katy Meets the Aliens)
    179,  // Time for School (matched to Back in Time for School)
    174,  // BBC Learning English (matched to True Stories drama)
    170,  // Fun Kids English (matched to 1990 festival)
    165   // Magic Lantern (matched to 1987 film)
  ]);

  // Also clear all generic thematic/audio/entertainment compilation categories ("موضوعی", "صوتی", "سرگرمی")
  // EXCEPT [91] Science Experiments which is genuinely Science Max: Experiments at Large
  for (const item of catalog) {
    if (["موضوعی", "صوتی", "سرگرمی"].includes(item.breadcrumb_type) && item.id !== 91) {
      clearIds.add(item.id);
    }
  }

  let fixedCount = 0;
  let clearedCount = 0;

  for (const item of catalog) {
    // Fix stray Arabic diacritics on English titles (e.g. "ٖٖSofia the First")
    if (item.title_en) {
      item.title_en = item.title_en.replace(/[\u064B-\u065F\u0670]/g, "").trim();
    }

    if (exactFixes[item.id]) {
      const spec = exactFixes[item.id];
      console.log(`Fetching exact TMDB match for [${item.id}] "${item.title_en}" -> ${spec.type}:${spec.id}...`);
      const tmdbObj = await fetchTmdbObject(spec.type, spec.id);
      if (tmdbObj) {
        item.tmdb = tmdbObj;
        if (spec.type === "tv") {
          await alignSeriesEpisodes(item);
        } else {
          resetEpisodesToSiteOnly(item);
        }
        fixedCount++;
      }
    } else if (clearIds.has(item.id) && item.tmdb !== null) {
      console.log(`Clearing false-positive TMDB match on [${item.id}] "${item.title_en}" (was: "${item.tmdb.title}")`);
      item.tmdb = null;
      resetEpisodesToSiteOnly(item);
      clearedCount++;
    }
  }

  console.log(`\nApplied ${fixedCount} exact TMDB fixes and cleared ${clearedCount} false-positive matches.`);

  // Regenerate organized-archive and metadata files
  const archiveRoot = path.join(BASE_DIR, "organized-archive");
  if (fs.existsSync(archiveRoot)) {
    fs.rmSync(archiveRoot, { recursive: true, force: true });
  }
  fs.mkdirSync(archiveRoot, { recursive: true });

  const groupedMetadata = {};
  let totalLinksCount = 0;
  const matchedCount = catalog.filter(x => x.tmdb).length;

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
      `Total Episodes      : ${item.episodes.length}`,
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

    lines.push(`### EPISODE GUIDE & METADATA (${item.episodes.length} Episodes - Corrected & Verified via TMDB)`);
    lines.push(`--------------------------------------------------------------------------------`);
    for (const ep of item.episodes) {
      const sTag = item.content_type === "movie"
        ? `PART ${String(ep.episode_number).padStart(2, "0")}`
        : `S${String(ep.season_number).padStart(2, "0")}E${String(ep.episode_number).padStart(2, "0")}`;
      const te = ep.tmdb_episode || {};
      const dispTitle = ep.display_title || ep.clean_title || ep.title;
      lines.push(`[${sTag}] ${dispTitle} (Site Raw: ${ep.title} | ID: ${ep.episode_id} | Match: ${ep.match_method || "site_only"})`);
      if (te.name && te.name !== dispTitle) {
        lines.push(`  TMDB EN Title : ${te.name}`);
      }
      if (te.air_date || te.runtime || te.rating) {
        lines.push(`  Info          : Air Date: ${te.air_date || "-"} | Runtime: ${te.runtime ? `${te.runtime}m` : "-"} | Rating: ${te.rating || "-"}`);
      }
      lines.push(`  Thumbnail     : ${te.still_url || ep.thumbnail}`);
      if (te.still_url && ep.thumbnail) {
        lines.push(`  Site Thumb    : ${ep.thumbnail}`);
      }
      if (te.overview) {
        lines.push(`  Overview      : ${te.overview}`);
      }
      for (const [q, url] of Object.entries(ep.sources || {})) {
        const sz = ep.file_sizes?.[q] ? ` (${ep.file_sizes[q]})` : "";
        lines.push(`  Stream ${q.toUpperCase().padEnd(5)} : ${url}${sz}`);
      }
      lines.push(``);
    }

    lines.push(`================================================================================`);
    lines.push(`### BULK DIRECT LINKS BY QUALITY`);
    lines.push(`================================================================================`);
    const qualitiesOrder = ["720p", "480p", "360p", ...Object.keys(item.bulk_sources || {}).filter(q => !["720p", "480p", "360p"].includes(q))];
    for (const q of qualitiesOrder) {
      const urls = item.bulk_sources?.[q];
      if (!urls || urls.length === 0) continue;
      totalLinksCount += urls.length;
      const totalSizeStr = item.total_sizes?.[q] ? ` | Total Size: ${item.total_sizes[q]}` : "";
      lines.push(`\n### Quality: ${q.toUpperCase()} (${urls.length} files${totalSizeStr})`);
      for (const u of urls) {
        lines.push(u);
      }
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
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2), "utf8");

  // Update hamechizdan_titles_metadata.json
  const summary = catalog.map(c => ({
    id: c.id,
    title_en: c.title_en,
    title_fa: c.title_fa,
    content_type: c.content_type,
    language: c.language,
    accent: c.accent,
    age_group: c.age_group,
    gender: c.gender,
    total_episodes_count: c.episodes.length,
    thumbnail: c.thumbnail,
    meta_description: c.meta_description,
    tmdb: c.tmdb
  }));
  fs.writeFileSync(path.join(BASE_DIR, "hamechizdan_titles_metadata.json"), JSON.stringify(summary, null, 2), "utf8");

  // Update hamechizdan_titles_metadata.csv with accurate total episode counts & TMDB info
  const csvEsc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csvHeader = "id,title_en,tmdb_search_query,title_fa,content_type,language,badges,episodes_count,tmdb_id,imdb_id,release_year,rating,last_updated,thumbnail,url";
  const csvRows = catalog.map(c => [
    c.id,
    csvEsc(c.title_en),
    csvEsc(c.tmdb_query || c.title_en),
    csvEsc(c.title_fa),
    csvEsc(c.content_type),
    csvEsc(c.language),
    csvEsc((c.badges || []).join(" | ")),
    c.episodes.length,
    c.tmdb?.tmdb_id || "",
    csvEsc(c.tmdb?.imdb_id || ""),
    csvEsc(c.tmdb?.release_year || ""),
    c.tmdb?.rating || "",
    csvEsc(c.last_updated),
    csvEsc(c.tmdb?.poster_url || c.thumbnail),
    csvEsc(c.url)
  ].join(","));
  fs.writeFileSync(path.join(BASE_DIR, "hamechizdan_titles_metadata.csv"), [csvHeader, ...csvRows].join("\n"), "utf8");

  // Update hamechizdan_playlist_720p.m3u with ALL episodes (using 720p or fallback 360p)
  const m3uLines = ["#EXTM3U"];
  let m3uTrackCount = 0;
  for (const c of catalog) {
    const groupTitle = `${c.title_en} (${c.title_fa})`.replace(/"/g, "'");
    for (const ep of c.episodes) {
      const streamUrl = ep.sources?.["720p"] || ep.sources?.["480p"] || ep.sources?.["360p"] || Object.values(ep.sources || {})[0];
      if (!streamUrl) continue;
      const sTag = c.content_type === "movie"
        ? (c.episodes.length > 1 ? `Part ${ep.episode_number}` : "Movie")
        : `S${String(ep.season_number || 1).padStart(2, "0")}E${String(ep.episode_number || 1).padStart(2, "0")}`;
      const dispTitle = ep.display_title || ep.clean_title || ep.title;
      const thumb = ep.tmdb_episode?.still_url || ep.thumbnail || c.tmdb?.poster_url || c.thumbnail || "";
      m3uLines.push(`#EXTINF:-1 tvg-id="${ep.episode_id || ""}" tvg-logo="${thumb}" group-title="${groupTitle}",${c.title_en} - ${sTag} - ${dispTitle}`);
      m3uLines.push(streamUrl);
      m3uTrackCount++;
    }
  }
  fs.writeFileSync(path.join(BASE_DIR, "hamechizdan_playlist_720p.m3u"), m3uLines.join("\n"), "utf8");

  console.log(`Updated M3U playlist with ${m3uTrackCount} episodes (previously only 10,633)!`);
  console.log(`All catalog files, CSV, M3U, and organized-archive have been cleanly updated.`);
}

main().catch(console.error);
