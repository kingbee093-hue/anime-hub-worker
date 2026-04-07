const axios = require('axios');
const CONFIG = require('../config/constants');
const { fetchGraphQL } = require('../utils/fetchHelper');
const { GENERIC_MANGA_QUERY } = require('../utils/anilistQueries');
const {
  convertMangaToFirestoreFormat,
  delay,
} = require('../utils/formatters');
const { isAdultContent, isManga } = require('../utils/filters');
const { writeJsonIfChanged } = require('../utils/writeJsonIfChanged');
const { discoverProviderTitlesForManga } = require('../utils/mangaFallbackProviders');
const {
  writeNewChaptersSection,
  writeReleasingSection,
  DEFAULT_SECTION_LIMIT,
} = require('../utils/mangaSections');

const MANGADEX_API = 'https://api.mangadex.org';
const CATALOG_PAGE_SIZE = 120;
const CATALOG_MAX_ITEMS = 2200;
const GENRE_MAX_ITEMS = 120;
const SECTION_ITEMS = 24;
const MANGADEX_DELAY_MS = 250;
const MANGADEX_MAPPING_ATTEMPTS_PER_RUN = Number(process.env.MANGADEX_MAPPING_ATTEMPTS_PER_RUN || 220);
const MANGADEX_MAPPING_PROVIDER_TITLE_LIMIT = Number(process.env.MANGADEX_MAPPING_PROVIDER_TITLE_LIMIT || 6);

const MANGA_CATALOG_SOURCES = [
  {
    label: 'featured',
    sectionPath: CONFIG.API_PATHS.MANGA_FEATURED,
    limit: 12,
    pages: 10,
    variables: {
      perPage: 35,
      sort: ['FAVOURITES_DESC', 'POPULARITY_DESC'],
    },
  },
  {
    label: 'popular',
    sectionPath: CONFIG.API_PATHS.MANGA_POPULAR,
    limit: SECTION_ITEMS,
    pages: 20,
    variables: {
      perPage: 35,
      sort: ['POPULARITY_DESC'],
    },
  },
  {
    label: 'top-rated',
    sectionPath: CONFIG.API_PATHS.MANGA_TOP_RATED,
    limit: SECTION_ITEMS,
    pages: 12,
    variables: {
      perPage: 35,
      sort: ['SCORE_DESC', 'POPULARITY_DESC'],
    },
  },
  {
    label: 'trending',
    sectionPath: CONFIG.API_PATHS.MANGA_TRENDING,
    limit: SECTION_ITEMS,
    pages: 10,
    variables: {
      perPage: 35,
      sort: ['TRENDING_DESC', 'POPULARITY_DESC'],
    },
  },
  {
    label: 'releasing',
    sectionPath: CONFIG.API_PATHS.MANGA_RELEASING,
    limit: SECTION_ITEMS,
    pages: 8,
    variables: {
      perPage: 35,
      status: 'RELEASING',
      sort: ['POPULARITY_DESC'],
    },
  },
];

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF\u3040-\u30ff\u3400-\u9fff\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getSearchShardKey(term) {
  const normalized = normalizeSearchText(term);
  if (!normalized) return 'other';
  const firstChar = normalized[0];
  if (/[a-z]/.test(firstChar)) return firstChar;
  if (/[0-9]/.test(firstChar)) return '0-9';
  if (/[\u0600-\u06FF]/.test(firstChar)) return 'arabic';
  return 'other';
}

function addToShard(shards, shardKey, item) {
  if (!shards.has(shardKey)) {
    shards.set(shardKey, new Map());
  }
  shards.get(shardKey).set(item.mangaId, item);
}

function computeRichnessScore(manga) {
  let score = 0;
  if (manga.synopsis) score += Math.min(manga.synopsis.length, 600);
  if (manga.bannerImage) score += 100;
  if (manga.imageUrl) score += 50;
  if (Array.isArray(manga.genres)) score += manga.genres.length * 10;
  if (Array.isArray(manga.synonyms)) score += manga.synonyms.length * 5;
  if (Array.isArray(manga.authors)) score += manga.authors.length * 4;
  if (Array.isArray(manga.artists)) score += manga.artists.length * 4;
  score += Number(manga.popularity || 0) / 1000;
  score += Number(manga.averageScore || 0);
  return score;
}

