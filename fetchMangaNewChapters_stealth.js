const fs = require('fs');
const path = require('path');
const axios = require('axios');

const CONFIG = require('./src/config/constants');
const { delay, convertMangaToFirestoreFormat } = require('./src/utils/formatters');
const { 
  getSecureHeaders, 
  computeRetryDelayMs, 
  getStealthDelay, 
  performCamouflageRequest,
  fetchGraphQL 
} = require('./fetchHelper_stealth');

const { isAdultContent, isManga } = require('./src/utils/filters');
const {
  getMangaCatalogEntries,
  getChapterManifest,
  buildChapterIndexId,
} = require('./src/utils/mangaBackfillData');
const { writeJsonIfChanged } = require('./src/utils/writeJsonIfChanged');
const { buildReleasingSection } = require('./src/utils/mangaSections');
const { META } = require('@consumet/extensions');

const MANGADEX_API = 'https://api.mangadex.org';
const FRESH_HOURS = Number(process.env.MANGA_NEW_CHAPTERS_FRESH_HOURS || 48);
const MAX_ATTEMPTS = Number(process.env.MANGA_NEW_CHAPTERS_MAX_ATTEMPTS || 4);
const RETRY_DELAY_MS = Number(process.env.MANGA_NEW_CHAPTERS_RETRY_DELAY_MS || 3000);
const REQUEST_DELAY_MS = Number(process.env.MANGA_NEW_CHAPTERS_REQUEST_DELAY_MS || 350);
const SECTION_LIMIT_RAW = Number(process.env.MANGA_NEW_CHAPTERS_LIMIT || 0);
const MAX_FEED_PAGES = Number(process.env.MANGA_NEW_CHAPTERS_MAX_FEED_PAGES || 100);
const DISCOVERY_LIMIT = Math.max(0, Number(process.env.MANGA_NEW_CHAPTERS_DISCOVERY_LIMIT || 300));
const discoveryFailures = [];

const SEARCH_RESULTS_LIMIT = Math.max(1, Number(process.env.MANGA_NEW_CHAPTERS_SEARCH_RESULTS_LIMIT || 10));
const FAILURE_COOLDOWN_HOURS = Math.max(1, Number(process.env.MANGA_NEW_CHAPTERS_FAILURE_COOLDOWN_HOURS || 12));
const MATCHER_VERSION = Number(process.env.MANGA_NEW_CHAPTERS_MATCHER_VERSION || 2);
const REQUEST_HOST_COOLDOWN_MS = Math.max(1000, Number(process.env.MANGA_NEW_CHAPTERS_HOST_COOLDOWN_MS || 12000));
const REQUEST_HOST_CIRCUIT_THRESHOLD = Math.max(2, Number(process.env.MANGA_NEW_CHAPTERS_HOST_CIRCUIT_THRESHOLD || 4));
const REQUEST_HOST_CIRCUIT_MS = Math.max(10000, Number(process.env.MANGA_NEW_CHAPTERS_HOST_CIRCUIT_MS || 180000));
const REQUEST_HOST_PREWAIT_MAX_MS = Math.max(5000, Number(process.env.MANGA_NEW_CHAPTERS_HOST_PREWAIT_MAX_MS || 90000));
const REQUEST_HEALTH_PRUNE_HOURS = Math.max(12, Number(process.env.MANGA_NEW_CHAPTERS_REQUEST_HEALTH_PRUNE_HOURS || 168));
const ALLOWED_LANGUAGES = String(process.env.MANGA_NEW_CHAPTERS_LANGUAGES || 'en,ar')
  .split(',')
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean);

const CATALOG_PAGE_SIZE = 120;
const GENRE_MAX_ITEMS = 120;
const DEFAULT_SECTION_LIMIT = 24;
const MANGADEX_REQUEST_RETRIES = Math.max(1, Number(process.env.MANGA_NEW_CHAPTERS_REQUEST_RETRIES || 3));

const ANILIST_MANGA_FRAGMENT = `
  id
  idMal
  title { romaji english native userPreferred }
  coverImage { extraLarge large medium color }
  bannerImage
  startDate { year month day }
  endDate { year month day }
  description
  chapters
  volumes
  countryOfOrigin
  source
  updatedAt
  genres
  synonyms
  averageScore
  meanScore
  popularity
  trending
  favourites
  isAdult
  siteUrl
  type
  format
  status
  tags { id name description category rank isGeneralSpoiler isMediaSpoiler isAdult }
  externalLinks { site url }
  staff(perPage: 5) {
    edges {
      role
      node {
        id
        name { full native }
        siteUrl
      }
    }
  }
`;

