import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';

const SCRATCH_DIR = '/Users/mustafa/.gemini/antigravity/brain/3c6bc69b-4c64-40e8-81da-aff75d086fcf/scratch';
const PACKS_PATH = path.join(SCRATCH_DIR, 'itoons_packs_full.json');
const RESOLVED_PACKS_PATH = path.join(SCRATCH_DIR, 'itoons_packs_resolved.json');
const cookieHeader = 'PHPSESSID=m3g05l662sauhuq047m5l9vjl4; utkn=we8m9049225hinpa';

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 10 });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 40 });

function resolveRedirect(dlHref, retries = 3) {
  return new Promise((resolve) => {
    if (!dlHref || dlHref.startsWith('http://dl.itoons.ir') || dlHref.includes('downloadha.com')) {
      return resolve(dlHref || '');
    }
    const attempt = (n) => {
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
        (res) => {
          res.resume();
          const loc = res.headers.location || '';
          if (loc && loc.startsWith('http://dl.itoons.ir')) {
            return resolve(loc);
          }
          if (n > 1) setTimeout(() => attempt(n - 1), 1000);
          else resolve('');
        }
      );
      req.on('error', () => {
        if (n > 1) setTimeout(() => attempt(n - 1), 1000);
        else resolve('');
      });
      req.on('timeout', () => {
        req.destroy();
        if (n > 1) setTimeout(() => attempt(n - 1), 1000);
        else resolve('');
      });
      req.end();
    };
    attempt(retries);
  });
}

