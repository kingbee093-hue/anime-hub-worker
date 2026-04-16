const CONFIG = require('../config/constants');
const { writeJsonIfChanged } = require('../utils/writeJsonIfChanged');
const {
  getMangaCatalogEntries,
  getMangaSectionEntries,
  getChapterManifest,
  buildChapterIndexId,
} = require('../utils/mangaBackfillData');
const fetchMangaChapters = require('./fetchMangaChapters');

const CHAPTER_BATCH_SIZE = Number(process.env.MANGA_BACKFILL_CHAPTER_BATCH || 50);
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
const SECTION_SCOPE = String(process.env.MANGA_BACKFILL_SECTION || '').trim();
const ONLY_RELEASING_DEFAULT = process.env.MANGA_BACKFILL_ONLY_RELEASING !== '0';
const chapterCountsCache = new Map();

function isChapterBearingFormat(item) {
  const format = String(item?.format || '').toUpperCase();
  return format === 'MANGA' || format === 'ONE_SHOT' || format === '';
}

function isReleasingStatus(status) {
  return String(status || '').trim().toUpperCase() === 'RELEASING';
}

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

function getStateRecency(stateItem) {
  const stamps = [
    stateItem?.lastAttemptAt,
    stateItem?.lastSuccessAt,
    stateItem?.lastFailureAt,
  ]
    .map((value) => new Date(value || 0).getTime())
    .filter((value) => Number.isFinite(value) && value > 0);
  return stamps.length > 0 ? Math.max(...stamps) : 0;
}

function getBestStateForItem(item, stateTitles) {
  const itemIds = new Set(getEntryIds(item));
  if (itemIds.size === 0) {
    return null;
  }

  let best = null;
  let bestRecency = -1;
  for (const [key, stateItem] of Object.entries(stateTitles || {})) {
    const stateIds = new Set(
      [key, stateItem?.chapterIndexId, stateItem?.mangadexId, stateItem?.mangaId, stateItem?.anilistId]
        .map((id) => String(id || ''))
        .filter(Boolean),
    );
    let matches = false;
    for (const id of itemIds) {
      if (stateIds.has(id)) {
        matches = true;
        break;
      }
    }
    if (!matches) continue;

    const recency = getStateRecency(stateItem);
    if (!best || recency >= bestRecency) {
      best = stateItem;
      bestRecency = recency;
    }
  }

  return best;
}

