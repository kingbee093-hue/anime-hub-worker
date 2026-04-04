const CONFIG = require('../config/constants');
const { writeJsonIfChanged } = require('../utils/writeJsonIfChanged');
const { getMangaCatalogEntries } = require('../utils/mangaBackfillData');

const UNIVERSE_PAGE_SIZE = Number(process.env.MANGA_UNIVERSE_PAGE_SIZE || 120);
const UNIVERSE_MIN_YEAR = Number(process.env.MANGA_UNIVERSE_MIN_YEAR || 2020);
const LEGACY_POPULARITY_THRESHOLD = Number(process.env.MANGA_UNIVERSE_LEGACY_POPULARITY || 100000);

function getUniverseReason(manga) {
  const year = Number(manga.year || 0);
  const popularity = Number(manga.popularity || 0);

  if (year >= UNIVERSE_MIN_YEAR) {
    return 'recent';
  }

  if (popularity >= LEGACY_POPULARITY_THRESHOLD) {
    return 'legacy_popular';
  }

  return null;
}

function sortUniverse(items) {
  return items.sort((a, b) => {
    const yearDelta = Number(b.year || 0) - Number(a.year || 0);
    if (yearDelta !== 0) return yearDelta;

    const popularityDelta = Number(b.popularity || 0) - Number(a.popularity || 0);
    if (popularityDelta !== 0) return popularityDelta;

    const scoreDelta = Number(b.averageScore || 0) - Number(a.averageScore || 0);
    if (scoreDelta !== 0) return scoreDelta;

    return String(a.title || '').localeCompare(String(b.title || ''));
  });
}

async function fetchMangaUniverse() {
  console.log('========================================');
  console.log('BUILDING: Manga Universe');
  console.log('========================================');

  const catalogEntries = getMangaCatalogEntries();
  const filtered = catalogEntries
    .filter((item) => item && item.mangadexId)
    .map((item) => {
      const reason = getUniverseReason(item);
      if (!reason) return null;
      return {
        mangaId: item.mangaId,
        anilistId: item.anilistId || item.mangaId,
        mangadexId: item.mangadexId,
        title: item.title || '',
        titleEnglish: item.titleEnglish || '',
        titleRomaji: item.titleRomaji || '',
        year: item.year || null,
        chapters: item.chapters || 0,
        volumes: item.volumes || 0,
        status: item.status || '',
        format: item.format || '',
        popularity: item.popularity || 0,
        averageScore: item.averageScore || 0,
        imageUrl: item.imageUrl || '',
        bannerImage: item.bannerImage || '',
        genres: item.genres || [],
        reason,
      };
    })
    .filter(Boolean);

  const deduped = Array.from(
    new Map(filtered.map((item) => [item.mangadexId, item])).values(),
  );

  const universe = sortUniverse(deduped);
  const pages = [];
  for (let index = 0; index < universe.length; index += UNIVERSE_PAGE_SIZE) {
    pages.push(universe.slice(index, index + UNIVERSE_PAGE_SIZE));
  }

  pages.forEach((items, index) => {
    writeJsonIfChanged(`${CONFIG.API_PATHS.MANGA_UNIVERSE}/page_${index + 1}`, items);
  });

  const recentCount = universe.filter((item) => item.reason === 'recent').length;
  const legacyPopularCount = universe.filter((item) => item.reason === 'legacy_popular').length;

  writeJsonIfChanged(`${CONFIG.API_PATHS.MANGA_UNIVERSE}/manifest`, {
    updatedAt: new Date().toISOString(),
    totalTitles: universe.length,
    recentCount,
    legacyPopularCount,
    pageSize: UNIVERSE_PAGE_SIZE,
    minYear: UNIVERSE_MIN_YEAR,
    legacyPopularityThreshold: LEGACY_POPULARITY_THRESHOLD,
    pages: pages.length,
    items: universe.map((item, index) => ({
      mangaId: item.mangaId,
      anilistId: item.anilistId,
      mangadexId: item.mangadexId,
      title: item.title,
      year: item.year,
      popularity: item.popularity,
      chapters: item.chapters,
      status: item.status,
      reason: item.reason,
      page: Math.floor(index / UNIVERSE_PAGE_SIZE) + 1,
    })),
  });

  console.log(`Universe built with ${universe.length} manga titles (${recentCount} recent, ${legacyPopularCount} legacy popular).`);
}

module.exports = fetchMangaUniverse;
