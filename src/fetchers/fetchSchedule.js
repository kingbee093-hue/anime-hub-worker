const CONFIG = require('../config/constants');
const { fetchGraphQL } = require('../utils/fetchHelper');
const { AIRING_SCHEDULE_WINDOW_QUERY } = require('../utils/anilistQueries');
const { convertToFirestoreFormat } = require('../utils/formatters');
const { isAdultContent, isAnime } = require('../utils/filters');
const { writeJsonIfChanged } = require('../utils/writeJsonIfChanged');

const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function buildWeekWindow() {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);

  return {
    from: Math.floor(start.getTime() / 1000),
    to: Math.floor(end.getTime() / 1000),
  };
}

function mergeScheduleEntry(existing, incoming) {
  if (!existing) {
    return incoming;
  }

  return {
    ...existing,
    ...incoming,
    nextEpisode: existing.nextEpisode || incoming.nextEpisode,
    nextAiringAt: existing.nextAiringAt || incoming.nextAiringAt,
  };
}

async function fetchSchedule() {
  console.log('========================================');
  console.log('FETCHING: Weekly Schedule');
  console.log('========================================');

  const window = buildWeekWindow();
  const groupedByDay = new Map(
    WEEKDAY_NAMES.map((day) => [day, new Map()]),
  );

  let page = 1;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await fetchGraphQL(AIRING_SCHEDULE_WINDOW_QUERY, {
      page,
      perPage: 100,
      from: window.from,
      to: window.to,
    });

    if (!data || !data.Page) {
      console.error('Failed to fetch weekly schedule.');
      return;
    }

    const schedules = data.Page.airingSchedules || [];
    for (const schedule of schedules) {
      const media = schedule.media;
      if (!media || (!media.idMal && !media.id)) continue;
      if (isAdultContent(media).blocked || !isAnime(media).allowed) continue;

      const firestoreData = convertToFirestoreFormat(media, {
        nextEpisode: schedule.episode || 0,
        nextAiringAt: schedule.airingAt || 0,
      });

      if (!firestoreData) continue;

      const airingDate = new Date((schedule.airingAt || 0) * 1000);
      const dayName = WEEKDAY_NAMES[airingDate.getUTCDay()];
      const dayMap = groupedByDay.get(dayName);
      const existing = dayMap.get(firestoreData.animeId);
      dayMap.set(
        firestoreData.animeId,
        mergeScheduleEntry(existing, firestoreData),
      );
    }

    hasNextPage = Boolean(data.Page.pageInfo?.hasNextPage);
    page += 1;
  }

  for (const [dayName, itemsMap] of groupedByDay.entries()) {
    const items = Array.from(itemsMap.values()).sort((a, b) => {
      const nextAiringA = a.nextAiringAt || 0;
      const nextAiringB = b.nextAiringAt || 0;
      if (nextAiringA != nextAiringB) {
        return nextAiringA - nextAiringB;
      }

      return (b.popularity || 0) - (a.popularity || 0);
    });

    const result = writeJsonIfChanged(
      `${CONFIG.API_PATHS.SCHEDULE}/${dayName}`,
      items,
    );
    if (result.changed) {
      console.log(`Schedule for ${dayName} written to ${result.file}.`);
    } else {
      console.log(`No changes detected for ${dayName} schedule.`);
    }
  }
}

module.exports = fetchSchedule;