function pruneStateAliases(item, stateTitles) {
  const canonicalKey = String(item?.chapterIndexId || '').trim();
  const itemIds = new Set(getEntryIds(item));
  if (!canonicalKey || itemIds.size === 0) {
    return;
  }

  for (const [key, stateItem] of Object.entries(stateTitles || {})) {
    if (key === canonicalKey) continue;
    const stateIds = new Set(
      [key, stateItem?.chapterIndexId, stateItem?.mangadexId, stateItem?.mangaId, stateItem?.anilistId]
        .map((id) => String(id || ''))
        .filter(Boolean),
    );
    const overlaps = Array.from(itemIds).some((id) => stateIds.has(id));
    if (overlaps) {
      delete stateTitles[key];
    }
  }
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

function getEffectiveExpectedChapterCount(item) {
  const sourceCount = Number(item?.chapterSourceChapterCount || 0);
  if (sourceCount > 0) {
    return sourceCount;
  }
  return Number(item?.chapters || 0);
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

function scoreCandidate(item, manifestItem, stateItem, allowNonReleasing = false) {
  const popularity = Number(item.popularity || 0);
  const expected = getEffectiveExpectedChapterCount(item);
  const manifestCounts = getManifestCounts(manifestItem);
  const storedCounts = getStoredChapterCounts(item.chapterIndexId);
  const counts = {
    en: Math.max(manifestCounts.en, storedCounts.en),
    ar: Math.max(manifestCounts.ar, storedCounts.ar),
    total: Math.max(manifestCounts.total, storedCounts.total),
  };
  const hasUsableCoverage = counts.total >= MIN_AVAILABLE_CHAPTERS;

  // SMART SKIP: If manga is FINISHED and we already have all expected chapters, skip it entirely.
  const isFinished = !isReleasingStatus(item.status);
  if (isFinished && expected > 0 && counts.en >= expected) {
    if (!FORCE_ALL && TARGET_IDS.size === 0) {
      return -1;
    }
  }

  if (!FORCE_ALL && isFailureCoolingDown(stateItem)) {
    return -1;
  }

  if (!FORCE_ALL && isSuccessCoolingDown(item, stateItem, counts)) {
    return -1;
  }

  if (!allowNonReleasing && !isReleasingStatus(item.status)) {
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
    // Don't waste time on tiny gaps for finished manga unless forced
    if (isFinished && ratio >= 0.98 && !FORCE_ALL) {
      return -1;
    }
    
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
  console.log('\n' + '⭐'.repeat(40));
  console.log('🚀 STAGE 2: SMART GAP-FILLING SYSTEM (Chapters & Images)');
  console.log('⭐'.repeat(40) + '\n');

  const rawCatalogEntries = getMangaCatalogEntries();
  const shouldRestrictToReleasing =
    ONLY_RELEASING_DEFAULT && !FORCE_ALL && TARGET_IDS.size === 0;
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
        .filter((item) => isChapterBearingFormat(item))
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
          chapterSourceChapterCount: Number(item.chapterSourceChapterCount || 0),
          title: item.title || '',
          popularity: Number(item.popularity || 0),
          chapters: Number(item.chapters || 0),
          format: item.format || '',
          status: item.status || '',
          year: item.year || item.startYear || null,
        }];
        })
        .filter(([chapterIndexId]) => Boolean(chapterIndexId)),
    ).values(),
  );
  const statusFilteredCatalogItems = shouldRestrictToReleasing
    ? catalogItems.filter((item) => isReleasingStatus(item.status))
    : catalogItems;
  console.log(`Backfill scope: ${getScopeLabel()} (${catalogItems.length} title(s) in scope).`);
  const releasingCount = statusFilteredCatalogItems.filter((item) => isReleasingStatus(item.status)).length;
  const nonReleasingCount = Math.max(0, catalogItems.length - releasingCount);
  if (shouldRestrictToReleasing) {
    console.log(
      `Status filter active: releasing only. Considered ${statusFilteredCatalogItems.length}/${catalogItems.length} title(s), skipped non-releasing: ${catalogItems.length - statusFilteredCatalogItems.length}.`,
    );
  } else {
    console.log(
      `Status filter disabled (force/targeted/manual override). Considering ${statusFilteredCatalogItems.length} title(s).`,
    );
  }
  console.log(
    `Routine chapter coverage target -> releasing: ${releasingCount}, non-releasing skipped unless targeted/forced: ${nonReleasingCount}.`,
  );
  const chapterManifest = getChapterManifest();
  const chapterMap = new Map(
    (chapterManifest.items || [])
      .map((item) => [item.chapterIndexId || item.mangadexId, item])
      .filter(([key]) => Boolean(key)),
  );
  const state = getState();
  const stateTitles = state.titles || {};

  const candidateEntries = statusFilteredCatalogItems
    .map((item) => {
      const manifestItem = chapterMap.get(item.chapterIndexId) || null;
      const stateItem = getBestStateForItem(item, stateTitles);
      const allowNonReleasing = FORCE_ALL || TARGET_IDS.size > 0;
      return {
        item,
        manifestItem,
        stateItem,
        score: scoreCandidate(item, manifestItem, stateItem, allowNonReleasing),
      };
    });

  const candidates = candidateEntries
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score);

  const selectedPool = TARGET_IDS.size > 0
    ? candidateEntries.filter(({ item }) =>
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
      format: item.format || '',
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
        const stateItem = getBestStateForItem(item, stateTitles);
        const allowNonReleasing = FORCE_ALL || TARGET_IDS.size > 0;
        return scoreCandidate(item, manifestItem, stateItem, allowNonReleasing) >= 0;
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
    let currentIndex = 0;
    const totalSelected = selected.length;
    for (const { item } of selected) {
      currentIndex++;
      console.log(`\n[${currentIndex} / ${totalSelected}] Processing: ${item.title}`);
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
        pruneStateAliases(item, stateTitles);
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
        pruneStateAliases(item, stateTitles);
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
