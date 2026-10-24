import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import zlib from 'zlib';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PIPELINE_DIR, 'data');

const CATALOG_GZ_PATH = path.join(DATA_DIR, 'hamechizdan_full_catalog.json.gz');
const ITOONS_GZ_PATH = path.join(DATA_DIR, 'itoons_packs_resolved.json.gz');
const ITOONS_INDEX_GZ_PATH = path.join(DATA_DIR, 'itoons_catalog.json.gz');

const HAMECHIZDAN_COOKIE = (process.env.HAMECHIZDAN_COOKIE || '').trim();
const ITOONS_COOKIE = (process.env.ITOONS_COOKIE || '').trim();
const TMDB_BEARER_TOKEN =
  (process.env.TMDB_BEARER_TOKEN || '').trim() ||
  'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJjZjdhNGFiZWZkZTU4MzVjNTM5OTNhNDcyYTM0YmViMSIsIm5iZiI6MTc5MjUyNDQxMi4zNjIsInN1YiI6IjZhZDdjMDdjMjEyNGYwMDMxZTdjZTI3NCIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.Ozv3z64IDDNM_0LRnOvUOSjBy0iIgf3_txUOMBjYvrc';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJsonGz(filePath) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(filePath)).toString('utf8'));
}

function writeJsonGz(filePath, data) {
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(data), 'utf8'), { level: 9 });
  fs.writeFileSync(filePath, gz);
}

function decodeHtml(str) {
  if (!str) return '';
  return str
    .replace(/<[^>]+>/g, ' ')
    .replace(/&zwnj;/g, '\u200c')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchText(url, cookieHeader = '', retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const headers = {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
      };
      if (cookieHeader) headers.Cookie = cookieHeader;
      const r = await fetch(url, { headers });
      if (r.ok) return await r.text();
      if (r.status === 404) return '';
    } catch {
      if (i === retries - 1) return '';
      await sleep(800);
    }
  }
  return '';
}

async function tmdbFetch(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, {
        headers: {
          Authorization: `Bearer ${TMDB_BEARER_TOKEN}`,
          accept: 'application/json',
        },
      });
      if (r.status === 429) {
        await sleep(1500);
        continue;
      }
      if (r.ok) return await r.json();
      return null;
    } catch {
      if (i === retries - 1) return null;
      await sleep(500);
    }
  }
  return null;
}

// ============================================================================
// PART A: Incremental Hamechizdan Sync
// ============================================================================
function parseHamechizdanCollectionPage(cid, html, movieIds) {
  if (!html) return null;
  const titleEnMatch = html.match(/<h1[^>]*class="[^"]*collections-show-card-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/);
  const titleFaMatch = html.match(/<p[^>]*class="[^"]*collections-show-card-subtitle[^"]*"[^>]*>([\s\S]*?)<\/p>/);
  const thumbMatch = html.match(/<div class="collections-show-card-media">\s*<img[^>]+src="([^"]+)"/);
  const updatedMatch = html.match(/آخرین بروزرسانی:\s*<span[^>]*>([\s\S]*?)<\/span>/);
  const metaDescMatch = html.match(/<meta name="description" content="([^"]*)"/);

  const badges = [];
  const badgeRegex = /class="collections-show-badge[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let bm;
  while ((bm = badgeRegex.exec(html)) !== null) {
    badges.push(decodeHtml(bm[1]));
  }

  const episodes = [];
  const epParts = html.split('<div class="collections-episodes-item">').slice(1);
  for (const part of epParts) {
    const epIdMatch =
      part.match(/href="https:\/\/hamechizdan\.com\/c\/e\/(\d+)/) || part.match(/download-dropdown-(\d+)/);
    const epId = epIdMatch ? parseInt(epIdMatch[1], 10) : null;
    const epTitleMatch = part.match(/class="collections-episode-title[^"]*">([\s\S]*?)<\/p>/);
    const epThumbMatch = part.match(/<div class="collections-episode-media">\s*<img[^>]+src="([^"]+)"/);
    const epDateMatch = part.match(/بارگذاری:\s*<span[^>]*>([\s\S]*?)<\/span>/);

    const sources = {};
    const fileSizes = {};
    const dlLinkRegex =
      /<a\s+href="(https:\/\/[^"]+\.mp4)"[^>]*>\s*([0-9]+p|[a-zA-Z0-9]+)\s*(?:<span>\(([^)]+)\)<\/span>)?\s*<\/a>/g;
    let dlm;
    while ((dlm = dlLinkRegex.exec(part)) !== null) {
      const url = dlm[1];
      const quality = dlm[2].trim();
      const size = dlm[3] ? decodeHtml(dlm[3]) : '';
      sources[quality] = url;
      if (size) fileSizes[quality] = size;
    }

    episodes.push({
      episode_id: epId,
      title: decodeHtml(epTitleMatch ? epTitleMatch[1] : ''),
      thumbnail: epThumbMatch ? epThumbMatch[1] : '',
      upload_date: epDateMatch ? decodeHtml(epDateMatch[1]) : '',
      sources,
      file_sizes: fileSizes,
    });
  }

  const titleEn = decodeHtml(titleEnMatch ? titleEnMatch[1] : '');
  const titleFa = decodeHtml(titleFaMatch ? titleFaMatch[1] : '');
  if (!titleEn && episodes.length === 0) return null;

  const isMovie = movieIds.has(cid);
  const knownLangs = ['انگلیسی', 'چینی', 'فرانسوی', 'آلمانی', 'عربی'];
  const language = badges.find((b) => knownLangs.includes(b)) || 'انگلیسی';

  return {
    id: cid,
    url: `https://hamechizdan.com/c/${cid}`,
    title_en: titleEn,
    title_fa: titleFa,
    thumbnail: thumbMatch ? thumbMatch[1] : '',
    badges,
    last_updated: updatedMatch ? decodeHtml(updatedMatch[1]) : '',
    episodes_count: episodes.length,
    total_episodes_count: episodes.length,
    episodes,
    meta_description: metaDescMatch ? decodeHtml(metaDescMatch[1]) : '',
    content_type: isMovie ? 'movie' : 'series',
    content_type_fa: isMovie ? 'فیلم (سینمایی)' : 'سریال',
    language,
    accent: badges.find((b) => b.includes('لهجه')) || '',
    age_group: badges.find((b) => b.includes('سال')) || '',
    gender: badges.find((b) => b.includes('دخترانه') || b.includes('پسرانه')) || '',
    tmdb_query: titleEn,
    tmdb: null,
  };
}

