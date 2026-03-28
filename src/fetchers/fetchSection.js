const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const CONFIG = require('../config/constants');
const { isAdultContent, isAnime } = require('../utils/filters');
const { convertToFirestoreFormat } = require('../utils/formatters');
const { fetchGraphQL } = require('../utils/fetchHelper');
const { GENERIC_MEDIA_QUERY } = require('../utils/anilistQueries');


async function fetchSection(collectionPath, variables, sectionName) {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🌟 FETCHING: ${sectionName}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const data = await fetchGraphQL(GENERIC_MEDIA_QUERY, variables);

  if (!data || !data.Page) {
      console.error(`⚠️  Failed to fetch ${sectionName}`);
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

  const apiFile = path.join(__dirname, '../../api', `${collectionPath}.json`);
  fs.mkdirSync(path.dirname(apiFile), { recursive: true });
  
  // To avoid unnecessary git commits, check if file content actually changed
  let existingContent = '';
  if (fs.existsSync(apiFile)) {
    existingContent = fs.readFileSync(apiFile, 'utf8');
  }
  const newContent = JSON.stringify(finalData, null, 2);
  
  if (existingContent !== newContent) {
    fs.writeFileSync(apiFile, newContent, 'utf8');
    console.log(`✅ ${sectionName} successfully written to ${apiFile}.`);
  } else {
    console.log(`⚠️ No changes detected for ${sectionName}.`);
  }
}

module.exports = fetchSection;
