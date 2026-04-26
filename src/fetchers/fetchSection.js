const fs   = require('fs');
const path = require('path');

const CONFIG    = require('../config/constants');
const { isAdultContent, isAnime }      = require('../utils/filters');
const { convertToFirestoreFormat }     = require('../utils/formatters');
const { fetchGraphQL }                 = require('../utils/fetchHelper');
const { GENERIC_MEDIA_QUERY }          = require('../utils/anilistQueries');
const { writeJsonIfChanged, readJson } = require('../utils/writeJsonIfChanged');
const { writeSectionPages } = require('../utils/sectionPagination');

// ─── Page-state persistence ──────────────────────────────────────────────────
// Using a regular file name (no dot) to ensure it's picked up by git and visible.
const STATE_FILE = path.join(__dirname, '../../api/section_state.json');

function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const content = fs.readFileSync(STATE_FILE, 'utf8');
            const parsed = JSON.parse(content);
            console.log(`  [State] Loaded state from ${STATE_FILE} (${Object.keys(parsed).length} keys)`);
            return parsed;
        }
    } catch (e) {
        console.error('  [State] Failed to load state:', e.message);
    }
    console.log('  [State] No existing state file found or failed to read, starting fresh.');
    return {};
}

function saveState(state) {
    try {
        fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
        // Double check it was written
        if (fs.existsSync(STATE_FILE)) {
            console.log(`  [State] Successfully saved state to ${STATE_FILE}`);
        }
    } catch (e) {
        console.error('  [State] Failed to save state:', e.message);
    }
}
// ─────────────────────────────────────────────────────────────────────────────

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetches a section with full pagination support.
 *
 * Strategy:
 *   accumulate=true  (trending, top_rated, genres):
 *     1. Fetch page 1 first (guarantees latest/newest items)
 *     2. Continue from last saved page (discovers deeper catalog)
 *     3. Merge with existing data — no deletions
 *
 *   accumulate=false (featured, upcoming, top_airing, popular_season):
 *     1. Always start from page 1, fetch sequentially
 *     2. Replace old data completely — always up-to-date
 */
async function fetchSection(collectionPath, variables, sectionName, options = {}) {
    console.log('----------------------------------------');
    console.log(`FETCHING: ${sectionName}${options.accumulate ? ' (ACCUMULATE)' : ' (REPLACE)'}`);
    if (options.maxItems) console.log(`  Target this run: ${options.maxItems} valid items`);

    const state     = loadState();
    const stateKey  = collectionPath;
    const lastSavedPage = options.accumulate ? (state[stateKey] || 0) : 0;

    const hardPageLimit = options.maxItems ? 300 : (options.maxPages || 10);
    const targetItems   = options.maxItems || Infinity;
    variables.perPage = variables.perPage || 50;

    const collected  = [];

    // ── Helper: fetch a single page and append valid items ──────────────────
    async function fetchPage(pageNum) {
        variables.page = pageNum;
        console.log(`  Fetching page ${pageNum}...`);

        const data = await fetchGraphQL(GENERIC_MEDIA_QUERY, variables);

        if (!data || !data.Page) {
            console.error(`  ✗ Failed on page ${pageNum}, stopping.`);
            return { items: 0, hasNext: false };
        }

        const mediaList = data.Page.media || [];
        if (mediaList.length === 0) {
            console.log(`  [Info] Page ${pageNum} is empty.`);
            return { items: 0, hasNext: false };
        }

        let added = 0;
        for (const media of mediaList) {
            if (collected.length >= targetItems) break;
            if (!media || (!media.idMal && !media.id)) continue;
            if (isAdultContent(media).blocked || !isAnime(media).allowed) continue;

            const formatted = convertToFirestoreFormat(media);
            if (formatted) { collected.push(formatted); added++; }
        }

        const pct = targetItems === Infinity
            ? `${collected.length}`
            : `${collected.length}/${targetItems}`;
        console.log(`  Page ${pageNum} — +${added} items (total: ${pct})`);

        return { items: added, hasNext: data.Page.pageInfo?.hasNextPage ?? false };
    }

    if (options.accumulate) {
        // ── ACCUMULATE: page 1 first, then continue from last saved page ────
        console.log(`  [Strategy] Accumulate — fetching page 1 first, then from page ${lastSavedPage + 1}`);

        // Phase 1: Always fetch page 1 (latest data)
        const p1 = await fetchPage(1);
        if (p1.items === 0 && !p1.hasNext) {
            console.log(`  [Info] Page 1 empty, nothing to accumulate.`);
            return;
        }
        if (collected.length < targetItems && p1.hasNext) await delay(1000);

        // Phase 2: Continue from last saved page (skip pages 2..lastSavedPage)
        let page = lastSavedPage > 0 ? lastSavedPage + 1 : 2;
        let hasNextPage = true;

        while (hasNextPage && collected.length < targetItems && page <= hardPageLimit) {
            const result = await fetchPage(page);
            hasNextPage = result.hasNext;
            if (collected.length < targetItems && hasNextPage) {
                await delay(1000);
                page++;
            }
        }

        // Save the last page we reached
        state[stateKey] = page;
        saveState(state);

    } else {
        // ── REPLACE: always start from page 1, fetch sequentially ────────────
        console.log(`  [Strategy] Replace — always starting from page 1`);

        let page = 1;
        let hasNextPage = true;

        while (hasNextPage && collected.length < targetItems && page <= hardPageLimit) {
            const result = await fetchPage(page);
            hasNextPage = result.hasNext;
            if (collected.length < targetItems && hasNextPage) {
                await delay(1000);
                page++;
            }
        }
    }

    console.log(`  ✓ Finished "${sectionName}". Total collected in this run: ${collected.length}`);

    // ── Accumulate (merge, no deletions) ────────────────────────────────────
    let finalOutput = collected;
    if (options.accumulate) {
        const existing = readJson(collectionPath);
        if (Array.isArray(existing) && existing.length > 0) {
            const deduped = new Map();
            // Load existing items
            for (const item of existing) {
                const id = item.anilistId || item.animeId;
                if (id) deduped.set(String(id), item);
            }
            
            let newCount = 0;
            for (const item of collected) {
                const id = item.anilistId || item.animeId;
                if (id) {
                    if (!deduped.has(String(id))) {
                        newCount++;
                    }
                    // Update/Add item
                    deduped.set(String(id), item);
                }
            }
            finalOutput = Array.from(deduped.values());
            console.log(`  [Accumulate] +${newCount} new items added.`);
            console.log(`  [Accumulate] New total entries: ${finalOutput.length}`);
        } else {
            console.log(`  [Accumulate] No existing data found, creating new file with ${collected.length} items.`);
        }
    }

    // ── Write JSON only if content changed ──────────────────────────────────
    const result = writeJsonIfChanged(collectionPath, finalOutput);
    if (result.changed) {
        console.log(`  ✔ Data updated: ${result.file}`);
    } else {
        console.log(`  = No changes in data, skipping file write.`);
    }

    // ── Write paginated page files into subfolder ────────────────────────────
    writeSectionPages(collectionPath, finalOutput);
}

module.exports = fetchSection;