async function syncHamechizdanIncremental() {
  if (!HAMECHIZDAN_COOKIE) {
    console.log('[Hamechizdan] No HAMECHIZDAN_COOKIE set — using cached Hamechizdan dataset.');
    return 0;
  }

  console.log('[Hamechizdan] Checking sitemap.xml for new collections...');
  const catalog = readJsonGz(CATALOG_GZ_PATH);
  const existingIds = new Set(catalog.filter((c) => c.id < 2000).map((c) => c.id));

  const sitemapXml = await fetchText('https://hamechizdan.com/sitemap.xml', HAMECHIZDAN_COOKIE);
  const sitemapIds = [
    ...new Set((sitemapXml.match(/https:\/\/hamechizdan\.com\/c\/(\d+)/g) || []).map((u) => parseInt(u.split('/').pop(), 10))),
  ].filter((id) => id > 0 && id < 2000 && !existingIds.has(id));

  if (sitemapIds.length === 0) {
    console.log('[Hamechizdan] No new collections found in sitemap.');
    return 0;
  }

  console.log(`[Hamechizdan] Discovered ${sitemapIds.length} new collection IDs: ${sitemapIds.join(', ')}`);
  const movieIds = new Set();
  for (let p = 1; p <= 3; p++) {
    const html = await fetchText(`https://hamechizdan.com/collections/9?page=${p}`, HAMECHIZDAN_COOKIE);
    for (const m of html.matchAll(/href="https:\/\/hamechizdan\.com\/c\/(\d+)/g)) {
      movieIds.add(parseInt(m[1], 10));
    }
  }

  let added = 0;
  for (const cid of sitemapIds) {
    const html = await fetchText(`https://hamechizdan.com/c/${cid}`, HAMECHIZDAN_COOKIE);
    const parsed = parseHamechizdanCollectionPage(cid, html, movieIds);
    if (!parsed || parsed.episodes.length === 0) continue;

    // Fetch full playlist if paginated
    const firstEpId = parsed.episodes[0]?.episode_id;
    if (firstEpId) {
      const epHtml = await fetchText(`https://hamechizdan.com/c/e/${firstEpId}?pp=1`, HAMECHIZDAN_COOKIE);
      const m = epHtml.match(/var playlist = JSON\.parse\(\x27(.*?)\x27\);/);
      if (m) {
        try {
          const pl = JSON.parse(JSON.parse(`"${m[1]}"`));
          if (Array.isArray(pl) && pl.length > parsed.episodes.length) {
            parsed.episodes = pl.map((p, idx) => ({
              episode_id: p.id,
              title: p.title || '',
              thumbnail: p.thumbnail || parsed.thumbnail,
              upload_date: '',
              sources: p.urls || {},
              file_sizes: p.file_sizes || {},
              season_number: parsed.content_type === 'movie' ? 0 : 1,
              episode_number: idx + 1,
              clean_title: p.title || `Episode ${idx + 1}`,
              display_title: p.title || `Episode ${idx + 1}`,
            }));
            parsed.episodes_count = parsed.episodes.length;
            parsed.total_episodes_count = parsed.episodes.length;
          }
        } catch {
          // ignore
        }
      }
    }

    catalog.push(parsed);
    added++;
  }

  if (added > 0) {
    writeJsonGz(CATALOG_GZ_PATH, catalog);
    console.log(`[Hamechizdan] Added ${added} new collections to hamechizdan_full_catalog.json.gz`);
  }
  return added;
}

// ============================================================================
// PART B: Incremental iToons Sync (Sitemap + Conservative CDN Resolution)
// ============================================================================
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 2 });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 20 });
let lastItoonsCallMs = 0;

