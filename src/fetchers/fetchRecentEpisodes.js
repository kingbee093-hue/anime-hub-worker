const fs = require('fs');
const path = require('path');
const { db } = require('../config/firebase');
const CONFIG = require('../config/constants');
const { isAdultContent, isAnime } = require('../utils/filters');
const { convertToFirestoreFormat, delay } = require('../utils/formatters');
const { fetchGraphQL } = require('../utils/fetchHelper');
const { AIRING_ANIME_QUERY } = require('../utils/anilistQueries');

const CACHE_FILE = path.join(__dirname, '../../seen_cache.json');

async function fetchRecentEpisodes() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📺 FETCHING RECENT EPISODES');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const allSchedules = [];
  let currentPage = 1;
  let hasNextPage = true;
  const now = Date.now() / 1000;
  const cutoffDate = now - (CONFIG.RECENCY_DAYS * 24 * 60 * 60);

  while (hasNextPage) {
    console.log(`📄 Page ${currentPage}...`);
    const data = await fetchGraphQL(AIRING_ANIME_QUERY, {
      page: currentPage,
      perPage: CONFIG.EPISODES_PER_PAGE,
    });

    if (!data || !data.Page) {
      console.error(`⚠️  Failed to fetch page ${currentPage}, stopping pagination`);
      break;
    }

    const schedules = data.Page.airingSchedules || [];
    allSchedules.push(...schedules);

    if (schedules.length > 0) {
      const oldestOnPage = schedules[schedules.length - 1].airingAt;
      if (oldestOnPage < cutoffDate) {
        hasNextPage = false;
        break;
      }
    }

    hasNextPage = !!data.Page.pageInfo?.hasNextPage;
    if (hasNextPage) {
      currentPage++;
      await delay(CONFIG.RATE_LIMIT_DELAY);
    }
  }

  const rawCache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) : {};
  if (!rawCache.recent_episodes) rawCache.recent_episodes = {};
  const newSeen = { ...rawCache.recent_episodes };
  const toUpload = [];
  const animeMap = new Map();

  for (const schedule of allSchedules) {
    const media = schedule.media;
    if (!media || (!media.idMal && !media.id)) continue;
    if (isAdultContent(media).blocked || !isAnime(media).allowed) continue;
    if (schedule.airingAt < cutoffDate || media.status !== 'RELEASING') continue;

    const animeId = media.idMal || media.id;
    if (animeMap.has(animeId) && animeMap.get(animeId).episode >= schedule.episode) continue;
    
    animeMap.set(animeId, { media, episode: schedule.episode, airingTime: schedule.airingAt, scheduleId: schedule.id });
  }

  for (const data of animeMap.values()) {
    const fallbackId = data.media.idMal || data.media.id;
    const key = `${fallbackId}_ep${data.episode}`;
    if (rawCache.recent_episodes[key]) continue;
    newSeen[key] = data.airingTime;

    const firestoreData = convertToFirestoreFormat(data.media, {
      latestEpisode: data.episode,
      latestEpisodeTitle: `Episode ${data.episode}`,
    });

    if (firestoreData) toUpload.push(firestoreData);
  }

  if (toUpload.length > 0) {
    console.log(`\n🚀 Uploading ${toUpload.length} new episodes to Firestore...`);
    let batch = db.batch();
    let count = 0;

    for (const item of toUpload) {
      const docRef = db.collection(CONFIG.FIRESTORE_COLLECTIONS.RECENT_EPISODES).doc(item.animeId.toString());
      item.updatedAt = new Date();
      batch.set(docRef, item, { merge: true });
      count++;
      
      // Batch limit is 500
      if (count % 400 === 0) {
          await batch.commit();
          batch = db.batch();
      }
    }
    if (count % 400 !== 0) {
        await batch.commit();
    }
    
    rawCache.recent_episodes = newSeen;
    fs.writeFileSync(CACHE_FILE, JSON.stringify(rawCache, null, 2), 'utf8');
    console.log(`✅ Uploaded ${toUpload.length} episodes.`);
  } else {
    console.log('\n✅ No new episodes to upload.');
  }
}

module.exports = fetchRecentEpisodes;
