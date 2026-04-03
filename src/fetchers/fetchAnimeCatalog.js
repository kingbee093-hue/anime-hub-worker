const CONFIG = require('../config/constants');
const { fetchGraphQL } = require('../utils/fetchHelper');
const { GENERIC_MEDIA_QUERY } = require('../utils/anilistQueries');
const { convertToFirestoreFormat, delay } = require('../utils/formatters');
const { isAdultContent, isAnime } = require('../utils/filters');
const { writeJsonIfChanged } = require('../utils/writeJsonIfChanged');

const CATALOG_PAGE_SIZE = 150;
const CATALOG_MAX_ITEMS = 2000;
const GENRE_MAX_ITEMS = 120;

const CATALOG_SOURCES = [
  {
    label: 'popular',
    pages: 20,
    variables: {
      perPage: 50,
      sort: ['POPULARITY_DESC'],
    },
  },
  {
    label: 'top-rated',
    pages: 10,
    variables: {
      perPage: 50,
      sort: ['SCORE_DESC', 'POPULARITY_DESC'],
    },
  },
  {
    label: 'trending',
    pages: 8,
    variables: {
      perPage: 50,
      sort: ['TRENDING_DESC', 'POPULARITY_DESC'],
    },
  },
  {
    label: 'airing',
    pages: 5,
    variables: {
      perPage: 50,
      status: 'RELEASING',
      sort: ['POPULARITY_DESC'],
    },
  },
  {
    label: 'upcoming',
    pages: 5,
    variables: {
      perPage: 50,
      status: 'NOT_YET_RELEASED',
      sort: ['POPULARITY_DESC'],
    },
  },
];

function computeRichnessScore(anime) {
  let score = 0;
  if (anime.synopsis) score += Math.min(anime.synopsis.length, 500);
  if (anime.bannerImage) score += 100;
  if (anime.imageUrl) score += 50;
  if (anime.coverImageLarge) score += 30;
  if (anime.coverImageMedium) score += 20;
  if (Array.isArray(anime.genres)) score += anime.genres.length * 10;
  if (Array.isArray(anime.synonyms)) score += anime.synonyms.length * 5;
  if (Array.isArray(anime.studiosNames)) score += anime.studiosNames.length * 4;
  score += Number(anime.popularity || 0) / 1000;
  score += Number(anime.averageScore || 0);
  return score;
}

function mergeAnime(existing, incoming) {
  if (!existing) {
    return incoming;
  }

  const merged = {
    ...existing,
    ...incoming,
    genres: Array.from(
      new Set([...(existing.genres || []), ...(incoming.genres || [])]),
    ),
    synonyms: Array.from(
      new Set([...(existing.synonyms || []), ...(incoming.synonyms || [])]),
    ),
    studiosNames: Array.from(
      new Set([
        ...(existing.studiosNames || []),
        ...(incoming.studiosNames || []),
      ]),
    ),
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

function sortCatalog(items) {
  return items.sort((a, b) => {
    const popularityDelta = Number(b.popularity || 0) - Number(a.popularity || 0);
    if (popularityDelta !== 0) {
      return popularityDelta;
    }

    const scoreDelta = Number(b.averageScore || 0) - Number(a.averageScore || 0);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }

    return String(a.title || '').localeCompare(String(b.title || ''));
  });
}

function buildSearchIndexItem(anime, detailPage) {
  return {
    animeId: anime.animeId,
    anilistId: anime.anilistId || anime.animeId,
    title: anime.title || '',
    titleEnglish: anime.titleEnglish || '',
    titleRomaji: anime.titleRomaji || '',
    titleNative: anime.titleNative || '',
    imageUrl: anime.imageUrl || anime.coverImageLarge || anime.coverImageMedium || '',
    synopsis: (anime.synopsis || '').substring(0, 260),
    genres: anime.genres || [],
    studiosNames: anime.studiosNames || [],
    popularity: anime.popularity || 0,
    averageScore: anime.averageScore || 0,
    episodes: anime.episodes || 0,
    season: anime.season || '',
    seasonYear: anime.seasonYear || null,
    format: anime.format || anime.type || '',
    detailPage,
    searchTerms: Array.from(
      new Set(
        [
          anime.title,
          anime.titleEnglish,
          anime.titleRomaji,
          anime.titleNative,
          ...(anime.synonyms || []),
          ...(anime.genres || []),
          ...(anime.studiosNames || []),
        ]
          .filter(Boolean)
          .map((value) => String(value).trim()),
      ),
    ),
  };
}

async function fetchAnimeCatalog() {
  console.log('========================================');
  console.log('BUILDING: Anime Catalog');
  console.log('========================================');

  const deduped = new Map();

  for (const source of CATALOG_SOURCES) {
    console.log(`Collecting source: ${source.label}`);
    for (let page = 1; page <= source.pages; page++) {
      const data = await fetchGraphQL(GENERIC_MEDIA_QUERY, {
        page,
        ...source.variables,
      });

      if (!data || !data.Page) {
        console.error(`Failed to fetch catalog source ${source.label} page ${page}`);
        continue;
      }

      for (const media of data.Page.media || []) {
        if (!media || (!media.idMal && !media.id)) continue;
        if (isAdultContent(media).blocked || !isAnime(media).allowed) continue;

        const formatted = convertToFirestoreFormat(media);
        if (!formatted) continue;

        deduped.set(formatted.animeId, mergeAnime(deduped.get(formatted.animeId), formatted));
      }

      await delay(CONFIG.RATE_LIMIT_DELAY);
    }
  }

  const catalog = sortCatalog(Array.from(deduped.values())).slice(0, CATALOG_MAX_ITEMS);
  const totalPages = Math.max(1, Math.ceil(catalog.length / CATALOG_PAGE_SIZE));
  const lookup = {};
  const genreBuckets = new Map();
  const searchIndex = [];

  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
    const start = (pageNumber - 1) * CATALOG_PAGE_SIZE;
    const pageItems = catalog.slice(start, start + CATALOG_PAGE_SIZE);

    for (const item of pageItems) {
      lookup[String(item.animeId)] = pageNumber;
      searchIndex.push(buildSearchIndexItem(item, pageNumber));

      for (const genre of item.genres || []) {
        if (!genreBuckets.has(genre)) {
          genreBuckets.set(genre, []);
        }
        genreBuckets.get(genre).push(item);
      }
    }

    writeJsonIfChanged(`${CONFIG.API_PATHS.CATALOG}/anime_page_${pageNumber}`, pageItems);
  }

  writeJsonIfChanged(`${CONFIG.API_PATHS.CATALOG}/anime_lookup`, lookup);
  writeJsonIfChanged(`${CONFIG.API_PATHS.CATALOG}/anime_manifest`, {
    generatedAt: new Date().toISOString(),
    totalItems: catalog.length,
    pageSize: CATALOG_PAGE_SIZE,
    totalPages,
    sourceCount: CATALOG_SOURCES.length,
  });

  for (const [genre, items] of genreBuckets.entries()) {
    const sortedItems = sortCatalog(
      Array.from(
        new Map(items.map((item) => [item.animeId, item])).values(),
      ),
    ).slice(0, GENRE_MAX_ITEMS);
    writeJsonIfChanged(`${CONFIG.API_PATHS.CATALOG}/genres/${genre}`, sortedItems);
  }

  writeJsonIfChanged(CONFIG.API_PATHS.SEARCH_INDEX, searchIndex);
  console.log(`Anime catalog built with ${catalog.length} items across ${totalPages} pages.`);
}

module.exports = fetchAnimeCatalog;
