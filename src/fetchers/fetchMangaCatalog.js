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
const {
  discoverProviderTitlesForManga,
  resolveFallbackProviderCandidates,
  validateProviderSourceMapping,
} = require('../utils/mangaFallbackProviders');
const {
  writeReleasingSection,
} = require('../utils/mangaSections');
const { buildChapterIndexId } = require('../utils/mangaBackfillData');
const manualMangaMappings = require('../config/manualMangaMappings.json');
const manualMangaSourceMappings = require('../config/manualMangaSourceMappings.json');

const MANGADEX_API = 'https://api.mangadex.org';
const CATALOG_PAGE_SIZE = 120;
const CATALOG_MAX_ITEMS = 100000;
const GENRE_MAX_ITEMS = 120;
const SECTION_ITEMS = 24;
const MANGADEX_DELAY_MS = 250;
const MANGADEX_MAPPING_ATTEMPTS_PER_RUN = Number(process.env.MANGADEX_MAPPING_ATTEMPTS_PER_RUN || 100);
const MANGADEX_MAPPING_PROVIDER_TITLE_LIMIT = Number(process.env.MANGADEX_MAPPING_PROVIDER_TITLE_LIMIT || 6);
const MANGADEX_MAPPING_MAX_QUERY_PLANS = Number(process.env.MANGADEX_MAPPING_MAX_QUERY_PLANS || 10);
const VERBOSE_MAPPING_LOGS = process.env.MANGA_VERBOSE_MAPPING_LOGS === '1';

