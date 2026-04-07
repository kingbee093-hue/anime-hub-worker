const { MANGA } = require('@consumet/extensions');

const PROVIDER_PRIORITY = ['mangapill', 'weebcentral', 'mangahere'];
const PROVIDER_HEADERS = {
  weebcentral: {
    Referer: 'https://weebcentral.com',
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
};

const PROVIDER_LABELS = {
  weebcentral: 'WeebCentral',
  mangapill: 'MangaPill',
  mangahere: 'MangaHere',
};
const MAX_SEARCH_RESULTS_PER_QUERY = 3;
const MAX_PROVIDER_CANDIDATES = 2;
const PROVIDER_SEARCH_TIMEOUT_MS = Number(process.env.MANGA_PROVIDER_SEARCH_TIMEOUT_MS || 12000);
const PROVIDER_INFO_TIMEOUT_MS = Number(process.env.MANGA_PROVIDER_INFO_TIMEOUT_MS || 15000);
const PROVIDER_PAGES_TIMEOUT_MS = Number(process.env.MANGA_PROVIDER_PAGES_TIMEOUT_MS || 15000);
const PROVIDER_PROBE_CHAPTER_LIMIT = Number(process.env.MANGA_PROVIDER_PROBE_CHAPTER_LIMIT || 1);
const PROVIDER_RESOLUTION_BUDGET_MS = Number(process.env.MANGA_PROVIDER_RESOLUTION_BUDGET_MS || 45000);

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
  const match = normalized.match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const parsed = Number.parseFloat(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
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
    dedupeKey: normalizeText(providerTitle) || providerId,
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

  for (const query of candidateTitles) {
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

  const dedupedByTitle = new Map();
  for (const item of rankedMap.values()) {
    const existing = dedupedByTitle.get(item.dedupeKey);
    if (!existing || item.matchScore > existing.matchScore) {
      dedupedByTitle.set(item.dedupeKey, item);
    }
  }

  return Array.from(dedupedByTitle.values())
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
    const result = await withTimeout(
      this.client.search(query),
      PROVIDER_SEARCH_TIMEOUT_MS,
      `${this.label} search`,
    );
    return Array.isArray(result?.results) ? result.results : [];
  }

  async fetchInfo(id) {
    return withTimeout(
      this.client.fetchMangaInfo(id),
      PROVIDER_INFO_TIMEOUT_MS,
      `${this.label} fetchInfo`,
    );
  }

  async fetchChapterPages(chapterId) {
    return withTimeout(
      this.client.fetchChapterPages(chapterId),
      PROVIDER_PAGES_TIMEOUT_MS,
      `${this.label} fetchChapterPages`,
    );
  }
}

const providers = {
  weebcentral: new FallbackProviderClient('weebcentral', () => new MANGA.WeebCentral()),
  mangapill: new FallbackProviderClient('mangapill', () => new MANGA.MangaPill()),
  mangahere: new FallbackProviderClient('mangahere', () => new MANGA.MangaHere()),
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

function normalizeProviderChapter(providerKey, chapter, pageUrls) {
  const chapterNumber = parseChapterNumber(chapter.chapter || chapter.chapterNumber || chapter.title);
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
  discoverProviderTitlesForManga,
  parseChapterNumber,
  resolveBestFallbackProvider,
  resolveFallbackProviderCandidates,
  validateProviderSourceMapping,
  normalizeProviderChapter,
};
