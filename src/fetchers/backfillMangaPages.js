const axios = require('axios');

const CONFIG = require('../config/constants');
const { writeJsonIfChanged } = require('../utils/writeJsonIfChanged');
const {
  getUniverseManifest,
  getChapterIndex,
  getPageManifest,
  sanitizeFilePart,
} = require('../utils/mangaBackfillData');
const { parseChapterNumber, PROVIDER_LABELS } = require('../utils/mangaFallbackProviders');

const MANGADEX_API = 'https://api.mangadex.org';
const PAGE_BATCH_SIZE = Number(process.env.MANGA_PAGE_BACKFILL_BATCH || 40);
const PAGE_PER_TITLE_LIMIT = Number(process.env.MANGA_PAGE_BACKFILL_PER_TITLE || 8);
const PAGE_LANGUAGES = String(process.env.MANGA_PAGE_LANGUAGES || 'en')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const PAGE_TARGET_IDS = new Set(
  String(process.env.MANGA_PAGE_TARGET_IDS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);

function buildChapterSortValue(chapter) {
  const parsed = parseChapterNumber(chapter.chapter);
  if (Number.isFinite(parsed)) return parsed;
  return -1;
}

function sortChapters(chapters) {
  return [...chapters].sort((a, b) => {
    const chapterDelta = buildChapterSortValue(b) - buildChapterSortValue(a);
    if (chapterDelta !== 0) return chapterDelta;
    return new Date(b.publishedAt || 0).getTime() - new Date(a.publishedAt || 0).getTime();
  });
}

function buildManifestKey(mangadexId, chapterId) {
  return `${mangadexId}|${chapterId}`;
}

function sortManifestItems(items) {
  return items.sort((a, b) => {
    const titleDelta = String(a.title || '').localeCompare(String(b.title || ''));
    if (titleDelta !== 0) return titleDelta;
    return String(b.chapter || '').localeCompare(String(a.chapter || ''), undefined, { numeric: true });
  });
}

function getReadableChapters(chapterIndex, languages) {
  const result = [];
  for (const language of languages) {
    const chapters = Array.isArray(chapterIndex?.languages?.[language])
      ? chapterIndex.languages[language]
      : [];
    for (const chapter of sortChapters(chapters)) {
      if (chapter.sourceType === 'reader' || chapter.sourceType === 'fallback_reader') {
        result.push({
          ...chapter,
          language,
        });
      }
    }
  }
  return result;
}

async function resolveMangaDexPages(chapter) {
  const response = await axios.get(`${MANGADEX_API}/at-home/server/${chapter.id}`, {
    timeout: 30000,
  });
  const body = response.data || {};
  const baseUrl = body.baseUrl;
  const hash = body.chapter?.hash;
  const pageFiles = Array.isArray(body.chapter?.data) ? body.chapter.data : [];
  const pageUrls = baseUrl && hash
    ? pageFiles.map((file) => `${baseUrl}/data/${hash}/${file}`)
    : [];

  return {
    pageUrls,
    imageHeaders: {
      Referer: 'https://mangadex.org/',
      'User-Agent': 'Mozilla/5.0',
    },
  };
}

async function backfillMangaPages() {
  console.log('========================================');
  console.log('BACKFILL: Manga Page Manifests');
  console.log('========================================');

  const universe = getUniverseManifest();
  const universeItems = Array.isArray(universe.items) ? universe.items : [];
  const pageManifest = getPageManifest();
  const pageItemMap = new Map((pageManifest.items || []).map((item) => [buildManifestKey(item.mangadexId, item.chapterId), item]));

  const candidates = [];
  for (const item of universeItems
    .slice()
    .sort((a, b) => Number(b.popularity || 0) - Number(a.popularity || 0))) {
    if (
      PAGE_TARGET_IDS.size > 0 &&
      !PAGE_TARGET_IDS.has(String(item.mangadexId)) &&
      !PAGE_TARGET_IDS.has(String(item.mangaId)) &&
      !PAGE_TARGET_IDS.has(String(item.anilistId))
    ) {
      continue;
    }
    const chapterIndex = getChapterIndex(item.mangadexId);
    if (!chapterIndex) continue;

    const chapters = getReadableChapters(chapterIndex, PAGE_LANGUAGES);
    let perTitleCount = 0;
    for (const chapter of chapters) {
      const key = buildManifestKey(item.mangadexId, chapter.id);
      if (pageItemMap.has(key)) {
        continue;
      }
      candidates.push({
        manga: item,
        chapter,
      });
      perTitleCount += 1;
      if (perTitleCount >= PAGE_PER_TITLE_LIMIT) {
        break;
      }
      if (candidates.length >= PAGE_BATCH_SIZE) {
        break;
      }
    }
    if (candidates.length >= PAGE_BATCH_SIZE) {
      break;
    }
  }

  const completed = [];
  const failed = [];

  function writePageManifest() {
    const items = sortManifestItems(Array.from(pageItemMap.values()));
    writeJsonIfChanged(`${CONFIG.API_PATHS.MANGA_PAGES}/manifest`, {
      updatedAt: new Date().toISOString(),
      totalChapters: items.length,
      languages: PAGE_LANGUAGES,
      items,
    });
    return items;
  }

  function writeProgress(extra = {}) {
    const items = Array.from(pageItemMap.values());
    writeJsonIfChanged(`${CONFIG.API_PATHS.MANGA_BACKFILL}/pages_progress`, {
      updatedAt: new Date().toISOString(),
      universeTotal: universeItems.length,
      warmedChapters: items.length,
      selectedCount: candidates.length,
      batchSize: PAGE_BATCH_SIZE,
      perTitleLimit: PAGE_PER_TITLE_LIMIT,
      languages: PAGE_LANGUAGES,
      targetIds: Array.from(PAGE_TARGET_IDS),
      completedCount: completed.length,
      failedCount: failed.length,
      completed,
      failed,
      selected: candidates.map(({ manga, chapter }) => ({
        mangadexId: manga.mangadexId,
        title: manga.title,
        chapterId: chapter.id,
        chapter: chapter.chapter,
        language: chapter.language,
        sourceType: chapter.sourceType,
        provider: chapter.provider || null,
      })),
      ...extra,
    });
  }

  writeProgress();

  if (candidates.length === 0) {
    console.log('No manga page manifest candidates need warmup right now.');
    return;
  }

  for (const { manga, chapter } of candidates) {
    let pageUrls = Array.isArray(chapter.pageUrls) ? chapter.pageUrls.map((url) => String(url)) : [];
    let imageHeaders = chapter.imageHeaders || {};

    if (chapter.sourceType === 'reader' && pageUrls.length === 0) {
      try {
        const resolved = await resolveMangaDexPages(chapter);
        pageUrls = resolved.pageUrls;
        imageHeaders = resolved.imageHeaders;
      } catch (error) {
        console.error(`Failed MangaDex page warmup for ${manga.title} ch ${chapter.chapter}: ${error.message}`);
        failed.push({
          mangadexId: manga.mangadexId,
          title: manga.title,
          chapterId: chapter.id,
          chapter: chapter.chapter,
          error: error.message,
        });
        writeProgress({
          currentItem: {
            mangadexId: manga.mangadexId,
            title: manga.title,
            chapterId: chapter.id,
            chapter: chapter.chapter,
            status: 'failed',
            error: error.message,
          },
        });
        continue;
      }
    }

    if (pageUrls.length === 0) {
      failed.push({
        mangadexId: manga.mangadexId,
        title: manga.title,
        chapterId: chapter.id,
        chapter: chapter.chapter,
        error: 'No page URLs resolved',
      });
      writeProgress({
        currentItem: {
          mangadexId: manga.mangadexId,
          title: manga.title,
          chapterId: chapter.id,
          chapter: chapter.chapter,
          status: 'skipped',
          error: 'No page URLs resolved',
        },
      });
      continue;
    }

    const fileId = sanitizeFilePart(chapter.id);
    const pageData = {
      updatedAt: new Date().toISOString(),
      mangaId: manga.mangaId,
      anilistId: manga.anilistId,
      mangadexId: manga.mangadexId,
      title: manga.title,
      chapterId: chapter.id,
      chapter: chapter.chapter,
      volume: chapter.volume || '',
      language: chapter.language,
      sourceType: chapter.sourceType,
      provider: chapter.provider || null,
      providerLabel: chapter.provider ? (PROVIDER_LABELS[chapter.provider] || chapter.provider) : 'MangaDex',
      pageCount: pageUrls.length,
      pageUrls,
      imageHeaders,
      publishedAt: chapter.publishedAt || null,
    };

    writeJsonIfChanged(`${CONFIG.API_PATHS.MANGA_PAGES}/${manga.mangadexId}/${fileId}`, pageData);
    pageItemMap.set(buildManifestKey(manga.mangadexId, chapter.id), {
      mangadexId: manga.mangadexId,
      title: manga.title,
      chapterId: chapter.id,
      chapter: chapter.chapter,
      language: chapter.language,
      sourceType: chapter.sourceType,
      provider: chapter.provider || null,
      pageCount: pageUrls.length,
      path: `${CONFIG.API_PATHS.MANGA_PAGES}/${manga.mangadexId}/${fileId}.json`,
      updatedAt: pageData.updatedAt,
    });
    completed.push({
      mangadexId: manga.mangadexId,
      title: manga.title,
      chapterId: chapter.id,
      chapter: chapter.chapter,
      language: chapter.language,
      sourceType: chapter.sourceType,
      provider: chapter.provider || null,
      pageCount: pageUrls.length,
    });
    writePageManifest();
    writeProgress({
      currentItem: {
        mangadexId: manga.mangadexId,
        title: manga.title,
        chapterId: chapter.id,
        chapter: chapter.chapter,
        status: 'completed',
      },
    });
  }

  writePageManifest();
  writeProgress({ status: 'completed' });

  console.log(`Page warmup completed for ${candidates.length} chapters.`);
}

module.exports = backfillMangaPages;
