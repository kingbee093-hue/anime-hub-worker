const fs = require('fs');
const path = require('path');
const axios = require('axios');

const CONFIG = require('../config/constants');
const { delay } = require('../utils/formatters');
const { writeJsonIfChanged } = require('../utils/writeJsonIfChanged');
const {
  PROVIDER_LABELS,
  parseChapterNumber,
  resolveBestFallbackProvider,
  providers,
  normalizeProviderChapter,
} = require('../utils/mangaFallbackProviders');

const MANGADEX_API = 'https://api.mangadex.org';
const CHAPTER_LANGUAGES = ['en', 'ar'];
const CHAPTER_PAGE_SIZE = 500;
const CHAPTER_DELAY_MS = 250;
const FALLBACK_DELAY_MS = 500;
const RELEASING_REFRESH_HOURS = Number(process.env.MANGA_RELEASING_REFRESH_HOURS || 12);
const LIBRARY_REFRESH_HOURS = Number(process.env.MANGA_LIBRARY_REFRESH_HOURS || 24 * 7);
const MAX_RELEASING_TITLES_PER_RUN = Number(process.env.MANGA_MAX_RELEASING_TITLES || 80);
const MAX_LIBRARY_TITLES_PER_RUN = Number(process.env.MANGA_MAX_LIBRARY_TITLES || 40);
const FORCE_FULL_REFRESH = process.env.MANGA_FORCE_FULL_REFRESH === '1';
const ENABLE_ENGLISH_FALLBACK = process.env.MANGA_ENABLE_ENGLISH_FALLBACK !== '0';
const TARGET_MANGA_IDS = new Set(
  String(process.env.MANGA_TARGET_IDS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);
const FALLBACK_MAPPING_TTL_HOURS = Number(process.env.MANGA_FALLBACK_MAPPING_TTL_HOURS || 24 * 14);
const FALLBACK_PAGE_MAX_RETRIES = Number(process.env.MANGA_FALLBACK_PAGE_MAX_RETRIES || 3);

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function getCatalogEntries() {
  const catalogDir = path.join(__dirname, '../../api/manga/catalog');
  if (!fs.existsSync(catalogDir)) {
    return [];
  }

  const pageFiles = fs.readdirSync(catalogDir)
    .filter((file) => /^manga_page_\d+\.json$/i.test(file))
    .sort((a, b) => {
      const aNum = Number(a.match(/(\d+)/)?.[1] || 0);
      const bNum = Number(b.match(/(\d+)/)?.[1] || 0);
      return aNum - bNum;
    });

  return pageFiles.flatMap((file) => {
    const fullPath = path.join(catalogDir, file);
    const items = readJsonFile(fullPath, []);
    return Array.isArray(items) ? items : [];
  });
}

function isReleasingStatus(status) {
  return String(status || '').toUpperCase() === 'RELEASING';
}

function getHoursSince(isoDate) {
  if (!isoDate) return Number.POSITIVE_INFINITY;
  const time = new Date(isoDate).getTime();
  if (Number.isNaN(time)) return Number.POSITIVE_INFINITY;
  return (Date.now() - time) / 3600000;
}

function getManifestMap() {
  const manifestPath = path.join(__dirname, '../../api', `${CONFIG.API_PATHS.MANGA_CHAPTERS}/manifest.json`);
  const manifest = readJsonFile(manifestPath, {});
  const items = Array.isArray(manifest.items) ? manifest.items : [];
  return new Map(items.map((item) => [item.mangadexId, item]));
}

function getFallbackMappingPath() {
  return path.join(__dirname, '../../api', `${CONFIG.API_PATHS.MANGA_MAPPING}_fallback.json`);
}

function getFallbackMappingMap() {
  const items = readJsonFile(getFallbackMappingPath(), { items: [] });
  const list = Array.isArray(items.items) ? items.items : [];
  return new Map(list.map((item) => [item.mangadexId, item]));
}

function writeFallbackMappingMap(mappingMap) {
  const items = Array.from(mappingMap.values()).sort((a, b) =>
    String(a.title || '').localeCompare(String(b.title || '')),
  );
  writeJsonIfChanged(CONFIG.API_PATHS.MANGA_MAPPING + '_fallback', {
    updatedAt: new Date().toISOString(),
    items,
  });
}

function buildRefreshPlan(entries, manifestMap) {
  if (FORCE_FULL_REFRESH) {
    return {
      refreshSet: new Set(entries.map((entry) => entry.mangadexId)),
      releasingCount: entries.filter((entry) => isReleasingStatus(entry.status)).length,
      libraryCount: entries.filter((entry) => !isReleasingStatus(entry.status)).length,
      skippedCount: 0,
    };
  }

  const releasingCandidates = [];
  const libraryCandidates = [];

  for (const entry of entries) {
    const existing = manifestMap.get(entry.mangadexId);
    if (!existing) {
      if (isReleasingStatus(entry.status)) {
        releasingCandidates.push({ entry, staleHours: Number.POSITIVE_INFINITY });
      } else {
        libraryCandidates.push({ entry, staleHours: Number.POSITIVE_INFINITY });
      }
      continue;
    }

    const staleHours = getHoursSince(existing.updatedAt);
    if (isReleasingStatus(entry.status)) {
      if (staleHours >= RELEASING_REFRESH_HOURS) {
        releasingCandidates.push({ entry, staleHours });
      }
    } else if (staleHours >= LIBRARY_REFRESH_HOURS) {
      libraryCandidates.push({ entry, staleHours });
    }
  }

  releasingCandidates.sort((a, b) => {
    const staleDelta = b.staleHours - a.staleHours;
    if (staleDelta !== 0) return staleDelta;
    return Number(b.entry.popularity || 0) - Number(a.entry.popularity || 0);
  });

  libraryCandidates.sort((a, b) => {
    const staleDelta = b.staleHours - a.staleHours;
    if (staleDelta !== 0) return staleDelta;
    return Number(b.entry.popularity || 0) - Number(a.entry.popularity || 0);
  });

  const selectedReleasing = releasingCandidates
    .slice(0, MAX_RELEASING_TITLES_PER_RUN)
    .map((item) => item.entry);
  const selectedLibrary = libraryCandidates
    .slice(0, MAX_LIBRARY_TITLES_PER_RUN)
    .map((item) => item.entry);

  return {
    refreshSet: new Set(
      [...selectedReleasing, ...selectedLibrary].map((entry) => entry.mangadexId),
    ),
    releasingCount: selectedReleasing.length,
    libraryCount: selectedLibrary.length,
    skippedCount:
      entries.length - selectedReleasing.length - selectedLibrary.length,
  };
}

function normalizeChapterItem(raw, scanlationGroup) {
  const attributes = raw?.attributes || {};
  const chapter = {
    id: String(raw?.id || ''),
    title: String(attributes.title || ''),
    chapter: String(attributes.chapter || ''),
    volume: String(attributes.volume || ''),
    language: String(attributes.translatedLanguage || ''),
    pages: Number(attributes.pages || 0),
    publishedAt: attributes.publishAt || null,
    externalUrl: attributes.externalUrl || null,
    scanlationGroup: scanlationGroup || '',
    sourceType: attributes.externalUrl ? 'official_external' : 'reader',
  };

  if (!chapter.id) {
    return null;
  }

  return chapter;
}

function dedupeChapters(chapters) {
  const grouped = new Map();
  for (const chapter of chapters) {
    const number = String(chapter.chapter || '').trim();
    const title = String(chapter.title || '').trim().toLowerCase();
    const key = number ? number : `title:${title || chapter.id}`;
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(chapter);
  }

  const resolved = Array.from(grouped.values()).map((variants) => {
    variants.sort((a, b) => {
      return scoreChapterVariant(b) - scoreChapterVariant(a);
    });
    return variants[0];
  });

  resolved.sort((a, b) => {
    const chapterDiff = (parseChapterNumber(b.chapter) || -1) - (parseChapterNumber(a.chapter) || -1);
    if (chapterDiff !== 0) {
      return chapterDiff;
    }
    return new Date(b.publishedAt || 0).getTime() - new Date(a.publishedAt || 0).getTime();
  });

  return resolved;
}

function scoreChapterVariant(chapter) {
  let score = 0;
  if (chapter.sourceType === 'reader') score += 900;
  if (chapter.sourceType === 'fallback_reader') score += 800;
  if (chapter.sourceType === 'official_external') score += 100;
  if (chapter.pages > 0) score += 400;
  if (Array.isArray(chapter.pageUrls) && chapter.pageUrls.length > 0) score += 350;
  if (chapter.scanlationGroup) score += 50;
  if (chapter.publishedAt) score += 25;
  return score;
}

function _chapterKey(chapter) {
  const chapterNumber = String(chapter.chapter || '').trim();
  if (chapterNumber) {
    return `${chapter.language || 'en'}|${chapterNumber}`;
  }

  const title = String(chapter.title || '').trim().toLowerCase();
  if (title) {
    return `${chapter.language || 'en'}|title|${title}`;
  }

  return `${chapter.language || 'en'}|${chapter.id}`;
}

function needsEnglishFallback(entry, englishChapters) {
  const catalogTotal = Number(entry.chapters || 0);
  if (englishChapters.length === 0) return true;

  const readableCount = englishChapters.filter((chapter) => chapter.sourceType === 'reader').length;
  const externalCount = englishChapters.filter((chapter) => chapter.sourceType === 'official_external').length;
  const maxChapter = Math.max(
    0,
    ...englishChapters
      .map((chapter) => parseChapterNumber(chapter.chapter))
      .filter((value) => Number.isFinite(value)),
  );

  if (catalogTotal > 0 && readableCount < catalogTotal) {
    return true;
  }

  if (externalCount > 0) {
    return true;
  }

  return catalogTotal > 0 && maxChapter + 1 < catalogTotal;
}

function isMappingFresh(mapping) {
  if (!mapping?.updatedAt) return false;
  const updatedAt = new Date(mapping.updatedAt).getTime();
  if (Number.isNaN(updatedAt)) return false;
  return (Date.now() - updatedAt) / 3600000 < FALLBACK_MAPPING_TTL_HOURS;
}

async function buildEnglishFallbackChapters(entry, existingEnglish, fallbackMappingMap) {
  if (!ENABLE_ENGLISH_FALLBACK || !needsEnglishFallback(entry, existingEnglish)) {
    return { chapters: existingEnglish, mapping: null };
  }

  const cachedMapping = fallbackMappingMap.get(entry.mangadexId);
  let mapping = isMappingFresh(cachedMapping) ? cachedMapping : null;
  if (!mapping) {
    console.log(`Resolving English fallback provider for ${entry.title}...`);
    mapping = await resolveBestFallbackProvider(entry, cachedMapping);
    if (mapping) {
      fallbackMappingMap.set(entry.mangadexId, {
        mangadexId: entry.mangadexId,
        title: entry.title,
        mangaId: entry.mangaId,
        anilistId: entry.anilistId,
        ...mapping,
      });
      writeFallbackMappingMap(fallbackMappingMap);
    }
  }

  if (!mapping?.provider || !mapping?.providerId || !providers[mapping.provider]) {
    return { chapters: existingEnglish, mapping: null };
  }

  const provider = providers[mapping.provider];
  console.log(`Using English fallback ${PROVIDER_LABELS[mapping.provider] || mapping.provider} for ${entry.title}.`);
  const info = await provider.fetchInfo(mapping.providerId);
  const providerChaptersRaw = Array.isArray(info?.chapters) ? info.chapters : [];
  const existingMap = new Map(existingEnglish.map((chapter) => [_chapterKey(chapter), chapter]));
  const merged = [...existingEnglish];
  let addedCount = 0;

  for (const chapter of providerChaptersRaw) {
    const chapterNumber = parseChapterNumber(chapter.chapter || chapter.chapterNumber || chapter.title);
    if (chapterNumber == null) {
      continue;
    }

    const tempChapter = {
      id: `${mapping.provider}:${chapter.id}`,
      title: String(chapter.title || '').trim(),
      chapter: String(chapterNumber),
      volume: chapter.volumeNumber != null ? String(chapter.volumeNumber) : '',
      language: 'en',
      pages: 0,
      publishedAt: chapter.releaseDate || chapter.releasedDate || null,
      externalUrl: null,
      scanlationGroup: PROVIDER_LABELS[mapping.provider] || mapping.provider,
      sourceType: 'fallback_reader',
    };
      const key = _chapterKey(tempChapter);
    const existing = existingMap.get(key);

    if (existing && existing.sourceType === 'reader' && Number(existing.pages || 0) > 0) {
      continue;
      }

      try {
      const pages = await fetchFallbackPagesWithRetry(provider, chapter.id);
      const pageUrls = Array.isArray(pages)
        ? pages
            .map((page) => page?.img)
            .filter(Boolean)
            .map((url) => String(url))
        : [];
      if (pageUrls.isEmpty) {
        continue;
      }

      const normalized = normalizeProviderChapter(mapping.provider, chapter, pageUrls);
      if (existing) {
        const index = merged.findIndex((item) => _chapterKey(item) === key);
        if (index >= 0 && scoreChapterVariant(normalized) > scoreChapterVariant(merged[index])) {
          merged[index] = normalized;
        }
      } else {
        merged.push(normalized);
      }
      existingMap.set(key, normalized);
      addedCount += 1;
    } catch (error) {
      console.error(
        `Failed fallback pages for ${entry.title} ch ${chapterNumber} via ${mapping.provider}: ${error.message}`,
      );
    }

    await delay(FALLBACK_DELAY_MS);
  }

  if (addedCount > 0) {
    console.log(`Added ${addedCount} English fallback chapters for ${entry.title}.`);
  }

  return {
    chapters: dedupeChapters(merged),
    mapping,
  };
}

async function fetchFallbackPagesWithRetry(provider, chapterId) {
  let attempt = 0;
  let lastError = null;

  while (attempt < FALLBACK_PAGE_MAX_RETRIES) {
    try {
      return await provider.fetchChapterPages(chapterId);
    } catch (error) {
      lastError = error;
      attempt += 1;
      const statusCode = error?.response?.status;
      if (statusCode === 429 && attempt < FALLBACK_PAGE_MAX_RETRIES) {
        await delay(FALLBACK_DELAY_MS * attempt * 3);
        continue;
      }
      if (attempt < FALLBACK_PAGE_MAX_RETRIES) {
        await delay(FALLBACK_DELAY_MS * attempt);
      }
    }
  }

  throw lastError || new Error('Failed to fetch fallback pages.');
}

async function fetchLanguageChapters(mangaDexId, language) {
  const items = [];
  let offset = 0;
  let total = null;

  while (total == null || offset < total) {
    const response = await axios.get(`${MANGADEX_API}/manga/${mangaDexId}/feed`, {
      params: {
        limit: CHAPTER_PAGE_SIZE,
        offset,
        'translatedLanguage[]': language,
        'order[chapter]': 'desc',
        'order[volume]': 'desc',
        'order[publishAt]': 'desc',
        'includes[]': 'scanlation_group',
      },
      timeout: 30000,
    });

    const body = response.data || {};
    const data = Array.isArray(body.data) ? body.data : [];
    total = Number(body.total || 0);

    for (const entry of data) {
      const relationships = Array.isArray(entry.relationships) ? entry.relationships : [];
      const scanlationGroup = relationships
        .filter((rel) => rel?.type === 'scanlation_group')
        .map((rel) => rel?.attributes?.name)
        .find(Boolean) || '';

      const normalized = normalizeChapterItem(entry, scanlationGroup);
      if (normalized) {
        items.push(normalized);
      }
    }

    offset += data.length;
    if (data.length === 0) {
      break;
    }
    await delay(CHAPTER_DELAY_MS);
  }

  return dedupeChapters(items);
}

async function fetchMangaChapters() {
  console.log('========================================');
  console.log('BUILDING: Manga Chapter Index');
  console.log('========================================');

  const rawCatalogEntries = getCatalogEntries()
    .filter((item) => item && item.mangadexId)
    .map((item) => ({
      mangaId: item.mangaId,
      anilistId: item.anilistId || item.mangaId,
      title: item.title || '',
      mangadexId: item.mangadexId,
      status: item.status || '',
      popularity: Number(item.popularity || 0),
      chapters: Number(item.chapters || 0),
      titleEnglish: item.titleEnglish || '',
      titleRomaji: item.titleRomaji || '',
      synonyms: Array.isArray(item.synonyms) ? item.synonyms : [],
    }));

  const catalogEntries = TARGET_MANGA_IDS.size > 0
    ? rawCatalogEntries.filter((item) =>
        TARGET_MANGA_IDS.has(String(item.mangadexId)) ||
        TARGET_MANGA_IDS.has(String(item.mangaId)) ||
        TARGET_MANGA_IDS.has(String(item.anilistId)),
      )
    : rawCatalogEntries;

  const uniqueEntries = Array.from(
    new Map(catalogEntries.map((item) => [item.mangadexId, item])).values(),
  );
  const existingManifestMap = getManifestMap();
  const fallbackMappingMap = getFallbackMappingMap();
  const refreshPlan = buildRefreshPlan(uniqueEntries, existingManifestMap);

  const manifest = {
    generatedAt: new Date().toISOString(),
    totalTitles: uniqueEntries.length,
    items: [],
  };

  console.log(
    `Manga chapter refresh plan -> releasing: ${refreshPlan.releasingCount}, library: ${refreshPlan.libraryCount}, skipped: ${refreshPlan.skippedCount}, forceFull: ${FORCE_FULL_REFRESH}`,
  );

  for (const entry of uniqueEntries) {
    if (!refreshPlan.refreshSet.has(entry.mangadexId)) {
      const existing = existingManifestMap.get(entry.mangadexId);
      if (existing) {
        manifest.items.push({
          ...existing,
          mangaId: entry.mangaId,
          anilistId: entry.anilistId,
          title: entry.title,
          mangadexId: entry.mangadexId,
        });
      }
      continue;
    }

    console.log(`Refreshing chapters for ${entry.title} (${entry.mangadexId})`);
    const languages = {};
    let englishFallbackMapping = null;

    for (const language of CHAPTER_LANGUAGES) {
      try {
        let chapters = await fetchLanguageChapters(entry.mangadexId, language);
        if (language === 'en') {
          const fallback = await buildEnglishFallbackChapters(entry, chapters, fallbackMappingMap);
          chapters = fallback.chapters;
          englishFallbackMapping = fallback.mapping;
        }
        if (chapters.length > 0) {
          languages[language] = chapters;
        }
      } catch (error) {
        console.error(`Failed to fetch ${language} chapters for ${entry.title}: ${error.message}`);
      }
      await delay(CHAPTER_DELAY_MS);
    }

    const availableLanguages = Object.keys(languages);
    const chapterIndex = {
      mangaId: entry.mangaId,
      anilistId: entry.anilistId,
      mangadexId: entry.mangadexId,
      title: entry.title,
      updatedAt: new Date().toISOString(),
      availableLanguages,
      counts: Object.fromEntries(
        availableLanguages.map((language) => [language, languages[language].length]),
      ),
      languages,
      englishFallbackProvider: englishFallbackMapping?.provider || null,
      englishFallbackProviderTitle: englishFallbackMapping?.providerTitle || null,
      englishFallbackChapterCount: englishFallbackMapping?.chapterCount || null,
    };

    writeJsonIfChanged(`${CONFIG.API_PATHS.MANGA_CHAPTERS}/${entry.mangadexId}`, chapterIndex);
    manifest.items.push({
      mangaId: entry.mangaId,
      anilistId: entry.anilistId,
      mangadexId: entry.mangadexId,
      title: entry.title,
      updatedAt: chapterIndex.updatedAt,
      availableLanguages,
      counts: chapterIndex.counts,
      englishFallbackProvider: chapterIndex.englishFallbackProvider,
      englishFallbackChapterCount: chapterIndex.englishFallbackChapterCount,
    });
  }

  writeJsonIfChanged(`${CONFIG.API_PATHS.MANGA_CHAPTERS}/manifest`, manifest);
  writeFallbackMappingMap(fallbackMappingMap);
  console.log(`Saved chapter indexes for ${manifest.items.length} manga titles.`);
}

module.exports = fetchMangaChapters;
