import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';

const SCRATCH_DIR = '/Users/mustafa/.gemini/antigravity/brain/3c6bc69b-4c64-40e8-81da-aff75d086fcf/scratch';
const CATALOG_INDEX_PATH = path.join(SCRATCH_DIR, 'itoons_catalog.json');
const PACKS_OUT_PATH = path.join(SCRATCH_DIR, 'itoons_packs_full.json');

function getCookiesFromChrome() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9222/json/list', (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        const targets = JSON.parse(body);
        const page = targets.find((t) => t.type === 'page' && t.url && t.url.includes('itoons.ir')) || targets.find((t) => t.type === 'page');
        if (!page) return reject(new Error('No page found in Chrome'));
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        ws.onopen = () => {
          ws.send(JSON.stringify({ id: 1, method: 'Network.getCookies', params: { urls: ['https://itoons.ir'] } }));
        };
        ws.onmessage = (msg) => {
          const cookies = JSON.parse(msg.data).result.cookies;
          const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
          ws.close();
          resolve(cookieHeader);
        };
        ws.onerror = reject;
      });
    }).on('error', reject);
  });
}

const agent = new https.Agent({ keepAlive: true, maxSockets: 25 });

function fetchHtml(url, cookieHeader, retries = 3) {
  return new Promise((resolve) => {
    const attempt = (n) => {
      const u = new URL(url);
      // properly encode path if needed
      const reqUrl = u.origin + u.pathname.split('/').map(seg => encodeURIComponent(decodeURIComponent(seg))).join('/') + u.search;
      const req = https.get(
        reqUrl,
        {
          agent,
          headers: {
            Cookie: cookieHeader,
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
          },
          timeout: 15000,
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            const nextUrl = new URL(res.headers.location, reqUrl).toString();
            return resolve(fetchHtml(nextUrl, cookieHeader, retries));
          }
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => resolve(data));
        }
      );
      req.on('error', () => {
        if (n > 1) setTimeout(() => attempt(n - 1), 600);
        else resolve('');
      });
      req.on('timeout', () => {
        req.destroy();
        if (n > 1) setTimeout(() => attempt(n - 1), 600);
        else resolve('');
      });
    };
    attempt(retries);
  });
}

function cleanText(s) {
  return (s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&zwnj;/g, '\u200c')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function parsePackHtml(html, itemMeta) {
  const h1 = cleanText((html.match(/<h1>([\s\S]*?)<\/h1>/) || [])[1]) || itemMeta.faTitle;
  const spanRaw = cleanText((html.match(/<h1>[\s\S]*?<\/h1>\s*<span>([\s\S]*?)<\/span>/) || [])[1]);
  const spanParts = spanRaw.split('|').map((x) => x.trim()).filter(Boolean);
  const ageRaw = spanParts[0] || '';
  const yearRaw = spanParts.find((p) => /^\d{4}$/.test(p)) || '';
  const countryRaw = spanParts.length >= 3 ? spanParts[2] : '';
  const studioRaw = spanParts.length >= 4 ? spanParts[3] : '';

  const engTitle = cleanText((html.match(/<div class="eng">([\s\S]*?)<\/div>/) || [])[1]) || itemMeta.enTitle;
  const poster = ((html.match(/<img\s+src="([^"]+)"[^>]*class="poster/) || [])[1]) ||
                 ((html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/) || [])[1]) || '';
  const cover = ((html.match(/url\(['"]?(https:\/\/itoons\.ir\/uploads\/products\/covers\/[^'")]+)['"]?\)/) || [])[1]) || '';

  const fieldsRaw = cleanText((html.match(/<div class="productfields"[\s\S]*?<div class="container">([\s\S]*?)<\/div>/) || [])[1]);
  let lang = 'انگلیسی';
  let subtitle = 'ندارد';
  let director = '';
  for (const part of fieldsRaw.split('|').map((x) => x.trim())) {
    if (part.startsWith('زبان:')) lang = part.replace('زبان:', '').trim();
    else if (part.startsWith('زیرنویس:')) subtitle = part.replace('زیرنویس:', '').trim();
    else if (part.startsWith('کارگردان:')) director = part.replace('کارگردان:', '').trim();
  }

  const descHtml = (html.match(/<div class="tab-pane active" id="description">\s*<div class="pad">([\s\S]*?)<\/div>\s*<\/div>/) || [])[1] || '';
  const descriptionFa = cleanText(descHtml);

  const tags = [...html.matchAll(/class="producttags"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => cleanText(m[1])).filter(Boolean);

  // Parse episode cards
  const episodes = [];
  const cardBlocks = html.split('<div class="col-xs-12 col-sm-6 col-lg-4 product-files"').slice(1);
  for (const block of cardBlocks) {
    const titleAttr = cleanText((block.match(/^\s*title="([^"]*)"/) || [])[1]);
    const fileTitle = cleanText((block.match(/<div class="filetitle">([\s\S]*?)<\/div>/) || [])[1]) || titleAttr;
    const vHref = ((block.match(/<a\s+href="(https:\/\/itoons\.ir\/v\/[^"]+)"/) || [])[1]) || '';
    const vCode = vHref ? vHref.split('/v/')[1].split('/')[0].split('?')[0] : '';
    const thumb = ((block.match(/data-src="([^"]+)"/) || [])[1]) || ((block.match(/<img\s+src="([^"]+)"/) || [])[1]) || '';
    const duration = cleanText((block.match(/<div class="duration"\s*>([\s\S]*?)<\/div>/) || [])[1]);
    const dlHref = ((block.match(/href="(https:\/\/itoons\.ir\/\?dl=[^"]+)"/) || [])[1]) || '';
    episodes.push({
      title: fileTitle,
      vCode,
      vHref,
      thumb,
      duration,
      dlHref,
    });
  }

  return {
    code: itemMeta.code,
    href: itemMeta.href,
    label: itemMeta.label,
    faTitle: h1,
    enTitle: engTitle,
    ageRaw,
    year: yearRaw,
    country: countryRaw,
    studio: studioRaw,
    lang,
    subtitle,
    director,
    poster,
    cover,
    descriptionFa,
    tags,
    episodes,
  };
}

async function main() {
  const cookieHeader = await getCookiesFromChrome();
  console.log('Got Chrome VIP cookies:', cookieHeader);

  const indexData = JSON.parse(fs.readFileSync(CATALOG_INDEX_PATH, 'utf8'));
  const allItems = indexData.allItems;
  console.log(`Crawling ${allItems.length} pack pages with concurrency 20...`);

  const results = new Array(allItems.length);
  let completed = 0;
  let totalEps = 0;
  let totalDlLinks = 0;

  const CONCURRENCY = 20;
  let cursor = 0;

  async function worker() {
    while (cursor < allItems.length) {
      const idx = cursor++;
      const item = allItems[idx];
      const html = await fetchHtml(item.href, cookieHeader);
      const parsed = parsePackHtml(html, item);
      results[idx] = parsed;
      completed++;
      totalEps += parsed.episodes.length;
      totalDlLinks += parsed.episodes.filter((e) => e.dlHref).length;
      if (completed % 100 === 0 || completed === allItems.length) {
        console.log(`Progress: ${completed}/${allItems.length} packs | Episodes: ${totalEps} | DL Links: ${totalDlLinks}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  fs.writeFileSync(PACKS_OUT_PATH, JSON.stringify(results, null, 2), 'utf8');
  console.log(`Saved ${results.length} packs to ${PACKS_OUT_PATH}`);
}

main().catch(console.error);
