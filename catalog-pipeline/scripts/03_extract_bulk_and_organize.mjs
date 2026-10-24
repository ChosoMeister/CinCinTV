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

function sanitizeFileName(name) {
  return name
    .replace(/[\/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanForTmdb(title) {
  return title
    .replace(/\b(Chinese|French|German|Arabic|Spanish|Russian|Turkish|Italian|Korean|Japanese|Deutsch|English)\b/gi, "")
    .replace(/\s*[-–—]\s*$/, "")
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

function parseMainPageExtra(html) {
  if (!html) return { breadcrumb_type: "", meta_description: "", total_sizes: {} };

  const metaDescMatch = html.match(/<meta name="description" content="([^"]*)"/);
  const meta_description = metaDescMatch ? decodeHtml(metaDescMatch[1]) : "";

  let breadcrumb_type = "";
  const bcMatch = html.match(/"@type":\s*"BreadcrumbList"[\s\S]*?<\/script>/);
  if (bcMatch) {
    const names = [...bcMatch[0].matchAll(/"name":\s*"([^"]+)"/g)].map(m => m[1]);
    // Usually: ["لیست کارتون‌ها", "انگلیسی", "سریالی", "عنوان"]
    if (names.length >= 3) {
      breadcrumb_type = names[2];
    }
  }

  const total_sizes = {};
  const sizeModalMatch = html.match(/id="episodesSize"[\s\S]*?<ul[^>]*>([\s\S]*?)<\/ul>/);
  if (sizeModalMatch) {
    const liRegex = /<span dir="ltr"[^>]*>([\s\S]*?)<\/span>\s*<span[^>]*>([\s\S]*?)<\/span>/g;
    let lm;
    while ((lm = liRegex.exec(sizeModalMatch[1])) !== null) {
      total_sizes[decodeHtml(lm[1])] = decodeHtml(lm[2]);
    }
  }

  return { breadcrumb_type, meta_description, total_sizes };
}

function parseBulkDownloadHtml(html) {
  const qualities = {};
  if (!html) return qualities;

  const accRegex = /<div class="bulk-download-accordion[\s\S]*?<\/ul>\s*<\/div>/g;
  let am;
  while ((am = accRegex.exec(html)) !== null) {
    const block = am[0];
    const headerMatch = block.match(/دانلود با کیفیت\s*([0-9a-zA-Z]+)/i) || block.match(/copy-([0-9a-zA-Z]+)-0/);
    const qKey = headerMatch ? headerMatch[1].toLowerCase() : "unknown";
    const linkBlocks = [...block.matchAll(/<div class="links hidden">([\s\S]*?)<\/div>/g)].map(m => m[1].trim());
    const links = linkBlocks
      .join("\n")
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(s => s.startsWith("http"));
    if (links.length > 0) {
      qualities[qKey] = [...new Set(links)];
    }
  }

  return qualities;
}

const langFolderMap = {
  "انگلیسی": "English (انگلیسی)",
  "چینی": "Chinese (چینی)",
  "فرانسوی": "French (فرانسوی)",
  "آلمانی": "German (آلمانی)",
  "عربی": "Arabic (عربی)"
};

async function main() {
  const cookieHeader = await getCookiesFromChrome();
  const baseDir = BASE_DIR;
  const existingCatalog = JSON.parse(fs.readFileSync(`${baseDir}/hamechizdan_full_catalog.json`, "utf8"));

  // First get the exact 150 movie IDs from /collections/9
  const movieIds = new Set();
  for (let p = 1; p <= 8; p++) {
    const html = await fetchText(`https://hamechizdan.com/collections/9?page=${p}`, cookieHeader);
    const ids = [...html.matchAll(/href="https:\/\/hamechizdan\.com\/c\/(\d+)/g)].map(m => parseInt(m[1]));
    for (const id of ids) movieIds.add(id);
  }
  console.log(`Loaded ${movieIds.size} movie IDs from /collections/9.`);

  console.log(`Fetching /bulk-download/{id} and extra metadata for ${existingCatalog.length} collections...`);
  const concurrency = 15;
  let completed = 0;

  for (let i = 0; i < existingCatalog.length; i += concurrency) {
    const batch = existingCatalog.slice(i, i + concurrency);
    await Promise.all(batch.map(async (item) => {
      const [mainHtml, bulkHtml] = await Promise.all([
        fetchText(`https://hamechizdan.com/c/${item.id}`, cookieHeader),
        fetchText(`https://hamechizdan.com/bulk-download/${item.id}`, cookieHeader)
      ]);

      const extra = parseMainPageExtra(mainHtml);
      const bulkQualities = parseBulkDownloadHtml(bulkHtml);

      // Fallback to episode links from main page if bulk-download was empty (e.g. single movie or audio)
      if (Object.keys(bulkQualities).length === 0 && item.episodes && item.episodes.length > 0) {
        for (const ep of item.episodes) {
          for (const [q, url] of Object.entries(ep.sources || {})) {
            const qKey = q.toLowerCase();
            if (!bulkQualities[qKey]) bulkQualities[qKey] = [];
            if (!bulkQualities[qKey].includes(url)) bulkQualities[qKey].push(url);
          }
        }
      }

      item.breadcrumb_type = extra.breadcrumb_type;
      item.meta_description = extra.meta_description;
      item.total_sizes = extra.total_sizes;
      item.bulk_sources = bulkQualities;

      const isMovie = movieIds.has(item.id) || extra.breadcrumb_type.includes("سینمایی");
      item.content_type = isMovie ? "movie" : "series";
      item.content_type_fa = isMovie ? "فیلم (سینمایی)" : "سریال";

      // Determine language
      const knownLangs = ["انگلیسی", "چینی", "فرانسوی", "آلمانی", "عربی"];
      const foundLang = (item.badges || []).find(b => knownLangs.includes(b)) || "انگلیسی";
      item.language = foundLang;
      item.accent = (item.badges || []).find(b => b.includes("لهجه")) || "";
      item.age_group = (item.badges || []).find(b => b.includes("سال")) || "";
      item.gender = (item.badges || []).find(b => b.includes("دخترانه") || b.includes("پسرانه")) || "";
      item.tmdb_query = cleanForTmdb(item.title_en);

      const qCounts = Object.values(bulkQualities).map(arr => arr.length);
      item.total_episodes_count = qCounts.length > 0 ? Math.max(...qCounts) : item.episodes_count;
    }));

    completed += batch.length;
    if (completed % 150 === 0 || completed === existingCatalog.length) {
      console.log(`Processed ${completed}/${existingCatalog.length}...`);
    }
  }

  // Write organized folder structure
  const archiveRoot = path.join(baseDir, "organized-archive");
  if (fs.existsSync(archiveRoot)) {
    fs.rmSync(archiveRoot, { recursive: true, force: true });
  }
  fs.mkdirSync(archiveRoot, { recursive: true });

  const groupedMetadata = {};
  let totalLinksCount = 0;

  for (const item of existingCatalog) {
    const langFolder = langFolderMap[item.language] || `Other (${item.language})`;
    const typeFolder = item.content_type === "movie" ? "Movies (فیلم)" : "Series (سریال)";
    const targetDir = path.join(archiveRoot, langFolder, typeFolder);
    fs.mkdirSync(targetDir, { recursive: true });

    const groupKey = `${langFolder}/${typeFolder}`;
    if (!groupedMetadata[groupKey]) {
      groupedMetadata[groupKey] = { dir: targetDir, items: [] };
    }
    groupedMetadata[groupKey].items.push(item);

    // Build per-title .txt file
    const safeTitle = sanitizeFileName(item.title_en || `Collection-${item.id}`);
    const filePath = path.join(targetDir, `${safeTitle}.txt`);

    const lines = [
      `================================================================================`,
      `Title (EN)       : ${item.title_en}`,
      `TMDB Search Name : ${item.tmdb_query}`,
      `Title (FA)       : ${item.title_fa}`,
      `Collection ID    : ${item.id}`,
      `Type             : ${item.content_type.toUpperCase()} (${item.content_type_fa})`,
      `Language         : ${item.language}${item.accent ? ` (${item.accent})` : ""}`,
      `Age Group        : ${item.age_group || "-"}`,
      `Target Gender    : ${item.gender || "-"}`,
      `Total Episodes   : ${item.total_episodes_count}`,
      `Last Updated     : ${item.last_updated || "-"}`,
      `Poster URL       : ${item.thumbnail}`,
      `Page URL         : ${item.url}`,
      `Description      : ${item.meta_description || "-"}`,
      `================================================================================`,
      ``
    ];

    const qualitiesOrder = ["720p", "480p", "360p", ...Object.keys(item.bulk_sources).filter(q => !["720p", "480p", "360p"].includes(q))];
    for (const q of qualitiesOrder) {
      const urls = item.bulk_sources[q];
      if (!urls || urls.length === 0) continue;
      totalLinksCount += urls.length;
      const totalSizeStr = item.total_sizes[q] ? ` | Total Size: ${item.total_sizes[q]}` : "";
      lines.push(`### Quality: ${q.toUpperCase()} (${urls.length} files${totalSizeStr})`);
      for (const u of urls) {
        lines.push(u);
      }
      lines.push(``);
    }

    fs.writeFileSync(filePath, lines.join("\n"), "utf8");
  }

  // Write metadata.txt in each language/type folder AND a master metadata.txt in archiveRoot
  const masterMetaLines = [
    `# HAMECHIZDAN MASTER METADATA CATALOG (FOR TMDB MATCHING & ANDROID TV)`,
    `# Total Collections: ${existingCatalog.length}`,
    `# Total Direct Video Links: ${totalLinksCount}`,
    `================================================================================`,
    ``
  ];

  for (const [groupKey, group] of Object.entries(groupedMetadata)) {
    const folderMetaLines = [
      `# METADATA LIST: ${groupKey}`,
      `# Count: ${group.items.length}`,
      `================================================================================`,
      ``
    ];

    for (const it of group.items) {
      const entryBlock = [
        `[ID: ${it.id}]`,
        `Title_EN         = ${it.title_en}`,
        `TMDB_Query       = ${it.tmdb_query}`,
        `Title_FA         = ${it.title_fa}`,
        `Type             = ${it.content_type} (${it.content_type_fa})`,
        `Language         = ${it.language}`,
        `Accent           = ${it.accent || "-"}`,
        `Age_Group        = ${it.age_group || "-"}`,
        `Gender           = ${it.gender || "-"}`,
        `Episodes_Count   = ${it.total_episodes_count}`,
        `Available_Qual   = ${Object.keys(it.bulk_sources).join(", ") || "-"}`,
        `Total_Sizes      = ${Object.entries(it.total_sizes).map(([k, v]) => `${k}: ${v}`).join(" | ") || "-"}`,
        `Last_Updated     = ${it.last_updated || "-"}`,
        `Poster_URL       = ${it.thumbnail}`,
        `Page_URL         = ${it.url}`,
        `Description      = ${it.meta_description || "-"}`,
        `File_Name        = ${sanitizeFileName(it.title_en || `Collection-${it.id}`)}.txt`,
        `--------------------------------------------------------------------------------`
      ].join("\n");

      folderMetaLines.push(entryBlock);
      masterMetaLines.push(entryBlock);
    }

    fs.writeFileSync(path.join(group.dir, "metadata.txt"), folderMetaLines.join("\n"), "utf8");
  }

  fs.writeFileSync(path.join(archiveRoot, "metadata.txt"), masterMetaLines.join("\n"), "utf8");
  fs.writeFileSync(`${baseDir}/hamechizdan_full_catalog.json`, JSON.stringify(existingCatalog, null, 2), "utf8");

  console.log(`Successfully generated organized archive in: ${archiveRoot}`);
  console.log(`Total video links extracted from bulk-download: ${totalLinksCount}`);
  for (const [k, g] of Object.entries(groupedMetadata)) {
    console.log(`  - ${k}: ${g.items.length} titles`);
  }
}

main().catch(console.error);
