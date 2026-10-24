import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';

const SCRATCH_DIR = '/Users/mustafa/.gemini/antigravity/brain/3c6bc69b-4c64-40e8-81da-aff75d086fcf/scratch';
const RESOLVED_PACKS_PATH = path.join(SCRATCH_DIR, 'itoons_packs_resolved.json');
const HCD_META_PATH = '/Users/mustafa/Documents/Project/Github/CinCin-ATV/hamechizdan_titles_metadata.json';
const cookieHeader = 'PHPSESSID=m3g05l662sauhuq047m5l9vjl4; utkn=we8m9049225hinpa';

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 2 });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 30 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Global mutex for itoons.ir redirect calls so we NEVER hit itoons.ir concurrently
let lastItoonsCallMs = 0;
let itoonsQueue = Promise.resolve();

function resolveRedirectSerial(dlHref) {
  if (!dlHref || dlHref.startsWith('http://dl.itoons.ir') || dlHref.includes('downloadha.com')) {
    return Promise.resolve(dlHref || '');
  }
  const run = async () => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      const now = Date.now();
      const wait = Math.max(0, 380 - (now - lastItoonsCallMs));
      if (wait > 0) await sleep(wait);
      lastItoonsCallMs = Date.now();

      const res = await new Promise((resolve) => {
        const req = https.request(
          dlHref,
          {
            method: 'HEAD',
            agent: httpsAgent,
            headers: {
              Cookie: cookieHeader,
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
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

      if (res.location && res.location.startsWith('http://dl.itoons.ir')) {
        return res.location;
      }
      if (res.status === 429) {
        console.log('  [429 detected on itoons.ir] Pausing 15s to let LiteSpeed cooldown...');
        await sleep(15000);
        continue;
      }
      await sleep(1000);
    }
    return '';
  };

  const p = itoonsQueue.then(run, run);
  itoonsQueue = p.catch(() => {});
  return p;
}

function checkDirectFile(url) {
  return new Promise((resolve) => {
    if (!url || !url.startsWith('http://dl.itoons.ir')) return resolve(null);
    let reqUrl;
    try {
      const u = new URL(url);
      reqUrl = u.origin + u.pathname.split('/').map((s) => encodeURIComponent(decodeURIComponent(s))).join('/');
    } catch {
      reqUrl = url;
    }
    const req = http.request(
      reqUrl,
      {
        method: 'HEAD',
        agent: httpAgent,
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 8000,
      },
      (res) => {
        res.resume();
        if (res.statusCode === 200) {
          const bytes = parseInt(res.headers['content-length'] || '0', 10);
          resolve({ url, bytes });
        } else {
          resolve(null);
        }
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

function formatSize(bytes) {
  if (!bytes || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${Math.round(mb)} MB`;
}

function generateSmartCandidates(firstEp, firstDirectUrl, targetEp, epIndexInPack) {
  if (!firstDirectUrl || !firstDirectUrl.startsWith('http://dl.itoons.ir/')) return [];
  const lastSlash = firstDirectUrl.lastIndexOf('/');
  const baseDir = firstDirectUrl.slice(0, lastSlash + 1);
  const firstFile = firstDirectUrl.slice(lastSlash + 1);

  // If firstFile has random 4 digits before .mp4 (e.g. .[itoons.ir].6531.mp4), prediction won't work
  if (/\.\[itoons\.ir\]\.\d{3,5}\.mp4$/i.test(firstFile)) return [];

  const suffixMatch = firstFile.match(/(\.(?:720p|480p|576p|1080p|360p)[^/]*\.mp4)$/i) || firstFile.match(/(\.\[itoons\.ir\]\.mp4)$/i);
  const suffix = suffixMatch ? suffixMatch[1] : '.720p.[itoons.ir].mp4';
  const firstCore = firstFile.slice(0, firstFile.length - suffix.length);

  const candidates = new Set();
  const rawTitle = (targetEp.title || '').trim();
  if (!rawTitle) return [];

  const addVariants = (str) => {
    if (!str) return;
    // Variant 1: spaces -> dots, remove quotes/question/exclamation, keep commas
    const v1 = str
      .replace(/['’`?!:;]/g, '')
      .replace(/\s+-\s+/g, '-')
      .replace(/\s+/g, '.')
      .replace(/\.+/g, '.')
      .replace(/^\.|\.$/g, '');
    candidates.add(`${baseDir}${v1}${suffix}`);

    // Variant 2: spaces -> dots, keep ' - ' as '.-.'
    const v2 = str
      .replace(/['’`?!:;]/g, '')
      .replace(/\s+/g, '.')
      .replace(/\.+/g, '.')
      .replace(/^\.|\.$/g, '');
    candidates.add(`${baseDir}${v2}${suffix}`);

    // Variant 3: remove commas too
    const v3 = v1.replace(/,/g, '').replace(/\.+/g, '.');
    candidates.add(`${baseDir}${v3}${suffix}`);
    const v4 = v2.replace(/,/g, '').replace(/\.+/g, '.');
    candidates.add(`${baseDir}${v4}${suffix}`);

    // Variant 4: remove ' - ' completely (replace with '.')
    const v5 = str
      .replace(/['’`?!:;,]/g, '')
      .replace(/\s+-\s+/g, '.')
      .replace(/\s+/g, '.')
      .replace(/\.+/g, '.')
      .replace(/^\.|\.$/g, '');
    candidates.add(`${baseDir}${v5}${suffix}`);

    // Variant 5: keep apostrophe
    const v6 = str
      .replace(/[?!:;]/g, '')
      .replace(/\s+-\s+/g, '-')
      .replace(/\s+/g, '.')
      .replace(/\.+/g, '.')
      .replace(/^\.|\.$/g, '');
    candidates.add(`${baseDir}${v6}${suffix}`);

    // Variant 6: Part 1 / Part 2 -> Part1 / Part2
    if (/Part\.\d/i.test(v1)) {
      candidates.add(`${baseDir}${v1.replace(/Part\.(\d)/gi, 'Part$1')}${suffix}`);
      candidates.add(`${baseDir}${v3.replace(/Part\.(\d)/gi, 'Part$1')}${suffix}`);
    }
  };

  addVariants(rawTitle);

  // Also check if firstEp's show prefix before SxxExx or episode number differs from targetEp's show prefix
  const sCodeMatch1 = firstCore.match(/^(.*?)\.(S\d+E\d+(?:E\d+)?|\d{2,3}(?:-\d{2,3})?)[.-]/i);
  const sCodeMatchT = rawTitle.match(/^(.*?)\s+(S\d+E\d+(?:E\d+)?|\d{2,3}(?:\s*-\s*\d{2,3})?)\s+(.*)$/i);
  if (sCodeMatch1 && sCodeMatchT) {
    const filePrefix = sCodeMatch1[1]; // e.g. CoComelon.Lane or Xavier.Riddle.and.the.Secret.Museum
    const epCode = sCodeMatchT[2].replace(/\s+/g, '');
    const epRest = sCodeMatchT[3].replace(/^-\s*/, '');
    addVariants(`${filePrefix}.${epCode}.${epRest}`);
    addVariants(`${filePrefix}.${epCode}-${epRest}`);
  }

  // Also if firstCore starts with a 2-digit number (e.g. 01.Umbrella.Umbrella or 61.Mister.Cat)
  const leadNumMatch = firstCore.match(/^(\d{2,3})\./);
  if (leadNumMatch) {
    const firstNum = parseInt(leadNumMatch[1], 10);
    const padLen = leadNumMatch[1].length;
    const expectedNum = String(firstNum + epIndexInPack).padStart(padLen, '0');
    const strippedTitle = rawTitle.replace(/^.*?(?:S\d+E\d+|\b\d{2,3}\b)\s*/i, '');
    addVariants(`${expectedNum}.${strippedTitle}`);
    addVariants(`${expectedNum}.${rawTitle}`);
  }

  // Also try dlHref slug!
  const slugMatch = (targetEp.dlHref || '').match(/\d+\.[a-z0-9]+\.([^&]+)\.mp4/i);
  if (slugMatch) {
    const slug = slugMatch[1];
    // Capitalize words or just dots
    const slugDots = slug.replace(/-/g, '.');
    candidates.add(`${baseDir}${slugDots}${suffix}`);
  }

  return [...candidates];
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

async function main() {
  const packs = JSON.parse(fs.readFileSync(RESOLVED_PACKS_PATH, 'utf8'));
  const hcd = JSON.parse(fs.readFileSync(HCD_META_PATH, 'utf8'));

  // Determine which packs belong to shows that are either NEW or have MORE episodes than HCD
  const shows = new Map();
  for (const p of packs) {
    const isMovie = /^\d{4}$/.test(p.label) || /Movie|Special|Short/i.test(p.label) || p.episodes.length === 1;
    const baseEn = cleanShowTitle(p.enTitle, isMovie);
    const baseFa = normFa(p.faTitle);
    const key = (p.lang !== 'انگلیسی' ? p.lang + ':' : '') + (isMovie ? 'movie:' + normEn(baseEn) : 'series:' + (baseFa || normEn(baseEn)));
    if (!shows.has(key)) shows.set(key, { baseEn, baseFa, isMovie, lang: p.lang, packs: [], totalEps: 0 });
    const g = shows.get(key);
    g.packs.push(p);
    g.totalEps += p.episodes.length;
  }

  const priorityPacks = [];
  for (const g of shows.values()) {
    const kEn = normEn(g.baseEn);
    const kFa = g.baseFa;
    const candidates = hcd.filter((h) => {
      const hIsMovie = h.content_type === 'movie';
      if (hIsMovie !== g.isMovie) return false;
      if (g.lang !== 'انگلیسی' && g.lang !== 'بی کلام' && h.language !== g.lang) return false;
      if (g.lang === 'انگلیسی' && h.language !== 'انگلیسی') return false;
      const hEn = normEn(h.title_en);
      const hFa = normFa(h.title_fa);
      const hTmdb = h.tmdb && h.tmdb.title ? normEn(h.tmdb.title) : '';
      if (hEn === kEn || hFa === kFa || (hTmdb && hTmdb === kEn)) return true;
      const w1 = kEn.split(' ').filter(Boolean);
      const w2 = hEn.split(' ').filter(Boolean);
      if (w1.length >= 2 && w2.length >= 2) {
        const common = w1.filter((w) => w2.includes(w));
        if (common.length === Math.min(w1.length, w2.length) && common.join('').length >= 8) return true;
      }
      return false;
    });
    const hcdEps = candidates.reduce((s, c) => s + (c.total_episodes_count || 0), 0);
    if (candidates.length === 0 || (!g.isMovie && g.totalEps > hcdEps)) {
      priorityPacks.push(...g.packs);
    }
  }

  const packsToProcess = priorityPacks.filter((p) => p.episodes && p.episodes.some((e) => !e.directUrl));
  console.log(`Priority packs needing resolution: ${packsToProcess.length} (out of ${priorityPacks.length} priority packs)`);

  let predictedCount = 0;
  let redirectedCount = 0;
  let failedCount = 0;

  for (let pIdx = 0; pIdx < packsToProcess.length; pIdx++) {
    const pack = packsToProcess[pIdx];
    const firstEp = pack.episodes[0];
    if (!firstEp.directUrl) {
      const u = await resolveRedirectSerial(firstEp.dlHref);
      if (u) {
        const info = await checkDirectFile(u);
        firstEp.directUrl = u;
        firstEp.fileSize = info ? formatSize(info.bytes) : '';
        firstEp.quality = (u.match(/\b(720p|480p|576p|1080p|360p)\b/i) || [])[1]?.toLowerCase() || '720p';
        redirectedCount++;
      } else {
        failedCount++;
      }
    }

    const firstUrl = firstEp.directUrl;
    const unresolvedEps = pack.episodes.map((ep, idx) => ({ ep, idx })).filter((x) => !x.ep.directUrl);

    // Step 1: Test smart candidate URLs against dl.itoons.ir in parallel (batches of 10)
    for (let i = 0; i < unresolvedEps.length; i += 10) {
      const batch = unresolvedEps.slice(i, i + 10);
      await Promise.all(
        batch.map(async ({ ep, idx }) => {
          const cands = generateSmartCandidates(firstEp, firstUrl, ep, idx);
          for (const cUrl of cands) {
            const info = await checkDirectFile(cUrl);
            if (info) {
              ep.directUrl = info.url;
              ep.fileSize = formatSize(info.bytes);
              ep.quality = (info.url.match(/\b(720p|480p|576p|1080p|360p)\b/i) || [])[1]?.toLowerCase() || firstEp.quality || '720p';
              predictedCount++;
              return;
            }
          }
        })
      );
    }

    // Step 2: For any still-unresolved episodes in this pack, resolve conservatively via serial redirect
    const stillUnresolved = pack.episodes.filter((e) => !e.directUrl);
    for (const ep of stillUnresolved) {
      const rUrl = await resolveRedirectSerial(ep.dlHref);
      if (rUrl) {
        const info = await checkDirectFile(rUrl);
        ep.directUrl = rUrl;
        ep.fileSize = info ? formatSize(info.bytes) : '';
        ep.quality = (rUrl.match(/\b(720p|480p|576p|1080p|360p)\b/i) || [])[1]?.toLowerCase() || firstEp.quality || '720p';
        redirectedCount++;
      } else {
        failedCount++;
      }
    }

    if ((pIdx + 1) % 15 === 0 || pIdx + 1 === packsToProcess.length) {
      console.log(
        `[${pIdx + 1}/${packsToProcess.length}] ${pack.enTitle} | Predicted(dl.itoons): ${predictedCount} | Redirected(Conservative): ${redirectedCount} | Failed: ${failedCount}`
      );
      fs.writeFileSync(RESOLVED_PACKS_PATH, JSON.stringify(packs, null, 2), 'utf8');
    }
  }

  fs.writeFileSync(RESOLVED_PACKS_PATH, JSON.stringify(packs, null, 2), 'utf8');
  console.log(`ALL PRIORITY PACKS RESOLVED! Predicted: ${predictedCount}, Redirected: ${redirectedCount}, Failed: ${failedCount}`);
}

main().catch(console.error);
