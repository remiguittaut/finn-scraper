import puppeteer from 'puppeteer';
import { Browser, Page } from 'puppeteer';
import * as fs from 'fs/promises';
import * as path from 'path';

const BASE_URL = "https://www.finn.no/realestate/leisuresale/search.html?filters=";

interface PropertyDetails {
    url: string;
    title?: string | null;
    finnCode: string | null;
    price: string | null;
    address: string | null;
    description: string | null;
    facilities: string[] | null;
    winterSports: boolean;
    summerActivities: boolean;
    altitude: string | null;
    images: string[];
    exploreLink: string | null;
    originalAdObject?: any;
}

let browser: Browser;

async function initializeBrowser() {
    browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
}

async function closeBrowser() {
    if (browser) await browser.close();
}

function sleep(ms: number) {
    return new Promise((res) => setTimeout(res, ms));
}

async function fetchSearchResults(page: Page, url: string): Promise<{ propertyLinks: string[]; nextPageLink: string | null }> {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // wait a bit for JS to populate
    await new Promise((r) => setTimeout(r, 1000));

    const result = await page.evaluate(() => {
        const links: string[] = [];
        const anchors = Array.from(document.querySelectorAll('a[href*="ad.html?finnkode="]')) as HTMLAnchorElement[];
        anchors.forEach((a) => {
            const href = a.getAttribute('href');
            if (href) {
                const full = href.startsWith('http') ? href : `https://www.finn.no${href}`;
                links.push(full);
            }
        });

        let next: string | null = null;
        const pagination = document.querySelector('nav[aria-label="Pagination"]');
        if (pagination) {
            const nextAnchor = pagination.querySelector('a[title="Neste side"]') as HTMLAnchorElement | null;
            if (nextAnchor) {
                const href = nextAnchor.getAttribute('href');
                if (href) next = href.startsWith('http') ? href : `https://www.finn.no${href}`;
            }
        }

        return { links, next };
    });

    const unique = Array.from(new Set(result.links));
    console.log(`Found ${unique.length} links on search page`);
    return { propertyLinks: unique, nextPageLink: result.next };
}

