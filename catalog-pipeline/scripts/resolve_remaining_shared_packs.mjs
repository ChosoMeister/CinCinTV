import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';

const SCRATCH_DIR = '/Users/mustafa/.gemini/antigravity/brain/3c6bc69b-4c64-40e8-81da-aff75d086fcf/scratch';
const RESOLVED_PACKS_PATH = path.join(SCRATCH_DIR, 'itoons_packs_resolved.json');
const cookieHeader = 'PHPSESSID=m3g05l662sauhuq047m5l9vjl4; utkn=we8m9049225hinpa';

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 2 });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 30 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastItoonsCallMs = 0;
let itoonsQueue = Promise.resolve();

function resolveRedirectSerial(dlHref) {
  if (!dlHref || /^https?:\/\/dl\.itoons\.ir/i.test(dlHref) || dlHref.includes('downloadha.com')) {
    return Promise.resolve(dlHref ? dlHref.replace(/^https:/i, 'http:') : '');
  }
  const run = async () => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      const now = Date.now();
      const wait = Math.max(0, 420 - (now - lastItoonsCallMs));
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

      if (res.location && /^https?:\/\/dl\.itoons\.ir/i.test(res.location)) {
        return res.location.replace(/^https:/i, 'http:');
      }
      if (res.status === 429) {
        console.log('  [429 detected on itoons.ir] Pausing 20s...');
        await sleep(20000);
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
    if (!url || !/^https?:\/\/dl\.itoons\.ir/i.test(url)) return resolve(null);
    const httpUrl = url.replace(/^https:/i, 'http:');
    let reqUrl;
    try {
      const u = new URL(httpUrl);
      reqUrl = u.origin + u.pathname.split('/').map((s) => encodeURIComponent(decodeURIComponent(s))).join('/');
    } catch {
      reqUrl = httpUrl;
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
          resolve({ url: httpUrl, bytes });
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
  if (!firstDirectUrl || !/^https?:\/\/dl\.itoons\.ir\//i.test(firstDirectUrl)) return [];
  const httpFirst = firstDirectUrl.replace(/^https:/i, 'http:');
  const lastSlash = httpFirst.lastIndexOf('/');
  const baseDir = httpFirst.slice(0, lastSlash + 1);
  const firstFile = httpFirst.slice(lastSlash + 1);

  if (/\.\[itoons\.ir\]\.\d{3,5}\.mp4$/i.test(firstFile)) return [];

  const suffixMatch = firstFile.match(/(\.(?:720p|480p|576p|1080p|360p)[^/]*\.mp4)$/i) || firstFile.match(/(\.\[itoons\.ir\]\.mp4)$/i);
  const suffix = suffixMatch ? suffixMatch[1] : '.720p.[itoons.ir].mp4';
  const firstCore = firstFile.slice(0, firstFile.length - suffix.length);

  const candidates = new Set();
  const rawTitle = (targetEp.title || '').trim();
  if (!rawTitle) return [];

  const addVariants = (str) => {
    if (!str) return;
    const v1 = str
      .replace(/['’`?!:;]/g, '')
      .replace(/\s+-\s+/g, '-')
      .replace(/\s+/g, '.')
      .replace(/\.+/g, '.')
      .replace(/^\.|\.$/g, '');
    candidates.add(`${baseDir}${v1}${suffix}`);

    const v2 = str
      .replace(/['’`?!:;]/g, '')
      .replace(/\s+/g, '.')
      .replace(/\.+/g, '.')
      .replace(/^\.|\.$/g, '');
    candidates.add(`${baseDir}${v2}${suffix}`);

    const v3 = v1.replace(/,/g, '').replace(/\.+/g, '.');
    candidates.add(`${baseDir}${v3}${suffix}`);
    const v4 = v2.replace(/,/g, '').replace(/\.+/g, '.');
    candidates.add(`${baseDir}${v4}${suffix}`);

    const v5 = str
      .replace(/['’`?!:;,]/g, '')
      .replace(/\s+-\s+/g, '.')
      .replace(/\s+/g, '.')
      .replace(/\.+/g, '.')
      .replace(/^\.|\.$/g, '');
    candidates.add(`${baseDir}${v5}${suffix}`);

    const v6 = str
      .replace(/[?!:;]/g, '')
      .replace(/\s+-\s+/g, '-')
      .replace(/\s+/g, '.')
      .replace(/\.+/g, '.')
      .replace(/^\.|\.$/g, '');
    candidates.add(`${baseDir}${v6}${suffix}`);

    if (/Part\.\d/i.test(v1)) {
      candidates.add(`${baseDir}${v1.replace(/Part\.(\d)/gi, 'Part$1')}${suffix}`);
      candidates.add(`${baseDir}${v3.replace(/Part\.(\d)/gi, 'Part$1')}${suffix}`);
    }
  };

  addVariants(rawTitle);

  const sCodeMatch1 = firstCore.match(/^(.*?)\.(S\d+E\d+(?:E\d+)?|\d{2,3}(?:-\d{2,3})?)[.-]/i);
  const sCodeMatchT = rawTitle.match(/^(.*?)\s+(S\d+E\d+(?:E\d+)?|\d{2,3}(?:\s*-\s*\d{2,3})?)\s+(.*)$/i);
  if (sCodeMatch1 && sCodeMatchT) {
    const filePrefix = sCodeMatch1[1];
    const epCode = sCodeMatchT[2].replace(/\s+/g, '');
    const epRest = sCodeMatchT[3].replace(/^-\s*/, '');
    addVariants(`${filePrefix}.${epCode}.${epRest}`);
    addVariants(`${filePrefix}.${epCode}-${epRest}`);
  }

  const leadNumMatch = firstCore.match(/^(\d{2,3})\./);
  if (leadNumMatch) {
    const firstNum = parseInt(leadNumMatch[1], 10);
    const padLen = leadNumMatch[1].length;
    const expectedNum = String(firstNum + epIndexInPack).padStart(padLen, '0');
    const strippedTitle = rawTitle.replace(/^.*?(?:S\d+E\d+|\b\d{2,3}\b)\s*/i, '');
    addVariants(`${expectedNum}.${strippedTitle}`);
    addVariants(`${expectedNum}.${rawTitle}`);
  }

  return [...candidates];
}

async function main() {
  const packs = JSON.parse(fs.readFileSync(RESOLVED_PACKS_PATH, 'utf8'));
  const packsToProcess = packs.filter((p) => p.episodes && p.episodes.some((e) => !e.directUrl));
  console.log(`Remaining shared packs needing resolution: ${packsToProcess.length}`);

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

    if ((pIdx + 1) % 20 === 0 || pIdx + 1 === packsToProcess.length) {
      console.log(
        `[${pIdx + 1}/${packsToProcess.length}] ${pack.enTitle} | Predicted(dl.itoons): ${predictedCount} | Redirected: ${redirectedCount} | Failed: ${failedCount}`
      );
      fs.writeFileSync(RESOLVED_PACKS_PATH, JSON.stringify(packs, null, 2), 'utf8');
    }
  }

  fs.writeFileSync(RESOLVED_PACKS_PATH, JSON.stringify(packs, null, 2), 'utf8');
  console.log(`ALL 925 PACKS RESOLVED! Predicted: ${predictedCount}, Redirected: ${redirectedCount}, Failed: ${failedCount}`);
}

main().catch(console.error);
