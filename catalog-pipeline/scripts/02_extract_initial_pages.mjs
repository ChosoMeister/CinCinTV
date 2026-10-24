import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR = path.resolve(__dirname, '..');

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

function decodeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&amp;/g, "&")
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
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
      await new Promise(res => setTimeout(res, 800));
    }
  }
  return "";
}

function parseCollectionHtml(cid, html) {
  if (!html) return null;

  const titleEnMatch = html.match(/<h1[^>]*class="[^"]*collections-show-card-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/);
  const titleFaMatch = html.match(/<p[^>]*class="[^"]*collections-show-card-subtitle[^"]*"[^>]*>([\s\S]*?)<\/p>/);
  const thumbMatch = html.match(/<div class="collections-show-card-media">\s*<img[^>]+src="([^"]+)"/);
  const updatedMatch = html.match(/آخرین بروزرسانی:\s*<span[^>]*>([\s\S]*?)<\/span>/);

  // Extract badges (language, accent, gender, age_group)
  const badges = [];
  const badgeRegex = /class="collections-show-badge[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let bm;
  while ((bm = badgeRegex.exec(html)) !== null) {
    badges.push(decodeHtml(bm[1].replace(/<[^>]+>/g, "")));
  }

  // Extract episodes
  const episodes = [];
  const epParts = html.split('<div class="collections-episodes-item">').slice(1);
  for (const part of epParts) {
    const epIdMatch = part.match(/href="https:\/\/hamechizdan\.com\/c\/e\/(\d+)/) || part.match(/download-dropdown-(\d+)/);
    const epId = epIdMatch ? parseInt(epIdMatch[1]) : null;
    const epTitleMatch = part.match(/class="collections-episode-title[^"]*">([\s\S]*?)<\/p>/);
    const epThumbMatch = part.match(/<div class="collections-episode-media">\s*<img[^>]+src="([^"]+)"/);
    const epDateMatch = part.match(/بارگذاری:\s*<span[^>]*>([\s\S]*?)<\/span>/);

    const sources = {};
    const fileSizes = {};
    const dlLinkRegex = /<a\s+href="(https:\/\/[^"]+\.mp4)"[^>]*>\s*([0-9]+p|[a-zA-Z0-9]+)\s*(?:<span>\(([^)]+)\)<\/span>)?\s*<\/a>/g;
    let dlm;
    while ((dlm = dlLinkRegex.exec(part)) !== null) {
      const url = dlm[1];
      const quality = dlm[2].trim();
      const size = dlm[3] ? decodeHtml(dlm[3]) : "";
      sources[quality] = url;
      if (size) fileSizes[quality] = size;
    }

    episodes.push({
      episode_id: epId,
      title: decodeHtml(epTitleMatch ? epTitleMatch[1] : ""),
      thumbnail: epThumbMatch ? epThumbMatch[1] : "",
      upload_date: epDateMatch ? decodeHtml(epDateMatch[1]) : "",
      sources,
      file_sizes: fileSizes
    });
  }

  return {
    id: cid,
    url: `https://hamechizdan.com/c/${cid}`,
    title_en: decodeHtml(titleEnMatch ? titleEnMatch[1] : ""),
    title_fa: decodeHtml(titleFaMatch ? titleFaMatch[1] : ""),
    thumbnail: thumbMatch ? thumbMatch[1] : "",
    badges,
    last_updated: updatedMatch ? decodeHtml(updatedMatch[1]) : "",
    episodes_count: episodes.length,
    episodes
  };
}

async function main() {
  const cookieHeader = await getCookiesFromChrome();
  const indexData = JSON.parse(fs.readFileSync("/tmp/collections_index.json", "utf8"));
  const allIds = indexData.map(x => x.id).sort((a, b) => b - a);
  console.log(`Starting extraction for ${allIds.length} collections...`);

  const results = [];
  const concurrency = 12;
  let completed = 0;

  for (let i = 0; i < allIds.length; i += concurrency) {
    const batch = allIds.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(async (cid) => {
      const html = await fetchText(`https://hamechizdan.com/c/${cid}`, cookieHeader);
      return parseCollectionHtml(cid, html);
    }));
    for (const r of batchResults) {
      if (r && (r.title_en || r.episodes.length > 0)) {
        results.push(r);
      }
    }
    completed += batch.length;
    if (completed % 120 === 0 || completed === allIds.length) {
      console.log(`Progress: ${completed}/${allIds.length} (Valid collections: ${results.length})`);
    }
  }

  const outDir = BASE_DIR;
  fs.mkdirSync(outDir, { recursive: true });

  // Full dataset with all episodes and video sources
  fs.writeFileSync(`${outDir}/hamechizdan_full_catalog.json`, JSON.stringify(results, null, 2));

  // Lightweight titles & metadata summary for quick TMDB matching
  const summary = results.map(c => ({
    id: c.id,
    title_en: c.title_en,
    title_fa: c.title_fa,
    thumbnail: c.thumbnail,
    badges: c.badges,
    last_updated: c.last_updated,
    episodes_count: c.episodes_count,
    url: c.url
  }));
  fs.writeFileSync(`${outDir}/hamechizdan_titles_metadata.json`, JSON.stringify(summary, null, 2));

  // Flat list of all video sources
  let totalEpisodes = 0;
  let totalVideoLinks = 0;
  for (const c of results) {
    totalEpisodes += c.episodes.length;
    for (const ep of c.episodes) {
      totalVideoLinks += Object.keys(ep.sources).length;
    }
  }

  console.log(`Done! Saved ${results.length} collections, ${totalEpisodes} episodes, ${totalVideoLinks} direct video links.`);
}

main().catch(console.error);