async function downloadImage(url: string, dest: string) {
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`status ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, buf);
    } catch (err) {
        console.warn(`Failed downloading image ${url}: ${(err as any).message}`);
    }
}

function chooseLargestFromSrcset(srcset: string | null): string | null {
    if (!srcset) return null;
    const parts = srcset.split(',').map(p => p.trim()).filter(Boolean);
    if (parts.length === 0) return null;
    const last = parts[parts.length - 1];
    const url = last.split(' ')[0];
    return url.startsWith('http') ? url : `https:${url}`;
}

async function fetchPropertyDetails(page: Page, url: string): Promise<PropertyDetails | null> {
    try {
        await page.goto(url, { waitUntil: 'networkidle2' });
        // small pause so dynamic content populates
        await new Promise((r) => setTimeout(r, 800));

        // Run extraction in page context; try multiple strategies
        const data = await page.evaluate(() => {
            const result: any = { found: false };

            const url = location.href;
            const finnCodeMatch = url.match(/finnkode=(\d+)/);
            result.finnCode = finnCodeMatch ? finnCodeMatch[1] : null;

            // Helper to attempt JSON parse safely
            function safeParse(text: string | null) {
                if (!text) return null;
                try {
                    return JSON.parse(text);
                } catch (e) {
                    return null;
                }
            }

            // 1) Try __NEXT_DATA__
            const nextEl = document.getElementById('__NEXT_DATA__');
            if (nextEl) {
                const parsed = safeParse(nextEl.innerText || nextEl.textContent || '');
                if (parsed) {
                    // try common paths
                    const candidates = [
                        parsed.props?.pageProps?.ad,
                        parsed.props?.initialProps?.pageProps?.ad,
                        parsed.props?.pageProps?.initialData?.ad,
                    ];
                    for (const c of candidates) {
                        if (c && (c.price || c.images || c.location)) {
                            result.ad = c;
                            result.found = true;
                            break;
                        }
                    }
                    if (!result.found) {
                        // try scanning for object with 'ad' like keys
                        function findAd(obj: any): any {
                            if (!obj || typeof obj !== 'object') return null;
                            if (obj.price || obj.images || obj.location || obj.advertisement) return obj;
                            for (const k of Object.keys(obj)) {
                                try {
                                    const v = obj[k];
                                    const f = findAd(v);
                                    if (f) return f;
                                } catch (e) { }
                            }
                            return null;
                        }
                        const found = findAd(parsed);
                        if (found) {
                            result.ad = found;
                            result.found = true;
                        }
                    }
                }
            }

            // 2) Try JSON-LD
            if (!result.found) {
                const jsonLd = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map(s => s.textContent).filter(Boolean);
                for (const txt of jsonLd) {
                    const parsed = safeParse(txt as string);
                    if (parsed && (parsed.name || parsed.price || parsed.image)) {
                        result.ld = parsed;
                        result.found = true;
                        break;
                    }
                }
            }

            // 3) Try other application/json scripts (some contain escaped HTML or html fragments)
            if (!result.found) {
                const aps = Array.from(document.querySelectorAll('script[type="application/json"]')) as HTMLScriptElement[];
                for (const s of aps) {
                    const text = s.textContent || '';
                    const parsed = safeParse(text);
                    if (parsed) {
                        // search for objects that look like ad/props
                        function findCandidate(obj: any): any {
                            if (!obj || typeof obj !== 'object') return null;
                            if (obj.price || obj.images || obj.location || obj.advertisement) return obj;
                            for (const key of Object.keys(obj)) {
                                try {
                                    const res = findCandidate(obj[key]);
                                    if (res) return res;
                                } catch (e) { }
                            }
                            return null;
                        }
                        const found = findCandidate(parsed);
                        if (found) {
                            result.ad = found;
                            result.found = true;
                            break;
                        }
                    }
                }
            }

            // 4) Fallback to DOM queries for price, address, description, title, facilities, images
            if (!result.found) {
                const out: any = {};
                // price attempts
                const metaPrice = document.querySelector('meta[property="product:price:amount"]') as HTMLMetaElement | null;
                if (metaPrice) out.price = metaPrice.getAttribute('content');
                const priceEl = document.querySelector('[data-testid] [data-testid*="price"]') as HTMLElement | null;
                if (!out.price && priceEl) out.price = priceEl.textContent?.trim() || null;

                // address
                const addressEl = document.querySelector('[data-testid*="address"]') as HTMLElement | null;
                if (addressEl) out.address = addressEl.textContent?.trim() || null;

                // description
                const descEl = Array.from(document.querySelectorAll('section')).find(s => (s.textContent || '').includes('Kort om')) as HTMLElement | null;
                if (descEl) out.description = descEl.textContent?.trim() || null;

                // images via carousel
                const images: string[] = [];
                const imgs = Array.from(document.querySelectorAll('ul li img')) as HTMLImageElement[];
                imgs.forEach(img => {
                    const src = img.getAttribute('src') || img.getAttribute('data-src') || null;
                    const srcset = img.getAttribute('srcset');
                    if (srcset) {
                        const parts = srcset.split(',').map(p => p.trim()).filter(Boolean);
                        if (parts.length) {
                            const url = parts[parts.length - 1].split(' ')[0];
                            images.push(url.startsWith('http') ? url : `https:${url}`);
                        }
                    } else if (src) {
                        images.push(src.startsWith('http') ? src : `https:${src}`);
                    }
                });
                if (images.length) {
                    out.images = images;
                    result.ad = out;
                    result.found = true;
                }
            }

            // DOM direct extraction for title, facilities, description even if structured data found
            try {
                const titleEl = document.querySelector('h1');
                result.title = (titleEl && titleEl.textContent) ? titleEl.textContent.trim() : (document.querySelector('meta[property="og:title"]') as HTMLMetaElement)?.getAttribute('content') || document.title;

                // find facilities section
                function extractListFromElement(el: Element | null) {
                    if (!el) return [];
                    const items: string[] = [];
                    const lis = Array.from(el.querySelectorAll('li')) as HTMLElement[];
                    if (lis.length) return lis.map(l => l.textContent?.trim() || '').filter(Boolean);
                    // fallback to children paragraphs/spans
                    const children = Array.from(el.querySelectorAll('p, span, dd')) as HTMLElement[];
                    if (children.length) return children.map(c => c.textContent?.trim() || '').filter(Boolean);
                    // inline text split by newlines
                    const txt = (el.textContent || '').trim();
                    return txt ? txt.split('\n').map(s => s.trim()).filter(Boolean) : [];
                }

                const allEls = Array.from(document.querySelectorAll('*')) as Element[];
                let facilitiesFound: string[] | null = null;
                for (const el of allEls) {
                    const t = (el.textContent || '').trim().toLowerCase();
                    if (t.includes('fasilitet') || t.includes('fasiliteter')) {
                        // try next sibling or parent
                        const next = el.nextElementSibling as Element | null;
                        const fromNext = extractListFromElement(next);
                        if (fromNext.length) { facilitiesFound = fromNext; break; }
                        const parent = el.parentElement;
                        const fromParent = extractListFromElement(parent);
                        if (fromParent.length) { facilitiesFound = fromParent; break; }
                    }
                }
                result.domFacilities = facilitiesFound;

                // description: look for headings like 'Om boligen', 'Kort om', 'Om eiendommen'
                const descKeywords = ['om boligen','kort om','om eiendommen','om eiendommen','om boligen','om eiendommen','om eiendom'];
                let descFound: string | null = null;
                for (const el of allEls) {
                    const txt = (el.textContent || '').trim().toLowerCase();
                    for (const kw of descKeywords) {
                        if (txt.includes(kw)) {
                            // try to get nearby paragraph
                            const next = el.nextElementSibling as HTMLElement | null;
                            if (next && (next.tagName.toLowerCase() === 'p' || next.tagName.toLowerCase() === 'div' || next.tagName.toLowerCase() === 'section')) {
                                descFound = next.textContent?.trim() || null;
                            } else {
                                // try parent
                                descFound = el.parentElement?.textContent?.trim() || null;
                            }
                            break;
                        }
                    }
                    if (descFound) break;
                }
                result.domDescription = descFound;
            } catch (e) {
                // ignore DOM extraction errors
            }

            return result;
        });

        if (!data || (!data.ad && !data.ld)) {
            console.warn(`No structured data found for ${url}`);
        }

        // Build standardized result from extracted data
        const res: PropertyDetails = {
            url,
            title: null,
            finnCode: data?.finnCode || null,
            price: null,
            address: null,
            description: null,
            facilities: null,
            winterSports: false,
            summerActivities: false,
            altitude: null,
            images: [],
            exploreLink: null,
            originalAdObject: data?.ad || data?.ld || null,
        };

        const ad = data?.ad || data?.ld || null;
        if (ad) {
            // price heuristics
            res.price = ad.price?.suggestion || ad.price || ad['price:amount'] || ad.priceAmount || null;
            if (typeof res.price === 'object') res.price = JSON.stringify(res.price);

            // address heuristics
            res.address = ad.location?.address || ad.address || ad['address'] || (ad.ld && ad.ld.address && (ad.ld.address.streetAddress || ad.ld.address.addressLocality)) || null;


            // description (prefer DOM description if present)
            res.description = data?.domDescription || ad.generalText?.find?.((t: any) => t.heading && t.heading.toLowerCase().includes('kort'))?.textUnsafe || ad.description || ad.ld?.description || null;

            // facilities (prefer DOM-extracted facilities)
            if (data?.domFacilities && Array.isArray(data.domFacilities) && data.domFacilities.length) {
                res.facilities = data.domFacilities;
            } else if (Array.isArray(ad.facilities) && ad.facilities.length) {
                res.facilities = ad.facilities;
            }

            // altitude
            if (ad.location?.altitude) {
                res.altitude = ad.location.altitude.toString();
                if (Number(ad.location.altitude) > 400) res.winterSports = true;
            }

            // detect activities from facilities or description
            const textPool = [res.description, JSON.stringify(ad)].filter(Boolean).join(' ').toLowerCase();
            if (textPool.match(/fisk|båt|strand|naust|sjø|vann/)) res.summerActivities = true;
            if (textPool.match(/alp|ski|skiløype|heis|snø/)) res.winterSports = true;

            // images
            if (Array.isArray(ad.images)) {
                res.images = ad.images.map((m: any) => m.uri || m.url).filter(Boolean);
            } else if (ad.image) {
                if (typeof ad.image === 'string') res.images = [ad.image];
                else if (Array.isArray(ad.image)) res.images = ad.image.map((i: any) => i.url || i);
            } else if (data.images) {
                res.images = data.images;
            }
        }

        // DOM-level image fallback: pick largest srcset from carousel
        if ((!res.images || res.images.length === 0)) {
            const imgs = await page.$$eval('ul li img', els => els.map(img => img.getAttribute('srcset') || img.getAttribute('src') || img.getAttribute('data-src')));
            const final: string[] = [];
            for (const s of imgs) {
                if (!s) continue;
                if (s.includes(',')) {
                    const parts = s.split(',').map(p => p.trim()).filter(Boolean);
                    const last = parts[parts.length - 1];
                    const url = last.split(' ')[0];
                    final.push(url.startsWith('http') ? url : `https:${url}`);
                } else {
                    final.push(s.startsWith('http') ? s : `https:${s}`);
                }
            }
            if (final.length) res.images = final;
        }

        // final normalization
        res.images = Array.from(new Set(res.images || [])).slice(0, 20);

        // title: prefer DOM title
        if (data?.title) res.title = data.title;
        else if (data?.ad?.title) res.title = data.ad.title || null;
        else res.title = res.address || null;

        return res;
    } catch (err) {
        console.error(`Error extracting property ${url}: ${(err as any).message}`);
        return null;
    }
}

async function scrapeAllPages(startUrl: string) {
    await initializeBrowser();
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    let currentUrl: string | null = startUrl;
    const allDetails: PropertyDetails[] = [];
    try {
        while (currentUrl) {
            console.log(`Scraping search: ${currentUrl}`);
            const { propertyLinks, nextPageLink } = await fetchSearchResults(page, currentUrl);

            for (const link of propertyLinks) {
                console.log(`Visiting property ${link}`);
                const adPage = await browser.newPage();
                try {
                    const details = await fetchPropertyDetails(adPage, link);
                    if (details) {
                        // download images (rate-limited)
                        if (details.images && details.images.length) {
                            const finn = details.finnCode || (details.url.match(/finnkode=(\d+)/)?.[1]) || 'unknown';
                                for (let i = 0; i < details.images.length; i++) {
                                const imgUrl = details.images[i];
                                const chosen = chooseLargestFromSrcset(imgUrl) || imgUrl;
                                const ext = path.extname(new URL(chosen).pathname).split('?')[0] || '.jpg';
                                const dest = path.join('images', `${finn}_${i}${ext}`);
                                await downloadImage(chosen, dest);
                                await sleep(1000); // enforce 1s between image downloads to avoid rate limiting
                            }
                        }
                        allDetails.push(details);
                    }
                } finally {
                    await adPage.close();
                }
                await sleep(1000); // respect rate limit: 1 request per second between property pages
            }

            if (nextPageLink) {
                // wait 1s before loading the next search page
                await sleep(1000);
                currentUrl = nextPageLink;
            } else {
                currentUrl = null;
            }
        }

        console.log(`Scraping finished. Collected ${allDetails.length} properties.`);
        await fs.writeFile('properties.json', JSON.stringify(allDetails, null, 2));
        console.log('Saved properties.json');
    } finally {
        await page.close();
        await closeBrowser();
    }
}

scrapeAllPages(BASE_URL).catch(err => {
    console.error('Fatal error', err);
    process.exit(1);
});