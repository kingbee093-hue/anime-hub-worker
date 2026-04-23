const CONFIG = require('../config/constants');
const { isAdultContent, isAnime } = require('../utils/filters');
const { convertToFirestoreFormat } = require('../utils/formatters');
const { fetchGraphQL } = require('../utils/fetchHelper');
const { GENERIC_MEDIA_QUERY } = require('../utils/anilistQueries');
const { writeJsonIfChanged, readJson } = require('../utils/writeJsonIfChanged');

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetches a section with full pagination support.
 *
 * @param {string} collectionPath - Path to write the JSON file
 * @param {object} variables - GraphQL variables (perPage, sort, etc.)
 * @param {string} sectionName - Human readable name for logging
 * @param {object} options
 * @param {boolean} options.accumulate  - Merge with existing data without deleting old entries
 * @param {number}  options.maxItems    - Target number of valid items to collect.
 *                                        Worker keeps scanning pages until this is reached,
 *                                        even if it takes 300 pages. No artificial page cap
 *                                        is applied when this is set.
 * @param {number}  options.maxPages    - Hard page cap (used only when maxItems is NOT set).
 *                                        Defaults to 10 (500 items) as a safety fallback.
 */
async function fetchSection(collectionPath, variables, sectionName, options = {}) {
    console.log('========================================');
    console.log(`FETCHING: ${sectionName}${options.accumulate ? ' (ACCUMULATE)' : ''}`);
    if (options.maxItems) console.log(`  Target: ${options.maxItems} valid items`);
    console.log('========================================');

    let page = 1;
    let hasNextPage = true;
    const collected = [];

    // If maxItems is set → scan up to 300 pages to reach that target.
    // If maxItems is NOT set → respect maxPages (default 10) as a safety cap.
    const hardPageLimit = options.maxItems
        ? 300
        : (options.maxPages || 10);

    const targetItems = options.maxItems || Infinity;

    variables.perPage = variables.perPage || 50;

    while (hasNextPage && page <= hardPageLimit && collected.length < targetItems) {
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

        if (hasNextPage && collected.length < targetItems) {
            await delay(1000); // gentle rate-limit
        }
        page++;
    }

    console.log(`  ✓ Finished "${sectionName}". Collected ${collected.length} valid items (scanned ${page - 1} pages).`);

    // ── Accumulate (merge with existing, no deletions) ──────────────────────
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

    // ── Write JSON only if content changed ─────────────────────────────────
    const result = writeJsonIfChanged(collectionPath, finalOutput);
    if (result.changed) {
        console.log(`  ✔ Written to ${result.file}`);
    } else {
        console.log(`  = No changes detected, skipping write.`);
    }
}

module.exports = fetchSection;
