const fs = require('fs');
const path = require('path');
const axios = require('axios');

const CONFIG = require('../config/constants');
const { delay } = require('../utils/formatters');
const { writeJsonIfChanged } = require('../utils/writeJsonIfChanged');
const {
  PROVIDER_LABELS,
  parseChapterNumber,
  resolveFallbackProviderCandidates,
  providers,
  normalizeProviderChapter,
} = require('../utils/mangaFallbackProviders');
const { writeNewChaptersSection, DEFAULT_SECTION_LIMIT } = require('../utils/mangaSections');
const {
  getMangaCatalogEntries,
  buildChapterIndexId,
} = require('../utils/mangaBackfillData');

const MANGADEX_API = 'https://api.mangadex.org';
const CHAPTER_LANGUAGES = ['en', 'ar'];
const CHAPTER_PAGE_SIZE = 500;
const CHAPTER_DELAY_MS = 250;
const FALLBACK_DELAY_MS = 500;
const RELEASING_REFRESH_HOURS = Number(process.env.MANGA_RELEASING_REFRESH_HOURS || 12);
const LIBRARY_REFRESH_HOURS = Number(process.env.MANGA_LIBRARY_REFRESH_HOURS || 24 * 7);
const MAX_RELEASING_TITLES_PER_RUN = Number(process.env.MANGA_MAX_RELEASING_TITLES || 80);
const MAX_LIBRARY_TITLES_PER_RUN = Number(process.env.MANGA_MAX_LIBRARY_TITLES || 40);
const MAX_NEW_RELEASING_TITLES_PER_RUN = Number(process.env.MANGA_MAX_NEW_RELEASING_TITLES || 12);
const MAX_NEW_LIBRARY_TITLES_PER_RUN = Number(process.env.MANGA_MAX_NEW_LIBRARY_TITLES || 8);
const BOOTSTRAP_INDEX_TARGET = Number(process.env.MANGA_BOOTSTRAP_INDEX_TARGET || 50);
const BOOTSTRAP_MULTIPLIER = Number(process.env.MANGA_BOOTSTRAP_MULTIPLIER || 2);
const ENABLE_ENGLISH_FALLBACK = process.env.MANGA_ENABLE_ENGLISH_FALLBACK !== '0';
const FALLBACK_MAPPING_TTL_HOURS = Number(process.env.MANGA_FALLBACK_MAPPING_TTL_HOURS || 24 * 14);
const FALLBACK_PAGE_MAX_RETRIES = Number(process.env.MANGA_FALLBACK_PAGE_MAX_RETRIES || 3);
const FALLBACK_PAGE_TIMEOUT_MS = Number(process.env.MANGA_FALLBACK_PAGE_TIMEOUT_MS || 45000);
const FALLBACK_PROVIDER_FAILURE_LIMIT = Number(process.env.MANGA_FALLBACK_PROVIDER_FAILURE_LIMIT || 5);
const FALLBACK_PROGRESS_EVERY = Number(process.env.MANGA_FALLBACK_PROGRESS_EVERY || 10);

function isProviderBlockedError(error) {
  const message = String(error?.message || '').toLowerCase();
  return (
    message.includes('removed all content') ||
    message.includes('removed all content or links') ||
    message.includes('copyright party') ||
    message.includes('dmca') ||
    message.includes('content unavailable') ||
    message.includes('this series has been licensed')
  );
}

function isForceFullRefresh() {
  return process.env.MANGA_FORCE_FULL_REFRESH === '1';
}

