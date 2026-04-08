const CONFIG = require('../config/constants');
const { writeJsonIfChanged } = require('../utils/writeJsonIfChanged');
const {
  getMangaCatalogEntries,
  getMangaSectionEntries,
  getChapterManifest,
  buildChapterIndexId,
} = require('../utils/mangaBackfillData');
const fetchMangaChapters = require('./fetchMangaChapters');

const CHAPTER_BATCH_SIZE = Number(process.env.MANGA_BACKFILL_CHAPTER_BATCH || 12);
const CHAPTER_STALE_HOURS = Number(process.env.MANGA_BACKFILL_CHAPTER_STALE_HOURS || 24 * 14);
const FORCE_ALL = process.env.MANGA_BACKFILL_FORCE_ALL === '1';
const FAILURE_COOLDOWN_HOURS = Number(process.env.MANGA_BACKFILL_FAILURE_COOLDOWN_HOURS || 24);
const SUCCESS_COOLDOWN_HOURS = Number(process.env.MANGA_BACKFILL_SUCCESS_COOLDOWN_HOURS || 24 * 7);
const SUCCESS_COOLDOWN_RELEASING_HOURS = Number(
  process.env.MANGA_BACKFILL_SUCCESS_COOLDOWN_RELEASING_HOURS || 24,
);
const MIN_AVAILABLE_CHAPTERS = Number(process.env.MANGA_BACKFILL_MIN_AVAILABLE_CHAPTERS || 1);
const TARGET_IDS = new Set(
  String(process.env.MANGA_BACKFILL_TARGET_IDS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);
const SECTION_SCOPE = String(process.env.MANGA_BACKFILL_SECTION || 'trending').trim();
const chapterCountsCache = new Map();

function getScopeLabel() {
  if (TARGET_IDS.size > 0) {
    return 'targeted';
  }
  return SECTION_SCOPE || 'all';
}

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
  return [item.chapterIndexId, item.mangadexId, item.mangaId, item.anilistId]
    .map((id) => String(id || ''))
    .filter(Boolean);
}

function getManifestCounts(manifestItem) {
  const counts = manifestItem?.counts || {};
  const legacyEn = Number(manifestItem?.englishChapterCount || 0);
  const legacyAr = Number(manifestItem?.arabicChapterCount || 0);
  const legacyTotal = Number(manifestItem?.totalChapters || 0);
  return {
    en: Math.max(Number(counts.en || 0), legacyEn),
    ar: Math.max(Number(counts.ar || 0), legacyAr),
    total: Math.max(
      Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0),
      legacyTotal,
      legacyEn + legacyAr,
    ),
  };
}

function getStoredChapterCounts(chapterIndexId) {
  if (!chapterIndexId) {
    return { en: 0, ar: 0, total: 0 };
  }

  if (chapterCountsCache.has(chapterIndexId)) {
    return chapterCountsCache.get(chapterIndexId);
  }

  const filePath = `${CONFIG.API_PATHS.MANGA_CHAPTERS}/${chapterIndexId}`;
  let chapterIndex = null;
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    chapterIndex = require(`../../api/${filePath}.json`);
  } catch (_) {
    chapterCountsCache.set(chapterIndexId, { en: 0, ar: 0, total: 0 });
    return chapterCountsCache.get(chapterIndexId);
  }

  const counts = chapterIndex?.counts || {};
  const languages = chapterIndex?.languages || {};
  const resolved = {
    en: Math.max(Number(counts.en || 0), Array.isArray(languages.en) ? languages.en.length : 0),
    ar: Math.max(Number(counts.ar || 0), Array.isArray(languages.ar) ? languages.ar.length : 0),
    total: 0,
  };
  resolved.total = Math.max(
    Number(chapterIndex?.totalChapters || 0),
    Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0),
    Object.values(languages).reduce((sum, value) => sum + (Array.isArray(value) ? value.length : 0), 0),
    resolved.en + resolved.ar,
  );

  chapterCountsCache.set(chapterIndexId, resolved);
  return resolved;
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