const ANILIST_MANGA_BY_ID_QUERY = `
query ($id: Int, $idMal: Int) {
  Media(id: $id, idMal: $idMal, type: MANGA) {
    \${ANILIST_MANGA_FRAGMENT}
  }
}
`;

const ANILIST_MANGA_SEARCH_QUERY = `
query ($search: String, $perPage: Int) {
  Page(page: 1, perPage: $perPage) {
    media(type: MANGA, search: $search, sort: [POPULARITY_DESC, SCORE_DESC]) {
      \${ANILIST_MANGA_FRAGMENT}
    }
  }
}
`;

/** 🚀 STEALTH UTILITIES 🚀 **/

function shuffleArray(array) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function getRandomFeedPageSize() {
  // Randomize between 70 and 100 to change request signature
  return Math.floor(Math.random() * 31) + 70;
}

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
  const byMangaId = new Map();

  for (const entry of entries || []) {
    if (!entry || !entry.mangaId) continue;
    byMangaId.set(String(entry.mangaId), entry);
    if (entry.mangadexId) {
      byMangadexId.set(String(entry.mangadexId), entry);
    }
    if (entry.chapterIndexId) {
      byChapterIndexId.set(String(entry.chapterIndexId), entry);
    }
  }

  return { byMangadexId, byChapterIndexId, byMangaId };
}

function getChapterManifestMap(manifest) {
  const sourceManifest = manifest || getChapterManifest();
  const items = Array.isArray(sourceManifest?.items) ? sourceManifest.items : [];
  return new Map(
    items
      .map((item) => [String(item.chapterIndexId || item.mangadexId || ''), item])
      .filter(([key]) => Boolean(key)),
  );
}