const MANGA_CATALOG_SOURCES = [
  {
    label: 'featured',
    sectionPath: CONFIG.API_PATHS.MANGA_FEATURED,
    limit: 10,
    pages: 1,
    variables: {
      perPage: 35,
      sort: ['FAVOURITES_DESC', 'POPULARITY_DESC'],
    },
  },
  {
    label: 'popular',
    sectionPath: CONFIG.API_PATHS.MANGA_POPULAR,
    limit: 10,
    pages: 1,
    variables: {
      perPage: 35,
      sort: ['POPULARITY_DESC'],
    },
  },
  {
    label: 'top-rated',
    sectionPath: CONFIG.API_PATHS.MANGA_TOP_RATED,
    limit: 10,
    pages: 1,
    variables: {
      perPage: 35,
      sort: ['SCORE_DESC', 'POPULARITY_DESC'],
    },
  },
  {
    label: 'trending',
    sectionPath: CONFIG.API_PATHS.MANGA_TRENDING,
    limit: 10,
    pages: 1,
    variables: {
      perPage: 35,
      sort: ['TRENDING_DESC', 'POPULARITY_DESC'],
    },
  },
  {
    label: 'releasing',
    sectionPath: CONFIG.API_PATHS.MANGA_RELEASING,
    limit: 10,
    pages: 1,
    variables: {
      perPage: 35,
      status: 'RELEASING',
      sort: ['POPULARITY_DESC'],
    },
  },
  // --- GENRES ---
  ...[
    'Action', 'Romance', 'Fantasy', 'Comedy', 'Drama', 'Slice of Life',
    'Sci-Fi', 'Horror', 'Mystery', 'Adventure', 'Sports', 'Supernatural', 'Psychological'
  ].map(genre => ({
    label: `genre-${genre.toLowerCase().replace(/\s+/g, '-')}`,
    sectionPath: `${CONFIG.API_PATHS.MANGA_BY_GENRE}/${genre.toLowerCase().replace(/\s+/g, '-')}`,
    limit: SECTION_ITEMS,
    pages: 1,
    variables: {
      perPage: 35,
      genre: genre,
      sort: ['POPULARITY_DESC'],
    },
  })),
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
    const normalizedTitle = normalizeSearchText(title);
    const key = `${strategy}|${normalizedTitle}|${year || ''}`;
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

  return plans.slice(0, MANGADEX_MAPPING_MAX_QUERY_PLANS);
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

function canUseProviderSourceMapping(manga) {
  const format = String(manga?.format || '').toUpperCase();
  return format === 'MANGA' || format === 'ONE_SHOT';
}

function getManualMangaDexMapping(manga) {
  return manualMangaMappings[String(manga.anilistId || manga.mangaId)] || null;
}

function getManualChapterSourceMapping(manga) {
  return manualMangaSourceMappings[String(manga.anilistId || manga.mangaId)] || null;
}

async function resolveMangaDexMapping(manga, existingCache, stats = null) {
  const cached = existingCache[String(manga.anilistId || manga.mangaId)];
  if (cached?.mangadexId) {
    if (stats) stats.cachedHits += 1;
    console.log(`Mapping cache hit: "${manga.title}" -> ${cached.mangadexId} (${cached.source || 'cached'}).`);
    return cached;
  }

  const manualMapping = getManualMangaDexMapping(manga);
  if (manualMapping?.mangadexId) {
    if (stats) stats.manualHits += 1;
    console.log(`Mapping success: "${manga.title}" -> ${manualMapping.mangadexId} via manual override.`);
    return {
      ...manualMapping,
      matchedAt: manualMapping.matchedAt || new Date().toISOString(),
      title: manga.title,
      anilistId: manga.anilistId || manga.mangaId,
      idMal: manga.idMal || null,
      mangadexUrl: manualMapping.mangadexUrl || `https://mangadex.org/title/${manualMapping.mangadexId}`,
    };
  }

  const anilistLinkedId = getAniListLinkedMangaDexId(manga);
  if (anilistLinkedId) {
    if (stats) stats.directExternalHits += 1;
    console.log(`Mapping success: "${manga.title}" -> ${anilistLinkedId} via AniList external link.`);
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
  const progress = {
    providerHints: 0,
    plansTried: 0,
    candidatesChecked: 0,
  };
  try {
    providerDiscoveredTitles = await discoverProviderTitlesForManga(
      manga,
      MANGADEX_MAPPING_PROVIDER_TITLE_LIMIT,
    );
  } catch (error) {
    console.warn(`Provider-assisted title discovery failed for "${manga.title}": ${error.message}`);
  }

  progress.providerHints = providerDiscoveredTitles.length;
  if (providerDiscoveredTitles.length > 0 && VERBOSE_MAPPING_LOGS) {
    console.log(
      `Provider-assisted titles for "${manga.title}": ${providerDiscoveredTitles
        .map((item) => `${item.title} [${item.provider}]`)
        .join(' | ')}.`,
    );
  }

  const queryPlans = buildMappingQueryPlans(manga, providerDiscoveredTitles);
  let bestMatch = null;

  for (const plan of queryPlans) {
    progress.plansTried += 1;
    try {
      if (VERBOSE_MAPPING_LOGS) {
        console.log(
          `Mapping search for "${manga.title}" via ${plan.strategy}: "${plan.title}"${plan.year ? ` (${plan.year})` : ''}.`,
        );
      }
      const candidates = await fetchMangaDexCandidates(plan.title, plan.year);
      progress.candidatesChecked += candidates.length;
      if (VERBOSE_MAPPING_LOGS) {
        console.log(
          `Mapping candidate count for "${manga.title}" via ${plan.strategy}: ${candidates.length}.`,
        );
      }
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

        if (result.source !== 'fuzzy') {
          if (stats) {
            if (result.source === 'al') stats.alHits += 1;
            else if (result.source === 'mal') stats.malHits += 1;
            else stats.otherDirectHits += 1;
          }
          console.log(
            `Mapping success: "${manga.title}" -> ${candidate.id} via ${result.source} after ${progress.plansTried} plan(s), ${progress.candidatesChecked} candidate(s), hints=${progress.providerHints}.`,
          );
          return resolved;
        }

        if (!bestMatch || Number(result.confidence || 0) > Number(bestMatch.confidence || 0)) {
          bestMatch = resolved;
        }
      }
    } catch (error) {
      if (VERBOSE_MAPPING_LOGS) {
        console.error(`MangaDex mapping failed for "${manga.title}" via ${plan.strategy} ("${plan.title}"): ${error.message}`);
      }
    }

    await delay(MANGADEX_DELAY_MS);
  }

  if (bestMatch?.mangadexId) {
    if (stats) stats.fuzzyHits += 1;
    console.log(
      `Mapping success: "${manga.title}" -> ${bestMatch.mangadexId} via fuzzy (${bestMatch.confidence}) after ${progress.plansTried} plan(s), ${progress.candidatesChecked} candidate(s), hints=${progress.providerHints}.`,
    );
    return bestMatch;
  }

  if (stats) stats.unmapped += 1;
  console.warn(
    `Mapping unresolved: "${manga.title}" after ${progress.plansTried} plan(s), ${progress.candidatesChecked} candidate(s), hints=${progress.providerHints}.`,
  );
  return null;
}

function attachMapping(manga, mapping) {
  if (!mapping?.mangadexId) return manga;
  return {
    ...manga,
    chapterIndexId: buildChapterIndexId({ ...manga, mangadexId: mapping.mangadexId }),
    mangadexId: mapping.mangadexId,
    mangadexUrl: mapping.mangadexUrl || `https://mangadex.org/title/${mapping.mangadexId}`,
    mangadexMappingSource: mapping.source || '',
    mangadexMappingConfidence: mapping.confidence || 0,
  };
}

async function resolveChapterSourceMapping(manga, existingSourceCache, stats = null) {
  if (!canUseProviderSourceMapping(manga)) {
    return null;
  }

  const anilistChapterCount = Number(manga.chapters || 0);
  const manualSource = getManualChapterSourceMapping(manga);
  if (manualSource?.provider && manualSource?.providerId) {
    if (stats) stats.providerManualHits += 1;
    console.log(`Chapter source success: "${manga.title}" -> ${manualSource.provider} via manual override.`);
    return {
      ...manualSource,
      title: manga.title,
      mangaId: manga.mangaId,
      anilistId: manga.anilistId || manga.mangaId,
      updatedAt: manualSource.updatedAt || new Date().toISOString(),
    };
  }

  const cached = existingSourceCache[String(manga.anilistId || manga.mangaId)];
  if (cached?.provider && cached?.providerId) {
    const cachedChapterCount = Number(cached.chapterCount || 0);
    const shouldReconcileCachedCounts =
      cached.source !== 'manual_provider_override' &&
      cached.source !== 'provider_consensus' &&
      cachedChapterCount > 0 &&
      anilistChapterCount > 0 &&
      cachedChapterCount !== anilistChapterCount;

    if (!shouldReconcileCachedCounts) {
      if (stats) stats.providerCacheHits += 1;
      console.log(`Chapter source cache hit: "${manga.title}" -> ${cached.provider} (${cached.providerId}).`);
      return cached;
    }

    console.log(
      `Chapter source cache recheck: "${manga.title}" -> cached=${cachedChapterCount}, AniList=${anilistChapterCount}; reviewing provider consensus.`,
    );
  }

  const providerCandidates = await resolveFallbackProviderCandidates(manga);
  const bestProvider = providerCandidates[0] || null;
  const chapterCountBuckets = new Map();

  for (const candidate of providerCandidates) {
    const chapterCount = Number(candidate?.chapterCount || 0);
    if (chapterCount <= 0) continue;

    if (!chapterCountBuckets.has(chapterCount)) {
      chapterCountBuckets.set(chapterCount, {
        chapterCount,
        providers: new Set(),
        candidates: [],
      });
    }

    const bucket = chapterCountBuckets.get(chapterCount);
    bucket.providers.add(candidate.provider);
    bucket.candidates.push(candidate);
  }

  const consensusBuckets = Array.from(chapterCountBuckets.values())
    .filter((bucket) => bucket.providers.size >= 2 && bucket.chapterCount > 0)
    .sort((a, b) => {
      if (b.providers.size !== a.providers.size) {
        return b.providers.size - a.providers.size;
      }

      const aDistance = Math.abs(a.chapterCount - anilistChapterCount);
      const bDistance = Math.abs(b.chapterCount - anilistChapterCount);
      if (aDistance !== bDistance) {
        return aDistance - bDistance;
      }

      return b.chapterCount - a.chapterCount;
    });
  const consensusBucket = consensusBuckets[0] || null;
  const consensusDiffersFromAniList =
    consensusBucket &&
    anilistChapterCount > 0 &&
    consensusBucket.chapterCount !== anilistChapterCount;

  if (consensusDiffersFromAniList && bestProvider) {
    const preferredConsensusCandidate =
      consensusBucket.candidates.find((candidate) => candidate.provider === bestProvider.provider)
      || consensusBucket.candidates[0];

    if (preferredConsensusCandidate?.provider && preferredConsensusCandidate?.providerId) {
      if (stats) stats.providerResolvedHits += 1;
      console.log(
        `Chapter source consensus: "${manga.title}" -> AniList=${anilistChapterCount}, providers=${consensusBucket.chapterCount} via ${Array.from(consensusBucket.providers).join(', ')}.`,
      );
      return {
        ...preferredConsensusCandidate,
        source: 'provider_consensus',
        consensusProviders: Array.from(consensusBucket.providers),
        title: manga.title,
        mangaId: manga.mangaId,
        anilistId: manga.anilistId || manga.mangaId,
      };
    }
  }

  if (bestProvider?.provider && bestProvider?.providerId && Number(bestProvider.chapterCount || 0) > 0) {
    if (stats) stats.providerResolvedHits += 1;
    console.log(
      `Chapter source success: "${manga.title}" -> ${bestProvider.provider} (${bestProvider.chapterCount} chapter candidates, AniList=${anilistChapterCount || 0}).`,
    );
    return {
      ...bestProvider,
      source: 'provider_fallback',
      title: manga.title,
      mangaId: manga.mangaId,
      anilistId: manga.anilistId || manga.mangaId,
    };
  }

  if (cached?.provider && cached?.providerId) {
    if (stats) stats.providerCacheHits += 1;
    console.log(`Chapter source fallback to cached mapping: "${manga.title}" -> ${cached.provider} (${cached.providerId}).`);
    return cached;
  }

  if (stats) stats.providerUnresolved += 1;
  console.warn(`Chapter source unresolved: "${manga.title}".`);
  return null;
}

function attachChapterSource(manga, sourceMapping) {
  if (!sourceMapping?.provider || !sourceMapping?.providerId) return manga;
  const shouldOverrideChapterCount =
    ['manual_provider_override', 'provider_consensus'].includes(sourceMapping.source) &&
    Number(sourceMapping.chapterCount || 0) > 0;
  return {
    ...manga,
    chapterIndexId: buildChapterIndexId({
      ...manga,
      chapterSourceProvider: sourceMapping.provider,
    }),
    chapterSourceProvider: sourceMapping.provider,
    chapterSourceId: sourceMapping.providerId,
    chapterSourceTitle: sourceMapping.providerTitle || '',
    chapterSourceChapterCount: Number(sourceMapping.chapterCount || 0),
    chapterSourceConfidence: Number(sourceMapping.confidence || 0),
    chapterCountSource: sourceMapping.source || 'anilist',
    chapterConsensusProviders: Array.isArray(sourceMapping.consensusProviders)
      ? sourceMapping.consensusProviders
      : [],
    chapterSourceUpdatedAt: sourceMapping.updatedAt || null,
    chapters: shouldOverrideChapterCount
      ? Number(sourceMapping.chapterCount)
      : manga.chapters,
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

function readArrayJson(relativePath) {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const value = require(`../../api/${relativePath}.json`);
    return Array.isArray(value) ? value : [];
  } catch (_) {
    return [];
  }
}

function mergeDiscoveredCatalogEntries(catalogEntries) {
  const discoveredEntries = readArrayJson(CONFIG.API_PATHS.MANGA_DISCOVERED_CATALOG);
  if (!discoveredEntries.length) {
    return catalogEntries;
  }

  const merged = new Map();
  for (const item of catalogEntries || []) {
    if (!item?.mangaId) continue;
    merged.set(item.mangaId, item);
  }

  for (const discovered of discoveredEntries) {
    if (!discovered?.mangaId) continue;
    merged.set(
      discovered.mangaId,
      mergeManga(merged.get(discovered.mangaId), discovered),
    );
  }

  return sortCatalog(Array.from(merged.values())).slice(0, CATALOG_MAX_ITEMS);
}

async function fetchMangaCatalog() {
  console.log('========================================');
  console.log('BUILDING: Manga Catalog');
  console.log('========================================');

  const existingCatalog = readObjectJson(CONFIG.API_PATHS.MANGA_SEARCH_INDEX);
  const deduped = new Map();

  if (Array.isArray(existingCatalog)) {
    console.log(`📡 Resuming with ${existingCatalog.length} existing catalog entries...`);
    for (const item of existingCatalog) {
      if (item && item.mangaId) {
        // Convert search index items back to a format suitable for merging if necessary
        // or just use them as-is
        deduped.set(String(item.mangaId), item);
      }
    }
  }

  const sectionBuckets = new Map();

  const GAP_THRESHOLD = Number(process.env.MANGA_GAP_THRESHOLD || 100);
  
  // Use the actual manifest to check which titles REALLY have chapters
  const { getChapterManifest } = require('../utils/mangaBackfillData');
  const manifest = getChapterManifest();
  const indexedIds = new Set((manifest.items || []).map(item => String(item.mangaId || item.anilistId)));
  
  const missingChapters = Array.from(deduped.values()).filter(m => {
    const id = String(m.anilistId || m.mangaId);
    return !indexedIds.has(id);
  });
  
  const gapRatio = (missingChapters.length / (deduped.size || 1)) * 100;

  let skipDiscovery = false;
  if (missingChapters.length > GAP_THRESHOLD && process.env.MANGA_FORCE_DISCOVERY !== '1') {
    console.warn('\n⚠️ [GAP PROTECTION ACTIVE]');
    console.warn(`Found ${missingChapters.length} titles without chapters (${gapRatio.toFixed(1)}% of catalog).`);
    console.warn(`Exceeds threshold of ${GAP_THRESHOLD}. Skipping new title discovery from AniList.`);
    console.warn('Goal: Focus on Stage 2 (Chapter & Image Backfilling) to ensure data integrity.');
    console.log('Canceling Stage 1 (Catalog Builder) to prioritize fill operations...\n');
    return; // [GAP PROTECTION] Exit Stage 1 immediately
  }

  console.log(`\n🔍 [STEP 1/2] Discovering titles from ${MANGA_CATALOG_SOURCES.length} sources...`);
  let newDiscoveries = 0;
  
  for (const source of MANGA_CATALOG_SOURCES) {
    process.stdout.write(`  📡 Collecting: ${source.label.padEnd(20)} \r`);
    const sourceItems = new Map();

    for (let page = 1; page <= source.pages; page++) {
      const data = await fetchGraphQL(GENERIC_MANGA_QUERY, {
        page,
        ...source.variables,
      });

      if (!data || !data.Page) continue;

      for (const media of data.Page.media || []) {
        if (!media || !media.id) continue;
        if (isAdultContent(media).blocked || !isManga(media).allowed) continue;

        const formatted = convertMangaToFirestoreFormat(media);
        if (!formatted) continue;

        if (!deduped.has(formatted.mangaId)) {
          newDiscoveries++;
          deduped.set(formatted.mangaId, formatted);
        } else {
          deduped.set(
            formatted.mangaId,
            mergeManga(deduped.get(formatted.mangaId), formatted),
          );
        }
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
  process.stdout.write('\x1b[2K'); // Clear line
  console.log(`✅ Discovery Complete: ${newDiscoveries} new titles found. (Total Library: ${deduped.size} titles)`);

  let catalog = sortCatalog(Array.from(deduped.values())).slice(0, CATALOG_MAX_ITEMS);
  const mappingCache = readObjectJson(CONFIG.API_PATHS.MANGA_MAPPING);
  const chapterSourceCache = readObjectJson(CONFIG.API_PATHS.MANGA_CHAPTER_SOURCE_MAPPING);
  const nextMappingCache = { ...mappingCache };
  const nextChapterSourceCache = { ...chapterSourceCache };
  const validatedChapterSources = new Map();
  let mappingAttempts = 0;
  const mappingStats = {
    cachedHits: 0,
    manualHits: 0,
    directExternalHits: 0,
    alHits: 0,
    malHits: 0,
    otherDirectHits: 0,
    fuzzyHits: 0,
    unmapped: 0,
    providerCacheHits: 0,
    providerManualHits: 0,
    providerResolvedHits: 0,
    providerUnresolved: 0,
    skippedNonChapterFormats: 0,
  };

  const prioritizedIndexes = catalog
    .map((manga, index) => ({ manga, index }))
    .sort((a, b) => mappingPriorityScore(b.manga) - mappingPriorityScore(a.manga));
  const processedMappingIds = new Set();
  console.log(`\n🔗 [STEP 2/2] Resolving Links for candidates...`);

  for (const { manga, index } of prioritizedIndexes) {
    if (skipDiscovery) break; // [GAP PROTECTION] Skip time-consuming mapping
    const processedKey = String(manga.anilistId || manga.mangaId);
    if (processedMappingIds.has(processedKey)) {
      continue;
    }
    processedMappingIds.add(processedKey);

    const cachedMapping = nextMappingCache[String(manga.anilistId || manga.mangaId)];
    const manualChapterSource = getManualChapterSourceMapping(manga);
    let knownChapterSource =
      manualChapterSource ||
      nextChapterSourceCache[processedKey];
    if (manualChapterSource?.provider && manualChapterSource?.providerId) {
      nextChapterSourceCache[processedKey] = {
        ...manualChapterSource,
        title: manga.title,
        mangaId: manga.mangaId,
        anilistId: manga.anilistId || manga.mangaId,
        updatedAt: manualChapterSource.updatedAt || new Date().toISOString(),
      };
      knownChapterSource = nextChapterSourceCache[processedKey];
    }
    if (cachedMapping?.mangadexId) {
      mappingStats.cachedHits += 1;
      if (knownChapterSource?.provider && knownChapterSource?.providerId) {
        const sourceKey = `${knownChapterSource.provider}:${knownChapterSource.providerId}`;
        let isValid = validatedChapterSources.get(sourceKey);
        if (isValid == null) {
          isValid = await validateProviderSourceMapping(knownChapterSource);
          validatedChapterSources.set(sourceKey, isValid);
        }
        if (!isValid) {
          delete nextChapterSourceCache[processedKey];
          knownChapterSource = null;
          console.warn(`Chapter source invalid: "${manga.title}" -> ${sourceKey} has no readable pages.`);
        }
      }
      catalog[index] = attachChapterSource(attachMapping(manga, cachedMapping), knownChapterSource);
      continue;
    }

    if (knownChapterSource?.provider && knownChapterSource?.providerId) {
      const sourceKey = `${knownChapterSource.provider}:${knownChapterSource.providerId}`;
      let isValid = validatedChapterSources.get(sourceKey);
      if (isValid == null) {
        isValid = await validateProviderSourceMapping(knownChapterSource);
        validatedChapterSources.set(sourceKey, isValid);
      }
      if (!isValid) {
        delete nextChapterSourceCache[processedKey];
        knownChapterSource = null;
        console.warn(`Chapter source invalid: "${manga.title}" -> ${sourceKey} has no readable pages.`);
      } else {
        catalog[index] = attachChapterSource(manga, knownChapterSource);
        nextChapterSourceCache[processedKey] = {
          ...knownChapterSource,
          title: manga.title,
          mangaId: manga.mangaId,
          anilistId: manga.anilistId || manga.mangaId,
          updatedAt: knownChapterSource.updatedAt || new Date().toISOString(),
        };
      }
    }

    if (!canUseProviderSourceMapping(manga)) {
      mappingStats.skippedNonChapterFormats += 1;
      if (VERBOSE_MAPPING_LOGS) {
        console.log(
          `Mapping skipped: "${manga.title}" (${manga.format || 'UNKNOWN'}) is not a chapter-bearing manga format.`,
        );
      }
      continue;
    }

    if (mappingAttempts >= MANGADEX_MAPPING_ATTEMPTS_PER_RUN) {
      continue;
    }

    const progress = `[${mappingAttempts + 1}/${MANGADEX_MAPPING_ATTEMPTS_PER_RUN}]`;
    const getTitle = (m) => {
      if (typeof m.title === 'string') return m.title;
      if (m.title && typeof m.title === 'object') return m.title.userPreferred || m.title.english || m.title.romaji;
      return 'Unknown Title';
    };
    const titleShort = getTitle(manga).slice(0, 35);
    process.stdout.write(`  ⏳ ${progress} Resolving: ${titleShort}... \r`);
    const resolved = await resolveMangaDexMapping(manga, nextMappingCache, mappingStats);
    mappingAttempts += 1;
    if (resolved?.mangadexId) {
      process.stdout.write(`  ✅ ${progress} Linked (MangaDex): ${titleShort.padEnd(35)}\n`);
      nextMappingCache[String(manga.anilistId || manga.mangaId)] = resolved;
      delete nextChapterSourceCache[processedKey];
      catalog[index] = attachMapping(manga, resolved);
      continue;
    }

    const chapterSource = await resolveChapterSourceMapping(manga, nextChapterSourceCache, mappingStats);
    if (chapterSource?.provider && chapterSource?.providerId) {
      process.stdout.write(`  🌐 ${progress} Tied (Fallback): ${titleShort.padEnd(35)}\n`);
      nextChapterSourceCache[processedKey] = chapterSource;
      catalog[index] = attachChapterSource(manga, chapterSource);
      validatedChapterSources.set(`${chapterSource.provider}:${chapterSource.providerId}`, true);
    }
  }
  
  if (totalMappingToAttempt > 0) {
    console.log(`\n🎉 Step 2 Complete! Resolved ${mappingAttempts} titles.`);
  }

  const enrichedCatalog = [];
  for (const manga of catalog) {
    const processedKey = String(manga.anilistId || manga.mangaId);
    const cachedMapping =
      nextMappingCache[processedKey] ||
      manualMangaMappings[processedKey] ||
      manualMangaMappings[String(manga.mangaId || '')];
    const manualChapterSource =
      manualMangaSourceMappings[processedKey] ||
      manualMangaSourceMappings[String(manga.mangaId || '')] ||
      getManualChapterSourceMapping(manga);
    let knownChapterSource =
      manualChapterSource ||
      nextChapterSourceCache[processedKey];

    let enriched = manga;
    if (cachedMapping?.mangadexId) {
      enriched = attachMapping(enriched, cachedMapping);
    }
    if (knownChapterSource?.provider && knownChapterSource?.providerId) {
      const sourceKey = `${knownChapterSource.provider}:${knownChapterSource.providerId}`;
      let isValid = validatedChapterSources.get(sourceKey);
      if (isValid == null) {
        isValid = await validateProviderSourceMapping(knownChapterSource);
        validatedChapterSources.set(sourceKey, isValid);
      }
      if (isValid) {
        nextChapterSourceCache[processedKey] = {
          ...knownChapterSource,
          title: manga.title,
          mangaId: manga.mangaId,
          anilistId: manga.anilistId || manga.mangaId,
          updatedAt: knownChapterSource.updatedAt || new Date().toISOString(),
        };
        enriched = attachChapterSource(enriched, nextChapterSourceCache[processedKey]);
      } else {
        delete nextChapterSourceCache[processedKey];
      }
    }
    enrichedCatalog.push(enriched);
  }
  catalog = enrichedCatalog;
  catalog = mergeDiscoveredCatalogEntries(catalog);

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
  writeJsonIfChanged(CONFIG.API_PATHS.MANGA_CHAPTER_SOURCE_MAPPING, nextChapterSourceCache);

  for (const [genre, items] of genreBuckets.entries()) {
    const sortedItems = sortCatalog(
      Array.from(new Map(items.map((item) => [item.mangaId, item])).values()),
    ).slice(0, GENRE_MAX_ITEMS);
    writeJsonIfChanged(`${CONFIG.API_PATHS.MANGA_BY_GENRE}/${genre}`, sortedItems);
  }

  for (const source of MANGA_CATALOG_SOURCES) {
    const items = (sectionBuckets.get(source.label) || [])
      .map((item) => attachChapterSource(
        attachMapping(item, nextMappingCache[String(item.anilistId || item.mangaId)]),
        nextChapterSourceCache[String(item.anilistId || item.mangaId)],
      ))
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
  console.log('Manga new chapters feed is managed by the dedicated workflow only (fetch_manga_new_chapters.yml).');
  console.log(`Manga catalog built with ${catalog.length} items across ${totalPages} pages.`);
  console.log(
    `Manga mapping summary -> attempts: ${mappingAttempts}, cache hits: ${mappingStats.cachedHits}, manual: ${mappingStats.manualHits}, AniList direct: ${mappingStats.directExternalHits}, AL link: ${mappingStats.alHits}, MAL bridge: ${mappingStats.malHits}, other direct: ${mappingStats.otherDirectHits}, fuzzy: ${mappingStats.fuzzyHits}, unresolved: ${mappingStats.unmapped}.`,
  );
  console.log(
    `Manga mapping skipped non-chapter formats: ${mappingStats.skippedNonChapterFormats}.`,
  );
  console.log(
    `Chapter source mapping summary -> cache hits: ${mappingStats.providerCacheHits}, manual: ${mappingStats.providerManualHits}, resolved: ${mappingStats.providerResolvedHits}, unresolved: ${mappingStats.providerUnresolved}.`,
  );
}

module.exports = fetchMangaCatalog;
