const { db } = require('../config/firebase');
const CONFIG = require('../config/constants');
const { isAdultContent, isAnime } = require('../utils/filters');
const { convertToFirestoreFormat } = require('../utils/formatters');
const { fetchGraphQL } = require('../utils/fetchHelper');
const { GENERIC_MEDIA_QUERY } = require('../utils/anilistQueries');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '../../seen_cache.json');

async function fetchSection(collectionPath, variables, sectionName) {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🌟 FETCHING: ${sectionName}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const data = await fetchGraphQL(GENERIC_MEDIA_QUERY, variables);

  if (!data || !data.Page) {
      console.error(`⚠️  Failed to fetch ${sectionName}`);
      return;
  }

  const rawCache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) : {};
  if (!rawCache.sections) rawCache.sections = {};
  if (!rawCache.sections[sectionName]) rawCache.sections[sectionName] = {};
  const currentSectionCache = rawCache.sections[sectionName];

  const mediaList = data.Page.media || [];
  const toUpload = [];

  for (const media of mediaList) {
    if (!media || !media.idMal) continue;
    if (isAdultContent(media).blocked || !isAnime(media).allowed) continue;

    const firestoreData = convertToFirestoreFormat(media);
    if (firestoreData) {
      // Create a hash of the structured data to check if it changed
      const itemHash = crypto.createHash('md5').update(JSON.stringify(firestoreData)).digest('hex');
      
      // If the exact same data is already cached, skip it
      if (currentSectionCache[firestoreData.animeId] === itemHash) continue;
      
      currentSectionCache[firestoreData.animeId] = itemHash;
      toUpload.push(firestoreData);
    }
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
    
    // Save updated cache
    fs.writeFileSync(CACHE_FILE, JSON.stringify(rawCache, null, 2), 'utf8');
    
    console.log(`✅ ${sectionName} successfully uploaded.`);
  } else {
      console.log(`⚠️ No valid/new anime updates found for ${sectionName}.`);
  }
}

module.exports = fetchSection;
