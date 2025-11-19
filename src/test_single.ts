import puppeteer from 'puppeteer';

const URL = process.argv[2] || 'https://www.finn.no/realestate/leisuresale/ad.html?finnkode=437605947';

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await sleep(1000);

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

      // images - gather top carousel images
      const imgs = Array.from(document.querySelectorAll('ul li img')) as HTMLImageElement[];
      const images = imgs.map(img => img.getAttribute('srcset') || img.getAttribute('src') || img.getAttribute('data-src')).filter(Boolean) as string[];

      return { title, facilities, description, images };
    });

    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await page.close();
    await browser.close();
  }
})();