function checkDirectFile(url) {
  return new Promise((resolve) => {
    if (!url || !url.startsWith('http://dl.itoons.ir')) return resolve(null);
    const req = http.request(
      url,
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

// Given Ep 1's dlHref slug and its resolved dl.itoons.ir filename, try to predict Ep N's dl.itoons.ir URL
function buildCandidateUrls(firstEp, firstDirectUrl, targetEp) {
  if (!firstDirectUrl || !firstDirectUrl.startsWith('http://dl.itoons.ir/')) return [];
  const lastSlash = firstDirectUrl.lastIndexOf('/');
  const baseDir = firstDirectUrl.slice(0, lastSlash + 1);
  const firstFile = firstDirectUrl.slice(lastSlash + 1);

  // Extract suffix like .720p.[itoons.ir].mp4 or .480p.en.[itoons.ir].mp4
  const suffixMatch = firstFile.match(/(\.(?:720p|480p|1080p|360p)[^/]*\.mp4)$/i);
  const suffix = suffixMatch ? suffixMatch[1] : '.[itoons.ir].mp4';

  const candidates = new Set();

  // Pattern A: Title with dots (e.g., Bananas.in.Pyjamas.S02E07.Fishy.Business.720p.[itoons.ir].mp4)
  if (targetEp.title) {
    const cleanT1 = targetEp.title
      .replace(/['’`]/g, '')
      .replace(/[^a-zA-Z0-9&-]+/g, '.')
      .replace(/\.+/g, '.')
      .replace(/^\.|\.$/g, '');
    candidates.add(`${baseDir}${cleanT1}${suffix}`);

    const cleanT2 = targetEp.title
      .replace(/['’`,!?:;]/g, '')
      .replace(/\s+/g, '.')
      .replace(/\.+/g, '.')
      .replace(/^\.|\.$/g, '');
    candidates.add(`${baseDir}${cleanT2}${suffix}`);
  }

  // Pattern B: Numbered prefix like 01.Umbrella.Umbrella.480p.en.[itoons.ir].mp4
  if (/^\d{2,3}\./.test(firstFile) && targetEp.title) {
    const epMatch = targetEp.title.match(/S\d+E(\d+)/i) || targetEp.title.match(/\b(\d{1,3})\b/);
    if (epMatch) {
      const numStr = epMatch[1].padStart(firstFile.indexOf('.'), '0');
      const afterCode = targetEp.title.replace(/^.*?S\d+E\d+\s*/i, '').replace(/^\S+\s+\d+\s+/, '');
      const cleanAfter = afterCode
        .replace(/['’`,!?:;]/g, '')
        .replace(/\s+/g, '.')
        .replace(/\.+/g, '.')
        .replace(/^\.|\.$/g, '');
      candidates.add(`${baseDir}${numStr}.${cleanAfter}${suffix}`);
    }
  }

  return [...candidates];
}

async function main() {
  const packs = JSON.parse(fs.readFileSync(PACKS_PATH, 'utf8'));
  console.log(`Loaded ${packs.length} packs (${packs.reduce((s, p) => s + p.episodes.length, 0)} episodes)`);

  let resolvedByPredict = 0;
  let resolvedByRedirect = 0;
  let failedCount = 0;
  let packsDone = 0;

  // Process packs with concurrency 8
  let cursor = 0;
  async function worker() {
    while (cursor < packs.length) {
      const idx = cursor++;
      const pack = packs[idx];
      if (!pack.episodes || pack.episodes.length === 0) {
        packsDone++;
        continue;
      }

      // If already has directUrl (like Miraculous), skip
      if (pack.episodes[0].directUrl) {
        packsDone++;
        continue;
      }

      // Resolve first episode via redirect
      const firstEp = pack.episodes[0];
      const firstUrl = await resolveRedirect(firstEp.dlHref);
      if (firstUrl) {
        const info = await checkDirectFile(firstUrl);
        firstEp.directUrl = firstUrl;
        firstEp.fileSize = info ? formatSize(info.bytes) : '';
        firstEp.quality = (firstUrl.match(/\b(720p|480p|1080p|360p)\b/i) || [])[1]?.toLowerCase() || '720p';
        resolvedByRedirect++;
      } else {
        failedCount++;
      }

      // Now process episodes 2..N in parallel batches of 6
      const rest = pack.episodes.slice(1);
      for (let i = 0; i < rest.length; i += 6) {
        const batch = rest.slice(i, i + 6);
        await Promise.all(
          batch.map(async (ep) => {
            // Try candidate URLs on dl.itoons.ir first
            const cands = buildCandidateUrls(firstEp, firstUrl, ep);
            for (const cUrl of cands) {
              const info = await checkDirectFile(cUrl);
              if (info) {
                ep.directUrl = info.url;
                ep.fileSize = formatSize(info.bytes);
                ep.quality = (info.url.match(/\b(720p|480p|1080p|360p)\b/i) || [])[1]?.toLowerCase() || firstEp.quality || '720p';
                resolvedByPredict++;
                return;
              }
            }
            // Fallback: resolve via ?dl= redirect on itoons.ir
            const rUrl = await resolveRedirect(ep.dlHref);
            if (rUrl) {
              const info = await checkDirectFile(rUrl);
              ep.directUrl = rUrl;
              ep.fileSize = info ? formatSize(info.bytes) : '';
              ep.quality = (rUrl.match(/\b(720p|480p|1080p|360p)\b/i) || [])[1]?.toLowerCase() || firstEp.quality || '720p';
              resolvedByRedirect++;
            } else {
              failedCount++;
            }
          })
        );
      }

      packsDone++;
      if (packsDone % 50 === 0 || packsDone === packs.length) {
        console.log(
          `Packs: ${packsDone}/${packs.length} | Predicted(dl.itoons.ir): ${resolvedByPredict} | Redirected(itoons.ir): ${resolvedByRedirect} | Failed: ${failedCount}`
        );
        // Save checkpoint every 100 packs
        if (packsDone % 100 === 0) {
          fs.writeFileSync(RESOLVED_PACKS_PATH, JSON.stringify(packs, null, 2), 'utf8');
        }
      }
    }
  }

  await Promise.all(Array.from({ length: 8 }, () => worker()));
  fs.writeFileSync(RESOLVED_PACKS_PATH, JSON.stringify(packs, null, 2), 'utf8');
  console.log(`ALL DONE! Saved to ${RESOLVED_PACKS_PATH}`);
}

main().catch(console.error);
