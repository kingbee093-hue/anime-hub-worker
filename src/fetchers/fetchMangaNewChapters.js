const fs = require('fs');
const path = require('path');
const axios = require('axios');

const CONFIG = require('../config/constants');
const { delay } = require('../utils/formatters');
const { getMangaCatalogEntries, getChapterManifest } = require('../utils/mangaBackfillData');
const { writeJsonIfChanged } = require('../utils/writeJsonIfChanged');

const MANGADEX_API = 'https://api.mangadex.org';
const FRESH_HOURS = Number(process.env.MANGA_NEW_CHAPTERS_FRESH_HOURS || 48);
const MAX_ATTEMPTS = Number(process.env.MANGA_NEW_CHAPTERS_MAX_ATTEMPTS || 4);
const RETRY_DELAY_MS = Number(process.env.MANGA_NEW_CHAPTERS_RETRY_DELAY_MS || 3000);
const REQUEST_DELAY_MS = Number(process.env.MANGA_NEW_CHAPTERS_REQUEST_DELAY_MS || 350);
const SECTION_LIMIT_RAW = Number(process.env.MANGA_NEW_CHAPTERS_LIMIT || 0);
const FEED_PAGE_SIZE = Math.min(Number(process.env.MANGA_NEW_CHAPTERS_FEED_PAGE_SIZE || 100), 100);
const MAX_FEED_PAGES = Number(process.env.MANGA_NEW_CHAPTERS_MAX_FEED_PAGES || 20);
const ALLOWED_LANGUAGES = String(process.env.MANGA_NEW_CHAPTERS_LANGUAGES || 'en,ar')
  .split(',')
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean);

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function parseExistingItems(filePath) {
  const parsed = readJsonFile(filePath, []);
  return Array.isArray(parsed) ? parsed : [];
}

function resolveSectionLimit(totalCount) {
  if (Number.isFinite(SECTION_LIMIT_RAW) && SECTION_LIMIT_RAW > 0) {
    return Math.floor(SECTION_LIMIT_RAW);
  }
  return Math.max(Number(totalCount || 0), 0);
}

function getManifestCount(item) {
  const counts = item?.counts || {};
  return Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
}

function buildCatalogMaps(entries) {
  const byMangadexId = new Map();
  const byChapterIndexId = new Map();

  for (const entry of entries || []) {
    if (!entry || !entry.mangaId) continue;
    if (entry.mangadexId) {
      byMangadexId.set(String(entry.mangadexId), entry);
    }
    if (entry.chapterIndexId) {
      byChapterIndexId.set(String(entry.chapterIndexId), entry);
    }
  }

  return { byMangadexId, byChapterIndexId };
}

function getChapterManifestMap() {
  const manifest = getChapterManifest();
  const items = Array.isArray(manifest?.items) ? manifest.items : [];
  return new Map(
    items
      .map((item) => [String(item.chapterIndexId || item.mangadexId || ''), item])
      .filter(([key]) => Boolean(key)),
  );
}

function extractMangaId(relationships = []) {
  const mangaRel = (Array.isArray(relationships) ? relationships : []).find((rel) => rel?.type === 'manga' && rel?.id);
  return mangaRel?.id ? String(mangaRel.id) : '';
}

function getPublishedTime(attributes = {}) {
  return attributes.publishAt || attributes.createdAt || attributes.updatedAt || null;
}

function compareChapterRecency(current, candidate) {
  const currentTime = new Date(current?.publishedAt || 0).getTime();
  const candidateTime = new Date(candidate?.publishedAt || 0).getTime();
  return candidateTime - currentTime;
}

async function fetchRecentMangaDexFeed() {
  const cutoffMs = Date.now() - (FRESH_HOURS * 60 * 60 * 1000);
  const latestByManga = new Map();
  let totalRows = 0;
  let fetchedPages = 0;

  for (let page = 0; page < MAX_FEED_PAGES; page++) {
    const offset = page * FEED_PAGE_SIZE;
    const response = await axios.get(`${MANGADEX_API}/chapter`, {
      params: {
        limit: FEED_PAGE_SIZE,
        offset,
        'order[publishAt]': 'desc',
        'order[createdAt]': 'desc',
        includeFuturePublishAt: 0,
        includeEmptyPages: 0,
        includeExternalUrl: 0,
        contentRating: ['safe', 'suggestive', 'erotica'],
        translatedLanguage: ALLOWED_LANGUAGES,
      },
      timeout: 45000,
    });

    const rows = Array.isArray(response.data?.data) ? response.data.data : [];
    fetchedPages += 1;
    if (rows.length === 0) {
      break;
    }

    totalRows += rows.length;
    let pageHasFreshRows = false;

    for (const row of rows) {
      const attributes = row?.attributes || {};
      const publishedAt = getPublishedTime(attributes);
      const publishedMs = new Date(publishedAt || 0).getTime();
      if (!Number.isFinite(publishedMs) || publishedMs <= 0) {
        continue;
      }
      if (publishedMs < cutoffMs) {
        continue;
      }

      pageHasFreshRows = true;
      const mangaId = extractMangaId(row.relationships);
      if (!mangaId) {
        continue;
      }

      const language = String(attributes.translatedLanguage || '').trim().toLowerCase();
      if (!ALLOWED_LANGUAGES.includes(language)) {
        continue;
      }

      const chapterItem = {
        chapterId: String(row.id || ''),
        mangaId,
        chapter: String(attributes.chapter || '').trim(),
        title: String(attributes.title || '').trim(),
        language,
        publishedAt,
      };

      const current = latestByManga.get(mangaId);
      if (!current || compareChapterRecency(current, chapterItem) > 0) {
        latestByManga.set(mangaId, chapterItem);
      }
    }

    const lastRow = rows[rows.length - 1];
    const lastPublished = new Date(getPublishedTime(lastRow?.attributes || {}) || 0).getTime();
    if (!pageHasFreshRows || (Number.isFinite(lastPublished) && lastPublished > 0 && lastPublished < cutoffMs)) {
      break;
    }

    await delay(REQUEST_DELAY_MS);
  }

  return {
    items: Array.from(latestByManga.values()),
    totalRows,
    fetchedPages,
    cutoffIso: new Date(cutoffMs).toISOString(),
  };
}

