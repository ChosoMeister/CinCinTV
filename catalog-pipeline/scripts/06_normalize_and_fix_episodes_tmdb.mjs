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

// Dice coefficient (bigram similarity) + word overlap for typo-tolerant matching
function similarityScore(a, b) {
  const s1 = normalizeStr(a);
  const s2 = normalizeStr(b);
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1.0;
  if (s1.replace(/\s+/g, "") === s2.replace(/\s+/g, "")) return 0.98;

  // Word overlap
  const w1 = s1.split(" ").filter(w => w.length > 1);
  const w2 = s2.split(" ").filter(w => w.length > 1);
  if (w1.length > 0 && w2.length > 0) {
    const set2 = new Set(w2);
    const common = w1.filter(w => set2.has(w)).length;
    const wordScore = (2 * common) / (w1.length + w2.length);
    if (wordScore >= 0.85) return wordScore;
  }

  // Bigrams
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

async function main() {
  const baseDir = BASE_DIR;
  const catalog = JSON.parse(fs.readFileSync(`${baseDir}/hamechizdan_full_catalog.json`, "utf8"));

  const tvSeries = catalog.filter(c => c.tmdb && c.tmdb.media_type === "tv" && c.episodes && c.episodes.length > 0);
  console.log(`Running smart episode correction & alignment for ${tvSeries.length} TV series...`);

  const concurrency = 15;
  let completed = 0;
  let totalCorrectedTitles = 0;
  let totalReorderedEpisodes = 0;
  let totalMatchedEpisodes = 0;

  for (let i = 0; i < tvSeries.length; i += concurrency) {
    const batch = tvSeries.slice(i, i + concurrency);
    await Promise.all(batch.map(async (item) => {
      const tmdbId = item.tmdb.tmdb_id;
      const siteSeasons = [...new Set(item.episodes.map(e => e.season_number || 1))].filter(s => s > 0 && s <= 50);
      // Also include season 1..min(number_of_seasons, 10) if not in siteSeasons so cross-season episodes can be found
      const maxTmdbSeasons = Math.min(item.tmdb.number_of_seasons || 1, 8);
      for (let s = 1; s <= maxTmdbSeasons; s++) {
        if (!siteSeasons.includes(s)) siteSeasons.push(s);
      }

      // Fetch English season episodes + localized season episodes (if non-English cartoon)
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

      if (allTmdbEpisodes.length === 0) return;

      for (const ep of item.episodes) {
        const siteSeason = ep.season_number || 1;
        const siteEpNum = ep.episode_number || 1;
        const siteClean = ep.clean_title || "";
        const isGenericSiteTitle = /^episode\s*\d+$/i.test(siteClean) || /^\d+$/.test(siteClean) || siteClean.length < 2;

        let bestMatch = null;
        let matchMethod = "none";

        // 1. Search by Title similarity across all fetched TMDB episodes (prioritizing same season if tie)
        if (!isGenericSiteTitle) {
          let bestSim = 0;
          let candidate = null;

          for (const te of allTmdbEpisodes) {
            const simEn = similarityScore(siteClean, te.name);
            const simLoc = te.localized_name ? similarityScore(siteClean, te.localized_name) : 0;
            let sim = Math.max(simEn, simLoc);

            // Slight bonus if season and episode number also match
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

        // 2. Fallback to exact (season_number, episode_number) if not matched by title
        if (!bestMatch) {
          const byNum = allTmdbEpisodes.find(te => te.season_number === siteSeason && te.episode_number === siteEpNum);
          if (byNum) {
            bestMatch = byNum;
            matchMethod = "season_episode_number";
          }
        }

        if (bestMatch) {
          totalMatchedEpisodes++;
          const officialTitle = (localizedLang && bestMatch.localized_name && !/^episode\s*\d+/i.test(bestMatch.localized_name))
            ? bestMatch.localized_name
            : (bestMatch.name || ep.clean_title);

          // Check if we corrected a typo or number
          if (officialTitle && officialTitle !== ep.clean_title && !/^episode\s*\d+$/i.test(officialTitle)) {
            totalCorrectedTitles++;
          }
          if (bestMatch.season_number !== ep.season_number || bestMatch.episode_number !== ep.episode_number) {
            totalReorderedEpisodes++;
          }

          ep.site_raw_title = ep.title;
          ep.site_season_number = ep.season_number;
          ep.site_episode_number = ep.episode_number;

          // Apply official TMDB numbering and title as primary display values
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
          ep.display_title = ep.clean_title;
          ep.match_method = "site_only";
        }
      }

      // Sort episodes cleanly by corrected (season_number, episode_number)
      item.episodes.sort((a, b) => {
        if ((a.season_number || 1) !== (b.season_number || 1)) {
          return (a.season_number || 1) - (b.season_number || 1);
        }
        return (a.episode_number || 1) - (b.episode_number || 1);
      });
    }));

    completed += batch.length;
    if (completed % 150 === 0 || completed === tvSeries.length) {
      console.log(`Progress: ${completed}/${tvSeries.length} | Matched: ${totalMatchedEpisodes} | Corrected Titles: ${totalCorrectedTitles} | Fixed Ep Numbers: ${totalReorderedEpisodes}`);
    }
  }

  // Rewrite all organized .txt files and JSON catalog
  const archiveRoot = path.join(baseDir, "organized-archive");
  for (const item of catalog) {
    const langFolder = langFolderMap[item.language] || `Other (${item.language})`;
    const typeFolder = item.content_type === "movie" ? "Movies (فیلم)" : "Series (سریال)";
    const targetDir = path.join(archiveRoot, langFolder, typeFolder);
    fs.mkdirSync(targetDir, { recursive: true });

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
      const totalSizeStr = item.total_sizes?.[q] ? ` | Total Size: ${item.total_sizes[q]}` : "";
      lines.push(`\n### Quality: ${q.toUpperCase()} (${urls.length} files${totalSizeStr})`);
      for (const u of urls) {
        lines.push(u);
      }
    }

    fs.writeFileSync(filePath, lines.join("\n"), "utf8");
  }

  fs.writeFileSync(`${baseDir}/hamechizdan_full_catalog.json`, JSON.stringify(catalog, null, 2), "utf8");
  console.log(`ALL EPISODES NORMALIZED AND SAVED!`);
}

main().catch(console.error);
