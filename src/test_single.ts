import puppeteer from 'puppeteer';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import axios from 'axios';

const URL = process.argv[2] || 'https://www.finn.no/realestate/leisuresale/ad.html?finnkode=437605947';

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  console.error('Starting scraper for', URL);
  console.error('Launching browser...');
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] });
  console.error('Browser launched');
  console.error('Opening new page...');
  const page = await browser.newPage();
  console.error('Page opened');
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  try {
    console.error('Navigating to', URL);
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    console.error('Page loaded (domcontentloaded). Waiting 1s for dynamic content...');
    await sleep(1000);

    console.error('Extracting structured data from page...');
    const result = await page.evaluate(() => {
      function safeText(el: Element | null) { return el ? (el.textContent || '').trim() : null; }

      const titleEl = document.querySelector('h1');
      const title = safeText(titleEl) || (document.querySelector('meta[property="og:title"]') as HTMLMetaElement)?.getAttribute('content') || document.title;

      // Extract facilities by finding heading containing "Fasilitet" or "Fasiliteter" and collecting small leaf nodes
      function extractFacilitiesFromSection(el: Element | null) {
        if (!el) return [] as string[];
        // Collect leaf nodes (no children) with short text
        const candidates = Array.from(el.querySelectorAll('*')) as HTMLElement[];
        const items = candidates
          .filter(c => c.children.length === 0)
          .map(c => (c.textContent||'').trim())
          .map(t => t.replace(/\s+/g, ' '))
          .filter(t => t && t.length > 0 && t.length < 80 && !t.match(/^\s*Foto[:]?/i));
        // Deduplicate and return
        return Array.from(new Set(items));
      }

      let facilities: string[] | null = null;
      const headings = Array.from(document.querySelectorAll('h2, h3, h4, strong, p')) as HTMLElement[];
      for (const h of headings) {
        const t = (h.textContent||'').toLowerCase();
        if (t.includes('fasilitet') || t.includes('fasiliteter')) {
          const next = h.nextElementSibling;
          facilities = extractFacilitiesFromSection(next || h.parentElement);
          if (facilities && facilities.length) break;
        }
      }

      // Description - find heading elements that exactly (or closely) match the section title like 'Om boligen' or 'Kort om eiendommen'
      const descKeywords = ['om boligen','kort om','om eiendommen','om eiendom','om boligen','kort om eiendommen'];
      let description: string | null = null;
      const headingEls = Array.from(document.querySelectorAll('h1,h2,h3,h4,legend')) as HTMLElement[];
      function normalize(s: string) { return s.replace(/\s+/g,' ').trim().toLowerCase(); }
      for (const h of headingEls) {
        const nt = normalize(h.textContent || '');
        for (const kw of descKeywords) {
          if (nt === kw || nt.startsWith(kw + ' ') || nt.includes(kw)) {
            // prefer next sibling paragraphs
            let node: Element | null = h.nextElementSibling;
            let collected = '';
            let attempts = 0;
            while (node && attempts < 6) {
              const tag = node.tagName.toLowerCase();
              if (tag === 'p' || tag === 'div' || tag === 'section') {
                const text = (node.textContent || '').trim();
                if (text.length > 30) {
                  collected += (collected ? '\n\n' : '') + text;
                }
              }
              // stop if we hit a new heading
              if (node.querySelector && (node.querySelector('h1,h2,h3,h4') || node.previousElementSibling?.tagName?.toLowerCase()?.startsWith('h'))) break;
              node = node.nextElementSibling;
              attempts++;
            }
            if (collected && collected.length > 40) { description = collected; break; }
            // fallback: look inside parent for first long paragraph
            const parentParagraphs = h.parentElement ? Array.from(h.parentElement.querySelectorAll('p')) as HTMLParagraphElement[] : [];
            if (parentParagraphs.length) {
              const long = parentParagraphs.map(p=> (p.textContent||'').trim()).sort((a,b)=>b.length-a.length)[0];
              if (long && long.length > 40) { description = long; break; }
            }
          }
        }
        if (description) break;
      }

        // images - gather top carousel images and normalize to largest-resolution URL
        const imgs = Array.from(document.querySelectorAll('ul li img')) as HTMLImageElement[];
        const rawImages = imgs.map(img => img.getAttribute('srcset') || img.getAttribute('src') || img.getAttribute('data-src')).filter(Boolean) as string[];

        function chooseLargestFromSrcset(val: string | null) {
          if (!val) return null;
          const s = String(val).trim();
          const parts = s.split(',').map(p => p.trim()).filter(Boolean);
          // Helper to parse a part into {url, w, isWebp}
          function parsePart(p: string) {
            const m = p.match(/^(\S+)(?:\s+(\d+)w)?$/);
            if (!m) return null;
            const url = m[1];
            const w = m[2] ? parseInt(m[2], 10) : 0;
            const isWebp = /\.webp(\?|$)/i.test(url) || url.toLowerCase().includes('.webp');
            return { url, w, isWebp };
          }

          const parsed = parts.map(parsePart).filter(Boolean) as Array<{url:string,w:number,isWebp:boolean}>;
          if (!parsed.length) return null;

          // Prefer the largest WebP if present
          const webps = parsed.filter(p => p.isWebp);
          if (webps.length) {
            webps.sort((a,b) => b.w - a.w);
            return webps[0].url;
          }

          // Fallback: pick largest overall
          parsed.sort((a,b) => b.w - a.w);
          return parsed[0].url;
        }

        const images = Array.from(new Set(rawImages.map(r => chooseLargestFromSrcset(r)).filter(Boolean))) as string[];

        // Key info (Nøkkelinfo) - dl with dt/dd pairs
        const keyInfoSection = document.querySelector('section[data-testid="key-info"], section[aria-labelledby="keyinfo-heading"]');
        const keyInfo: Record<string, string|number|null> = {};
        // helpers to parse numeric fields from strings
        function parseAreaNumber(s: string | null) {
          if (!s) return null;
          const cleaned = (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
          // match first number with optional decimal/comma
          const m = cleaned.match(/([0-9]+(?:[.,][0-9]+)?)/);
          if (!m) return null;
          const num = parseFloat(m[1].replace(',', '.'));
          return Number.isFinite(num) ? num : null;
        }
        function parseIntNumber(s: string | null) {
          if (!s) return null;
          const m = (s || '').match(/(\d+)/);
          if (!m) return null;
          const n = parseInt(m[1], 10);
          return Number.isFinite(n) ? n : null;
        }

        if (keyInfoSection) {
          const dts = Array.from(keyInfoSection.querySelectorAll('dt')) as HTMLElement[];
          for (const dt of dts) {
            const rawKey = (dt.textContent || '').replace(/\s+/g, ' ').trim();
            const dd = dt.nextElementSibling as HTMLElement | null;
            const rawVal = dd ? (dd.textContent || '').replace(/\s+/g, ' ').trim() : null;
            function mapKey(k: string) {
              const s = k.toLowerCase();
              if (s.includes('beliggenhet')) return 'situation';
              if (s.includes('boligtype')) return 'propertyType';
              if (s.includes('eieform')) return 'ownershipType';
              if (s.includes('internt bruksareal')) return 'usableIArea';
              if (s.includes('bruksareal')) return 'usableArea';
              if (s.includes('balkong') || s.includes('terrasse')) return 'openArea';
              if (s.includes('tomteareal') || s.includes('tomteareal')) return 'plotArea';
              if (s.includes('byggeår') || s.includes('byggår')) return 'constructionYear';
              if (s.includes('soverom')) return 'bedrooms';
              if (s.includes('rom')) return 'rooms';
              if (s.includes('overtakelse') || s.includes('overtakelse')) return 'acquisition';
              return k.replace(/\s+/g,'_');
            }
            const mapped = mapKey(rawKey);
            // Normalize numeric fields where appropriate
            let value: string|number|null = rawVal;
            if (mapped === 'usableIArea' || mapped === 'usableArea' || mapped === 'openArea' || mapped === 'plotArea') {
              const n = parseAreaNumber(rawVal);
              value = n !== null ? n : rawVal;
            } else if (mapped === 'constructionYear') {
              const n = parseIntNumber(rawVal);
              value = n !== null ? n : rawVal;
            } else if (mapped === 'bedrooms' || mapped === 'rooms') {
              const n = parseIntNumber(rawVal);
              value = n !== null ? n : rawVal;
            }
            keyInfo[mapped] = value;
          }
        }

        // Area description (Arealbeskrivelse) - preserve line breaks from <br>
        function extractRichText(selector: string) {
          const node = document.querySelector(selector) as HTMLElement | null;
          if (!node) return null;
          // Replace <br> with newline then strip remaining tags
          const html = node.innerHTML.replace(/<br\s*\/?>/gi, '\n');
          const tmp = document.createElement('div');
          tmp.innerHTML = html;
          return (tmp.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+$/,'').trim();
        }

        const areaDescription = extractRichText('[data-testid="html-arealbeskrivelse"] .description-area') || extractRichText('[data-testid="area-description"] .description-area');
        const salesCosts = extractRichText('[data-testid="html-omkostninger"] .description-area');

        // Matrikkelinformasjon
        const cadastreNode = document.querySelector('section[data-testid="cadastre-info"]');
        const cadastre: Record<string,string> = {};
        if (cadastreNode) {
          const divs = Array.from(cadastreNode.querySelectorAll('div')) as HTMLElement[];
          for (const d of divs) {
            const txt = (d.textContent || '').replace(/\s+/g,' ').trim();
            const parts = txt.split(':').map(p=>p.trim()).filter(Boolean);
            if (parts.length === 2) cadastre[parts[0]] = parts[1];
          }
        }

        // Pricing details
        const pricingNode = document.querySelector('section[data-testid="pricing-details"]');
        const pricingDetails: Record<string, number|string|null> = {};
        function parseAmount(s: string | null) {
          if (!s) return null;
          let t = String(s || '');
          // Remove currency words and non-number punctuation commonly used
          t = t.replace(/kr\.?/gi, '');
          t = t.replace(/nok\.?/gi, '');
          // remove non-digit except comma and dot and minus
          // first remove spaces and non-breaking spaces
          t = t.replace(/\u00a0/g, ' ');
          t = t.replace(/\s+/g, '');
          // remove dots used as thousand separators
          t = t.replace(/\./g, '');
          // replace comma with dot for decimals
          t = t.replace(/,/g, '.');
          // strip anything left that's not digit or dot or -
          t = t.replace(/[^0-9.\-]/g, '');
          if (!t || !t.match(/[0-9]/)) return null;
          const n = parseFloat(t);
          return Number.isFinite(n) ? n : null;
        }

        function normalizeLabelKey(k: string) {
          const s = (k || '').toLowerCase().replace(/\s+/g, ' ').trim();
          if (s.includes('prisantydning') || (s.includes('pris') && s.includes('antyd'))) return 'askingPrice';
          if (s.includes('totalpris')) return 'totalPrice';
          if (s.includes('felleskost') || s.includes('fellesutg')) return 'commonCosts';
          if (s.includes('omkost') || s.includes('dokumentavgift')) return 'fees';
          if (s.includes('pris')) return 'price';
          return s.replace(/\s+/g,'_');
        }

        if (pricingNode) {
          // Prefer dt/dd pairs
          const dts = Array.from(pricingNode.querySelectorAll('dt')) as HTMLElement[];
          if (dts.length) {
            for (const dt of dts) {
              const keyRaw = (dt.textContent || '').replace(/\s+/g,' ').trim();
              const dd = dt.nextElementSibling as HTMLElement | null;
              const valRaw = dd ? (dd.textContent || '').replace(/\s+/g,' ').trim() : null;
              const key = normalizeLabelKey(keyRaw);
              const n = parseAmount(valRaw);
              pricingDetails[key] = n !== null ? n : (valRaw || null);
            }
          } else {
            // fallback: rows separated by divs or paragraphs
            const rows = Array.from(pricingNode.querySelectorAll('div, p')) as HTMLElement[];
            for (const r of rows) {
              const txt = (r.textContent || '').replace(/\s+/g,' ').trim();
              if (!txt) continue;
              const parts = txt.split(':');
              if (parts.length >= 2) {
                const keyRaw = parts[0].trim();
                const valRaw = parts.slice(1).join(':').trim();
                const key = normalizeLabelKey(keyRaw);
                const n = parseAmount(valRaw);
                pricingDetails[key] = n !== null ? n : valRaw;
              } else if (r.children.length >= 2) {
                const k = (r.children[0].textContent || '').trim();
                const v = (r.children[r.children.length-1].textContent || '').trim();
                const key = normalizeLabelKey(k);
                const n = parseAmount(v);
                pricingDetails[key] = n !== null ? n : v;
              }
            }
          }
        }

        // Also check for the prominent indicative asking price element and prefer it
        try {
          const indicative = document.querySelector('[data-testid="pricing-indicative-price"]');
          if (indicative) {
            // the value is often in a bold/large span as the last span
            const valEl = indicative.querySelector('span.text-28.font-bold, span.font-bold, span.text-28, span:last-child') as HTMLElement | null;
            const valRaw = valEl ? (valEl.textContent || '').replace(/\s+/g,' ').trim() : (indicative.textContent || '').replace(/\s+/g,' ').trim();
            const n = parseAmount(valRaw);
            pricingDetails['askingPrice'] = n !== null ? n : (valRaw || null);
          }
        } catch (e) {
          // ignore
        }

        return { title, facilities, description, images, keyInfo, areaDescription, salesCosts, cadastre, pricingDetails };
    });

    // Download normalized images into `images/` directory
    async function downloadImages(urls: string[], destDir: string, prefix: string) {
      await fsPromises.mkdir(destDir, { recursive: true });
      const downloaded: string[] = [];
      function drawProgress(done: number, total: number) {
        try {
          const width = 30;
          const filled = Math.round((done / Math.max(1, total)) * width);
          const empty = width - filled;
          const bar = '[' + '#'.repeat(filled) + '-'.repeat(empty) + `] ${done}/${total}`;
          process.stderr.write('\r' + bar);
        } catch (e) {}
      }

      for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        if (!url) continue;
        try {
          // Update progress before starting
          drawProgress(i, urls.length);
          console.error(`\nDownloading image ${i+1}/${urls.length}: ${url}`);
          const basename = ((): string => {
            try {
              const U = (globalThis as any).URL || (globalThis as any).url;
              if (U) return path.basename(new U(url).pathname);
            } catch (e) {}
            try {
              return path.basename((url.split('?')[0].split('/').pop() as string) || `img${i}.jpg`);
            } catch (e) { return `img${i}.jpg`; }
          })();
          const filename = `${prefix}_${i}_${basename}`;
          const dest = path.join(destDir, filename);
          const writer = fs.createWriteStream(dest);
          const resp = await axios.get(url, { responseType: 'stream', timeout: 30000 });
          await new Promise<void>((resolve, reject) => {
            resp.data.pipe(writer);
            writer.on('finish', () => resolve());
            writer.on('error', (err: any) => reject(err));
            resp.data.on('error', (err: any) => reject(err));
          });
          downloaded.push(dest);
          console.error(`Downloaded ${i+1}/${urls.length} -> ${dest}`);
          // Update progress after successful download
          drawProgress(i + 1, urls.length);
        } catch (err) {
          // skip failures but continue
          console.error('Image download failed for', url, err ? String(err) : '');
        }
        // respect <=1 req/sec when downloading multiple images
        if (i < urls.length - 1) await new Promise(r => setTimeout(r, 1100));
      }
      // newline after progress bar finished
      try { process.stderr.write('\n'); } catch (e) {}
      return downloaded;
    }

    const imagesToDownload = Array.isArray(result.images) ? result.images : [];
    const finnMatch = (URL || '').toString().match(/finnkode=(\d+)/);
    const finnPrefix = (finnMatch && finnMatch[1]) ? `finn_${finnMatch[1]}` : `finn_${Date.now()}`;
    const imagesDir = path.join(process.cwd(), 'images');
    let downloadedFiles: string[] = [];
    if (imagesToDownload.length) {
      console.error(`Preparing to download ${imagesToDownload.length} images to ${imagesDir}`);
      try {
        // download images sequentially to avoid bursts
        downloadedFiles = await downloadImages(imagesToDownload, imagesDir, finnPrefix);
        console.error(`Finished downloading images (${downloadedFiles.length}/${imagesToDownload.length})`);
      } catch (err) {
        console.error('Downloading images failed:', err);
      }
    } else {
      console.error('No images to download');
    }
    // attach downloaded file paths to output
    (result as any).downloaded = downloadedFiles;

    // Ensure a local `tmp/` directory and save the full JSON there (instead of /tmp)
    try {
      const outDir = path.join(process.cwd(), 'tmp');
      await fsPromises.mkdir(outDir, { recursive: true });
      const outName = `${finnPrefix}_scrape_${Date.now()}.json`;
      const outPath = path.join(outDir, outName);
      await fsPromises.writeFile(outPath, JSON.stringify(result, null, 2), 'utf8');
      console.error('Saved JSON output to', outPath);
    } catch (e) {
      console.error('Failed to write local tmp file', e);
    }
    console.error('Closing page and browser...');
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await page.close();
    await browser.close();
  }
})();