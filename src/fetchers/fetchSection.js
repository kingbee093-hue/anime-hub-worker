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
 * Fetches a section with full pagination support, resuming from the last
 * page fetched on the previous run (page-state tracking).
 */
async function fetchSection(collectionPath, variables, sectionName, options = {}) {
    console.log('----------------------------------------');
    console.log(`FETCHING: ${sectionName}${options.accumulate ? ' (ACCUMULATE)' : ''}`);
    if (options.maxItems) console.log(`  Target this run: ${options.maxItems} valid items`);

    // ── Resume from last saved page ─────────────────────────────────────────
    const state     = loadState();
    const stateKey  = collectionPath;
    let   lastSavedPage = state[stateKey] || 0;
    let   startPage     = lastSavedPage + 1;

    console.log(`  [State] Last page for "${stateKey}" was ${lastSavedPage}, starting at page ${startPage}`);

    const hardPageLimit = options.maxItems ? 300 : (options.maxPages || 10);
    const targetItems   = options.maxItems || Infinity;

    let page         = startPage;
    let hasNextPage  = true;
    let wrappedAround = false;
    const collected  = [];

    variables.perPage = variables.perPage || 50;

    while (hasNextPage && collected.length < targetItems) {
        if (page > hardPageLimit) {
            if (wrappedAround) break; 
            console.log(`  [State] Reached page limit ${hardPageLimit}, wrapping to page 1.`);
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
        if (mediaList.length === 0) {
            console.log(`  [Info] Page ${page} is empty.`);
            hasNextPage = false;
        } else {
            for (const media of mediaList) {
                if (collected.length >= targetItems) break;
                if (!media || (!media.idMal && !media.id)) continue;
                if (isAdultContent(media).blocked || !isAnime(media).allowed) continue;

                const formatted = convertToFirestoreFormat(media);
                if (formatted) collected.push(formatted);
            }
            hasNextPage = data.Page.pageInfo?.hasNextPage ?? false;
        }

        // If AniList says no next page, wrap around on accumulate sections
        if (!hasNextPage && options.accumulate && !wrappedAround && collected.length < targetItems) {
            console.log(`  [State] No more pages available, wrapping to page 1.`);
            page = 1;
            hasNextPage = true;
            wrappedAround = true;
            continue;
        }

        if (hasNextPage && collected.length < targetItems) {
            await delay(1000);
            page++;
        }
    }

    // Save the last page we reached
    state[stateKey] = page;
    saveState(state);
    
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