function isSuccessCoolingDown(item, stateItem, counts) {
  if (!stateItem?.lastSuccessAt) return false;
  if ((counts?.total || 0) < MIN_AVAILABLE_CHAPTERS) return false;
  const cooldownHours = String(item?.status || '').toUpperCase() === 'RELEASING'
    ? SUCCESS_COOLDOWN_RELEASING_HOURS
    : SUCCESS_COOLDOWN_HOURS;
  return getHoursSince(stateItem.lastSuccessAt) < cooldownHours;
}

function scoreCandidate(item, manifestItem, stateItem) {
  const popularity = Number(item.popularity || 0);
  const expected = Number(item.chapters || 0);
  const manifestCounts = getManifestCounts(manifestItem);
  const storedCounts = getStoredChapterCounts(item.chapterIndexId);
  const counts = {
    en: Math.max(manifestCounts.en, storedCounts.en),
    ar: Math.max(manifestCounts.ar, storedCounts.ar),
    total: Math.max(manifestCounts.total, storedCounts.total),
  };
  const hasUsableCoverage = counts.total >= MIN_AVAILABLE_CHAPTERS;

  if (!FORCE_ALL && isFailureCoolingDown(stateItem)) {
    return -1;
  }

  if (!FORCE_ALL && isSuccessCoolingDown(item, stateItem, counts)) {
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
  const shouldApplySectionScope = TARGET_IDS.size === 0 && Boolean(SECTION_SCOPE);
  const rawScopedEntries = shouldApplySectionScope
    ? getMangaSectionEntries(SECTION_SCOPE)
    : rawCatalogEntries;
  const scopedIds = new Set(
    rawScopedEntries
      .map((item) => buildChapterIndexId(item))
      .filter(Boolean),
  );
  const catalogItems = Array.from(
    new Map(
      rawCatalogEntries
        .filter((item) => item && (item.mangadexId || (item.chapterSourceProvider && item.chapterSourceId)))
        .filter((item) => !shouldApplySectionScope || scopedIds.has(buildChapterIndexId(item)))
        .map((item) => {
          const chapterIndexId = buildChapterIndexId(item);
          return [chapterIndexId, {
          chapterIndexId,
          mangaId: item.mangaId,
          anilistId: item.anilistId || item.mangaId,
          mangadexId: item.mangadexId,
          chapterSourceProvider: item.chapterSourceProvider || '',
          chapterSourceId: item.chapterSourceId || '',
          title: item.title || '',
          popularity: Number(item.popularity || 0),
          chapters: Number(item.chapters || 0),
          status: item.status || '',
          year: item.year || item.startYear || null,
        }];
        })
        .filter(([chapterIndexId]) => Boolean(chapterIndexId)),
    ).values(),
  );
  console.log(`Backfill scope: ${getScopeLabel()} (${catalogItems.length} title(s) in scope).`);
  const chapterManifest = getChapterManifest();
  const chapterMap = new Map(
    (chapterManifest.items || [])
      .map((item) => [item.chapterIndexId || item.mangadexId, item])
      .filter(([key]) => Boolean(key)),
  );
  const state = getState();
  const stateTitles = state.titles || {};

  const candidates = catalogItems
    .map((item) => ({
      item,
      manifestItem: chapterMap.get(item.chapterIndexId) || null,
      stateItem: stateTitles[item.chapterIndexId] || null,
      score: scoreCandidate(
        item,
        chapterMap.get(item.chapterIndexId) || null,
        stateTitles[item.chapterIndexId] || null,
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
    sectionScope: getScopeLabel(),
    catalogTotal: catalogItems.length,
    indexedTitles: chapterManifest.items?.length || 0,
    pendingTitles: candidates.length,
    selectedCount: selected.length,
    batchSize: CHAPTER_BATCH_SIZE,
    forceAll: FORCE_ALL,
    failureCooldownHours: FAILURE_COOLDOWN_HOURS,
    successCooldownHours: SUCCESS_COOLDOWN_HOURS,
    successCooldownReleasingHours: SUCCESS_COOLDOWN_RELEASING_HOURS,
    targetIds: Array.from(TARGET_IDS),
    selected: selected.map(({ item, manifestItem, stateItem, score }) => ({
      mangadexId: item.mangadexId,
      title: item.title,
      score,
      year: item.year,
      popularity: item.popularity,
      chapters: item.chapters,
      chapterIndexId: item.chapterIndexId,
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
    const refreshedMap = new Map(
      (refreshedManifest.items || [])
        .map((item) => [item.chapterIndexId || item.mangadexId, item])
        .filter(([key]) => Boolean(key)),
    );
    writeJsonIfChanged(`${CONFIG.API_PATHS.MANGA_BACKFILL}/chapters_progress`, {
      ...baseProgress,
      ...extra,
      updatedAt: new Date().toISOString(),
      indexedTitles: refreshedManifest.items?.length || 0,
      pendingTitles: candidates.filter(({ item }) => {
        const manifestItem = refreshedMap.get(item.chapterIndexId);
        return scoreCandidate(item, manifestItem, stateTitles[item.chapterIndexId] || null) >= 0;
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
    console.log(`No manga chapter coverage work is needed right now for scope "${getScopeLabel()}".`);
    return;
  }

  try {
    for (const { item } of selected) {
      try {
        process.env.MANGA_TARGET_IDS = item.chapterIndexId;
        await fetchMangaChapters();
        const refreshedManifest = getChapterManifest();
        const refreshedMap = new Map(
          (refreshedManifest.items || [])
            .map((entry) => [entry.chapterIndexId || entry.mangadexId, entry])
            .filter(([key]) => Boolean(key)),
        );
        const manifestItem = refreshedMap.get(item.chapterIndexId) || {};
        const hasCoverage = hasAnyUsableChapters(manifestItem);
        if (!hasCoverage) {
          throw new Error('No readable chapter coverage was produced for this title.');
        }
        stateTitles[item.chapterIndexId] = {
          title: item.title,
          chapterIndexId: item.chapterIndexId,
          mangaId: item.mangaId,
          anilistId: item.anilistId,
          mangadexId: item.mangadexId,
          lastAttemptAt: new Date().toISOString(),
          lastSuccessAt: new Date().toISOString(),
          lastFailureAt: stateTitles[item.chapterIndexId]?.lastFailureAt || null,
          consecutiveFailures: 0,
          latestEnglishCount: Number(manifestItem.counts?.en || 0),
          latestArabicCount: Number(manifestItem.counts?.ar || 0),
          hasCoverage,
        };
        writeState(state);
        completed.push({
          chapterIndexId: item.chapterIndexId,
          mangadexId: item.mangadexId,
          title: item.title,
          englishCount: Number(manifestItem.counts?.en || 0),
          arabicCount: Number(manifestItem.counts?.ar || 0),
          fallback: manifestItem.englishFallbackProvider || null,
          updatedAt: manifestItem.updatedAt || null,
        });
        writeProgress({
          currentItem: {
            chapterIndexId: item.chapterIndexId,
            mangadexId: item.mangadexId,
            title: item.title,
            status: 'completed',
          },
        });
      } catch (error) {
        const previousFailures = Number(stateTitles[item.chapterIndexId]?.consecutiveFailures || 0);
        stateTitles[item.chapterIndexId] = {
          title: item.title,
          chapterIndexId: item.chapterIndexId,
          mangaId: item.mangaId,
          anilistId: item.anilistId,
          mangadexId: item.mangadexId,
          lastAttemptAt: new Date().toISOString(),
          lastSuccessAt: stateTitles[item.chapterIndexId]?.lastSuccessAt || null,
          lastFailureAt: new Date().toISOString(),
          consecutiveFailures: previousFailures + 1,
          latestEnglishCount: Number(chapterMap.get(item.chapterIndexId)?.counts?.en || 0),
          latestArabicCount: Number(chapterMap.get(item.chapterIndexId)?.counts?.ar || 0),
          hasCoverage: hasAnyUsableChapters(chapterMap.get(item.chapterIndexId)),
        };
        writeState(state);
        failed.push({
          chapterIndexId: item.chapterIndexId,
          mangadexId: item.mangadexId,
          title: item.title,
          error: error.message,
        });
        writeProgress({
          currentItem: {
            chapterIndexId: item.chapterIndexId,
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
