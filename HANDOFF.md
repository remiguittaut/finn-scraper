# Handoff / Conversation Snapshot

Date: 2025-11-19

Purpose: capture the full context, decisions, and next steps so you can pick up the FINN scraper project on another computer.

---

## Short summary

- Project: `finn-scrapper` — Node.js + TypeScript scraper using Puppeteer to extract cabin (leisuresale) ads from FINN.no.
- Key goals: follow search results, visit each ad, extract normalized JSON (include original ad link and `finnkode`), pick largest image from `srcset`, follow pagination and extra links like "Utforsk", respect <= 1 request/sec.
- Current focus: single ad `finnkode=437605947` to stabilize parsing for description variants (particularly the `<div class="description-area whitespace-pre-wrap">` list-style variant).

## Current workspace (important files)

- `package.json` — project dependencies (Puppeteer, TypeScript, ts-node, axios, cheerio, etc.).
- `tsconfig.json`
- `src/main.ts` — main scraper / orchestrator (search pages, pagination, per-ad extraction, image download helpers).
- `src/test_single.ts` — focused extractor for `finnkode=437605947` used to iterate heuristics quickly. This file was recently restored to a user-provided snapshot and tested.
- `properties.json` — output from an initial bulk run (51 properties; many descriptions/facilities were null).
- `images/` — target folder for downloaded images (image-download logic exists in code).
- `HANDOFF.md` — this file.

Repository root: `/Users/remi/source/finn-scrapper`

---

## What was done so far (technical recap)

- Switched from static HTML parsing to Puppeteer because FINN pages render client-side.
- Implemented hybrid extraction approach in `src/main.ts`: try embedded runtime JSON structures (JSON-LD / __NEXT_DATA__-like objects / `application/json` scripts) first, then JSON-LD, then DOM heuristics as fallback.
- Implemented `chooseLargestFromSrcset()` helper to parse `srcset` and pick the largest candidate URL.
- Implemented rate limiting (sleep) to keep requests <= 1 per second.
- Added image download helper to save images to `images/` (with throttling).
- Ran an initial bulk scraping pass (51 properties), wrote `properties.json` (some fields missing; DOM heuristics need hardening).
- Created `src/test_single.ts` and iterated heuristics until it reliably extracted title, `facilities` (array), a paragraph-style `description`, and `images` (as `srcset` strings) for `finnkode=437605947` in the current render.
- Attempted to surface an alternate HTML variant (the `<div class="description-area whitespace-pre-wrap">` block that contains a `<br>`-separated "Verdt å merke seg" list) by clicking UI elements and trying mobile UA; it was not present in the current render.

---

## Test commands (how to run locally)

Install dependencies (if not already installed):

```bash
pnpm install
```

Run the focused test (single ad):

```bash
pnpm exec ts-node src/test_single.ts
```

Run the main scraper (be careful; respects 1s delay but can still load many pages):

```bash
pnpm exec ts-node src/main.ts
```

Notes:
- `src/test_single.ts` currently defaults to `finnkode=437605947`. Edit it or pass an environment variable if you want a different ad.
- If you want to run Puppeteer in headful mode for debugging, set the environment variable `HEADFUL=true` before running or modify the script's launch options.

---

## How to commit & push to GitHub (example commands)

1. If you haven't created a Git repo yet in this folder, initialize it and create a branch:

```bash
cd /Users/remi/source/finn-scrapper
git init
git add .
git commit -m "Initial finn-scrapper work: puppeteer scraper + test harness"
# create branch for work
git branch -M main
```

2. Create a GitHub repository on GitHub (via web UI) and copy the remote URL, e.g. `git@github.com:youruser/finn-scrapper.git` or `https://github.com/youruser/finn-scrapper.git`.

3. Add the remote and push:

```bash
git remote add origin git@github.com:youruser/finn-scrapper.git
git push -u origin main
```

4. If you prefer a named branch for continuing work, create and push it:

```bash
git checkout -b feat/robust-extraction
git push -u origin feat/robust-extraction
```

Important: this repo may contain Puppeteer, which on first install downloads Chromium. On other machines, run `pnpm install` which will fetch the browser binary and dependencies.

---

## How to pick up on another computer

1. Clone repository:

```bash
git clone git@github.com:youruser/finn-scrapper.git
cd finn-scrapper
pnpm install
```

2. Run the single-ad test to confirm everything works:

```bash
pnpm exec ts-node src/test_single.ts
```

3. If you want to run with a visible browser for debugging:

```bash
export HEADFUL=true
pnpm exec ts-node src/test_single.ts
```

4. If you want to try mobile UA to surface alternate rendering:

- Edit `src/test_single.ts` (or `src/main.ts`) and set the page emulation in Puppeteer to a mobile device (example: `page.emulate(puppeteer.devices['iPhone 12'])`) then run the script again.

---

## Known gaps / next tasks (pick these up next)

- Merge robust DOM heuristics from `src/test_single.ts` into `src/main.ts`'s `fetchPropertyDetails()` so the main scraper returns consistent `description` and `facilities` values.
- Normalize images: make final output contain a single largest image URL per carousel image (use `chooseLargestFromSrcset()`), and optionally download them.
- Add a CLI or config to limit total number of ads to scrape for safer testing.
- Investigate why the `<div class="description-area whitespace-pre-wrap">` variant isn't appearing:
  - Try mobile UA emulation, or click additional UI elements programmatically (we attempted this but did not find the variant in the current render).
- Add automated tests for the in-page extraction helper (using a saved HTML snippet) so parsing doesn't regress.

---

## Quick developer notes (where to look in code)

- `src/test_single.ts` — fastest place to iterate heuristics for a single ad.
- `src/main.ts` — orchestrates search pagination and calls the per-ad extraction; merge validated heuristics here.
- `chooseLargestFromSrcset()` — helper to parse `srcset` and determine largest image.

---

## If you want me to do the push now

Tell me whether you want me to:
- (A) Run the git commit & push commands now (I can run them locally in this workspace), or
- (B) Only create this `HANDOFF.md` and you will perform the remote push from your machine.

If you choose (A), please provide the remote repository URL (or add it to the repo) and confirm you'd like me to push.

---

## Full conversation snapshot

(Shortened / redacted for readability — the full chat log is available on your machine in the `HANDOFF.md` created here. If you want a raw full transcript inserted, I can add it.)

- Created Puppeteer-based scraper due to client-side rendering.
- Implemented hybrid extraction (embedded JSON → JSON-LD → DOM heuristics).
- Implemented srcset largest-candidate parsing and image download helper.
- Ran initial bulk scraping (51 ads) — `properties.json` produced.
- Focused on `finnkode=437605947` in `src/test_single.ts` and iterated description/facilities extraction; currently returns paragraph-style description in the present render.
- Attempted to surface `<div class="description-area whitespace-pre-wrap">` variant (list-style with `<br>`), but it was not present in the current rendering. Suggested mobile UA / alternative UI interactions as follow-up.

---

## Contact / support

If you want, I can:
- Push the current repository to your GitHub remote now (if you provide the URL).
- Add a `README.md` with the same quick-start steps (I can create that file too).
- Add a `scripts` entry to `package.json` for common tasks (`test-single`, `scrape`, etc.).

Tell me which option you prefer and I will continue.