function mergeManga(existing, incoming) {
  if (!existing) return incoming;

  const merged = {
    ...existing,
    ...incoming,
    genres: Array.from(new Set([...(existing.genres || []), ...(incoming.genres || [])])),
    synonyms: Array.from(new Set([...(existing.synonyms || []), ...(incoming.synonyms || [])])),
    authors: Array.from(new Set([...(existing.authors || []), ...(incoming.authors || [])])),
    artists: Array.from(new Set([...(existing.artists || []), ...(incoming.artists || [])])),
    externalLinks: _mergeExternalLinks(existing.externalLinks || [], incoming.externalLinks || []),
  };

  return computeRichnessScore(incoming) > computeRichnessScore(existing)
    ? merged
    : {
        ...merged,
        synopsis: existing.synopsis || merged.synopsis,
        bannerImage: existing.bannerImage || merged.bannerImage,
        imageUrl: existing.imageUrl || merged.imageUrl,
      };
}

function _mergeExternalLinks(existing, incoming) {
  const deduped = new Map();
  for (const link of [...existing, ...incoming]) {
    const key = `${link.site}|${link.url}`;
    deduped.set(key, link);
  }
  return Array.from(deduped.values());
}

function sortCatalog(items) {
  return items.sort((a, b) => {
    const popularityDelta = Number(b.popularity || 0) - Number(a.popularity || 0);
    if (popularityDelta !== 0) return popularityDelta;

    const scoreDelta = Number(b.averageScore || 0) - Number(a.averageScore || 0);
    if (scoreDelta !== 0) return scoreDelta;

    return String(a.title || '').localeCompare(String(b.title || ''));
  });
}

function buildSearchIndexItem(manga, detailPage) {
  return {
    mangaId: manga.mangaId,
    anilistId: manga.anilistId || manga.mangaId,
    idMal: manga.idMal || null,
    title: manga.title || '',
    titleEnglish: manga.titleEnglish || '',
    titleRomaji: manga.titleRomaji || '',
    titleNative: manga.titleNative || '',
    imageUrl: manga.imageUrl || manga.coverImageLarge || manga.coverImageMedium || '',
    synopsis: (manga.synopsis || '').substring(0, 260),
    genres: manga.genres || [],
    authors: manga.authors || [],
    artists: manga.artists || [],
    popularity: manga.popularity || 0,
    averageScore: manga.averageScore || 0,
    chapters: manga.chapters || 0,
    volumes: manga.volumes || 0,
    year: manga.year || null,
    format: manga.format || manga.type || '',
    status: manga.status || '',
    mangadexId: manga.mangadexId || null,
    detailPage,
    searchTerms: Array.from(
      new Set(
        [
          manga.title,
          manga.titleEnglish,
          manga.titleRomaji,
          manga.titleNative,
          ...(manga.synonyms || []),
          ...(manga.genres || []),
          ...(manga.authors || []),
          ...(manga.artists || []),
        ]
          .filter(Boolean)
          .map((value) => String(value).trim()),
      ),
    ),
  };
}

function getCandidateTitles(manga) {
  const titles = [
    manga.titleEnglish,
    manga.title,
    manga.titleRomaji,
    manga.titleNative,
    ...(manga.synonyms || []),
  ]
    .filter(Boolean)
    .map((value) => String(value).trim())
    .filter((value) => value.length >= 2);

  return Array.from(new Set(titles)).slice(0, 6);
}

function buildTitleVariants(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];

  const variants = new Set([raw]);
  const separators = [':', ' - ', ' — ', ' – ', '(', '[', '/'];

  for (const separator of separators) {
    if (!raw.includes(separator)) continue;
    const parts = raw.split(separator).map((item) => item.trim()).filter(Boolean);
    for (const part of parts) {
      if (part.length >= 2) {
        variants.add(part.replace(/[)\]]+$/g, '').trim());
      }
    }
  }

  variants.add(raw.replace(/[:\-–—/()[\]]/g, ' ').replace(/\s+/g, ' ').trim());
  variants.add(raw.replace(/\bpart\s+\d+\b/gi, '').replace(/\s+/g, ' ').trim());

  return Array.from(variants)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
}

