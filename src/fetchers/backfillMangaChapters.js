const CONFIG = require('../config/constants');
const { writeJsonIfChanged } = require('../utils/writeJsonIfChanged');
const {
  getMangaCatalogEntries,
  getChapterManifest,
} = require('../utils/mangaBackfillData');
const fetchMangaChapters = require('./fetchMangaChapters');

const CHAPTER_BATCH_SIZE = Number(process.env.MANGA_BACKFILL_CHAPTER_BATCH || 12);
const CHAPTER_STALE_HOURS = Number(process.env.MANGA_BACKFILL_CHAPTER_STALE_HOURS || 24 * 14);
const FORCE_ALL = process.env.MANGA_BACKFILL_FORCE_ALL === '1';
const FAILURE_COOLDOWN_HOURS = Number(process.env.MANGA_BACKFILL_FAILURE_COOLDOWN_HOURS || 24);
const MIN_AVAILABLE_CHAPTERS = Number(process.env.MANGA_BACKFILL_MIN_AVAILABLE_CHAPTERS || 1);
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

function getStatePath() {
  return `${CONFIG.API_PATHS.MANGA_BACKFILL}/chapters_state`;
}

function getState() {
  const fallback = {
    updatedAt: null,
    titles: {},
  };
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require(`../../api/${getStatePath()}.json`);
  } catch (_) {
    return fallback;
  }
}

function writeState(state) {
  writeJsonIfChanged(getStatePath(), {
    updatedAt: new Date().toISOString(),
    titles: state.titles || {},
  });
}

function getEntryIds(item) {
  return [item.mangadexId, item.mangaId, item.anilistId].map((id) => String(id || '')).filter(Boolean);
}

function getManifestCounts(manifestItem) {
  const counts = manifestItem?.counts || {};
  return {
    en: Number(counts.en || 0),
    ar: Number(counts.ar || 0),
    total: Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0),
  };
}

function hasAnyUsableChapters(manifestItem) {
  return getManifestCounts(manifestItem).total >= MIN_AVAILABLE_CHAPTERS;
}

function isFailureCoolingDown(stateItem) {
  if (!stateItem?.lastFailureAt) return false;
  if (stateItem?.lastSuccessAt && new Date(stateItem.lastSuccessAt).getTime() > new Date(stateItem.lastFailureAt).getTime()) {
    return false;
  }
  return getHoursSince(stateItem.lastFailureAt) < FAILURE_COOLDOWN_HOURS;
}