function getTargetMangaIds() {
  return new Set(
    String(process.env.MANGA_TARGET_IDS || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

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
  return new Map(items.map((item) => [item.chapterIndexId || item.mangadexId, item]).filter(([key]) => Boolean(key)));
}

function getExistingChapterIndex(chapterIndexId) {
  const chapterPath = path.join(
    __dirname,
    '../../api',
    `${CONFIG.API_PATHS.MANGA_CHAPTERS}/${chapterIndexId}.json`,
  );
  return readJsonFile(chapterPath, null);
}

function getFallbackMappingPath() {
  return path.join(__dirname, '../../api', `${CONFIG.API_PATHS.MANGA_MAPPING}_fallback.json`);
}

function getFallbackMappingMap() {
  const items = readJsonFile(getFallbackMappingPath(), { items: [] });
  const list = Array.isArray(items.items) ? items.items : [];
  return new Map(
    list
      .map((item) => [item.chapterIndexId || item.mangadexId, item])
      .filter(([key]) => Boolean(key)),
  );
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

function buildRefreshPlan(entries, manifestMap, forceFullRefresh) {
  if (forceFullRefresh) {
    return {
      refreshSet: new Set(entries.map((entry) => entry.chapterIndexId)),
      releasingCount: entries.filter((entry) => isReleasingStatus(entry.status)).length,
      libraryCount: entries.filter((entry) => !isReleasingStatus(entry.status)).length,
      newReleasingCount: entries.filter((entry) => isReleasingStatus(entry.status)).length,
      newLibraryCount: entries.filter((entry) => !isReleasingStatus(entry.status)).length,
      staleReleasingCount: 0,
      staleLibraryCount: 0,
      skippedCount: 0,
    };
  }

  const newReleasingCandidates = [];
  const newLibraryCandidates = [];
  const staleReleasingCandidates = [];
  const staleLibraryCandidates = [];

  for (const entry of entries) {
    const existing = manifestMap.get(entry.chapterIndexId);
    if (!existing) {
      if (isReleasingStatus(entry.status)) {
        newReleasingCandidates.push({ entry, staleHours: Number.POSITIVE_INFINITY });
      } else {
        newLibraryCandidates.push({ entry, staleHours: Number.POSITIVE_INFINITY });
      }
      continue;
    }

    const staleHours = getHoursSince(existing.updatedAt);
    if (isReleasingStatus(entry.status)) {
      if (staleHours >= RELEASING_REFRESH_HOURS) {
        staleReleasingCandidates.push({ entry, staleHours });
      }
    } else if (staleHours >= LIBRARY_REFRESH_HOURS) {
      staleLibraryCandidates.push({ entry, staleHours });
    }
  }

  newReleasingCandidates.sort((a, b) => {
    return Number(b.entry.popularity || 0) - Number(a.entry.popularity || 0);
  });

  newLibraryCandidates.sort((a, b) => {
    return Number(b.entry.popularity || 0) - Number(a.entry.popularity || 0);
  });

  staleReleasingCandidates.sort((a, b) => {
    const staleDelta = b.staleHours - a.staleHours;
    if (staleDelta !== 0) return staleDelta;
    return Number(b.entry.popularity || 0) - Number(a.entry.popularity || 0);
  });

  staleLibraryCandidates.sort((a, b) => {
    const staleDelta = b.staleHours - a.staleHours;
    if (staleDelta !== 0) return staleDelta;
    return Number(b.entry.popularity || 0) - Number(a.entry.popularity || 0);
  });

  const bootstrapMultiplier = manifestMap.size < BOOTSTRAP_INDEX_TARGET
    ? BOOTSTRAP_MULTIPLIER
    : 1;

  const selectedNewReleasing = newReleasingCandidates
    .slice(0, MAX_NEW_RELEASING_TITLES_PER_RUN * bootstrapMultiplier)
    .map((item) => item.entry);
  const selectedNewLibrary = newLibraryCandidates
    .slice(0, MAX_NEW_LIBRARY_TITLES_PER_RUN * bootstrapMultiplier)
    .map((item) => item.entry);
  const selectedStaleReleasing = staleReleasingCandidates
    .slice(0, MAX_RELEASING_TITLES_PER_RUN)
    .map((item) => item.entry);
  const selectedStaleLibrary = staleLibraryCandidates
    .slice(0, MAX_LIBRARY_TITLES_PER_RUN)
    .map((item) => item.entry);

  return {
    refreshSet: new Set(
      [
        ...selectedNewReleasing,
        ...selectedNewLibrary,
        ...selectedStaleReleasing,
        ...selectedStaleLibrary,
      ].map((entry) => entry.chapterIndexId),
    ),
    releasingCount: selectedNewReleasing.length + selectedStaleReleasing.length,
    libraryCount: selectedNewLibrary.length + selectedStaleLibrary.length,
    newReleasingCount: selectedNewReleasing.length,
    newLibraryCount: selectedNewLibrary.length,
    staleReleasingCount: selectedStaleReleasing.length,
    staleLibraryCount: selectedStaleLibrary.length,
    skippedCount:
      entries.length -
      selectedNewReleasing.length -
      selectedNewLibrary.length -
      selectedStaleReleasing.length -
      selectedStaleLibrary.length,
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

function formatProviderStats(successMap, failureMap) {
  const keys = Array.from(
    new Set([
      ...successMap.keys(),
      ...failureMap.keys(),
    ]),
  );

  if (keys.length === 0) {
    return 'no provider stats';
  }

  return keys
    .map((providerKey) => {
      const label = PROVIDER_LABELS[providerKey] || providerKey;
      const success = successMap.get(providerKey) || 0;
      const failure = failureMap.get(providerKey) || 0;
      return `${label}: +${success}/-${failure}`;
    })
    .join(', ');
}

async function buildEnglishFallbackChapters(
  entry,
  currentEnglish,
  previousEnglish,
  fallbackMappingMap,
) {
  const baseEnglish = dedupeChapters([...(previousEnglish || []), ...(currentEnglish || [])]);
  if (!ENABLE_ENGLISH_FALLBACK || !needsEnglishFallback(entry, baseEnglish)) {
    return { chapters: baseEnglish, mapping: null };
  }

  const cachedMapping = fallbackMappingMap.get(entry.chapterIndexId);
  const freshCached = isMappingFresh(cachedMapping) ? cachedMapping : null;
  console.log(`Resolving English fallback providers for ${entry.title} (MangaPill preferred first)...`);

  const rankedCandidates = await resolveFallbackProviderCandidates(entry);
  const providerCandidates = [...rankedCandidates];

  if (freshCached?.provider && freshCached?.providerId) {
    const exists = providerCandidates.some((item) =>
      item.provider === freshCached.provider && item.providerId === freshCached.providerId);
    if (!exists) {
      providerCandidates.push(freshCached);
    }
  }

  const providerEntries = [];
  for (const mapping of providerCandidates) {
    if (!mapping?.provider || !mapping?.providerId || !providers[mapping.provider]) {
      continue;
    }

    const provider = providers[mapping.provider];
    console.log(
      `Evaluating fallback candidate ${PROVIDER_LABELS[mapping.provider] || mapping.provider} for ${entry.title}: ${mapping.providerTitle || mapping.providerId}.`,
    );

    let info;
    try {
      info = await provider.fetchInfo(mapping.providerId);
    } catch (error) {
      console.error(`Failed fallback info for ${entry.title} via ${mapping.provider}: ${error.message}`);
      continue;
    }

    const chapterCount = Array.isArray(info?.chapters) ? info.chapters.length : 0;
    console.log(
      `Fallback candidate ready for ${entry.title}: ${PROVIDER_LABELS[mapping.provider] || mapping.provider} -> "${mapping.providerTitle || mapping.providerId}" with ${chapterCount} chapter candidate(s).`,
    );

    providerEntries.push({
      mapping,
      provider,
      chapters: Array.isArray(info?.chapters) ? info.chapters : [],
    });
  }

  if (providerEntries.length === 0) {
    console.warn(`No usable English fallback providers were found for ${entry.title}.`);
    return { chapters: baseEnglish, mapping: null };
  }

  const existingMap = new Map(baseEnglish.map((chapter) => [_chapterKey(chapter), chapter]));
  const merged = [...baseEnglish];
  const chapterOptions = new Map();

  for (const providerEntry of providerEntries) {
    for (const chapter of providerEntry.chapters) {
      const chapterNumber = parseChapterNumber(chapter.chapter || chapter.chapterNumber || chapter.title);
      if (chapterNumber == null) {
        continue;
      }

      const tempChapter = {
        id: `${providerEntry.mapping.provider}:${chapter.id}`,
        title: String(chapter.title || '').trim(),
        chapter: String(chapterNumber),
        volume: chapter.volumeNumber != null ? String(chapter.volumeNumber) : '',
        language: 'en',
        pages: 0,
        publishedAt: chapter.releaseDate || chapter.releasedDate || null,
        externalUrl: null,
        scanlationGroup: PROVIDER_LABELS[providerEntry.mapping.provider] || providerEntry.mapping.provider,
        sourceType: 'fallback_reader',
      };
      const key = _chapterKey(tempChapter);
      if (existingMap.get(key) && Number(existingMap.get(key).pages || 0) > 0) {
        continue;
      }

      if (!chapterOptions.has(key)) {
        chapterOptions.set(key, []);
      }
      chapterOptions.get(key).push({
        providerEntry,
        chapter,
      });
    }
  }

  console.log(
    `Preparing fallback chapter pages for ${entry.title}: ${chapterOptions.size} chapter gaps, ${providerEntries.length} provider candidate(s).`,
  );
  console.log(
    `Fallback provider order for ${entry.title}: ${providerEntries
      .map((item) => `${PROVIDER_LABELS[item.mapping.provider] || item.mapping.provider}("${item.mapping.providerTitle || item.mapping.providerId}")`)
      .join(' -> ')}.`,
  );

  let addedCount = 0;
  const providerSuccessCounts = new Map();
  const providerFailureCounts = new Map();
  const blockedProviders = new Set();
  let processedCount = 0;

  for (const [key, options] of chapterOptions.entries()) {
    processedCount += 1;
    if (
      processedCount === 1 ||
      processedCount === chapterOptions.size ||
      processedCount % FALLBACK_PROGRESS_EVERY === 0
    ) {
      console.log(
        `Fallback progress for ${entry.title}: ${processedCount}/${chapterOptions.size} chapter gap(s) checked, ${addedCount} readable chapter(s) added so far.`,
      );
    }

    const existing = existingMap.get(key);
    if (existing && Number(existing.pages || 0) > 0) {
      continue;
    }

    let resolved = false;

    for (const { providerEntry, chapter } of options) {
      const providerKey = providerEntry.mapping.provider;
      if (blockedProviders.has(providerKey)) {
        continue;
      }
      const failureCount = providerFailureCounts.get(providerKey) || 0;
      const successCount = providerSuccessCounts.get(providerKey) || 0;
      if (failureCount >= FALLBACK_PROVIDER_FAILURE_LIMIT && successCount === 0) {
        continue;
      }

      try {
        const chapterNumber = parseChapterNumber(chapter.chapter || chapter.chapterNumber || chapter.title);
        console.log(
          `Trying ${PROVIDER_LABELS[providerKey] || providerKey} for ${entry.title} chapter ${chapterNumber ?? '?'} (${chapter.id}).`,
        );
        const pages = await fetchFallbackPagesWithRetry(providerEntry.provider, chapter.id);
        const pageUrls = Array.isArray(pages)
          ? pages
              .map((page) => page?.img)
              .filter(Boolean)
              .map((url) => String(url))
          : [];
        if (pageUrls.length === 0) {
          providerFailureCounts.set(providerKey, failureCount + 1);
          continue;
        }

        const normalized = normalizeProviderChapter(providerKey, chapter, pageUrls);
        if (existing) {
          const index = merged.findIndex((item) => _chapterKey(item) === key);
          if (index >= 0 && scoreChapterVariant(normalized) > scoreChapterVariant(merged[index])) {
            merged[index] = normalized;
          }
        } else {
          merged.push(normalized);
        }
        existingMap.set(key, normalized);
        providerSuccessCounts.set(providerKey, successCount + 1);
        addedCount += 1;
        console.log(
          `Accepted ${PROVIDER_LABELS[providerKey] || providerKey} for ${entry.title} chapter ${normalized.chapter || '?' } with ${pageUrls.length} page(s).`,
        );
        resolved = true;
        break;
      } catch (error) {
        providerFailureCounts.set(providerKey, failureCount + 1);
        const chapterNumber = parseChapterNumber(chapter.chapter || chapter.chapterNumber || chapter.title);
        if (isProviderBlockedError(error)) {
          blockedProviders.add(providerKey);
          console.error(
            `Blocked fallback provider ${providerKey} for ${entry.title}: ${error.message}`,
          );
          continue;
        }
        console.error(
          `Failed fallback pages for ${entry.title} ch ${chapterNumber} via ${providerKey}: ${error.message}`,
        );
      }
    }

    if (!resolved) {
      const chapterNumber = key.split('|')[1];
      console.warn(`All fallback providers failed for ${entry.title} ch ${chapterNumber}. Skipping.`);
    }

    await delay(FALLBACK_DELAY_MS);
  }

  if (addedCount > 0) {
    const [bestProviderKey] = Array.from(providerSuccessCounts.entries())
      .sort((a, b) => b[1] - a[1])[0] || [];
    const bestProviderEntry = providerEntries.find((item) => item.mapping.provider === bestProviderKey) || providerEntries[0];
    const finalMapping = {
      chapterIndexId: entry.chapterIndexId,
      mangadexId: entry.mangadexId,
      title: entry.title,
      mangaId: entry.mangaId,
      anilistId: entry.anilistId,
      ...bestProviderEntry.mapping,
    };
    fallbackMappingMap.set(entry.chapterIndexId, finalMapping);
    writeFallbackMappingMap(fallbackMappingMap);
    console.log(`Added ${addedCount} English fallback chapters for ${entry.title}.`);
    console.log(
      `Fallback provider stats for ${entry.title}: ${formatProviderStats(providerSuccessCounts, providerFailureCounts)}.`,
    );
    return {
      chapters: dedupeChapters(merged),
      mapping: finalMapping,
    };
  }

  console.warn(
    `No readable English fallback chapters were added for ${entry.title}. Provider stats: ${formatProviderStats(providerSuccessCounts, providerFailureCounts)}.`,
  );
  return { chapters: baseEnglish, mapping: null };
}

async function fetchFallbackPagesWithRetry(provider, chapterId) {
  let attempt = 0;
  let lastError = null;

  while (attempt < FALLBACK_PAGE_MAX_RETRIES) {
    try {
      return await Promise.race([
        provider.fetchChapterPages(chapterId),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`Timeout after ${FALLBACK_PAGE_TIMEOUT_MS}ms`)), FALLBACK_PAGE_TIMEOUT_MS);
        }),
      ]);
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

async function buildProviderOnlyEnglishChapters(
  entry,
  fallbackMappingMap,
) {
  if (!entry.chapterSourceProvider || !entry.chapterSourceId) {
    return { chapters: [], mapping: null };
  }

  console.log(
    `Building provider-backed chapter index for ${entry.title} using ${PROVIDER_LABELS[entry.chapterSourceProvider] || entry.chapterSourceProvider} first.`,
  );

  const preferredMapping = {
    chapterIndexId: entry.chapterIndexId,
    title: entry.title,
    mangaId: entry.mangaId,
    anilistId: entry.anilistId,
    provider: entry.chapterSourceProvider,
    providerId: entry.chapterSourceId,
    providerTitle: entry.chapterSourceTitle || entry.title,
    chapterCount: Number(entry.chapterSourceChapterCount || 0),
    confidence: Number(entry.chapterSourceConfidence || 0),
    updatedAt: entry.chapterSourceUpdatedAt || new Date().toISOString(),
  };

  const rankedCandidates = await resolveFallbackProviderCandidates(entry);
  const providerCandidates = [];
  const seen = new Set();
  for (const mapping of [preferredMapping, ...rankedCandidates]) {
    if (!mapping?.provider || !mapping?.providerId) {
      continue;
    }
    const key = `${mapping.provider}:${mapping.providerId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    providerCandidates.push(mapping);
  }

  const providerEntries = [];
  for (const mapping of providerCandidates) {
    const provider = providers[mapping.provider];
    if (!provider) {
      continue;
    }

    console.log(
      `Evaluating provider source candidate ${PROVIDER_LABELS[mapping.provider] || mapping.provider} for ${entry.title}: ${mapping.providerTitle || mapping.providerId}.`,
    );

    let info;
    try {
      info = await provider.fetchInfo(mapping.providerId);
    } catch (error) {
      console.error(`Failed provider source info for ${entry.title} via ${mapping.provider}: ${error.message}`);
      continue;
    }

    const chapterCount = Array.isArray(info?.chapters) ? info.chapters.length : 0;
    if (chapterCount <= 0) {
      continue;
    }

    console.log(
      `Provider source candidate ready for ${entry.title}: ${PROVIDER_LABELS[mapping.provider] || mapping.provider} -> "${mapping.providerTitle || mapping.providerId}" with ${chapterCount} chapter candidate(s).`,
    );

    providerEntries.push({
      mapping: {
        ...mapping,
        chapterCount,
      },
      provider,
      chapters: Array.isArray(info?.chapters) ? info.chapters : [],
    });
  }

  if (providerEntries.length === 0) {
    console.warn(`No usable provider-backed chapter source was found for ${entry.title}.`);
    return { chapters: [], mapping: null };
  }

  const merged = [];
  const existingMap = new Map();
  const chapterOptions = new Map();

  for (const providerEntry of providerEntries) {
    for (const chapter of providerEntry.chapters) {
      const chapterNumber = parseChapterNumber(chapter.chapter || chapter.chapterNumber || chapter.title);
      if (chapterNumber == null) {
        continue;
      }

      const tempChapter = {
        id: `${providerEntry.mapping.provider}:${chapter.id}`,
        title: String(chapter.title || '').trim(),
        chapter: String(chapterNumber),
        volume: chapter.volumeNumber != null ? String(chapter.volumeNumber) : '',
        language: 'en',
        pages: 0,
        publishedAt: chapter.releaseDate || chapter.releasedDate || null,
        externalUrl: null,
        scanlationGroup: PROVIDER_LABELS[providerEntry.mapping.provider] || providerEntry.mapping.provider,
        sourceType: 'fallback_reader',
      };
      const key = _chapterKey(tempChapter);
      if (!chapterOptions.has(key)) {
        chapterOptions.set(key, []);
      }
      chapterOptions.get(key).push({
        providerEntry,
        chapter,
      });
    }
  }

  console.log(
    `Preparing provider-backed chapter pages for ${entry.title}: ${chapterOptions.size} chapter candidate(s), ${providerEntries.length} provider candidate(s).`,
  );
  console.log(
    `Provider source order for ${entry.title}: ${providerEntries
      .map((item) => `${PROVIDER_LABELS[item.mapping.provider] || item.mapping.provider}("${item.mapping.providerTitle || item.mapping.providerId}")`)
      .join(' -> ')}.`,
  );

  let addedCount = 0;
  let processedCount = 0;
  const providerSuccessCounts = new Map();
  const providerFailureCounts = new Map();
  const blockedProviders = new Set();

  for (const [key, options] of chapterOptions.entries()) {
    processedCount += 1;
    if (
      processedCount === 1 ||
      processedCount === chapterOptions.size ||
      processedCount % FALLBACK_PROGRESS_EVERY === 0
    ) {
      console.log(
        `Provider source progress for ${entry.title}: ${processedCount}/${chapterOptions.size} chapter(s) checked, ${addedCount} readable chapter(s) added so far.`,
      );
    }

    let resolved = false;
    for (const { providerEntry, chapter } of options) {
      const providerKey = providerEntry.mapping.provider;
      if (blockedProviders.has(providerKey)) {
        continue;
      }
      const failureCount = providerFailureCounts.get(providerKey) || 0;
      const successCount = providerSuccessCounts.get(providerKey) || 0;
      if (failureCount >= FALLBACK_PROVIDER_FAILURE_LIMIT && successCount === 0) {
        continue;
      }

      try {
        const chapterNumber = parseChapterNumber(chapter.chapter || chapter.chapterNumber || chapter.title);
        console.log(
          `Trying provider source ${PROVIDER_LABELS[providerKey] || providerKey} for ${entry.title} chapter ${chapterNumber ?? '?' } (${chapter.id}).`,
        );
        const pages = await fetchFallbackPagesWithRetry(providerEntry.provider, chapter.id);
        const pageUrls = Array.isArray(pages)
          ? pages.map((page) => page?.img).filter(Boolean).map((url) => String(url))
          : [];
        if (pageUrls.length === 0) {
          providerFailureCounts.set(providerKey, failureCount + 1);
          continue;
        }

        const normalized = normalizeProviderChapter(providerKey, chapter, pageUrls);
        const existing = existingMap.get(key);
        if (existing) {
          const index = merged.findIndex((item) => _chapterKey(item) === key);
          if (index >= 0 && scoreChapterVariant(normalized) > scoreChapterVariant(merged[index])) {
            merged[index] = normalized;
          }
        } else {
          merged.push(normalized);
        }
        existingMap.set(key, normalized);
        providerSuccessCounts.set(providerKey, successCount + 1);
        addedCount += 1;
        console.log(
          `Accepted provider source ${PROVIDER_LABELS[providerKey] || providerKey} for ${entry.title} chapter ${normalized.chapter || '?'} with ${pageUrls.length} page(s).`,
        );
        resolved = true;
        break;
      } catch (error) {
        providerFailureCounts.set(providerKey, failureCount + 1);
        if (isProviderBlockedError(error)) {
          blockedProviders.add(providerKey);
          console.error(`Blocked provider source ${providerKey} for ${entry.title}: ${error.message}`);
          continue;
        }
        const chapterNumber = parseChapterNumber(chapter.chapter || chapter.chapterNumber || chapter.title);
        console.error(
          `Failed provider source pages for ${entry.title} ch ${chapterNumber} via ${providerKey}: ${error.message}`,
        );
      }
    }

    if (!resolved) {
      const chapterNumber = key.split('|')[1];
      console.warn(`All provider sources failed for ${entry.title} ch ${chapterNumber}. Skipping.`);
    }

    await delay(FALLBACK_DELAY_MS);
  }

  if (addedCount > 0) {
    const [bestProviderKey] = Array.from(providerSuccessCounts.entries())
      .sort((a, b) => b[1] - a[1])[0] || [];
    const bestProviderEntry = providerEntries.find((item) => item.mapping.provider === bestProviderKey) || providerEntries[0];
    const finalMapping = {
      chapterIndexId: entry.chapterIndexId,
      title: entry.title,
      mangaId: entry.mangaId,
      anilistId: entry.anilistId,
      ...bestProviderEntry.mapping,
    };
    fallbackMappingMap.set(entry.chapterIndexId, finalMapping);
    writeFallbackMappingMap(fallbackMappingMap);
    console.log(`Added ${addedCount} provider-backed English chapters for ${entry.title}.`);
    console.log(
      `Provider source stats for ${entry.title}: ${formatProviderStats(providerSuccessCounts, providerFailureCounts)}.`,
    );
    return {
      chapters: dedupeChapters(merged),
      mapping: finalMapping,
    };
  }

  console.warn(
    `No readable provider-backed chapters were added for ${entry.title}. Provider stats: ${formatProviderStats(providerSuccessCounts, providerFailureCounts)}.`,
  );
  return { chapters: [], mapping: null };
}

async function fetchMangaChapters() {
  console.log('========================================');
  console.log('BUILDING: Manga Chapter Index');
  console.log('========================================');

  const forceFullRefresh = isForceFullRefresh();
  const targetMangaIds = getTargetMangaIds();

  const rawCatalogEntries = getCatalogEntries()
    .filter((item) => item && (item.mangadexId || (item.chapterSourceProvider && item.chapterSourceId)))
    .map((item) => ({
      mangaId: item.mangaId,
      anilistId: item.anilistId || item.mangaId,
      title: item.title || '',
      mangadexId: item.mangadexId || null,
      chapterIndexId: buildChapterIndexId(item),
      chapterSourceProvider: item.chapterSourceProvider || '',
      chapterSourceId: item.chapterSourceId || '',
      chapterSourceTitle: item.chapterSourceTitle || '',
      chapterSourceChapterCount: Number(item.chapterSourceChapterCount || 0),
      chapterSourceConfidence: Number(item.chapterSourceConfidence || 0),
      chapterSourceUpdatedAt: item.chapterSourceUpdatedAt || null,
      status: item.status || '',
      popularity: Number(item.popularity || 0),
      chapters: Number(item.chapters || 0),
      titleEnglish: item.titleEnglish || '',
      titleRomaji: item.titleRomaji || '',
      synonyms: Array.isArray(item.synonyms) ? item.synonyms : [],
    }))
    .filter((item) => Boolean(item.chapterIndexId));

  const allUniqueEntries = Array.from(
    new Map(rawCatalogEntries.map((item) => [item.chapterIndexId, item])).values(),
  );

  const catalogEntries = targetMangaIds.size > 0
    ? rawCatalogEntries.filter((item) =>
        targetMangaIds.has(String(item.chapterIndexId)) ||
        targetMangaIds.has(String(item.mangadexId || '')) ||
        targetMangaIds.has(String(item.mangaId)) ||
        targetMangaIds.has(String(item.anilistId)),
      )
    : rawCatalogEntries;

  const uniqueEntries = Array.from(
    new Map(catalogEntries.map((item) => [item.chapterIndexId, item])).values(),
  );
  const existingManifestMap = getManifestMap();
  const fallbackMappingMap = getFallbackMappingMap();
  const refreshPlan = buildRefreshPlan(uniqueEntries, existingManifestMap, forceFullRefresh);
  const untouchedManifestItems = targetMangaIds.size > 0
    ? Array.from(existingManifestMap.values()).filter((item) =>
        !targetMangaIds.has(String(item.chapterIndexId || '')) &&
        !targetMangaIds.has(String(item.mangadexId || '')) &&
        !targetMangaIds.has(String(item.mangaId)) &&
        !targetMangaIds.has(String(item.anilistId)),
      )
    : [];

  const manifest = {
    generatedAt: new Date().toISOString(),
    totalTitles: allUniqueEntries.length,
    items: [...untouchedManifestItems],
  };

  console.log(
    `Manga chapter refresh plan -> new releasing: ${refreshPlan.newReleasingCount}, new library: ${refreshPlan.newLibraryCount}, stale releasing: ${refreshPlan.staleReleasingCount}, stale library: ${refreshPlan.staleLibraryCount}, skipped: ${refreshPlan.skippedCount}, forceFull: ${forceFullRefresh}, targeted: ${targetMangaIds.size}`,
  );

  for (const entry of uniqueEntries) {
    if (!refreshPlan.refreshSet.has(entry.chapterIndexId)) {
      const existing = existingManifestMap.get(entry.chapterIndexId);
      if (existing) {
        manifest.items.push({
          ...existing,
          chapterIndexId: entry.chapterIndexId,
          mangaId: entry.mangaId,
          anilistId: entry.anilistId,
          title: entry.title,
          mangadexId: entry.mangadexId,
        });
      }
      continue;
    }

    console.log(`Refreshing chapters for ${entry.title} (${entry.chapterIndexId})`);
    const languages = {};
    let englishFallbackMapping = null;
    const existingChapterIndex = getExistingChapterIndex(entry.chapterIndexId);
    const previousLanguages =
      existingChapterIndex && typeof existingChapterIndex.languages === 'object'
        ? existingChapterIndex.languages
        : {};

    for (const language of CHAPTER_LANGUAGES) {
      try {
        let chapters = [];
        if (entry.mangadexId) {
          chapters = await fetchLanguageChapters(entry.mangadexId, language);
          const previousEnglish = Array.isArray(previousLanguages.en)
            ? previousLanguages.en
                .filter((item) => item && typeof item === 'object')
                .map(normalizeStoredChapter)
            : [];
          if (language === 'en') {
            console.log(
              `Fetched ${chapters.length} raw ${language.toUpperCase()} chapter(s) from MangaDex for ${entry.title}.`,
            );
            console.log(
              `Existing cached EN chapters for ${entry.title}: ${previousEnglish.length}. Catalog chapter target: ${entry.chapters || 0}.`,
            );
            const fallback = await buildEnglishFallbackChapters(
              entry,
              chapters,
              previousEnglish,
              fallbackMappingMap,
            );
            chapters = fallback.chapters;
            englishFallbackMapping = fallback.mapping;
          }
        } else if (language === 'en') {
          const fallback = await buildProviderOnlyEnglishChapters(entry, fallbackMappingMap);
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
    if (availableLanguages.length === 0) {
      console.warn(`No readable chapter coverage was produced for ${entry.title}. Skipping chapter index write.`);
      const existing = existingManifestMap.get(entry.chapterIndexId);
      if (existing) {
        manifest.items.push({
          ...existing,
          chapterIndexId: entry.chapterIndexId,
          mangaId: entry.mangaId,
          anilistId: entry.anilistId,
          mangadexId: entry.mangadexId,
          title: entry.title,
        });
      }
      continue;
    }

    const chapterIndex = {
      chapterIndexId: entry.chapterIndexId,
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
      chapterSourceProvider: entry.chapterSourceProvider || englishFallbackMapping?.provider || null,
      chapterSourceId: entry.chapterSourceId || englishFallbackMapping?.providerId || null,
      chapterSourceTitle: entry.chapterSourceTitle || englishFallbackMapping?.providerTitle || null,
      englishFallbackProvider: englishFallbackMapping?.provider || null,
      englishFallbackProviderTitle: englishFallbackMapping?.providerTitle || null,
      englishFallbackChapterCount: englishFallbackMapping?.chapterCount || null,
    };

    console.log(
      `Final chapter coverage for ${entry.title}: ${availableLanguages
        .map((language) => `${language.toUpperCase()}=${chapterIndex.counts[language] || 0}`)
        .join(', ')}${chapterIndex.englishFallbackProvider ? ` | EN fallback=${chapterIndex.englishFallbackProvider}` : ''}.`,
    );

    writeJsonIfChanged(`${CONFIG.API_PATHS.MANGA_CHAPTERS}/${entry.chapterIndexId}`, chapterIndex);
    manifest.items.push({
      chapterIndexId: entry.chapterIndexId,
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

  manifest.items.sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
  writeJsonIfChanged(`${CONFIG.API_PATHS.MANGA_CHAPTERS}/manifest`, manifest);
  writeFallbackMappingMap(fallbackMappingMap);
  const fullCatalogEntries = getMangaCatalogEntries();
  const newChapterItems = writeNewChaptersSection(fullCatalogEntries, manifest, DEFAULT_SECTION_LIMIT);
  console.log(`Manga new chapters section refreshed with ${newChapterItems.length} titles.`);
  console.log(`Saved chapter indexes for ${manifest.items.length} manga titles.`);
}

function normalizeStoredChapter(item) {
  return {
    id: String(item.id || ''),
    title: String(item.title || ''),
    chapter: String(item.chapter || ''),
    volume: String(item.volume || ''),
    language: String(item.language || ''),
    pages: Number(item.pages || 0),
    pageUrls: Array.isArray(item.pageUrls) ? item.pageUrls.map((url) => String(url)) : [],
    imageHeaders: item.imageHeaders || {},
    publishedAt: item.publishedAt || null,
    externalUrl: item.externalUrl || null,
    scanlationGroup: String(item.scanlationGroup || ''),
    sourceType: String(item.sourceType || 'reader'),
    provider: item.provider || '',
    providerChapterId: item.providerChapterId || '',
  };
}

module.exports = fetchMangaChapters;
