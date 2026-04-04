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

class FallbackProviderClient {
  constructor(key, factory) {
    this.key = key;
    this.label = PROVIDER_LABELS[key] || key;
    this.headers = PROVIDER_HEADERS[key] || {};
    this.client = factory();
  }

  async search(query) {
    const result = await this.client.search(query);
    return Array.isArray(result?.results) ? result.results : [];
  }

  async fetchInfo(id) {
    return this.client.fetchMangaInfo(id);
  }

  async fetchChapterPages(chapterId) {
    return this.client.fetchChapterPages(chapterId);
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

async function resolveBestFallbackProvider(manga, cachedMapping = null) {
  if (cachedMapping?.provider && cachedMapping?.providerId) {
    return cachedMapping;
  }

  const candidateTitles = buildCandidateTitles(manga);
  if (candidateTitles.length === 0) return null;

  let best = null;

  for (const providerKey of PROVIDER_PRIORITY) {
    const provider = providers[providerKey];
    for (const query of candidateTitles) {
      let searchResults = [];
      try {
        searchResults = await provider.search(query);
      } catch (_) {
        continue;
      }

      for (const candidate of searchResults.slice(0, 4)) {
        const matchScore = titleScore(candidate.title, candidateTitles);
        if (matchScore < 55) {
          continue;
        }

        try {
          const info = await provider.fetchInfo(candidate.id);
          const chapterCount = Array.isArray(info?.chapters) ? info.chapters.length : 0;
          const score =
            matchScore +
            scoreCoverage(chapterCount, manga.chapters) +
            (PROVIDER_PRIORITY.length - PROVIDER_PRIORITY.indexOf(providerKey));

          if (!best || score > best.score) {
            best = {
              provider: providerKey,
              providerId: candidate.id,
              providerTitle: typeof candidate.title === 'string' ? candidate.title : query,
              chapterCount,
              score,
              updatedAt: new Date().toISOString(),
            };
          }
        } catch (_) {
          continue;
        }
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
    const provider = providers[providerKey];
    for (const query of candidateTitles) {
      let searchResults = [];
      try {
        searchResults = await provider.search(query);
      } catch (_) {
        continue;
      }

      for (const candidate of searchResults.slice(0, 4)) {
        const matchScore = titleScore(candidate.title, candidateTitles);
        if (matchScore < 55) {
          continue;
        }

        try {
          const info = await provider.fetchInfo(candidate.id);
          const chapterCount = Array.isArray(info?.chapters) ? info.chapters.length : 0;
          const score =
            matchScore +
            scoreCoverage(chapterCount, manga.chapters) +
            (PROVIDER_PRIORITY.length - PROVIDER_PRIORITY.indexOf(providerKey));

          ranked.push({
            provider: providerKey,
            providerId: candidate.id,
            providerTitle: typeof candidate.title === 'string' ? candidate.title : query,
            chapterCount,
            score,
            updatedAt: new Date().toISOString(),
          });
        } catch (_) {
          continue;
        }
      }
    }
  }

  return Array.from(
    new Map(
      ranked
        .sort((a, b) => b.score - a.score)
        .map((item) => [`${item.provider}:${item.providerId}`, item]),
    ).values(),
  );
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
  parseChapterNumber,
  resolveBestFallbackProvider,
  resolveFallbackProviderCandidates,
  normalizeProviderChapter,
};