function scoreCandidate(item, manifestItem, stateItem) {
  const popularity = Number(item.popularity || 0);
  const expected = Number(item.chapters || 0);
  const counts = getManifestCounts(manifestItem);
  const hasUsableCoverage = counts.total >= MIN_AVAILABLE_CHAPTERS;

  if (!FORCE_ALL && isFailureCoolingDown(stateItem)) {
    return -1;
  }

  if (!manifestItem) {
    if (expected > 0) {
      return 500000 + popularity + Math.min(expected, 1000);
    }
    return 200000 + popularity;
  }

  const staleHours = getHoursSince(manifestItem.updatedAt);

  if (!hasUsableCoverage) {
    if (expected > 0) {
      return 450000 + popularity + Math.min(expected, 1000);
    }
    return 180000 + popularity;
  }

  if (expected > 0 && counts.en < expected) {
    const gap = expected - counts.en;
    const ratio = expected > 0 ? counts.en / expected : 1;
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

  const rawCatalogEntries = getMangaCatalogEntries();
  const catalogItems = Array.from(
    new Map(
      rawCatalogEntries
        .filter((item) => item && item.mangadexId)
        .map((item) => [item.mangadexId, {
          mangaId: item.mangaId,
          anilistId: item.anilistId || item.mangaId,
          mangadexId: item.mangadexId,
          title: item.title || '',
          popularity: Number(item.popularity || 0),
          chapters: Number(item.chapters || 0),
          status: item.status || '',
          year: item.year || item.startYear || null,
        }]),
    ).values(),
  );
  const chapterManifest = getChapterManifest();
  const chapterMap = new Map((chapterManifest.items || []).map((item) => [item.mangadexId, item]));
  const state = getState();
  const stateTitles = state.titles || {};

  const candidates = catalogItems
    .map((item) => ({
      item,
      manifestItem: chapterMap.get(item.mangadexId) || null,
      stateItem: stateTitles[item.mangadexId] || null,
      score: scoreCandidate(
        item,
        chapterMap.get(item.mangadexId) || null,
        stateTitles[item.mangadexId] || null,
      ),
    }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score);

  const selectedPool = TARGET_IDS.size > 0
    ? candidates.filter(({ item }) =>
        getEntryIds(item).some((id) => TARGET_IDS.has(id)),
      )
    : candidates;

  const selected = FORCE_ALL
    ? selectedPool
    : selectedPool.slice(0, CHAPTER_BATCH_SIZE);

  const baseProgress = {
    updatedAt: new Date().toISOString(),
    catalogTotal: catalogItems.length,
    indexedTitles: chapterManifest.items?.length || 0,
    pendingTitles: candidates.length,
    selectedCount: selected.length,
    batchSize: CHAPTER_BATCH_SIZE,
    forceAll: FORCE_ALL,
    failureCooldownHours: FAILURE_COOLDOWN_HOURS,
    targetIds: Array.from(TARGET_IDS),
    selected: selected.map(({ item, manifestItem, stateItem, score }) => ({
      mangadexId: item.mangadexId,
      title: item.title,
      score,
      year: item.year,
      popularity: item.popularity,
      chapters: item.chapters,
      currentEnglishCount: Number(manifestItem?.counts?.en || 0),
      currentArabicCount: Number(manifestItem?.counts?.ar || 0),
      hasCoverage: hasAnyUsableChapters(manifestItem),
      lastSuccessAt: stateItem?.lastSuccessAt || null,
      lastFailureAt: stateItem?.lastFailureAt || null,
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
        return scoreCandidate(item, manifestItem, stateTitles[item.mangadexId] || null) >= 0;
      }).length,
      completedCount: completed.length,
      failedCount: failed.length,
      completed,
      failed,
    });
  }

  writeProgress();

  if (selected.length === 0) {
    writeProgress({ status: 'idle' });
    console.log('No manga chapter coverage work is needed right now.');
    return;
  }

  try {
    for (const { item } of selected) {
      try {
        process.env.MANGA_TARGET_IDS = item.mangadexId;
        await fetchMangaChapters();
        const refreshedManifest = getChapterManifest();
        const refreshedMap = new Map((refreshedManifest.items || []).map((entry) => [entry.mangadexId, entry]));
        const manifestItem = refreshedMap.get(item.mangadexId) || {};
        stateTitles[item.mangadexId] = {
          title: item.title,
          mangaId: item.mangaId,
          anilistId: item.anilistId,
          mangadexId: item.mangadexId,
          lastAttemptAt: new Date().toISOString(),
          lastSuccessAt: new Date().toISOString(),
          lastFailureAt: stateTitles[item.mangadexId]?.lastFailureAt || null,
          consecutiveFailures: 0,
          latestEnglishCount: Number(manifestItem.counts?.en || 0),
          latestArabicCount: Number(manifestItem.counts?.ar || 0),
          hasCoverage: hasAnyUsableChapters(manifestItem),
        };
        writeState(state);
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
        const previousFailures = Number(stateTitles[item.mangadexId]?.consecutiveFailures || 0);
        stateTitles[item.mangadexId] = {
          title: item.title,
          mangaId: item.mangaId,
          anilistId: item.anilistId,
          mangadexId: item.mangadexId,
          lastAttemptAt: new Date().toISOString(),
          lastSuccessAt: stateTitles[item.mangadexId]?.lastSuccessAt || null,
          lastFailureAt: new Date().toISOString(),
          consecutiveFailures: previousFailures + 1,
          latestEnglishCount: Number(chapterMap.get(item.mangadexId)?.counts?.en || 0),
          latestArabicCount: Number(chapterMap.get(item.mangadexId)?.counts?.ar || 0),
          hasCoverage: hasAnyUsableChapters(chapterMap.get(item.mangadexId)),
        };
        writeState(state);
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
        console.error(`Failed chapter coverage for ${item.title}: ${error.message}`);
      }
    }
  } finally {
    delete process.env.MANGA_TARGET_IDS;
  }

  writeProgress({
    status: failed.length > 0 ? 'completed_with_failures' : 'completed',
  });
  console.log(`Chapter coverage backfill completed. Success: ${completed.length}, Failed: ${failed.length}.`);
}

module.exports = backfillMangaChapters;
