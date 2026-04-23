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
 * @param {string} collectionPath - Path to write the JSON file
 * @param {object} variables - GraphQL variables (perPage, sort, etc.)
 * @param {string} sectionName - Human readable name for logging
 * @param {object} options
 * @param {boolean} options.accumulate - Merge with existing data (no deletion)
 * @param {number} options.maxPages - Max pages to fetch (default: 40 = 2000 items)
 * @param {number} options.maxItems - Max total items to collect, stops early if reached
 */
async function fetchSection(collectionPath, variables, sectionName, options = {}) {
  console.log('========================================');
  console.log(`FETCHING: ${sectionName} ${options.accumulate ? '(ACCUMULATE MODE)' : ''}`);
  if (options.maxItems) console.log(`  [Limit: ${options.maxItems} items]`);
  console.log('========================================');

  let page = 1;
  let hasNextPage = true;
  const finalData = [];
  const maxPages = options.maxPages || 40; // Default: 40 pages × 50 = 2000 items
  const maxItems = options.maxItems || Infinity; // Optional hard item cap

  variables.perPage = variables.perPage || 50;

  while (hasNextPage && page <= maxPages && finalData.length < maxItems) {
    variables.page = page;
    console.log(`Fetching page ${page} for ${sectionName}... (collected ${finalData.length}/${maxItems === Infinity ? '∞' : maxItems})`);

    const data = await fetchGraphQL(GENERIC_MEDIA_QUERY, variables);

    if (!data || !data.Page) {
      console.error(`Failed to fetch ${sectionName} on page ${page}`);
      break;
    }

    const mediaList = data.Page.media || [];
    let processedOnPage = 0;

    for (const media of mediaList) {
      if (finalData.length >= maxItems) break; // Stop early if maxItems reached
      if (!media || (!media.idMal && !media.id)) continue;
      if (isAdultContent(media).blocked || !isAnime(media).allowed) continue;

      const firestoreData = convertToFirestoreFormat(media);
      if (firestoreData) {
        finalData.push(firestoreData);
        processedOnPage++;
      }
    }

    console.log(`  -> Processed ${processedOnPage} valid items on page ${page}. Total so far: ${finalData.length}`);

    if (data.Page.pageInfo) {
      hasNextPage = data.Page.pageInfo.hasNextPage;
    } else {
      hasNextPage = false;
    }

    if (hasNextPage && page < maxPages && finalData.length < maxItems) {
       await delay(1000);
    }
    page++;
  }

  console.log(`Finished fetching ${sectionName}. Total valid items: ${finalData.length}`);

  let finalOutput = finalData;
  if (options.accumulate) {
    const existing = readJson(collectionPath);
    if (Array.isArray(existing)) {
      const deduped = new Map();
      for (const item of existing) {
        const id = item.anilistId || item.animeId;
        if (id) deduped.set(String(id), item);
      }
      let newCount = 0;
      for (const item of finalData) {
        const id = item.anilistId || item.animeId;
        if (id) {
          if (!deduped.has(String(id))) newCount++;
          deduped.set(String(id), item);
        }
      }
      finalOutput = Array.from(deduped.values());
      console.log(`[Accumulate] Merged. Added ${newCount} new entries. Total: ${finalOutput.length}`);
    }
  }

  const result = writeJsonIfChanged(collectionPath, finalOutput);
  if (result.changed) {
    console.log(`${sectionName} successfully written to ${result.file}.`);
  } else {
    console.log(`No changes detected for ${sectionName}.`);
  }
}

module.exports = fetchSection;