function buildMappingQueryPlans(manga, providerDiscoveredTitles = []) {
  const nativeTitles = getCandidateTitles(manga)
    .flatMap((title) => buildTitleVariants(title));
  const providerTitles = providerDiscoveredTitles
    .flatMap((item) => buildTitleVariants(item.title));

  const allNativeTitles = Array.from(new Set(nativeTitles));
  const allProviderTitles = Array.from(new Set(providerTitles))
    .filter((title) => !allNativeTitles.includes(title))
    .slice(0, MANGADEX_MAPPING_PROVIDER_TITLE_LIMIT);

  const plans = [];
  const seen = new Set();

  function pushPlan(strategy, title, year = null) {
    const key = `${strategy}|${title}|${year || ''}`;
    if (!title || seen.has(key)) return;
    seen.add(key);
    plans.push({ strategy, title, year });
  }

  for (const title of allNativeTitles) {
    pushPlan('title+year', title, manga.year || null);
  }
  for (const title of allProviderTitles) {
    pushPlan('provider-title+year', title, manga.year || null);
  }
  for (const title of allNativeTitles) {
    pushPlan('title', title, null);
  }
  for (const title of allProviderTitles) {
    pushPlan('provider-title', title, null);
  }

  return plans;
}

function extractMangaDexIdFromUrl(url) {
  const match = String(url || '').match(/mangadex\.org\/title\/([0-9a-f-]{36})/i);
  return match ? match[1] : null;
}

function getAniListLinkedMangaDexId(manga) {
  for (const link of manga.externalLinks || []) {
    const directId = extractMangaDexIdFromUrl(link.url);
    if (directId) return directId;
  }
  return null;
}

async function fetchMangaDexCandidates(title, year) {
  const response = await axios.get(`${MANGADEX_API}/manga`, {
    params: {
      title,
      limit: 5,
      year: year || undefined,
      includes: ['author', 'artist'],
    },
    timeout: 25000,
  });

  return Array.isArray(response.data?.data) ? response.data.data : [];
}

function candidateTitles(candidate) {
  const attributes = candidate?.attributes || {};
  const altTitles = Array.isArray(attributes.altTitles) ? attributes.altTitles : [];
  const flattenedAltTitles = altTitles.flatMap((entry) => Object.values(entry || {}));
  return Array.from(
    new Set([
      ...Object.values(attributes.title || {}),
      ...flattenedAltTitles,
    ]
      .filter(Boolean)
      .map((value) => normalizeSearchText(value))),
  );
}

function scoreMangaDexCandidate(candidate, manga) {
  const links = candidate?.attributes?.links || {};
  const aniListId = String(manga.anilistId || manga.mangaId);
  const malId = manga.idMal != null ? String(manga.idMal) : null;

  if (links.al && String(links.al) === aniListId) {
    return { matched: true, source: 'al', confidence: 1.0, score: 1.0 };
  }

  if (malId && links.mal && String(links.mal) === malId) {
    return { matched: true, source: 'mal', confidence: 0.98, score: 0.98 };
  }

  const directId = getAniListLinkedMangaDexId(manga);
  if (directId && candidate?.id === directId) {
    return { matched: true, source: 'anilist_external', confidence: 0.99, score: 0.99 };
  }

  const titles = candidateTitles(candidate);
  const queryTitles = getCandidateTitles(manga).map(normalizeSearchText);
  let score = 0;

  for (const queryTitle of queryTitles) {
    if (!queryTitle) continue;
    if (titles.includes(queryTitle)) {
      score = Math.max(score, 0.94);
      continue;
    }

    for (const title of titles) {
      if (!title) continue;
      if (title.includes(queryTitle) || queryTitle.includes(title)) {
        score = Math.max(score, 0.82);
      } else {
        const queryTokens = new Set(queryTitle.split(' ').filter(Boolean));
        const titleTokens = new Set(title.split(' ').filter(Boolean));
        const overlap = Array.from(queryTokens).filter((token) => titleTokens.has(token)).length;
        const union = new Set([...queryTokens, ...titleTokens]).size;
        if (union > 0) {
          score = Math.max(score, overlap / union);
        }
      }
    }
  }

  const candidateYear = candidate?.attributes?.year;
  if (candidateYear && manga.year && candidateYear === manga.year) {
    score += 0.05;
  }

  return {
    matched: score >= 0.74,
    source: 'fuzzy',
    confidence: Math.min(Number(score.toFixed(2)), 0.95),
    score,
  };
}

