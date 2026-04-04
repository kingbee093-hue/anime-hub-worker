const CONFIG = require('../config/constants');
const { writeJsonIfChanged } = require('../utils/writeJsonIfChanged');
const {
  getUniverseManifest,
  getChapterManifest,
} = require('../utils/mangaBackfillData');
const fetchMangaChapters = require('./fetchMangaChapters');

const CHAPTER_BATCH_SIZE = Number(process.env.MANGA_BACKFILL_CHAPTER_BATCH || 8);
const CHAPTER_STALE_HOURS = Number(process.env.MANGA_BACKFILL_CHAPTER_STALE_HOURS || 24 * 14);
const FORCE_ALL = process.env.MANGA_BACKFILL_FORCE_ALL === '1';
const TARGET_IDS = new Set(
  String(process.env.MANGA_BACKFILL_TARGET_IDS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);

function getHoursSince(isoDate) {
  if (!isoDate) return Number.POSITIVE_INFINITY;
  const time = new Date(isoDate).getTime();
  if (Number.isNaN(time)) return Number.POSITIVE_INFINITY;
  return (Date.now() - time) / 3600000;
}

function scoreCandidate(item, manifestItem) {
  const popularity = Number(item.popularity || 0);
  const expected = Number(item.chapters || 0);

  if (!manifestItem) {
    if (expected > 0) {
      return 500000 + popularity + Math.min(expected, 1000);
    }
    return 200000 + popularity;
  }

  const enCount = Number(manifestItem.counts?.en || 0);
  const staleHours = getHoursSince(manifestItem.updatedAt);

  if (enCount === 0) {
    if (expected > 0) {
      return 450000 + popularity + Math.min(expected, 1000);
    }
    return 180000 + popularity;
  }

  if (expected > 0 && enCount < expected) {
    const gap = expected - enCount;
    const ratio = expected > 0 ? enCount / expected : 1;
    if (gap >= 5 && ratio < 0.97) {
      return 350000 + gap * 1000 + popularity;
    }
  }

  if (staleHours >= CHAPTER_STALE_HOURS) {
    return 100000 + Math.min(staleHours, 1000) + popularity;
  }

  return -1;
}

async function backfillMangaChapters() {
  console.log('========================================');
  console.log('BACKFILL: Manga Chapters');
  console.log('========================================');

  const universe = getUniverseManifest();
  const universeItems = Array.isArray(universe.items) ? universe.items : [];
  const chapterManifest = getChapterManifest();
  const chapterMap = new Map((chapterManifest.items || []).map((item) => [item.mangadexId, item]));

  const candidates = universeItems
    .map((item) => ({
      item,
      manifestItem: chapterMap.get(item.mangadexId) || null,
      score: scoreCandidate(item, chapterMap.get(item.mangadexId) || null),
    }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score);

  const selectedPool = TARGET_IDS.size > 0
    ? candidates.filter(({ item }) =>
        TARGET_IDS.has(String(item.mangadexId)) ||
        TARGET_IDS.has(String(item.mangaId)) ||
        TARGET_IDS.has(String(item.anilistId)),
      )
    : candidates;

  const selected = FORCE_ALL
    ? selectedPool
    : selectedPool.slice(0, CHAPTER_BATCH_SIZE);

  const baseProgress = {
    updatedAt: new Date().toISOString(),
    universeTotal: universeItems.length,
    indexedTitles: chapterManifest.items?.length || 0,
    pendingTitles: candidates.length,
    selectedCount: selected.length,
    batchSize: CHAPTER_BATCH_SIZE,
    forceAll: FORCE_ALL,
    targetIds: Array.from(TARGET_IDS),
    selected: selected.map(({ item, manifestItem, score }) => ({
      mangadexId: item.mangadexId,
      title: item.title,
      score,
      year: item.year,
      popularity: item.popularity,
      chapters: item.chapters,
      currentEnglishCount: Number(manifestItem?.counts?.en || 0),
    })),
    nextSample: candidates.slice(selected.length, selected.length + 15).map(({ item }) => ({
      mangadexId: item.mangadexId,
      title: item.title,
    })),
  };

  const completed = [];
  const failed = [];

  function writeProgress(extra = {}) {
    const refreshedManifest = getChapterManifest();
    const refreshedMap = new Map((refreshedManifest.items || []).map((item) => [item.mangadexId, item]));
    writeJsonIfChanged(`${CONFIG.API_PATHS.MANGA_BACKFILL}/chapters_progress`, {
      ...baseProgress,
      ...extra,
      updatedAt: new Date().toISOString(),
      indexedTitles: refreshedManifest.items?.length || 0,
      pendingTitles: candidates.filter(({ item }) => {
        const manifestItem = refreshedMap.get(item.mangadexId);
        return scoreCandidate(item, manifestItem) >= 0;
      }).length,
      completedCount: completed.length,
      failedCount: failed.length,
      completed,
      failed,
    });
  }

  writeProgress();

  if (selected.length === 0) {
    console.log('No manga chapter backfill candidates need work right now.');
    return;
  }

  process.env.MANGA_FORCE_FULL_REFRESH = '1';

  try {
    for (const { item } of selected) {
      try {
        process.env.MANGA_TARGET_IDS = item.mangadexId;
        await fetchMangaChapters();
        const refreshedManifest = getChapterManifest();
        const refreshedMap = new Map((refreshedManifest.items || []).map((entry) => [entry.mangadexId, entry]));
        const manifestItem = refreshedMap.get(item.mangadexId) || {};
        completed.push({
          mangadexId: item.mangadexId,
          title: item.title,
          englishCount: Number(manifestItem.counts?.en || 0),
          arabicCount: Number(manifestItem.counts?.ar || 0),
          fallback: manifestItem.englishFallbackProvider || null,
          updatedAt: manifestItem.updatedAt || null,
        });
        writeProgress({
          currentItem: {
            mangadexId: item.mangadexId,
            title: item.title,
            status: 'completed',
          },
        });
      } catch (error) {
        failed.push({
          mangadexId: item.mangadexId,
          title: item.title,
          error: error.message,
        });
        writeProgress({
          currentItem: {
            mangadexId: item.mangadexId,
            title: item.title,
            status: 'failed',
            error: error.message,
          },
        });
        throw error;
      }
    }
  } finally {
    delete process.env.MANGA_TARGET_IDS;
    delete process.env.MANGA_FORCE_FULL_REFRESH;
  }

  writeProgress({ status: 'completed' });
  console.log(`Chapter backfill completed for ${selected.length} manga titles.`);
}

module.exports = backfillMangaChapters;
