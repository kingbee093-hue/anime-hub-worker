const fs = require('fs');
const path = require('path');
const CONFIG = require('../config/constants');
const { isAdultContent, isAnime } = require('../utils/filters');
const { convertToFirestoreFormat, delay } = require('../utils/formatters');
const { fetchGraphQL } = require('../utils/fetchHelper');
const { AIRING_ANIME_QUERY } = require('../utils/anilistQueries');

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

  const animeMap = new Map();
  const finalData = [];

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
    const firestoreData = convertToFirestoreFormat(data.media, {
      latestEpisode: data.episode,
      latestEpisodeTitle: `Episode ${data.episode}`,
    });

    if (firestoreData) finalData.push(firestoreData);
  }

  // Sort by newest airing time first
  finalData.sort((a, b) => b.airingTime - a.airingTime);

  const apiFile = path.join(__dirname, '../../api', `${CONFIG.API_PATHS.RECENT_EPISODES}.json`);
  fs.mkdirSync(path.dirname(apiFile), { recursive: true });
  
  let existingContent = '';
  if (fs.existsSync(apiFile)) {
    existingContent = fs.readFileSync(apiFile, 'utf8');
  }
  const newContent = JSON.stringify(finalData, null, 2);
  
  if (existingContent !== newContent) {
    fs.writeFileSync(apiFile, newContent, 'utf8');
    console.log(`✅ Uploaded ${finalData.length} recent episodes to ${apiFile}.`);
  } else {
    console.log('\n✅ No new episodes to upload (API file is up to date).');
  }
}

module.exports = fetchRecentEpisodes;