function extractMangaId(relationships = []) {
  const mangaRel = (Array.isArray(relationships) ? relationships : [])
    .find((rel) => rel?.type === 'manga' && rel?.id);
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

function normalizeSearchText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF\u3040-\u30ff\u3400-\u9fff\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isPureASCII(str) {
  return /^[\x00-\x7F]*$/.test(str);
}

function buildSearchTitleVariants(titles) {
  const variants = new Set();

  function addVariant(value) {
    const raw = String(value || '').trim();
    if (raw.length < 2) return;
    variants.add(raw);

    const stripped = [
      raw.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim(),
      raw.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim(),
      raw.replace(/["'`“”‘’]/g, '').trim(),
    ];

    for (const candidate of stripped) {
      if (candidate.length >= 2) {
        variants.add(candidate);
      }
    }

    const separators = [' : ', ':', ' - ', '-', ' ~ ', '~', ' @', '@', ' | ', '|'];
    for (const separator of separators) {
      if (!raw.includes(separator)) continue;
      const left = raw.split(separator)[0].trim();
      const right = raw.split(separator).slice(1).join(separator).trim();
      if (left.length >= 3) variants.add(left);
      if (right.length >= 3 && right.split(/\s+/).length <= 6) variants.add(right);
    }
  }

  for (const title of titles || []) {
    addVariant(title);
  }

  return Array.from(variants);
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

function getDiscoveredEntriesPath() {
  return path.join(__dirname, 'api', `\${CONFIG.API_PATHS.MANGA_DISCOVERED_CATALOG}.json`);
}

function readDiscoveredCatalogEntries() {
  return parseExistingItems(getDiscoveredEntriesPath());
}

function writeDiscoveredCatalogEntries(items) {
  writeJsonIfChanged(CONFIG.API_PATHS.MANGA_DISCOVERED_CATALOG, items);
}

function readDiscoveryState() {
  const filePath = path.join(__dirname, 'api', `\${CONFIG.API_PATHS.MANGA_DISCOVERY_STATE}.json`);
  console.log(`[Debug] Reading discovery state from: \${filePath}`);
  const parsed = readJsonFile(filePath, {});
  console.log(`[Debug] Discovery state entries: \${Object.keys(parsed || {}).length}`);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function writeDiscoveryState(state) {
  writeJsonIfChanged(CONFIG.API_PATHS.MANGA_DISCOVERY_STATE, state);
}

function writeDiscoveryReport(report) {
  writeJsonIfChanged(CONFIG.API_PATHS.MANGA_DISCOVERY_REPORT, report);
}

function readRequestHealth() {
  const filePath = path.join(__dirname, 'api', `\${CONFIG.API_PATHS.MANGA_REQUEST_HEALTH}.json`);
  const parsed = readJsonFile(filePath, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function writeRequestHealth(state) {
  writeJsonIfChanged(CONFIG.API_PATHS.MANGA_REQUEST_HEALTH, state);
}

const requestHealthState = readRequestHealth();
let requestHealthDirty = false;

function getRequestHostKey(url, fallbackLabel = 'request') {
  try {
    return new URL(url).host || fallbackLabel;
  } catch (_) {
    return fallbackLabel;
  }
}

function getRequestHealthEntry(hostKey) {
  if (!requestHealthState[hostKey] || typeof requestHealthState[hostKey] !== 'object') {
    requestHealthState[hostKey] = {
      host: hostKey,
      consecutiveFailures: 0,
      totalFailures: 0,
      totalSuccesses: 0,
      lastFailureAt: null,
      lastSuccessAt: null,
      lastStatus: null,
      cooldownUntil: null,
      circuitOpenUntil: null,
      lastError: null,
    };
    requestHealthDirty = true;
  }

  return requestHealthState[hostKey];
}

function getRequestHealthWaitMs(entry) {
  const now = Date.now();
  const cooldownUntil = new Date(entry?.cooldownUntil || 0).getTime();
  const circuitOpenUntil = new Date(entry?.circuitOpenUntil || 0).getTime();
  return Math.max(
    Number.isFinite(cooldownUntil) ? Math.max(0, cooldownUntil - now) : 0,
    Number.isFinite(circuitOpenUntil) ? Math.max(0, circuitOpenUntil - now) : 0,
  );
}

function pruneRequestHealthState() {
  const cutoffMs = Date.now() - (REQUEST_HEALTH_PRUNE_HOURS * 60 * 60 * 1000);
  for (const [hostKey, entry] of Object.entries(requestHealthState)) {
    const lastTouchedMs = Math.max(
      new Date(entry?.lastFailureAt || 0).getTime(),
      new Date(entry?.lastSuccessAt || 0).getTime(),
    );
    const activeWaitMs = getRequestHealthWaitMs(entry);
    if ((Number.isFinite(lastTouchedMs) && lastTouchedMs > 0 && lastTouchedMs < cutoffMs) && activeWaitMs <= 0) {
      delete requestHealthState[hostKey];
      requestHealthDirty = true;
    }
  }
}

async function waitForHostAvailability(hostKey, label) {
  const entry = getRequestHealthEntry(hostKey);
  const waitMs = getRequestHealthWaitMs(entry);
  if (waitMs <= 0) {
    return;
  }

  if (waitMs > REQUEST_HOST_PREWAIT_MAX_MS) {
    throw new Error(
      `host cooldown active for \${hostKey} before \${label}; remaining \${(waitMs / 1000).toFixed(1)}s exceeds prewait cap`,
    );
  }

  console.log(
    `Host \${hostKey} cooling down before \${label}; waiting \${(waitMs / 1000).toFixed(1)}s.`,
  );
  await delay(waitMs);
}

function markRequestSuccess(hostKey) {
  const entry = getRequestHealthEntry(hostKey);
  entry.consecutiveFailures = 0;
  entry.totalSuccesses = Number(entry.totalSuccesses || 0) + 1;
  entry.lastSuccessAt = new Date().toISOString();
  entry.lastStatus = 200;
  entry.cooldownUntil = null;
  entry.circuitOpenUntil = null;
  entry.lastError = null;

  requestHealthDirty = true;
}

function markRequestFailure(hostKey, error, waitTimeMs) {
  const entry = getRequestHealthEntry(hostKey);
  const status = Number(error?.response?.status || 0) || null;
  const nowIso = new Date().toISOString();
  const isRateLimited = status === 429;
  const isTemporary =
    isRateLimited ||
    status === 403 ||
    status === 408 ||
    status === 409 ||
    status === 423 ||
    status === 425 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    !status;

  entry.consecutiveFailures = Number(entry.consecutiveFailures || 0) + 1;
  entry.totalFailures = Number(entry.totalFailures || 0) + 1;
  entry.lastFailureAt = nowIso;
  entry.lastStatus = status;
  entry.lastError = String(error?.message || 'request_failed');

  const cooldownMs = Math.max(waitTimeMs || 0, isTemporary ? REQUEST_HOST_COOLDOWN_MS : 0);
  if (cooldownMs > 0) {
    const nextIso = new Date(Date.now() + cooldownMs).toISOString();
    if (!entry.cooldownUntil || new Date(entry.cooldownUntil).getTime() < new Date(nextIso).getTime()) {
      entry.cooldownUntil = nextIso;
    }
  }

  if (isTemporary && entry.consecutiveFailures >= REQUEST_HOST_CIRCUIT_THRESHOLD) {
    entry.circuitOpenUntil = new Date(Date.now() + REQUEST_HOST_CIRCUIT_MS).toISOString();
  }

  requestHealthDirty = true;
}

function getRequestHealthSummary() {
  const entries = Object.values(requestHealthState);
  const now = Date.now();
  const cooling = entries.filter((entry) => new Date(entry?.cooldownUntil || 0).getTime() > now).length;
  const openCircuits = entries.filter((entry) => new Date(entry?.circuitOpenUntil || 0).getTime() > now).length;
  return {
    hosts: entries.length,
    cooling,
    openCircuits,
  };
}

async function requestJsonWithRetries(url, options = {}, label = 'request') {
  const hostKey = getRequestHostKey(url, label);
  let attempt = 0;
  while (attempt < MANGADEX_REQUEST_RETRIES) {
    try {
      await waitForHostAvailability(hostKey, label);
      await performCamouflageRequest();

      const response = await axios.get(url, {
        ...options,
        headers: {
          ...getSecureHeaders(url),
          ...(options.headers || {}),
        },
      });
      markRequestSuccess(hostKey);
      return response;
    } catch (error) {
      attempt += 1;
      const statusText = error.response ? `[\${error.response.status}]` : '[Network]';
      console.error(`API request failed \${statusText} for \${label} (Attempt \${attempt}/\${MANGADEX_REQUEST_RETRIES}): \${error.message}`);
      const waitTimeMs = computeRetryDelayMs(attempt, error);
      markRequestFailure(hostKey, error, waitTimeMs);
      if (attempt >= MANGADEX_REQUEST_RETRIES) {
        throw error;
      }
      console.log(`Retrying \${label} in \${(waitTimeMs / 1000).toFixed(1)}s...`);
      await delay(waitTimeMs);
    }
  }
  throw new Error(`\${label} failed after \${MANGADEX_REQUEST_RETRIES} attempts`);
}

function summarizeRecentItem(recentItem, extra = {}) {
  return {
    mangadexId: String(recentItem?.mangaId || ''),
    chapterId: String(recentItem?.chapterId || ''),
    chapter: String(recentItem?.chapter || ''),
    title: String(extra.title || recentItem?.title || ''),
    chapterTitle: String(recentItem?.title || ''),
    language: String(recentItem?.language || ''),
    publishedAt: recentItem?.publishedAt || null,
    ...extra,
  };
}

function isRecentFailureState(stateEntry, recentItem) {
  if (!stateEntry || stateEntry.status !== 'failed') return false;
  if (String(stateEntry.lastChapterId || '') !== String(recentItem.chapterId || '')) return false;
  if (Number(stateEntry.matcherVersion || 1) !== MATCHER_VERSION) return false;
  const lastAttemptMs = new Date(stateEntry.lastAttemptAt || 0).getTime();
  if (!Number.isFinite(lastAttemptMs) || lastAttemptMs <= 0) return false;
  return (Date.now() - lastAttemptMs) < (FAILURE_COOLDOWN_HOURS * 60 * 60 * 1000);
}

function mergeCatalogEntries(baseEntries, discoveredEntries) {
  const merged = new Map();
  for (const item of [...(baseEntries || []), ...(discoveredEntries || [])]) {
    if (!item?.mangaId) continue;
    merged.set(String(item.mangaId), {
      ...(merged.get(String(item.mangaId)) || {}),
      ...item,
    });
  }
  return sortCatalog(Array.from(merged.values()));
}

function extractMangadexTitles(details) {
  const attributes = details?.attributes || {};
  const directTitles = Object.values(attributes.title || {}).map((value) => String(value || '').trim());

  const altTitles = (attributes.altTitles || [])
    .flatMap((item) => Object.values(item || {}))
    .map((value) => String(value || '').trim());

  return Array.from(
    new Set([...directTitles, ...altTitles].filter((value) => value.length >= 2)),
  );
}

function getPrimaryMangadexTitle(details) {
  const titles = extractMangadexTitles(details);
  return titles[0] || 'Unknown Title';
}

function extractAniListLinkId(details) {
  const links = details?.attributes?.links || {};
  const raw = links.al;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function extractMalLinkId(details) {
  const links = details?.attributes?.links || {};
  const raw = links.mal;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function extractIdFromText(text, regex) {
  if (!text) return null;
  const match = text.match(regex);
  const parsed = match ? Number(match[1]) : null;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}


function buildTitleScore(media, titles, year) {
  const candidateTitles = [
    media?.title?.english,
    media?.title?.romaji,
    media?.title?.native,
    ...(media?.synonyms || []),
  ]
    .map((value) => normalizeSearchText(value))
    .filter(Boolean);

  const searchTitles = titles.map((value) => normalizeSearchText(value)).filter(Boolean);
  let score = 0;

  for (const searchTitle of searchTitles) {
    for (const candidate of candidateTitles) {
      if (candidate === searchTitle) {
        score += 120;
      } else if (candidate.includes(searchTitle) || searchTitle.includes(candidate)) {
        score += 60;
      } else {
        const searchTokens = searchTitle.split(' ').filter((token) => token.length >= 3);
        const candidateTokens = candidate.split(' ').filter((token) => token.length >= 3);
        const overlap = searchTokens.filter((token) => candidateTokens.includes(token)).length;
        if (overlap >= 2) {
          score += overlap * 18;
        } else if (overlap === 1) {
          score += 8;
        }
      }
    }
  }

  if (year && media?.startDate?.year) {
    const delta = Math.abs(Number(media.startDate.year) - Number(year));
    if (delta === 0) score += 30;
    else if (delta <= 1) score += 15;
  }

  score += Number(media?.popularity || 0) / 1000;
  score += Number(media?.averageScore || 0) / 100;
  return score;
}

function parseIntegerChapter(value) {
  const text = String(value || '').trim();
  if (!/^\\d+(?:\\.0+)?\$/.test(text)) {
    return null;
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.floor(parsed);
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

function buildChapterIndexPayload(entry, languages, extra = {}) {
  const availableLanguages = Object.keys(languages).filter((language) =>
    Array.isArray(languages[language]) && languages[language].length > 0,
  );

  return {
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
    chapterSourceProvider: entry.chapterSourceProvider || 'mangadex',
    chapterSourceId: entry.chapterSourceId || entry.mangadexId,
    chapterSourceTitle: entry.chapterSourceTitle || entry.title,
    englishFallbackProvider: null,
    englishFallbackProviderTitle: null,
    englishFallbackChapterCount: null,
    ...extra,
  };
}

async function fetchRecentMangaDexFeed() {
  const cutoffMs = Date.now() - (FRESH_HOURS * 60 * 60 * 1000);
  const latestByManga = new Map();
  let totalRows = 0;
  let fetchedPages = 0;

  for (let page = 0; page < MAX_FEED_PAGES; page++) {
    const offset = page * 100; // Original was FEED_PAGE_SIZE, we use 100 for safety but limit loop
    const limit = getRandomFeedPageSize();
    
    const response = await requestJsonWithRetries(`\${MANGADEX_API}/chapter`, {
      params: {
        limit: limit,
        offset: page * limit,
        'order[publishAt]': 'desc',
        'order[createdAt]': 'desc',
        includeFuturePublishAt: 0,
        includeEmptyPages: 0,
        includeExternalUrl: 0,
        contentRating: ['safe', 'suggestive'],
        translatedLanguage: ALLOWED_LANGUAGES,
      },
      timeout: 45000,
    }, `mangadex recent feed page \${page + 1}`);

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
      if (!Number.isFinite(publishedMs) || publishedMs <= 0 || publishedMs < cutoffMs) {
        continue;
      }

      pageHasFreshRows = true;
      const mangaId = extractMangaId(row.relationships);
      if (!mangaId) continue;

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

    const stealthDelay = await getStealthDelay(REQUEST_DELAY_MS);
    await delay(stealthDelay);
  }

  return {
    items: Array.from(latestByManga.values()),
    totalRows,
    fetchedPages,
    cutoffIso: new Date(cutoffMs).toISOString(),
  };
}

async function fetchMangaDexMangaDetails(mangaId, cache) {
  if (cache.has(mangaId)) {
    return cache.get(mangaId);
  }

  const response = await requestJsonWithRetries(`\${MANGADEX_API}/manga/\${mangaId}`, {
    params: {
      includes: ['cover_art', 'author', 'artist'],
    },
    timeout: 30000,
  }, `mangadex manga details \${mangaId}`);

  const details = response.data?.data;
  if (details) {
    cache.set(mangaId, details);
  }
  return details;
}
