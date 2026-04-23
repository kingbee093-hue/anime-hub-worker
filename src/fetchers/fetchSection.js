const CONFIG = require('../config/constants');
const { isAdultContent, isAnime } = require('../utils/filters');
const { convertToFirestoreFormat } = require('../utils/formatters');
const { fetchGraphQL } = require('../utils/fetchHelper');
const { GENERIC_MEDIA_QUERY } = require('../utils/anilistQueries');
const { writeJsonIfChanged, readJson } = require('../utils/writeJsonIfChanged');

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchSection(collectionPath, variables, sectionName, options = {}) {
  console.log('========================================');
  console.log(`FETCHING: ${sectionName} ${options.accumulate ? '(ACCUMULATE MODE)' : ''}`);
  console.log('========================================');

  let page = 1;
  let hasNextPage = true;
  const finalData = [];
  const maxPages = options.maxPages || 40; // Hard limit of 40 pages (2000 items) to prevent infinite loops and optimize execution time

  // Force perPage to 50 for max efficiency if not specified
  variables.perPage = variables.perPage || 50;

  while (hasNextPage && page <= maxPages) {
    variables.page = page;
    console.log(`Fetching page ${page} for ${sectionName}...`);

    const data = await fetchGraphQL(GENERIC_MEDIA_QUERY, variables);

    if (!data || !data.Page) {
      console.error(`Failed to fetch ${sectionName} on page ${page}`);
      break;
    }

    const mediaList = data.Page.media || [];
    let processedOnPage = 0;

    for (const media of mediaList) {
      if (!media || (!media.idMal && !media.id)) continue;
      if (isAdultContent(media).blocked || !isAnime(media).allowed) continue;

      const firestoreData = convertToFirestoreFormat(media);
      if (firestoreData) {
        finalData.push(firestoreData);
        processedOnPage++;
      }
    }

    console.log(`  -> Processed ${processedOnPage} valid items on page ${page}.`);

    if (data.Page.pageInfo) {
      hasNextPage = data.Page.pageInfo.hasNextPage;
    } else {
      hasNextPage = false;
    }

    if (hasNextPage && page < maxPages) {
       await delay(1000); // 1 sec delay between pages to be gentle on AniList
    }
    page++;
  }

  console.log(`Finished fetching ${sectionName}. Total valid items fetched: ${finalData.length}`);

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
            if (!deduped.has(String(id))) {
                newCount++;
            }
            deduped.set(String(id), item);
        }
      }
      
      finalOutput = Array.from(deduped.values());
      console.log(`[Accumulate] Merged ${finalData.length} fetched items with ${existing.length} existing. Added ${newCount} completely new entries. Total: ${finalOutput.length}`);
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