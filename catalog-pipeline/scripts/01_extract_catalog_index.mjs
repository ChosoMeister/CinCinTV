import http from 'http';
import fs from 'fs';

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
    .trim();
}

async function fetchWithRetry(url, cookieHeader, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, {
        headers: {
          "Cookie": cookieHeader,
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"
        }
      });
      if (r.ok) return await r.text();
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(res => setTimeout(res, 1000));
    }
  }
  return "";
}

async function main() {
  const cookieHeader = await getCookiesFromChrome();
  console.log("Got session cookies from Chrome.");

  const categories = [
    { id: 1, name: "انگلیسی - سریالی", lang: "en" },
    { id: 5, name: "انگلیسی - موضوعی", lang: "en" },
    { id: 9, name: "سینمایی", lang: "en" },
    { id: 8, name: "چینی", lang: "zh" },
    { id: 10, name: "فرانسوی", lang: "fr" },
    { id: 12, name: "آلمانی", lang: "de" },
    { id: 13, name: "عربی", lang: "ar" },
    { id: 3, name: "صوتی", lang: "en" },
    { id: 7, name: "سرگرمی", lang: "en" }
  ];

  const collectionsMap = new Map();

  for (const cat of categories) {
    let page = 1;
    let maxPage = 1;
    while (page <= maxPage) {
      const url = page === 1
        ? `https://hamechizdan.com/collections/${cat.id}`
        : `https://hamechizdan.com/collections/${cat.id}?page=${page}`;
      const html = await fetchWithRetry(url, cookieHeader);
      if (page === 1) {
        const pages = [...new Set((html.match(/\?page=(\d+)/g) || []).map(x => parseInt(x.replace("?page=", ""))))];
        if (pages.length) maxPage = Math.max(...pages);
        console.log(`Scanning Category ${cat.id} (${cat.name}) - ${maxPage} pages...`);
      }

      const cardRegex = /<div class="collections-grid-item">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g;
      let match;
      while ((match = cardRegex.exec(html)) !== null) {
        const block = match[1];
        const idMatch = block.match(/href="https:\/\/hamechizdan\.com\/c\/(\d+)/);
        if (!idMatch) continue;
        const cid = parseInt(idMatch[1]);
        const imgMatch = block.match(/<img[^>]+alt="([^"]*)"[^>]+src="([^"]+)"/);
        const ageMatch = block.match(/<small class="collections-card-age">([\s\S]*?)<\/small>/);
        const flagMatch = block.match(/class="collections-card-flag"[^>]*alt="([^"]*)"/) || block.match(/alt="([^"]*)"[^>]*class="collections-card-flag"/);

        if (!collectionsMap.has(cid)) {
          collectionsMap.set(cid, {
            id: cid,
            title_en: decodeHtml(imgMatch ? imgMatch[1] : ""),
            thumbnail: imgMatch ? imgMatch[2] : "",
            age_group: ageMatch ? ageMatch[1].replace(/\s+/g, " ").trim() : "",
            language: flagMatch ? decodeHtml(flagMatch[1]) : cat.name,
            categories: [cat.name],
            url: `https://hamechizdan.com/c/${cid}`
          });
        } else {
          const existing = collectionsMap.get(cid);
          if (!existing.categories.includes(cat.name)) {
            existing.categories.push(cat.name);
          }
        }
      }
      page++;
    }
  }

  console.log(`Total unique collections discovered from categories: ${collectionsMap.size}`);

  // Also check sitemap.xml for any additional collection IDs
  const sitemapXml = await fetchWithRetry("https://hamechizdan.com/sitemap.xml", cookieHeader);
  const sitemapIds = [...new Set((sitemapXml.match(/https:\/\/hamechizdan\.com\/c\/(\d+)/g) || []).map(u => parseInt(u.split("/").pop())))];
  for (const sid of sitemapIds) {
    if (!collectionsMap.has(sid)) {
      collectionsMap.set(sid, {
        id: sid,
        title_en: "",
        thumbnail: "",
        age_group: "",
        language: "",
        categories: [],
        url: `https://hamechizdan.com/c/${sid}`
      });
    }
  }
  console.log(`Total unique collections including sitemap: ${collectionsMap.size}`);
  fs.writeFileSync("/tmp/collections_index.json", JSON.stringify([...collectionsMap.values()], null, 2));
}

main().catch(console.error);
