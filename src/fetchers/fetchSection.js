const { db } = require('../config/firebase');
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
  const toUpload = [];

  for (const media of mediaList) {
    if (!media || !media.idMal) continue;
    if (isAdultContent(media).blocked || !isAnime(media).allowed) continue;

    const firestoreData = convertToFirestoreFormat(media);
    if (firestoreData) toUpload.push(firestoreData);
  }

  if (toUpload.length > 0) {
    console.log(`🚀 Uploading ${toUpload.length} animes to ${collectionPath}...`);
    let batch = db.batch();
    let count = 0;
    
    for (const item of toUpload) {
      const docRef = db.collection(collectionPath).doc(item.animeId.toString());
      item.updatedAt = new Date();
      batch.set(docRef, item, { merge: true });
      count++;
      
      if (count % 400 === 0) {
          await batch.commit();
          batch = db.batch();
      }
    }
    if (count % 400 !== 0) {
        await batch.commit();
    }
    console.log(`✅ ${sectionName} successfully uploaded.`);
  } else {
      console.log(`⚠️ No valid anime found for ${sectionName}.`);
  }
}

module.exports = fetchSection;