function mappingPriorityScore(manga) {
  const format = String(manga.format || '').toUpperCase();
  let bonus = 0;
  if (format === 'MANGA') bonus += 1000000;
  else if (format === 'ONE_SHOT') bonus += 600000;
  else if (format === 'NOVEL') bonus -= 250000;

  bonus += Number(manga.popularity || 0) * 10;
  bonus += Number(manga.averageScore || 0);
  bonus += Number(manga.year || 0) / 1000;
  return bonus;
}

async function resolveMangaDexMapping(manga, existingCache, stats = null) {
  const cached = existingCache[String(manga.anilistId || manga.mangaId)];
  if (cached?.mangadexId) {
    if (stats) stats.cachedHits += 1;
    console.log(`Mapping cache hit for "${manga.title}" -> ${cached.mangadexId} (${cached.source || 'cached'}).`);
    return cached;
  }

  const anilistLinkedId = getAniListLinkedMangaDexId(manga);
  if (anilistLinkedId) {
    if (stats) stats.directExternalHits += 1;
    console.log(`Mapping direct AniList external hit for "${manga.title}" -> ${anilistLinkedId}.`);
    return {
      mangadexId: anilistLinkedId,
      source: 'anilist_external',
      confidence: 0.99,
      matchedAt: new Date().toISOString(),
      title: manga.title,
      anilistId: manga.anilistId || manga.mangaId,
      idMal: manga.idMal || null,
    };
  }

  let providerDiscoveredTitles = [];
  try {
    providerDiscoveredTitles = await discoverProviderTitlesForManga(
      manga,
      MANGADEX_MAPPING_PROVIDER_TITLE_LIMIT,
    );
  } catch (error) {
    console.warn(`Provider-assisted title discovery failed for "${manga.title}": ${error.message}`);
  }

  if (providerDiscoveredTitles.length > 0) {
    console.log(
      `Provider-assisted titles for "${manga.title}": ${providerDiscoveredTitles
        .map((item) => `${item.title} [${item.provider}]`)
        .join(' | ')}.`,
    );
  }

  const queryPlans = buildMappingQueryPlans(manga, providerDiscoveredTitles);
  let bestMatch = null;

  for (const plan of queryPlans) {
    try {
      console.log(
        `Mapping search for "${manga.title}" via ${plan.strategy}: "${plan.title}"${plan.year ? ` (${plan.year})` : ''}.`,
      );
      const candidates = await fetchMangaDexCandidates(plan.title, plan.year);
      console.log(
        `Mapping candidate count for "${manga.title}" via ${plan.strategy}: ${candidates.length}.`,
      );
      for (const candidate of candidates) {
        const result = scoreMangaDexCandidate(candidate, manga);
        if (!result.matched) continue;

        const resolved = {
          mangadexId: candidate.id,
          source: result.source,
          confidence: result.confidence,
          matchedAt: new Date().toISOString(),
          title: manga.title,
          anilistId: manga.anilistId || manga.mangaId,
          idMal: manga.idMal || null,
          mangadexUrl: `https://mangadex.org/title/${candidate.id}`,
        };

        console.log(
          `Mapping matched for "${manga.title}" -> ${candidate.id} via ${plan.strategy}/${result.source} (${result.confidence}).`,
        );

        if (result.source !== 'fuzzy') {
          if (stats) {
            if (result.source === 'al') stats.alHits += 1;
            else if (result.source === 'mal') stats.malHits += 1;
            else stats.otherDirectHits += 1;
          }
          return resolved;
        }

        if (!bestMatch || Number(result.confidence || 0) > Number(bestMatch.confidence || 0)) {
          bestMatch = resolved;
        }
      }
    } catch (error) {
      console.error(`MangaDex mapping failed for "${manga.title}" via ${plan.strategy} ("${plan.title}"): ${error.message}`);
    }

    await delay(MANGADEX_DELAY_MS);
  }

  if (bestMatch?.mangadexId) {
    if (stats) stats.fuzzyHits += 1;
    console.log(
      `Mapping accepted best fuzzy match for "${manga.title}" -> ${bestMatch.mangadexId} (${bestMatch.confidence}).`,
    );
    return bestMatch;
  }

  if (stats) stats.unmapped += 1;
  console.warn(`Mapping unresolved for "${manga.title}".`);
  return null;
}

