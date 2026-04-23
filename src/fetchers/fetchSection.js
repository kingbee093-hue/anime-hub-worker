const fs   = require('fs');
const path = require('path');

const CONFIG    = require('../config/constants');
const { isAdultContent, isAnime }      = require('../utils/filters');
const { convertToFirestoreFormat }     = require('../utils/formatters');
const { fetchGraphQL }                 = require('../utils/fetchHelper');
const { GENERIC_MEDIA_QUERY }          = require('../utils/anilistQueries');
const { writeJsonIfChanged, readJson } = require('../utils/writeJsonIfChanged');

// ─── Page-state persistence ──────────────────────────────────────────────────
// Saved at api/.section_state.json inside the repo so it survives between runs.
const STATE_FILE = path.join(__dirname, '../../api/.section_state.json');

function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        }
    } catch (_) { /* ignore */ }
    return {};
}

function saveState(state) {
    try {
        fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch (e) {
        console.error('  [State] Failed to save state:', e.message);
    }
}
// ─────────────────────────────────────────────────────────────────────────────

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetches a section with full pagination support, resuming from the last
 * page fetched on the previous run (page-state tracking).
 *
 * @param {string} collectionPath - Relative path used as the JSON file key
 * @param {object} variables      - GraphQL query variables
 * @param {string} sectionName    - Label used in log output
 * @param {object} options
 * @param {boolean} options.accumulate - Merge with existing data (no deletions)
 * @param {number}  options.maxItems   - Stop collecting once this many valid items
 *                                       are gathered in this run. Worker scans up
 *                                       to 300 pages to reach the target.
 * @param {number}  options.maxPages   - Hard page cap when maxItems is NOT set (default 10).
 */
async function fetchSection(collectionPath, variables, sectionName, options = {}) {
    console.log('========================================');
    console.log(`FETCHING: ${sectionName}${options.accumulate ? ' (ACCUMULATE)' : ''}`);
    if (options.maxItems) console.log(`  Target this run: ${options.maxItems} valid items`);
    console.log('========================================');

    // ── Resume from last saved page ─────────────────────────────────────────
    const state     = loadState();
    const stateKey  = collectionPath;
    let   startPage = (state[stateKey] || 0) + 1;  // continue from next page
    console.log(`  [State] Last page for "${stateKey}" was ${startPage - 1}, starting at page ${startPage}`);

    const hardPageLimit = options.maxItems ? 300 : (options.maxPages || 10);
    const targetItems   = options.maxItems || Infinity;

    let page         = startPage;
    let hasNextPage  = true;
    let wrappedAround = false;
    const collected  = [];

    variables.perPage = variables.perPage || 50;

    while (hasNextPage && collected.length < targetItems) {
        // If we've passed the hard limit, wrap around to page 1 and continue
        // collecting until we hit targetItems (prevents infinite loop: stop after
        // one full wrap that brings us back to startPage).
        if (page > hardPageLimit) {
            if (wrappedAround) break; // already wrapped once, stop
            console.log(`  [State] Reached page ${page}, wrapping to page 1.`);
            page = 1;
            wrappedAround = true;
        }

        variables.page = page;
        const pct = targetItems === Infinity
            ? `${collected.length}`
            : `${collected.length}/${targetItems}`;
        console.log(`  Page ${page} — collected ${pct} so far...`);

        const data = await fetchGraphQL(GENERIC_MEDIA_QUERY, variables);

        if (!data || !data.Page) {
            console.error(`  ✗ Failed on page ${page}, stopping.`);
            break;
        }

        const mediaList = data.Page.media || [];

        for (const media of mediaList) {
            if (collected.length >= targetItems) break;
            if (!media || (!media.idMal && !media.id)) continue;
            if (isAdultContent(media).blocked || !isAnime(media).allowed) continue;

            const formatted = convertToFirestoreFormat(media);
            if (formatted) collected.push(formatted);
        }

        hasNextPage = data.Page.pageInfo?.hasNextPage ?? false;

        // If AniList says no next page, wrap around on accumulate sections
        if (!hasNextPage && options.accumulate && !wrappedAround && collected.length < targetItems) {
            console.log(`  [State] No more pages from AniList, wrapping to page 1.`);
            page = 1;
            hasNextPage = true;
            wrappedAround = true;
            continue;
        }

        if (hasNextPage && collected.length < targetItems) {
            await delay(1000);
        }
        page++;
    }

    // Save the last page we reached so next run continues from here
    state[stateKey] = page - 1;
    saveState(state);
    console.log(`  [State] Saved last page = ${page - 1} for "${stateKey}"`);
    console.log(`  ✓ Finished "${sectionName}". Collected ${collected.length} valid items.`);

    // ── Accumulate (merge, no deletions) ────────────────────────────────────
    let finalOutput = collected;
    if (options.accumulate) {
        const existing = readJson(collectionPath);
        if (Array.isArray(existing) && existing.length > 0) {
            const deduped = new Map();
            for (const item of existing) {
                const id = item.anilistId || item.animeId;
                if (id) deduped.set(String(id), item);
            }
            let newCount = 0;
            for (const item of collected) {
                const id = item.anilistId || item.animeId;
                if (id) {
                    if (!deduped.has(String(id))) newCount++;
                    deduped.set(String(id), item);
                }
            }
            finalOutput = Array.from(deduped.values());
            console.log(`  [Accumulate] +${newCount} new → total ${finalOutput.length} entries.`);
        }
    }

    // ── Write JSON only if content changed ──────────────────────────────────
    const result = writeJsonIfChanged(collectionPath, finalOutput);
    if (result.changed) {
        console.log(`  ✔ Written to ${result.file}`);
    } else {
        console.log(`  = No changes detected, skipping write.`);
    }
}

module.exports = fetchSection;