function buildRecentFeedItems(recentFeedItems) {
  const catalogEntries = getMangaCatalogEntries();
  const catalogMaps = buildCatalogMaps(catalogEntries);
  const manifestMap = getChapterManifestMap();
  const enriched = [];

  for (const recentItem of recentFeedItems) {
    const catalogEntry = catalogMaps.byMangadexId.get(String(recentItem.mangaId));
    if (!catalogEntry) {
      continue;
    }

    const manifestItem =
      manifestMap.get(String(catalogEntry.chapterIndexId || '')) ||
      manifestMap.get(String(catalogEntry.mangadexId || '')) ||
      null;

    enriched.push({
      ...catalogEntry,
      latestChapterUpdatedAt: recentItem.publishedAt,
      latestChapterNumber: recentItem.chapter,
      latestChapterTitle: recentItem.title,
      latestChapterLanguage: recentItem.language,
      latestChapterId: recentItem.chapterId,
      chapterCoverageCount: getManifestCount(manifestItem),
      chapterCoverageLanguages: Array.isArray(manifestItem?.availableLanguages)
        ? manifestItem.availableLanguages
        : [],
    });
  }

  enriched.sort((a, b) => {
    const timeDelta = new Date(b.latestChapterUpdatedAt || 0).getTime() - new Date(a.latestChapterUpdatedAt || 0).getTime();
    if (timeDelta !== 0) return timeDelta;
    return Number(b.popularity || 0) - Number(a.popularity || 0);
  });

  const deduped = new Map();
  for (const item of enriched) {
    deduped.set(String(item.mangaId), item);
  }

  const dedupedItems = Array.from(deduped.values());
  const sectionLimit = resolveSectionLimit(dedupedItems.length);
  return {
    items: sectionLimit > 0 ? dedupedItems.slice(0, sectionLimit) : dedupedItems,
    catalogCount: catalogEntries.length,
    matchedCount: dedupedItems.length,
    sectionLimit,
  };
}

async function collectFreshNewChapterItems() {
  const recentFeed = await fetchRecentMangaDexFeed();
  const built = buildRecentFeedItems(recentFeed.items);
  return {
    ...built,
    feedRows: recentFeed.totalRows,
    feedPages: recentFeed.fetchedPages,
    freshFeedItems: recentFeed.items.length,
    cutoffIso: recentFeed.cutoffIso,
  };
}

async function fetchMangaNewChapters() {
  console.log('========================================');
  console.log('REFRESHING MANGA NEW CHAPTERS');
  console.log('========================================');

  const outputPath = path.join(__dirname, '../../api', `${CONFIG.API_PATHS.MANGA_NEW_CHAPTERS}.json`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const previousItems = parseExistingItems(outputPath);
  console.log(`Window: last ${FRESH_HOURS} hours. Previous file entries: ${previousItems.length}.`);

  let latestAttempt = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    latestAttempt = await collectFreshNewChapterItems();

    console.log(
      `Attempt ${attempt}/${MAX_ATTEMPTS}: catalog=${latestAttempt.catalogCount}, feed-pages=${latestAttempt.feedPages}, feed-rows=${latestAttempt.feedRows}, fresh-feed=${latestAttempt.freshFeedItems}, matched=${latestAttempt.matchedCount}, limit=${latestAttempt.sectionLimit}, section=${latestAttempt.items.length}.`,
    );

    if (latestAttempt.items.length > 0) {
      if (attempt > 1) {
        console.log(`Recovered non-empty new chapters section on attempt ${attempt}.`);
      }
      break;
    }

    if (attempt < MAX_ATTEMPTS) {
      console.warn(
        `New chapters result is empty (attempt ${attempt}/${MAX_ATTEMPTS}). Retrying in ${RETRY_DELAY_MS}ms...`,
      );
      await delay(RETRY_DELAY_MS);
    }
  }

  const finalItems = Array.isArray(latestAttempt?.items) ? latestAttempt.items : [];

  if (finalItems.length === 0 && previousItems.length > 0) {
    console.warn(
      `New chapters still empty after ${MAX_ATTEMPTS} attempts. Keeping previous file with ${previousItems.length} entries.`,
    );
    return;
  }

  if (finalItems.length === 0) {
    console.warn(
      `New chapters empty after ${MAX_ATTEMPTS} attempts and no previous cache exists. Skipping write to avoid publishing empty feed.`,
    );
    return;
  }

  writeJsonIfChanged(CONFIG.API_PATHS.MANGA_NEW_CHAPTERS, finalItems);
  console.log(`Manga new chapters refreshed with ${finalItems.length} titles (cutoff: ${latestAttempt.cutoffIso}).`);
}

module.exports = fetchMangaNewChapters;
