const CONFIG = require('../config/constants');
const { isAdultContent, isAnime } = require('../utils/filters');
const { convertToFirestoreFormat } = require('../utils/formatters');
const { fetchGraphQL } = require('../utils/fetchHelper');
const { GENERIC_MEDIA_QUERY } = require('../utils/anilistQueries');
const { writeJsonIfChanged } = require('../utils/writeJsonIfChanged');

async function fetchSection(collectionPath, variables, sectionName) {
  console.log('========================================');
  console.log(`FETCHING: ${sectionName}`);
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

  const result = writeJsonIfChanged(collectionPath, finalData);
  if (result.changed) {
    console.log(`${sectionName} successfully written to ${result.file}.`);
  } else {
    console.log(`No changes detected for ${sectionName}.`);
  }
}

module.exports = fetchSection;