function attachMapping(manga, mapping) {
  if (!mapping?.mangadexId) return manga;
  return {
    ...manga,
    mangadexId: mapping.mangadexId,
    mangadexUrl: mapping.mangadexUrl || `https://mangadex.org/title/${mapping.mangadexId}`,
    mangadexMappingSource: mapping.source || '',
    mangadexMappingConfidence: mapping.confidence || 0,
  };
}

function readObjectJson(relativePath) {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require(`../../api/${relativePath}.json`);
  } catch (_) {
    return {};
  }
}

async function fetchMangaCatalog() {
  console.log('========================================');
  console.log('BUILDING: Manga Catalog');
  console.log('========================================');

  const deduped = new Map();
  const sectionBuckets = new Map();

  for (const source of MANGA_CATALOG_SOURCES) {
    console.log(`Collecting manga source: ${source.label}`);
    const sourceItems = new Map();

    for (let page = 1; page <= source.pages; page++) {
      const data = await fetchGraphQL(GENERIC_MANGA_QUERY, {
        page,
        ...source.variables,
      });

      if (!data || !data.Page) {
        console.error(`Failed to fetch manga source ${source.label} page ${page}`);
        continue;
      }

      for (const media of data.Page.media || []) {
        if (!media || !media.id) continue;
        if (isAdultContent(media).blocked || !isManga(media).allowed) continue;

        const formatted = convertMangaToFirestoreFormat(media);
        if (!formatted) continue;

        deduped.set(
          formatted.mangaId,
          mergeManga(deduped.get(formatted.mangaId), formatted),
        );
        sourceItems.set(
          formatted.mangaId,
          mergeManga(sourceItems.get(formatted.mangaId), formatted),
        );
      }

      await delay(CONFIG.RATE_LIMIT_DELAY);
    }

    sectionBuckets.set(
      source.label,
      sortCatalog(Array.from(sourceItems.values())).slice(0, source.limit || SECTION_ITEMS),
    );
  }

  let catalog = sortCatalog(Array.from(deduped.values())).slice(0, CATALOG_MAX_ITEMS);
  const mappingCache = readObjectJson(CONFIG.API_PATHS.MANGA_MAPPING);
  const nextMappingCache = { ...mappingCache };
  let mappingAttempts = 0;
  const mappingStats = {
    cachedHits: 0,
    directExternalHits: 0,
    alHits: 0,
    malHits: 0,
    otherDirectHits: 0,
    fuzzyHits: 0,
    unmapped: 0,
  };

  const prioritizedIndexes = catalog
    .map((manga, index) => ({ manga, index }))
    .sort((a, b) => mappingPriorityScore(b.manga) - mappingPriorityScore(a.manga));

  for (const { manga, index } of prioritizedIndexes) {
    const cachedMapping = nextMappingCache[String(manga.anilistId || manga.mangaId)];
    if (cachedMapping?.mangadexId) {
      mappingStats.cachedHits += 1;
      catalog[index] = attachMapping(manga, cachedMapping);
      continue;
    }

    if (mappingAttempts >= MANGADEX_MAPPING_ATTEMPTS_PER_RUN) {
      continue;
    }

    console.log(
      `Mapping attempt ${mappingAttempts + 1}/${MANGADEX_MAPPING_ATTEMPTS_PER_RUN} for "${manga.title}" (${manga.format || 'UNKNOWN'}, pop=${manga.popularity || 0}, year=${manga.year || 0}).`,
    );
    const resolved = await resolveMangaDexMapping(manga, nextMappingCache, mappingStats);
    mappingAttempts += 1;
    if (resolved?.mangadexId) {
      nextMappingCache[String(manga.anilistId || manga.mangaId)] = resolved;
      catalog[index] = attachMapping(manga, resolved);
    }
  }

  const totalPages = Math.max(1, Math.ceil(catalog.length / CATALOG_PAGE_SIZE));
  const lookup = {};
  const genreBuckets = new Map();
  const searchIndex = [];
  const searchShards = new Map();

  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
    const start = (pageNumber - 1) * CATALOG_PAGE_SIZE;
    const pageItems = catalog.slice(start, start + CATALOG_PAGE_SIZE);

    for (const item of pageItems) {
      lookup[String(item.mangaId)] = pageNumber;
      const searchItem = buildSearchIndexItem(item, pageNumber);
      searchIndex.push(searchItem);

      const shardTerms = new Set([
        searchItem.title,
        searchItem.titleEnglish,
        searchItem.titleRomaji,
        searchItem.titleNative,
        ...((item.synonyms || []).slice(0, 8)),
      ]);
      for (const term of shardTerms) {
        addToShard(searchShards, getSearchShardKey(term), searchItem);
      }

      for (const genre of item.genres || []) {
        if (!genreBuckets.has(genre)) {
          genreBuckets.set(genre, []);
        }
        genreBuckets.get(genre).push(item);
      }
    }

    writeJsonIfChanged(`${CONFIG.API_PATHS.MANGA_CATALOG}/manga_page_${pageNumber}`, pageItems);
  }

  writeJsonIfChanged(`${CONFIG.API_PATHS.MANGA_CATALOG}/manga_lookup`, lookup);
  writeJsonIfChanged(CONFIG.API_PATHS.MANGA_MAPPING, nextMappingCache);

  for (const [genre, items] of genreBuckets.entries()) {
    const sortedItems = sortCatalog(
      Array.from(new Map(items.map((item) => [item.mangaId, item])).values()),
    ).slice(0, GENRE_MAX_ITEMS);
    writeJsonIfChanged(`${CONFIG.API_PATHS.MANGA_BY_GENRE}/${genre}`, sortedItems);
  }

  for (const source of MANGA_CATALOG_SOURCES) {
    const items = (sectionBuckets.get(source.label) || [])
      .map((item) => attachMapping(item, nextMappingCache[String(item.anilistId || item.mangaId)]))
      .slice(0, source.limit || SECTION_ITEMS);

    if (source.sectionPath) {
      writeJsonIfChanged(source.sectionPath, items);
    }
  }

  const searchManifest = {
    generatedAt: new Date().toISOString(),
    totalItems: searchIndex.length,
    shards: {},
  };

  for (const [shardKey, itemsMap] of searchShards.entries()) {
    const shardItems = sortCatalog(Array.from(itemsMap.values()));
    searchManifest.shards[shardKey] = {
      count: shardItems.length,
      path: `${CONFIG.API_PATHS.MANGA_SEARCH_INDEX}/shards/${shardKey}.json`,
    };
    writeJsonIfChanged(
      `${CONFIG.API_PATHS.MANGA_SEARCH_INDEX}/shards/${shardKey}`,
      shardItems,
    );
  }

  writeJsonIfChanged(`${CONFIG.API_PATHS.MANGA_SEARCH_INDEX}/manifest`, searchManifest);
  writeJsonIfChanged(CONFIG.API_PATHS.MANGA_SEARCH_INDEX, searchIndex);
  const releasingItems = writeReleasingSection(catalog, SECTION_ITEMS);
  console.log(`Manga releasing section refreshed with ${releasingItems.length} titles.`);
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const existingChapterManifest = require(`../../api/${CONFIG.API_PATHS.MANGA_CHAPTERS}/manifest.json`);
    const newChapterItems = writeNewChaptersSection(catalog, existingChapterManifest, DEFAULT_SECTION_LIMIT);
    console.log(`Manga new chapters section refreshed with ${newChapterItems.length} titles.`);
  } catch (_) {
    writeNewChaptersSection(catalog, { items: [] }, DEFAULT_SECTION_LIMIT);
    console.log('Manga new chapters section refreshed with 0 titles (chapter manifest unavailable yet).');
  }
  console.log(`Manga catalog built with ${catalog.length} items across ${totalPages} pages.`);
  console.log(
    `Manga mapping summary -> attempts: ${mappingAttempts}, cache hits: ${mappingStats.cachedHits}, AniList direct: ${mappingStats.directExternalHits}, AL link: ${mappingStats.alHits}, MAL bridge: ${mappingStats.malHits}, other direct: ${mappingStats.otherDirectHits}, fuzzy: ${mappingStats.fuzzyHits}, unresolved: ${mappingStats.unmapped}.`,
  );
}

module.exports = fetchMangaCatalog;
