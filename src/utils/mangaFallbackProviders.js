const axios = require('axios');
const { MANGA } = require('@consumet/extensions');
const { safeUnpack } = require('@consumet/extensions/dist/utils/utils');

const PROVIDER_PRIORITY = ['mangapill', 'weebcentral', 'mangahere', 'comick', 'asurascans'];
const PROVIDER_HEADERS = {
  weebcentral: {
    Referer: 'https://weebcentral.com',
    'User-Agent': 'Mozilla/5.0',
  },
  comick: {
    Referer: 'https://comick.io/',
    'User-Agent': 'Mozilla/5.0',
  },
  mangapill: {
    Referer: 'https://mangapill.com/',
    'User-Agent': 'Mozilla/5.0',
  },
  mangahere: {
    Referer: 'https://www.mangahere.cc/',
    'User-Agent': 'Mozilla/5.0',
  },
  asurascans: {
    Referer: 'https://asurascans.com/',
    'User-Agent': 'Mozilla/5.0',
  },
};

const PROVIDER_LABELS = {
  weebcentral: 'WeebCentral',
  comick: 'ComicK',
  mangapill: 'MangaPill',
  mangahere: 'MangaHere',
  asurascans: 'AsuraScans',
};
const MAX_SEARCH_RESULTS_PER_QUERY = 3;
const MAX_PROVIDER_CANDIDATES = 4;
const PROVIDER_SEARCH_TIMEOUT_MS = Number(process.env.MANGA_PROVIDER_SEARCH_TIMEOUT_MS || 30000);
const PROVIDER_INFO_TIMEOUT_MS = Number(process.env.MANGA_PROVIDER_INFO_TIMEOUT_MS || 40000);
const PROVIDER_PAGES_TIMEOUT_MS = Number(process.env.MANGA_PROVIDER_PAGES_TIMEOUT_MS || 40000);
const PROVIDER_PROBE_CHAPTER_LIMIT = Number(process.env.MANGA_PROVIDER_PROBE_CHAPTER_LIMIT || 1);
const PROVIDER_RESOLUTION_BUDGET_MS = Number(process.env.MANGA_PROVIDER_RESOLUTION_BUDGET_MS || 120000);

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseChapterNumber(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return null;

  const explicitPatterns = [
    /\b(?:chapter|chap|ch)\.?\s*[:#-]?\s*(\d+(?:\.\d+)?)/i,
    /\b(?:episode|ep)\.?\s*[:#-]?\s*(\d+(?:\.\d+)?)/i,
    /\bc\.?\s*(\d+(?:\.\d+)?)/i,
  ];

  for (const pattern of explicitPatterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    const parsed = Number.parseFloat(match[1]);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  const numbers = normalized.match(/\d+(?:\.\d+)?/g) || [];
  if (numbers.length === 0) return null;

  const parsed = Number.parseFloat(numbers[numbers.length - 1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildProviderChapterContext(providerKey, chapters = []) {
  if (providerKey !== 'weebcentral' || !Array.isArray(chapters) || chapters.length === 0) {
    return null;
  }

  const seasonGroups = new Map();

  for (const chapter of chapters) {
    const title = String(chapter?.title || '').trim();
    const match = title.match(/^S(\d+)\s*-\s*Episode\s*(\d+(?:\.\d+)?)/i);
    if (!match) continue;

    const season = Number(match[1]);
    const episode = Number.parseFloat(match[2]);
    if (!Number.isFinite(season) || !Number.isFinite(episode)) continue;

    if (!seasonGroups.has(season)) {
      seasonGroups.set(season, []);
    }
    seasonGroups.get(season).push(episode);
  }

  if (seasonGroups.size < 2) {
    return null;
  }

  const orderedSeasons = Array.from(seasonGroups.keys()).sort((a, b) => a - b);
  const offsets = {};
  let cumulativeOffset = 0;

  for (const season of orderedSeasons) {
    offsets[season] = cumulativeOffset;
    const episodes = seasonGroups.get(season) || [];
    const maxEpisode = episodes
      .filter((value) => Number.isInteger(value) && value >= 0)
      .reduce((max, value) => Math.max(max, value), 0);
    cumulativeOffset += maxEpisode;
  }

  return {
    type: 'season_episode_offsets',
    offsets,
  };
}

function parseProviderChapterNumber(providerKey, chapter, manga = null) {
  const rawValue = chapter?.chapter || chapter?.chapterNumber || chapter?.title || '';

  if (providerKey === 'weebcentral' && manga?.providerChapterContext?.type === 'season_episode_offsets') {
    const title = String(chapter?.title || '').trim();
    const match = title.match(/^S(\d+)\s*-\s*Episode\s*(\d+(?:\.\d+)?)/i);
    if (match) {
      const season = Number(match[1]);
      const episode = Number.parseFloat(match[2]);
      if (Number.isFinite(season) && Number.isFinite(episode)) {
        const offsets = manga.providerChapterContext.offsets || {};

        if (Object.prototype.hasOwnProperty.call(offsets, season)) {
          if (episode === 0) {
            return offsets[season] + 0.5;
          }
          return offsets[season] + episode;
        }
      }
    }
  }

  return parseChapterNumber(rawValue);
}

function buildCandidateTitles(manga) {
  return Array.from(
    new Set(
      [
        manga.titleEnglish,
        manga.title,
        manga.titleRomaji,
        ...(manga.synonyms || []),
      ]
        .filter(Boolean)
        .map((title) => String(title).trim())
        .filter((title) => title.length >= 2),
    ),
  ).slice(0, 5);
}

function buildSearchQueries(providerKey, candidateTitles) {
  const queries = new Set();

  for (const rawTitle of candidateTitles) {
    const title = String(rawTitle || '').trim();
    if (!title) continue;

    queries.add(title);

    const normalized = normalizeText(title);
    if (normalized && normalized !== title.toLowerCase()) {
      queries.add(normalized);
    }

    if (providerKey === 'weebcentral') {
      const compact = normalized
        .replace(/\b(can t|won t|isn t|doesn t|don t)\b/g, (match) => match.replace(/\s+/g, ''))
        .replace(/\s+/g, ' ')
        .trim();
      if (compact) {
        queries.add(compact);
      }
    }
  }

  return Array.from(queries);
}

function titleScore(resultTitle, candidates) {
  const normalizedResult = normalizeText(resultTitle);
  if (!normalizedResult) return 0;

  let best = 0;
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeText(candidate);
    if (!normalizedCandidate) continue;

    if (normalizedCandidate == normalizedResult) {
      best = Math.max(best, 100);
      continue;
    }

    if (normalizedResult.startsWith(normalizedCandidate) ||
        normalizedCandidate.startsWith(normalizedResult)) {
      best = Math.max(best, 88);
      continue;
    }

    if (normalizedResult.includes(normalizedCandidate) ||
        normalizedCandidate.includes(normalizedResult)) {
      best = Math.max(best, 72);
      continue;
    }

    const resultWords = new Set(normalizedResult.split(' '));
    const candidateWords = normalizedCandidate.split(' ');
    const overlap = candidateWords.filter((word) => resultWords.has(word)).length;
    if (overlap > 0) {
      best = Math.max(best, overlap * 10);
    }
  }

  return best;
}

function buildSearchCandidateRecord(candidate, candidateTitles, query) {
  const providerId = String(candidate?.id || '').trim();
  if (!providerId) return null;

  const providerTitle = typeof candidate?.title === 'string' ? candidate.title : query;
  const matchScore = titleScore(providerTitle, candidateTitles);
  if (matchScore < 55) {
    return null;
  }

  return {
    providerId,
    providerTitle,
    matchScore,
  };
}

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

async function collectProviderCandidates(providerKey, candidateTitles) {
  const provider = providers[providerKey];
  const rankedMap = new Map();
  const searchQueries = buildSearchQueries(providerKey, candidateTitles);

  for (const query of searchQueries) {
    let searchResults = [];
    try {
      searchResults = await provider.search(query);
    } catch (_) {
      continue;
    }

    for (const candidate of searchResults.slice(0, MAX_SEARCH_RESULTS_PER_QUERY)) {
      const record = buildSearchCandidateRecord(candidate, candidateTitles, query);
      if (!record) {
        continue;
      }

      const existing = rankedMap.get(record.providerId);
      if (!existing || record.matchScore > existing.matchScore) {
        rankedMap.set(record.providerId, record);
      }
    }
  }

  return Array.from(rankedMap.values())
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, MAX_PROVIDER_CANDIDATES);
}

class FallbackProviderClient {
  constructor(key, factory) {
    this.key = key;
    this.label = PROVIDER_LABELS[key] || key;
    this.headers = PROVIDER_HEADERS[key] || {};
    this.client = factory();
  }

  async search(query) {
    if (this.key === 'asurascans') {
      return fetchAsuraSearch(query);
    }

    const queries = [query];
    const normalized = normalizeText(query);
    if (normalized && !queries.includes(normalized)) {
      queries.push(normalized);
    }

    if (this.key === 'weebcentral') {
      const compact = normalized
        .replace(/\b(can t|won t|isn t|doesn t|don t)\b/g, (match) => match.replace(/\s+/g, ''))
        .replace(/\s+/g, ' ')
        .trim();
      if (compact && !queries.includes(compact)) {
        queries.push(compact);
      }
    }

    for (const searchQuery of queries) {
      const result = await withTimeout(
        this.client.search(searchQuery),
        PROVIDER_SEARCH_TIMEOUT_MS,
        `${this.label} search`,
      );
      const results = Array.isArray(result?.results) ? result.results : [];
      if (results.length > 0) {
        return results;
      }
    }

    return [];
  }

  async fetchInfo(id) {
    if (this.key === 'asurascans') {
      return fetchAsuraInfo(id);
    }

    if (this.key === 'comick') {
      return fetchComicKInfo(id);
    }

    return withTimeout(
      this.client.fetchMangaInfo(id),
      PROVIDER_INFO_TIMEOUT_MS,
      `${this.label} fetchInfo`,
    );
  }

  async fetchChapterPages(chapterId) {
    if (this.key === 'asurascans') {
      return withTimeout(
        fetchAsuraChapterPages(chapterId),
        PROVIDER_PAGES_TIMEOUT_MS,
        `${this.label} fetchChapterPages`,
      );
    }

    if (this.key === 'mangahere') {
      try {
        return await withTimeout(
          this.client.fetchChapterPages(chapterId),
          PROVIDER_PAGES_TIMEOUT_MS,
          `${this.label} fetchChapterPages`,
        );
      } catch (error) {
        return withTimeout(
          fetchMangaHereChapterPages(chapterId),
          PROVIDER_PAGES_TIMEOUT_MS,
          `${this.label} fetchChapterPagesFallback`,
        );
      }
    }

    return withTimeout(
      this.client.fetchChapterPages(chapterId),
      PROVIDER_PAGES_TIMEOUT_MS,
      `${this.label} fetchChapterPages`,
    );
  }
}

async function fetchAsuraSearch(query) {
  const { data } = await axios.get('https://api.asurascans.com/api/search', {
    params: { q: query },
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Referer: 'https://asurascans.com/',
    },
  });

  return Array.isArray(data?.data)
    ? data.data.map((item) => ({
        id: item.slug,
        title: item.title,
        image: item.cover,
      }))
    : [];
}

async function fetchMangaHereChapterPages(chapterId) {
  const url = `https://mangahere.cc/manga/${chapterId}/1.html`;
  const { data } = await axios.get(url, {
    headers: {
      cookie: 'isAdult=1',
      Referer: 'https://www.mangahere.cc/',
      'User-Agent': 'Mozilla/5.0',
    },
  });

  const blockedMatch = data.match(/Dear users?,[\s\S]*?enjoy it\./i) || data.match(/removed all content[\s\S]*?enjoy it\./i);
  if (blockedMatch) {
    throw new Error(blockedMatch[0].replace(/\s+/g, ' ').trim());
  }

  const scriptStart = data.indexOf('eval(function(p,a,c,k,e,d)');
  const scriptEnd = scriptStart >= 0 ? data.indexOf('</script>', scriptStart) : -1;
  if (scriptStart >= 0 && scriptEnd > scriptStart) {
    const packedScript = data.substring(scriptStart, scriptEnd);
    const unpacked = safeUnpack(packedScript) || '';
    const imageUrls = [...new Set((unpacked.match(/\/\/[A-Za-z0-9._/-]+?\.jpg/g) || []))]
      .map((urlPart) => `https:${urlPart}`);

    if (imageUrls.length > 0) {
      return imageUrls.map((img, index) => ({
        page: index,
        img,
        headerForImage: { Referer: url },
      }));
    }
  }

  throw new Error('MangaHere fallback parser could not extract chapter pages');
}

async function fetchAsuraInfo(mangaId) {
  const headers = {
    'User-Agent': 'Mozilla/5.0',
    Referer: 'https://asurascans.com/',
  };

  const [{ data: detailData }, { data: chapterData }] = await Promise.all([
    axios.get(`https://api.asurascans.com/api/series/${mangaId}`, { headers }),
    axios.get(`https://api.asurascans.com/api/series/${mangaId}/chapters`, { headers }),
  ]);

  const series = detailData?.series || {};
  const publicUrl = series.public_url || `/comics/${series.slug || mangaId}`;
  const chapterRows = Array.isArray(chapterData?.data) ? chapterData.data : [];
  const chapters = chapterRows
    .map((chapter) => ({
      id: `${publicUrl}/chapter/${chapter.number}`,
      title: chapter.title ? `Chapter ${chapter.number}: ${chapter.title}` : `Chapter ${chapter.number}`,
      chapterNumber: chapter.number,
      volumeNumber: '',
      releaseDate: chapter.published_at || null,
      lang: 'en',
    }))
    .filter((chapter) => chapter.id && chapter.chapterNumber != null);

  return {
    id: series.slug || mangaId,
    title: series.title || mangaId,
    altTitles: Array.isArray(series.alt_titles) ? series.alt_titles : [],
    description: String(series.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    genres: Array.isArray(series.genres) ? series.genres.map((genre) => genre?.name).filter(Boolean) : [],
    image: series.cover || '',
    links: [],
    chapters,
  };
}

async function fetchAsuraChapterPages(chapterId) {
  const chapterUrl = chapterId.startsWith('http')
    ? chapterId
    : `https://asurascans.com${chapterId.startsWith('/') ? '' : '/'}${chapterId}`;
  const { data } = await axios.get(chapterUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Referer: 'https://asurascans.com/',
    },
  });

  const decoded = String(data).replace(/&quot;/g, '"');
  const imageUrls = [
    ...new Set(
      (decoded.match(/https:\/\/cdn\.asurascans\.com\/asura-images\/chapters\/[^"\s<>]+/g) || [])
        .filter((url) => url.endsWith('.webp') || url.endsWith('.jpg') || url.endsWith('.jpeg') || url.endsWith('.png')),
    ),
  ];

  if (imageUrls.length === 0) {
    throw new Error('AsuraScans parser could not extract chapter pages');
  }

  return imageUrls.map((img, index) => ({
    page: index + 1,
    img,
    headerForImage: { Referer: chapterUrl },
  }));
}

function normalizeComicKAltTitles(mdTitles) {
  if (Array.isArray(mdTitles)) {
    return mdTitles
      .map((item) => item?.title || item)
      .filter(Boolean)
      .map((value) => String(value).trim());
  }

  if (mdTitles && typeof mdTitles === 'object') {
    return Object.values(mdTitles)
      .map((item) => item?.title || item)
      .filter(Boolean)
      .map((value) => String(value).trim());
  }

  return [];
}

async function fetchComicKInfo(mangaId) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    Referer: 'https://comick.art',
  };

  const pageResponse = await axios.get(`https://comick.art/comic/${mangaId}`, { headers });
  const match = String(pageResponse.data).match(/<script id="comic-data"[^>]*>([\s\S]*?)<\/script>/i);
  const comicData = match ? JSON.parse(match[1]) : {};

  const chapters = [];
  const chapterKeys = new Set();
  for (let page = 1; page <= 20; page += 1) {
    const response = await axios.get(`https://comick.art/api/comics/${mangaId}/chapter-list?page=${page}`, { headers });
    const pageChapters = Array.isArray(response?.data?.data) ? response.data.data : [];
    if (pageChapters.length === 0) {
      break;
    }

    for (const chapter of pageChapters) {
      const chapterKey = [
        String(chapter.chap ?? '').trim(),
        String(chapter.lang ?? '').trim(),
        String(chapter.vol ?? '').trim(),
        String(chapter.hid ?? '').trim(),
      ].join('|');
      if (chapterKeys.has(chapterKey)) {
        continue;
      }
      chapterKeys.add(chapterKey);
      chapters.push({
        id: `${mangaId}/${chapter.hid}-chapter-${chapter.chap}-${chapter.lang}`,
        title: chapter.title ?? chapter.chap,
        chapterNumber: chapter.chap,
        volumeNumber: chapter.vol,
        releaseDate: chapter.created_at,
        lang: chapter.lang,
      });
    }
  }

  return {
    id: comicData.slug || mangaId,
    title: comicData.title || mangaId,
    altTitles: normalizeComicKAltTitles(comicData.md_titles),
    description: comicData.desc || '',
    genres: Array.isArray(comicData.md_comic_md_genres)
      ? comicData.md_comic_md_genres
          .map((genre) => genre?.md_genres?.name)
          .filter(Boolean)
      : [],
    image: comicData.default_thumbnail || '',
    malId: comicData?.links?.mal || null,
    links: Object.values(comicData.links || {}).filter((link) => link != null),
    chapters,
  };
}

const providers = {
  weebcentral: new FallbackProviderClient('weebcentral', () => new MANGA.WeebCentral()),
  comick: new FallbackProviderClient('comick', () => new MANGA.ComicK()),
  mangapill: new FallbackProviderClient('mangapill', () => new MANGA.MangaPill()),
  mangahere: new FallbackProviderClient('mangahere', () => new MANGA.MangaHere()),
  asurascans: new FallbackProviderClient('asurascans', () => new MANGA.AsuraScans()),
};

function scoreCoverage(chapterCount, catalogTotal) {
  const total = Number(catalogTotal || 0);
  const count = Number(chapterCount || 0);
  if (count <= 0) return -1000;
  if (total <= 0) return Math.min(count, 300);
  const gap = Math.abs(total - count);
  return Math.max(0, 220 - (gap * 3));
}

function extractPageUrls(pagesPayload) {
  if (Array.isArray(pagesPayload)) {
    return pagesPayload
      .map((item) => {
        if (typeof item === 'string') return item;
        if (typeof item?.img === 'string') return item.img;
        if (typeof item?.url === 'string') return item.url;
        return null;
      })
      .filter(Boolean);
  }

  if (Array.isArray(pagesPayload?.pages)) {
    return pagesPayload.pages
      .map((item) => {
        if (typeof item === 'string') return item;
        if (typeof item?.img === 'string') return item.img;
        if (typeof item?.url === 'string') return item.url;
        return null;
      })
      .filter(Boolean);
  }

  return [];
}

function pickProbeChapters(chapters) {
  if (!Array.isArray(chapters) || chapters.length === 0) return [];

  const requestedLimit = Math.max(1, PROVIDER_PROBE_CHAPTER_LIMIT);
  if (requestedLimit <= 1) {
    const latest = chapters[0] || null;
    return latest?.id ? [latest] : [];
  }

  const picks = [];
  const indexes = [
    0,
    Math.floor(chapters.length / 2),
    chapters.length - 1,
  ];

  for (const index of indexes) {
    const chapter = chapters[index];
    if (chapter?.id && !picks.some((item) => item.id === chapter.id)) {
      picks.push(chapter);
    }
  }

  return picks.slice(0, requestedLimit);
}

async function probeReadableCandidate(providerKey, info) {
  const provider = providers[providerKey];
  if (!provider) return null;

  const probeChapters = pickProbeChapters(info?.chapters || []);
  for (const chapter of probeChapters) {
    try {
      const pagesPayload = await provider.fetchChapterPages(chapter.id);
      const pageUrls = extractPageUrls(pagesPayload);
      if (pageUrls.length > 0) {
        return {
          chapterId: chapter.id,
          pageCount: pageUrls.length,
        };
      }
    } catch (_) {
      continue;
    }
  }

  return null;
}

async function validateProviderSourceMapping(mapping) {
  if (!mapping?.provider || !mapping?.providerId) return false;

  const provider = providers[mapping.provider];
  if (!provider) return false;

  try {
    const info = await provider.fetchInfo(mapping.providerId);
    const chapterCount = Array.isArray(info?.chapters) ? info.chapters.length : 0;
    if (chapterCount <= 0) {
      return false;
    }

    const probe = await probeReadableCandidate(mapping.provider, info);
    return Boolean(probe?.pageCount);
  } catch (_) {
    return false;
  }
}

async function resolveBestFallbackProvider(manga, cachedMapping = null) {
  if (cachedMapping?.provider && cachedMapping?.providerId) {
    return cachedMapping;
  }

  const candidateTitles = buildCandidateTitles(manga);
  if (candidateTitles.length === 0) return null;

  let best = null;

  for (const providerKey of PROVIDER_PRIORITY) {
    const providerStartedAt = Date.now();
    const provider = providers[providerKey];
    const providerCandidates = await collectProviderCandidates(providerKey, candidateTitles);

    for (const candidate of providerCandidates) {
      if ((Date.now() - providerStartedAt) > PROVIDER_RESOLUTION_BUDGET_MS) {
        break;
      }
      try {
        const info = await provider.fetchInfo(candidate.providerId);
        const chapterCount = Array.isArray(info?.chapters) ? info.chapters.length : 0;
        const probe = await probeReadableCandidate(providerKey, info);
        if (!probe?.pageCount) {
          continue;
        }
        const score =
          candidate.matchScore +
          scoreCoverage(chapterCount, manga.chapters) +
          (PROVIDER_PRIORITY.length - PROVIDER_PRIORITY.indexOf(providerKey));

        if (!best || score > best.score) {
          best = {
            provider: providerKey,
            providerId: candidate.providerId,
            providerTitle: candidate.providerTitle,
            chapterCount,
            probePageCount: probe.pageCount,
            score,
            updatedAt: new Date().toISOString(),
          };
        }
      } catch (_) {
        continue;
      }
    }
  }

  return best;
}

async function resolveFallbackProviderCandidates(manga) {
  const candidateTitles = buildCandidateTitles(manga);
  if (candidateTitles.length === 0) return [];

  const ranked = [];

  for (const providerKey of PROVIDER_PRIORITY) {
    const providerStartedAt = Date.now();
    const provider = providers[providerKey];
    const providerCandidates = await collectProviderCandidates(providerKey, candidateTitles);

    for (const candidate of providerCandidates) {
      if ((Date.now() - providerStartedAt) > PROVIDER_RESOLUTION_BUDGET_MS) {
        break;
      }
      try {
        const info = await provider.fetchInfo(candidate.providerId);
        const chapterCount = Array.isArray(info?.chapters) ? info.chapters.length : 0;
        const probe = await probeReadableCandidate(providerKey, info);
        if (!probe?.pageCount) {
          continue;
        }
        const score =
          candidate.matchScore +
          scoreCoverage(chapterCount, manga.chapters) +
          (PROVIDER_PRIORITY.length - PROVIDER_PRIORITY.indexOf(providerKey));

        ranked.push({
          provider: providerKey,
          providerId: candidate.providerId,
          providerTitle: candidate.providerTitle,
          chapterCount,
          probePageCount: probe.pageCount,
          score,
          updatedAt: new Date().toISOString(),
        });
      } catch (_) {
        continue;
      }
    }
  }

  return Array.from(
    new Map(
      ranked
        .sort((a, b) => {
          const providerRankA = PROVIDER_PRIORITY.indexOf(a.provider);
          const providerRankB = PROVIDER_PRIORITY.indexOf(b.provider);
          if (providerRankA !== providerRankB) {
            return providerRankA - providerRankB;
          }
          return b.score - a.score;
        })
        .map((item) => [`${item.provider}:${item.providerId}`, item]),
    ).values(),
  );
}

async function discoverProviderTitlesForManga(manga, limit = 6) {
  const candidateTitles = buildCandidateTitles(manga);
  if (candidateTitles.length === 0) return [];

  const discovered = [];

  for (const providerKey of PROVIDER_PRIORITY) {
    const providerCandidates = await collectProviderCandidates(providerKey, candidateTitles);
    for (const candidate of providerCandidates) {
      const title = String(candidate.providerTitle || '').trim();
      if (!title) continue;
      discovered.push({
        provider: providerKey,
        title,
        score: candidate.matchScore,
      });
    }
  }

  return Array.from(
    new Map(
      discovered
        .sort((a, b) => b.score - a.score)
        .map((item) => [normalizeText(item.title), item]),
    ).values(),
  )
    .slice(0, limit);
}

function normalizeProviderChapter(providerKey, chapter, pageUrls, manga = null) {
  const chapterNumber = parseProviderChapterNumber(providerKey, chapter, manga);
  return {
    id: `${providerKey}:${chapter.id}`,
    provider: providerKey,
    providerChapterId: String(chapter.id || ''),
    title: String(chapter.title || chapter.chapter || '').trim(),
    chapter: chapterNumber == null ? '' : String(chapterNumber),
    volume: chapter.volumeNumber != null ? String(chapter.volumeNumber) : '',
    language: 'en',
    pages: Array.isArray(pageUrls) ? pageUrls.length : 0,
    pageUrls: Array.isArray(pageUrls) ? pageUrls : [],
    imageHeaders: PROVIDER_HEADERS[providerKey] || {},
    publishedAt: chapter.releaseDate || chapter.releasedDate || null,
    externalUrl: null,
    scanlationGroup: PROVIDER_LABELS[providerKey] || providerKey,
    sourceType: 'fallback_reader',
  };
}

module.exports = {
  PROVIDER_PRIORITY,
  PROVIDER_HEADERS,
  PROVIDER_LABELS,
  providers,
  buildCandidateTitles,
  buildProviderChapterContext,
  discoverProviderTitlesForManga,
  parseChapterNumber,
  parseProviderChapterNumber,
  resolveBestFallbackProvider,
  resolveFallbackProviderCandidates,
  validateProviderSourceMapping,
  normalizeProviderChapter,
};
