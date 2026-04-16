const CONFIG = require('../config/constants');
const { isAdultContent, isAnime } = require('../utils/filters');
const { convertToFirestoreFormat } = require('../utils/formatters');
const { fetchGraphQL } = require('../utils/fetchHelper');
const { GENERIC_MEDIA_QUERY } = require('../utils/anilistQueries');
const { writeJsonIfChanged, readJson } = require('../utils/writeJsonIfChanged');

async function fetchSection(collectionPath, variables, sectionName, options = {}) {
  console.log('========================================');
  console.log(`FETCHING: ${sectionName} ${options.accumulate ? '(ACCUMULATE MODE)' : ''}`);
  console.log('========================================');

  const data = await fetchGraphQL(GENERIC_MEDIA_QUERY, variables);

  if (!data || !data.Page) {
    console.error(`Failed to fetch ${sectionName}`);
    return;
  }

  const mediaList = data.Page.media || [];
  const finalData = [];

  for (const media of mediaList) {
    if (!media || (!media.idMal && !media.id)) continue;
    if (isAdultContent(media).blocked || !isAnime(media).allowed) continue;

    const firestoreData = convertToFirestoreFormat(media);
    if (firestoreData) {
      finalData.push(firestoreData);
    }
  }

  let finalOutput = finalData;
  if (options.accumulate) {
    const existing = readJson(collectionPath);
    if (Array.isArray(existing)) {
      const deduped = new Map();
      // Load existing (older ones might be replaced by newer versions if IDs match)
      for (const item of existing) {
        const id = item.anilistId || item.animeId;
        if (id) deduped.set(String(id), item);
      }
      // Add new ones
      for (const item of finalData) {
        const id = item.anilistId || item.animeId;
        if (id) deduped.set(String(id), item);
      }
      
      finalOutput = Array.from(deduped.values());
      console.log(`[Accumulate] Merged ${finalData.length} new items with ${existing.length} existing. Total: ${finalOutput.length}`);
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
