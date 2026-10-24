import http from 'http';
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

function getCookiesFromChrome() {
  return new Promise((resolve, reject) => {
    http.get("http://127.0.0.1:9222/json/list", (res) => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => {
        const targets = JSON.parse(body);
        const page = targets.find(t => t.type === "page");
        if (!page) return reject(new Error("No page found in Chrome"));
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        ws.onopen = () => {
          ws.send(JSON.stringify({id: 1, method: "Network.getCookies", params: {urls: ["https://hamechizdan.com"]}}));
        };
        ws.onmessage = (msg) => {
          const cookies = JSON.parse(msg.data).result.cookies;
          const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join("; ");
          ws.close();
          resolve(cookieHeader);
        };
        ws.onerror = reject;
      });
    }).on("error", reject);
  });
}

function sanitizeFileName(name) {
  return name
    .replace(/[\/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function parseEpisodeTitle(rawTitle, indexFallback) {
  const str = (rawTitle || "").trim();
  // Pattern 1: S01E02-Title or S1E2 - Title
  const m1 = str.match(/^S(\d+)\s*E(\d+)\s*[-–—:_.]*\s*(.*)$/i);
  if (m1) {
    return {
      season_number: parseInt(m1[1], 10),
      episode_number: parseInt(m1[2], 10),
      clean_title: m1[3].trim() || `Episode ${parseInt(m1[2], 10)}`
    };
  }
  // Pattern 2: E02-Title or Ep 02 - Title
  const m2 = str.match(/^(?:Ep|Episode|E)\s*(\d+)\s*[-–—:_.]*\s*(.*)$/i);
  if (m2) {
    return {
      season_number: 1,
      episode_number: parseInt(m2[1], 10),
      clean_title: m2[2].trim() || `Episode ${parseInt(m2[1], 10)}`
    };
  }
  // Pattern 3: 01 - Title or 01. Title
  const m3 = str.match(/^(\d{1,3})\s*[-–—:_.]+\s*(.+)$/);
  if (m3) {
    return {
      season_number: 1,
      episode_number: parseInt(m3[1], 10),
      clean_title: m3[2].trim()
    };
  }
  return {
    season_number: 1,
    episode_number: indexFallback,
    clean_title: str || `Episode ${indexFallback}`
  };
}

async function fetchText(url, cookieHeader, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, {
        headers: {
          "Cookie": cookieHeader,
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"
        }
      });
      if (r.ok) return await r.text();
      if (r.status === 404) return "";
    } catch (e) {
      if (i === retries - 1) return "";
      await new Promise(res => setTimeout(res, 600));
    }
  }
  return "";
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
  const cookieHeader = await getCookiesFromChrome();
  const baseDir = BASE_DIR;
  const catalog = JSON.parse(fs.readFileSync(`${baseDir}/hamechizdan_full_catalog.json`, "utf8"));

  // Step 1: For any collection where episodes.length < total_episodes_count, fetch full `var playlist` from its first episode page!
  const needsFullPlaylist = catalog.filter(c => c.episodes && c.episodes.length > 0 && c.total_episodes_count > c.episodes.length);
  console.log(`Collections needing full multi-page playlist fetch: ${needsFullPlaylist.length}`);

  const concurrency = 15;
  let plCompleted = 0;
  for (let i = 0; i < needsFullPlaylist.length; i += concurrency) {
    const batch = needsFullPlaylist.slice(i, i + concurrency);
    await Promise.all(batch.map(async (item) => {
      const firstEpId = item.episodes[0]?.episode_id;
      if (!firstEpId) return;
      const html = await fetchText(`https://hamechizdan.com/c/e/${firstEpId}?pp=1`, cookieHeader);
      const m = html.match(/var playlist = JSON\.parse\(\x27(.*?)\x27\);/);
      if (m) {
        try {
          const rawJson = JSON.parse(`"${m[1]}"`);
          const pl = JSON.parse(rawJson);
          if (Array.isArray(pl) && pl.length > item.episodes.length) {
            // Preserve upload_date from page 1 if available
            const oldDates = new Map(item.episodes.map(e => [e.episode_id, e.upload_date]));
            item.episodes = pl.map(p => ({
              episode_id: p.id,
              title: p.title || "",
              thumbnail: p.thumbnail || item.thumbnail,
              upload_date: oldDates.get(p.id) || "",
              sources: p.urls || {},
              file_sizes: p.file_sizes || {}
            }));
            item.episodes_count = item.episodes.length;
            item.total_episodes_count = Math.max(item.total_episodes_count, item.episodes.length);
          }
        } catch (e) {
          // ignore parse error
        }
      }
    }));
    plCompleted += batch.length;
    if (plCompleted % 60 === 0 || plCompleted === needsFullPlaylist.length) {
      console.log(`Playlist fetch progress: ${plCompleted}/${needsFullPlaylist.length}`);
    }
  }

  // Step 2: Parse Season & Episode numbers on EVERY episode in the catalog
  for (const item of catalog) {
    if (!item.episodes) item.episodes = [];
    item.episodes.forEach((ep, idx) => {
      const parsed = parseEpisodeTitle(ep.title, idx + 1);
      ep.season_number = item.content_type === "movie" ? 0 : parsed.season_number;
      ep.episode_number = item.content_type === "movie" ? (idx + 1) : parsed.episode_number;
      ep.clean_title = parsed.clean_title;
    });
  }

  // Step 3: Fetch TMDB Season Episode metadata for matched TV series
  const tvMatched = catalog.filter(c => c.tmdb && c.tmdb.media_type === "tv" && c.episodes.length > 0);
  console.log(`Enriching episode-level TMDB data for ${tvMatched.length} TV series...`);

  let tvCompleted = 0;
  let totalEpisodesMatchedTmdb = 0;

  for (let i = 0; i < tvMatched.length; i += concurrency) {
    const batch = tvMatched.slice(i, i + concurrency);
    await Promise.all(batch.map(async (item) => {
      const tmdbId = item.tmdb.tmdb_id;
      const uniqueSeasons = [...new Set(item.episodes.map(e => e.season_number || 1))].filter(s => s > 0 && s <= 50);

      const seasonDataMap = new Map();
      for (const sNum of uniqueSeasons) {
        const sJson = await tmdbFetch(`https://api.themoviedb.org/3/tv/${tmdbId}/season/${sNum}`);
        if (sJson && Array.isArray(sJson.episodes)) {
          seasonDataMap.set(sNum, sJson.episodes);
        }
      }

      // Match episodes by (season_number, episode_number) OR by clean_title similarity
      for (const ep of item.episodes) {
        const sEpisodes = seasonDataMap.get(ep.season_number) || seasonDataMap.get(1) || [];
        if (sEpisodes.length === 0) continue;

        let tEp = sEpisodes.find(x => x.episode_number === ep.episode_number);
        const cleanLower = (ep.clean_title || "").toLowerCase();
        if (!tEp && cleanLower.length > 3) {
          tEp = sEpisodes.find(x => (x.name || "").toLowerCase() === cleanLower || (x.name || "").toLowerCase().includes(cleanLower));
        }

        if (tEp) {
          totalEpisodesMatchedTmdb++;
          ep.tmdb_episode = {
            tmdb_episode_id: tEp.id,
            name: tEp.name || "",
            overview: (tEp.overview || "").replace(/\s+/g, " ").trim(),
            air_date: tEp.air_date || "",
            runtime: tEp.runtime || item.tmdb.runtime_minutes || null,
            rating: tEp.vote_average ? Number(tEp.vote_average.toFixed(1)) : 0,
            still_url: tEp.still_path ? `https://image.tmdb.org/t/p/w500${tEp.still_path}` : null,
            still_original_url: tEp.still_path ? `https://image.tmdb.org/t/p/original${tEp.still_path}` : null
          };
        }
      }
    }));

    tvCompleted += batch.length;
    if (tvCompleted % 150 === 0 || tvCompleted === tvMatched.length) {
      console.log(`TMDB Season/Episode progress: ${tvCompleted}/${tvMatched.length} (Matched episodes: ${totalEpisodesMatchedTmdb})`);
    }
  }

  // Step 4: Rewrite all .txt files and JSON files with the structured Episode Guide + Bulk Links
  const archiveRoot = path.join(baseDir, "organized-archive");
  let totalEpisodesInCatalog = 0;

  for (const item of catalog) {
    totalEpisodesInCatalog += item.episodes.length;
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

    // Section A: Detailed Episode Guide (Season, Episode, Title, Thumbnail, TMDB Still, Runtime, Overview, Direct 720p & 360p Links)
    lines.push(`### EPISODE GUIDE & METADATA (${item.episodes.length} Episodes)`);
    lines.push(`--------------------------------------------------------------------------------`);
    for (const ep of item.episodes) {
      const sTag = item.content_type === "movie"
        ? `PART ${String(ep.episode_number).padStart(2, "0")}`
        : `S${String(ep.season_number).padStart(2, "0")}E${String(ep.episode_number).padStart(2, "0")}`;
      const te = ep.tmdb_episode || {};
      lines.push(`[${sTag}] ${ep.clean_title} (Raw: ${ep.title} | ID: ${ep.episode_id})`);
      if (te.name && te.name.toLowerCase() !== ep.clean_title.toLowerCase()) {
        lines.push(`  TMDB Ep Title : ${te.name}`);
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

    // Section B: Raw Bulk Links grouped by Quality (for quick copy/paste)
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
  console.log(`COMPLETE! Total episodes with full metadata across all 1041 collections: ${totalEpisodesInCatalog} (TMDB episode matches: ${totalEpisodesMatchedTmdb})`);
}

main().catch(console.error);
