const fs = require('fs');
const path = require('path');
const CONFIG = require('../config/constants');
const { isAdultContent, isAnime } = require('../utils/filters');
const { convertToFirestoreFormat, delay } = require('../utils/formatters');
const { fetchGraphQL } = require('../utils/fetchHelper');
const { AIRING_ANIME_QUERY } = require('../utils/anilistQueries');

async function collectRecentEpisodesOnce() {
  const allSchedules = [];
  let currentPage = 1;
  let hasNextPage = true;
  const now = Date.now() / 1000;
  const cutoffDate = now - CONFIG.RECENCY_DAYS * 24 * 60 * 60;

  while (hasNextPage) {
    console.log(`Page ${currentPage}...`);
    const data = await fetchGraphQL(AIRING_ANIME_QUERY, {
      page: currentPage,
      perPage: CONFIG.EPISODES_PER_PAGE,
    });

    if (!data || !data.Page) {
      console.error(`Failed to fetch page ${currentPage}, stopping pagination.`);
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

    animeMap.set(animeId, {
      media,
      episode: schedule.episode,
      airingTime: schedule.airingAt,
      scheduleId: schedule.id,
    });
  }

  for (const data of animeMap.values()) {
    const firestoreData = convertToFirestoreFormat(data.media, {
      latestEpisode: data.episode,
      latestEpisodeTitle: `Episode ${data.episode}`,
    });

    if (firestoreData) finalData.push(firestoreData);
  }

  finalData.sort((a, b) => b.airingTime - a.airingTime);
  return finalData;
}

function parseExistingEpisodes(existingContent) {
  try {
    const parsed = JSON.parse(existingContent);
    if (Array.isArray(parsed)) return parsed;
  } catch (_) {
    // Keep safe fallback below.
  }
  return [];
}

async function fetchRecentEpisodes() {
  console.log('========================================');
  console.log('FETCHING RECENT EPISODES');
  console.log('========================================');

  const apiFile = path.join(__dirname, '../../api', `${CONFIG.API_PATHS.RECENT_EPISODES}.json`);
  fs.mkdirSync(path.dirname(apiFile), { recursive: true });

  let existingContent = '';
  if (fs.existsSync(apiFile)) {
    existingContent = fs.readFileSync(apiFile, 'utf8');
  }
  const previousEpisodes = parseExistingEpisodes(existingContent);

  const maxAttempts = 4;
  let finalData = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    finalData = await collectRecentEpisodesOnce();
    if (finalData.length > 0) {
      if (attempt > 1) {
        console.log(`Recovered after retry ${attempt}/${maxAttempts}.`);
      }
      break;
    }

    if (attempt < maxAttempts) {
      const retryDelayMs = CONFIG.RATE_LIMIT_DELAY * (attempt + 1);
      console.warn(
        `Recent episodes result is empty (attempt ${attempt}/${maxAttempts}). Retrying in ${retryDelayMs}ms...`,
      );
      await delay(retryDelayMs);
    }
  }

  if (finalData.length === 0 && previousEpisodes.length > 0) {
    console.warn(
      `Recent episodes still empty after ${maxAttempts} attempts. Keeping previous file with ${previousEpisodes.length} entries.`,
    );
    return;
  }

  if (finalData.length === 0) {
    console.warn(
      `Recent episodes empty after ${maxAttempts} attempts and no previous cache is available. Skipping write to avoid publishing empty feed.`,
    );
    return;
  }

  const newContent = JSON.stringify(finalData, null, 2);
  if (existingContent !== newContent) {
    fs.writeFileSync(apiFile, newContent, 'utf8');
    console.log(`Uploaded ${finalData.length} recent episodes to ${apiFile}.`);
  } else {
    console.log('No new episodes to upload (API file is up to date).');
  }
}

module.exports = fetchRecentEpisodes;