async function resolveItoonsRedirectSerial(dlHref) {
  if (!dlHref || /^https?:\/\/dl\.itoons\.ir/i.test(dlHref)) {
    return dlHref ? dlHref.replace(/^https:/i, 'http:') : '';
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    const wait = Math.max(0, 450 - (Date.now() - lastItoonsCallMs));
    if (wait > 0) await sleep(wait);
    lastItoonsCallMs = Date.now();

    const res = await new Promise((resolve) => {
      const req = https.request(
        dlHref,
        {
          method: 'HEAD',
          agent: httpsAgent,
          headers: {
            Cookie: ITOONS_COOKIE,
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          },
          timeout: 12000,
        },
        (r) => {
          r.resume();
          resolve({ status: r.statusCode, location: r.headers.location || '' });
        }
      );
      req.on('error', () => resolve({ status: 0, location: '' }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ status: 0, location: '' });
      });
      req.end();
    });

    if (res.location && /^https?:\/\/dl\.itoons\.ir/i.test(res.location)) {
      return res.location.replace(/^https:/i, 'http:');
    }
    if (res.status === 429) {
      await sleep(15000);
    } else {
      await sleep(800);
    }
  }
  return '';
}

function checkDirectCdnFile(url) {
  return new Promise((resolve) => {
    if (!url || !/^https?:\/\/dl\.itoons\.ir/i.test(url)) return resolve(null);
    const httpUrl = url.replace(/^https:/i, 'http:');
    let reqUrl = httpUrl;
    try {
      const u = new URL(httpUrl);
      reqUrl = u.origin + u.pathname.split('/').map((s) => encodeURIComponent(decodeURIComponent(s))).join('/');
    } catch {
      // ignore
    }
    const req = http.request(reqUrl, { method: 'HEAD', agent: httpAgent, timeout: 8000 }, (res) => {
      res.resume();
      if (res.statusCode === 200) {
        const bytes = parseInt(res.headers['content-length'] || '0', 10);
        const mb = bytes > 0 ? (bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(2)} GB` : `${Math.round(bytes / 1048576)} MB`) : '';
        resolve({ url: httpUrl, fileSize: mb });
      } else {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

function parseItoonsPackPage(html, code, href) {
  const h1 = decodeHtml((html.match(/<h1>([\s\S]*?)<\/h1>/) || [])[1]);
  const engTitle = decodeHtml((html.match(/<div class="eng">([\s\S]*?)<\/div>/) || [])[1]);
  if (!h1 && !engTitle) return null;

  const spanRaw = decodeHtml((html.match(/<h1>[\s\S]*?<\/h1>\s*<span>([\s\S]*?)<\/span>/) || [])[1]);
  const spanParts = spanRaw.split('|').map((x) => x.trim()).filter(Boolean);
  const ageRaw = spanParts[0] || '';
  const yearRaw = spanParts.find((p) => /^\d{4}$/.test(p)) || '';
  const countryRaw = spanParts.length >= 3 ? spanParts[2] : '';
  const studioRaw = spanParts.length >= 4 ? spanParts[3] : '';

  const poster =
    ((html.match(/<img\s+src="([^"]+)"[^>]*class="poster/) || [])[1]) ||
    ((html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/) || [])[1]) ||
    '';
  const cover = ((html.match(/url\(['"]?(https:\/\/itoons\.ir\/uploads\/products\/covers\/[^'")]+)['"]?\)/) || [])[1]) || '';

  const fieldsRaw = decodeHtml((html.match(/<div class="productfields"[\s\S]*?<div class="container">([\s\S]*?)<\/div>/) || [])[1]);
  let lang = 'انگلیسی';
  for (const part of fieldsRaw.split('|').map((x) => x.trim())) {
    if (part.startsWith('زبان:')) lang = part.replace('زبان:', '').trim();
  }

  const descHtml = (html.match(/<div class="tab-pane active" id="description">\s*<div class="pad">([\s\S]*?)<\/div>\s*<\/div>/) || [])[1] || '';
  const descriptionFa = decodeHtml(descHtml);

  const episodes = [];
  const cardBlocks = html.split('<div class="col-xs-12 col-sm-6 col-lg-4 product-files"').slice(1);
  for (const block of cardBlocks) {
    const titleAttr = decodeHtml((block.match(/^\s*title="([^"]*)"/) || [])[1]);
    const fileTitle = decodeHtml((block.match(/<div class="filetitle">([\s\S]*?)<\/div>/) || [])[1]) || titleAttr;
    const vHref = ((block.match(/<a\s+href="(https:\/\/itoons\.ir\/v\/[^"]+)"/) || [])[1]) || '';
    const vCode = vHref ? vHref.split('/v/')[1].split('/')[0].split('?')[0] : '';
    const thumb = ((block.match(/data-src="([^"]+)"/) || [])[1]) || ((block.match(/<img\s+src="([^"]+)"/) || [])[1]) || '';
    const duration = decodeHtml((block.match(/<div class="duration"\s*>([\s\S]*?)<\/div>/) || [])[1]);
    const dlHref = ((block.match(/href="(https:\/\/itoons\.ir\/\?dl=[^"]+)"/) || [])[1]) || '';
    episodes.push({ title: fileTitle, vCode, vHref, thumb, duration, dlHref });
  }

  return {
    code,
    href,
    label: episodes.length === 1 ? yearRaw || 'Movie' : `${episodes.length} قسمت`,
    faTitle: h1,
    enTitle: engTitle,
    ageRaw,
    year: yearRaw,
    country: countryRaw,
    studio: studioRaw,
    lang,
    poster,
    cover,
    descriptionFa,
    episodes,
  };
}

async function syncItoonsIncremental() {
  if (!ITOONS_COOKIE) {
    console.log('[iToons] No ITOONS_COOKIE set — using cached iToons packs.');
    return 0;
  }

  console.log('[iToons] Checking sitemap for new animation packs...');
  const packs = readJsonGz(ITOONS_GZ_PATH);
  const existingCodes = new Set(packs.map((p) => p.code));

  const sitemapXml = await fetchText('https://itoons.ir/sitemap.xml', ITOONS_COOKIE);
  const packUrls = [...new Set(sitemapXml.match(/https:\/\/itoons\.ir\/a\/[A-Za-z0-9]+\/[^\s<"]+/g) || [])];
  const newPacksToCrawl = [];
  for (const u of packUrls) {
    const m = u.match(/https:\/\/itoons\.ir\/a\/([A-Za-z0-9]+)\//);
    if (m && !existingCodes.has(m[1])) {
      existingCodes.add(m[1]);
      newPacksToCrawl.push({ code: m[1], href: u });
    }
  }

  if (newPacksToCrawl.length === 0) {
    console.log('[iToons] No new animation packs found in sitemap.');
    return 0;
  }

  console.log(`[iToons] Found ${newPacksToCrawl.length} new packs to crawl...`);
  let addedPacks = 0;
  for (const item of newPacksToCrawl) {
    const html = await fetchText(item.href, ITOONS_COOKIE);
    const pack = parseItoonsPackPage(html, item.code, item.href);
    if (!pack || pack.episodes.length === 0) continue;

    for (const ep of pack.episodes) {
      if (!ep.dlHref) continue;
      const directUrl = await resolveItoonsRedirectSerial(ep.dlHref);
      if (directUrl) {
        const info = await checkDirectCdnFile(directUrl);
        ep.directUrl = directUrl;
        ep.fileSize = info?.fileSize || 'HD';
        ep.quality = (directUrl.match(/\b(720p|480p|576p|1080p|360p)\b/i) || [])[1]?.toLowerCase() || '720p';
      }
    }

    if (pack.episodes.some((e) => e.directUrl)) {
      packs.unshift(pack);
      addedPacks++;
    }
  }

  if (addedPacks > 0) {
    writeJsonGz(ITOONS_GZ_PATH, packs);
    console.log(`[iToons] Added ${addedPacks} new packs to itoons_packs_resolved.json.gz`);
  }
  return addedPacks;
}

async function main() {
  console.log('=== CinCin TV Automated Catalog Sync & Binary Builder ===');
  const hAdded = await syncHamechizdanIncremental();
  const iAdded = await syncItoonsIncremental();
  console.log(`Incremental sync summary: +${hAdded} Hamechizdan collections, +${iAdded} iToons packs.`);

  console.log('\nRunning 08_merge_itoons_and_build_catalog.mjs to enrich TMDB & build hamechizdan_catalog.bin...');
  const mergeScript = path.join(__dirname, '08_merge_itoons_and_build_catalog.mjs');
  const res = spawnSync(process.execPath, [mergeScript], {
    stdio: 'inherit',
    env: { ...process.env, TMDB_BEARER_TOKEN },
  });
  if (res.status !== 0) {
    process.exit(res.status || 1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
