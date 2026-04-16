const axios = require('axios');
const fs = require('fs');
const path = require('path');
const CONFIG = require('../config/constants');
const { delay } = require('./formatters');

const MODERN_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
];

const MANGADEX_API = 'https://api.mangadex.org';
const ANILIST_API = 'https://graphql.anilist.co';

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5000;
const REQUEST_DELAY_MS = 1500;

// Configuration from environment variables
const FRESH_HOURS = Number(process.env.MANGA_NEW_CHAPTERS_FRESH_HOURS || 48);
const SECTION_LIMIT_RAW = Number(process.env.MANGA_NEW_CHAPTERS_LIMIT || 0);
const MAX_FEED_PAGES = Number(process.env.MANGA_NEW_CHAPTERS_MAX_FEED_PAGES || 100);
const DISCOVERY_LIMIT = Math.max(0, Number(process.env.MANGA_NEW_CHAPTERS_DISCOVERY_LIMIT || 300));
const discoveryFailures = [];

const SEARCH_RESULTS_LIMIT = Math.max(1, Number(process.env.MANGA_NEW_CHAPTERS_SEARCH_RESULTS_LIMIT || 10));
const FAILURE_COOLDOWN_HOURS = Math.max(1, Number(process.env.MANGA_NEW_CHAPTERS_FAILURE_COOLDOWN_HOURS || 12));
const MATCHER_VERSION = Number(process.env.MANGA_NEW_CHAPTERS_MATCHER_VERSION || 2);

const { 
  requestJsonWithRetries, 
  getRequestHealthSummary, 
  pruneRequestHealthState,
  writeRequestHealth,
  requestHealthState,
} = require('./fetchHelper');
let { requestHealthDirty } = require('./fetchHelper');

/**
 * GraphQL Queries
 */
const ANILIST_MANGA_SEARCH_QUERY = `
query ($search: String, $perPage: Int) {
  Page(page: 1, perPage: $perPage) {
    media(search: $search, type: MANGA, sort: SEARCH_MATCH) {
      id
      idMal
      title {
        romaji
        english
        native
      }
      format
      status
      isAdult
      synonyms
      startDate {
        year
      }
    }
  }
}
`;

const ANILIST_MANGA_BY_ID_QUERY = `
query ($id: Int, $idMal: Int) {
  Media(id: $id, idMal: $idMal, type: MANGA) {
    id
    idMal
    title {
      romaji
      english
      native
    }
    format
    status
    isAdult
    synonyms
    startDate {
      year
    }
  }
}
`;

/**
 * Helper: Pure ASCII check to prioritize safe search terms
 */
function isPureASCII(str) {
  return /^[\x00-\x7F]*$/.test(str);
}

/**
 * Helper: Filter out non-manga or adult results based on standard safety rules
 */
function isManga(media) {
  const allowedFormats = ['MANGA', 'ONE_SHOT'];
  return {
    allowed: allowedFormats.includes(media.format),
    reason: allowedFormats.includes(media.format) ? '' : `Invalid format: ${media.format}`
  };
}

function isAdultContent(media) {
  if (media.isAdult) return { blocked: true, reason: 'Explicitly marked as Adult' };
  return { blocked: false };
}

/**
 * Helper: Build common title variants for better matching
 */
function buildSearchTitleVariants(titles) {
  const variants = new Set();
  titles.forEach(t => {
    if (!t) return;
    variants.add(t);
    // Remove "Season X" or similar suffixes often found in MangaDex
    const cleaned = t.replace(/\s+(Season|Part)\s+\d+/i, '').trim();
    if (cleaned !== t) variants.add(cleaned);
  });
  return Array.from(variants);
}

/**
 * Helper: Calculate similarity score between two strings
 */
function calculateSimilarity(s1, s2) {
  if (!s1 || !s2) return 0;
  const a = s1.toLowerCase().trim();
  const b = s2.toLowerCase().trim();
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return 85;
  return 0; // Simplified for performance
}

/**
 * Helper: Build a score for a media candidate
 */
function buildTitleScore(media, targetTitles, targetYear) {
  let maxScore = 0;
  const candidates = [
    media.title.romaji,
    media.title.english,
    media.title.native,
    ...(media.synonyms || [])
  ].filter(Boolean);

  for (const target of targetTitles) {
    for (const cand of candidates) {
      const score = calculateSimilarity(target, cand);
      if (score > maxScore) maxScore = score;
    }
  }

  // Bonus/Penalty for year match
  if (targetYear && media.startDate?.year) {
    if (media.startDate.year === targetYear) maxScore += 20;
    else if (Math.abs(media.startDate.year - targetYear) <= 1) maxScore += 10;
  }

  return maxScore;
}

/**
 * Helper: Get failure cache
 */
function getFailureCache() {
  const cachePath = path.join(process.cwd(), '.tmp_worker', 'discovery_failures.json');
  try {
    if (fs.existsSync(cachePath)) {
      return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function saveFailure(mangaId) {
  const cachePath = path.join(process.cwd(), '.tmp_worker', 'discovery_failures.json');
  const cache = getFailureCache();
  cache[mangaId] = {
    timestamp: Date.now(),
    version: MATCHER_VERSION
  };
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
}

function isRecentFailure(mangaId) {
  const cache = getFailureCache();
  const entry = cache[mangaId];
  if (!entry) return false;
  
  // If matcher version changed, retry all
  if (entry.version !== MATCHER_VERSION) return false;

  const hoursSince = (Date.now() - entry.timestamp) / (1000 * 60 * 60);
  return hoursSince < FAILURE_COOLDOWN_HOURS;
}

/**
 * Core: Fetch logic
 */
async function fetchGraphQL(query, variables) {
  try {
    const response = await requestJsonWithRetries(ANILIST_API, {
      method: 'POST',
      data: { query, variables }
    }, 'anilist graphql');
    return response.data?.data;
  } catch (e) {
    return null;
  }
}

async function fetchMangaDexDetails(mangaId, cache) {
  if (cache.has(mangaId)) return cache.get(mangaId);
  
  const response = await requestJsonWithRetries(`${MANGADEX_API}/manga/${mangaId}`, {
    params: {
      includes: ['cover_art', 'author', 'artist'],
    },
    timeout: 30000,
  }, `mangadex manga details ${mangaId}`);

  const details = response.data?.data || null;
  cache.set(mangaId, details);
  return details;
}

async function fetchAniListMediaByIds({ anilistId = null, malId = null }) {
  if (!anilistId && !malId) {
    return null;
  }

  const data = await fetchGraphQL(ANILIST_MANGA_BY_ID_QUERY, {
    id: anilistId || undefined,
    idMal: malId || undefined,
  });

  return data?.Media || null;
}

async function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function searchAniListMediaByTitles(titles, year) {
  // Prioritize ASCII titles to avoid Cloudflare WAF issues with Japanese characters
  // Also reduce variants to 1 for Discovery to minimize rate limit pressure
  const variants = buildSearchTitleVariants(titles);
  const asciiVariants = variants.filter(isPureASCII);
  const nonAsciiVariants = variants.filter(v => !isPureASCII(v));
  
  const searchCandidates = [
    ...shuffleArray(asciiVariants), 
    ...shuffleArray(nonAsciiVariants)
  ].slice(0, 2); // Reduced from 3 to 2 to save requests

  let best = null;
  let bestScore = -1;

  for (const title of searchCandidates) {
    if (!title || title.length < 2) continue;
    
    // Explicitly log for diagnostics since we see rejections
    console.log(`[AniList] Searching with term: "${title}"`);

    const data = await fetchGraphQL(ANILIST_MANGA_SEARCH_QUERY, {
      search: title,
      perPage: SEARCH_RESULTS_LIMIT,
    });
    
    if (!data) continue; // Skip if request failed or was blocked

    const candidates = Array.isArray(data?.Page?.media) ? data.Page.media : [];

    for (const media of candidates) {
      const adult = isAdultContent(media);
      const manga = isManga(media);
      if (adult.blocked || !manga.allowed) {
        continue;
      }

      const score = buildTitleScore(media, variants, year);
      if (score > bestScore) {
        best = media;
        bestScore = score;
      }
    }

    if (bestScore >= 120) {
      break;
    }
    
    // Safety delay between title variations
    await delay(1200);
  }

  const result = bestScore >= 45 ? best : null;
  if (!result) {
    discoveryFailures.push({ titles, reason: `No match found (Best score: ${bestScore})` });
  }
  return result;
}

async function fetchChapterPages(chapterId) {
  const response = await requestJsonWithRetries(`${MANGADEX_API}/at-home/server/${chapterId}`, {
    timeout: 10000,
  }, `mangadex chapter pages ${chapterId}`);
  
  const hash = response.data?.chapter?.hash;
  const data = response.data?.chapter?.data || [];
  const baseUrl = response.data?.baseUrl;
  
  if (!hash || !baseUrl || data.length === 0) return [];
  
  return data.map(filename => `${baseUrl}/data/${hash}/${filename}`);
}

async function getRecentMangaDexFeed() {
  const feedItems = [];
  const processedMangaIds = new Set();
  
  for (let page = 0; page < MAX_FEED_PAGES; page++) {
    const offset = page * 100;
    const response = await requestJsonWithRetries(`${MANGADEX_API}/chapter`, {
      params: {
        limit: 100,
        offset,
        translatedLanguage: ['en'],
        order: { readableAt: 'desc' },
        includes: ['manga'],
      },
    }, `mangadex feed page ${page + 1}`);

    const chapters = response.data?.data || [];
    if (chapters.length === 0) break;

    for (const chapter of chapters) {
      const mangaRel = chapter.relationships.find(r => r.type === 'manga');
      if (!mangaRel || processedMangaIds.has(mangaRel.id)) continue;

      const readableAt = new Uint8Array(new TextEncoder().encode(chapter.attributes.readableAt));
      const date = new Date(chapter.attributes.readableAt);
      const hoursDiff = (Date.now() - date.getTime()) / (1000 * 60 * 60);

      if (hoursDiff > FRESH_HOURS) {
        // Since it's ordered by desc, we can stop if we go too far back
        return feedItems;
      }

      feedItems.push({
        mangaId: mangaRel.id,
        chapterId: chapter.id,
        chapterNum: chapter.attributes.chapter,
        title: chapter.attributes.title,
        readableAt: chapter.attributes.readableAt
      });
      processedMangaIds.add(mangaRel.id);
    }
    
    await delay(500); // Small gap between feed pages
  }
  
  return feedItems;
}

async function collectFreshNewChapterItems() {
  const results = [];
  const catalogDir = path.join(process.cwd(), 'api/manga/chapters');
  const catalogCount = fs.existsSync(catalogDir) ? fs.readdirSync(catalogDir).length : 0;
  
  console.log(`Window: last ${FRESH_HOURS} hours. Previous file entries: ${catalogCount}.`);

  const feed = await getRecentMangaDexFeed();
  const mangaDetailsCache = new Map();
  
  let processedCount = 0;
  let discoveredCount = 0;
  let matchedCount = 0;
  let discoveryAttempts = 0;
  
  const stats = {
    known: 0,
    failed: 0,
    skippedRecent: 0,
    skippedLimit: 0,
    cutoffIso: new Date(Date.now() - (FRESH_HOURS * 60 * 60 * 1000)).toISOString()
  };

  for (const entry of feed) {
    const { mangaId } = entry;
    const filePath = path.join(catalogDir, `${mangaId}.json`);
    let mangaData = null;

    if (fs.existsSync(filePath)) {
      mangaData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      stats.known++;
    } else {
      // Discovery Mode
      if (discoveredCount >= DISCOVERY_LIMIT && DISCOVERY_LIMIT > 0) {
        stats.skippedLimit++;
        continue;
      }

      if (isRecentFailure(mangaId)) {
        stats.skippedRecent++;
        continue;
      }

      discoveryAttempts++;
      console.log(`Discovered new manga from recent feed: ${mangaId}`);
      
      try {
        const md = await fetchMangaDexDetails(mangaId, mangaDetailsCache);
        if (!md) throw new Error('MangaDex details empty');

        const titleObj = md.attributes.title || {};
        const titles = Object.values(titleObj).filter(Boolean);
        const altTitles = (md.attributes.altTitles || []).map(at => Object.values(at)).flat().filter(Boolean);
        const year = md.attributes.year;

        const allTitles = [...new Set([...titles, ...altTitles])];
        
        let anilistId = null;
        let malId = null;
        const links = md.attributes.links || {};
        if (links.al) anilistId = parseInt(links.al);
        if (links.mal) malId = parseInt(links.mal);

        let media = null;
        if (anilistId || malId) {
          media = await fetchAniListMediaByIds({ anilistId, malId });
        }
        
        if (!media && allTitles.length > 0) {
          media = await searchAniListMediaByTitles(allTitles, year);
        }

        if (media) {
          mangaData = {
            id: mangaId,
            anilistId: media.id,
            title: media.title.romaji || media.title.english || titles[0],
            image: `https://api.mangadex.org/front-cover/${mangaId}.jpg`, // Optional placeholder if needed
            description: '', // Should fetch full details in a separate step or just leave empty for list
          };
          // Persist the mapping so we don't discovery it again
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, JSON.stringify(mangaData, null, 2));
          discoveredCount++;
          console.log(`Discovered new manga from recent feed: ${mangaData.title} (AniList=${media.id}, MangaDex=${mangaId}, latest ch=${entry.chapterNum})`);
        } else {
          stats.failed++;
          saveFailure(mangaId);
          console.warn(`[AniList] No match for: ${titles[0]} (${mangaId}). Skipping.`);
        }
      } catch (e) {
        stats.failed++;
        saveFailure(mangaId);
        console.error(`Failed to process discovery for ${mangaId}: ${e.message}`);
      }
      
      // Mandatory wait between discovery items to respect AniList 90/min
      await delay(REQUEST_DELAY_MS);
    }

    if (mangaData) {
      results.push({
        ...mangaData,
        latestChapter: entry.chapterNum,
        chapterTitle: entry.title,
        updatedAt: entry.readableAt
      });
      matchedCount++;
    }
  }

  // Sort by date desc
  results.sort((a,b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  const finalSection = SECTION_LIMIT_RAW > 0 ? results.slice(0, SECTION_LIMIT_RAW) : results;

  return {
    items: finalSection,
    catalogCount,
    feedPages: MAX_FEED_PAGES,
    feedRows: feed.length,
    freshFeedItems: feed.length,
    discoveredCount,
    matchedCount,
    sectionLimit: SECTION_LIMIT_RAW || results.length,
    discoveryAttempts,
    discoveryAlreadyKnown: stats.known,
    discoveryFailedCount: stats.failed,
    discoverySkippedRecentFailure: stats.skippedRecent,
    discoverySkippedByLimit: stats.skippedLimit,
    cutoffIso: stats.cutoffIso
  };
}

async function fetchMangaNewChapters() {
  try {
    console.log('-------------------------------------------');
    console.log('REFRESHING MANGA NEW CHAPTERS [STEALTH MODE]');
    console.log('-------------------------------------------');

    const summary = getRequestHealthSummary();
    console.log(`Request health before run: hosts=${summary.hosts}, cooling=${summary.cooling}, open-circuits=${summary.openCircuits}.`);

    const previousFile = path.join(process.cwd(), CONFIG.API_PATHS.MANGA_NEW_CHAPTERS);
    let previousItems = [];
    try {
      if (fs.existsSync(previousFile)) {
        previousItems = JSON.parse(fs.readFileSync(previousFile, 'utf8'));
      }
    } catch (e) {}

    let latestAttempt = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      latestAttempt = await collectFreshNewChapterItems();

      console.log(
        `Attempt ${attempt}/${MAX_ATTEMPTS}: catalog=${latestAttempt.catalogCount}, feed-pages=${latestAttempt.feedPages}, feed-rows=${latestAttempt.feedRows}, fresh-feed=${latestAttempt.freshFeedItems}, discovered=${latestAttempt.discoveredCount}, matched=${latestAttempt.matchedCount}, limit=${latestAttempt.sectionLimit}, section=${latestAttempt.items.length}.`,
      );

      console.log(
        `Discovery details: already-known=${latestAttempt.discoveryAlreadyKnown}, failed=${latestAttempt.discoveryFailedCount}, skipped-recent-failure=${latestAttempt.discoverySkippedRecentFailure}, skipped-limit=${latestAttempt.discoverySkippedByLimit}.`,
      );

      if (latestAttempt.discoverySkippedByLimit > 0) {
        console.log(
          `Discovery limit reached in this run: skipped ${latestAttempt.discoverySkippedByLimit} unmatched recent title(s) after ${latestAttempt.discoveryAttempts} attempts.`,
        );
      }

      if (discoveryFailures.length > 0) {
        console.log('\n---------- DISCOVERY FAILURE REPORT ----------');
        discoveryFailures.forEach((f, i) => {
          const mainTitle = f.titles[0] || 'Unknown';
          console.log(`${i+1}. "${mainTitle}" -> Reason: ${f.reason}`);
        });
        console.log('----------------------------------------------\n');
        // Clear for next attempt if retrying
        discoveryFailures.length = 0;
      }


      if (latestAttempt.items.length > 0) {
        if (attempt > 1) {
          console.log(`Recovered non-empty new chapters section on attempt ${attempt}.`);
        }
        break;
      }

      if (attempt < MAX_ATTEMPTS) {
        console.warn(
          `New chapters result is empty (attempt ${attempt}/${MAX_ATTEMPTS}). Retrying in ${RETRY_DELAY_MS}ms...`,
        );
        await delay(RETRY_DELAY_MS);
      }
    }

    const finalItems = Array.isArray(latestAttempt?.items) ? latestAttempt.items : [];

    if (finalItems.length === 0 && previousItems.length > 0) {
      console.warn(
        `New chapters still empty after ${MAX_ATTEMPTS} attempts. Keeping previous file with ${previousItems.length} entries.`,
      );
      return;
    }

    if (finalItems.length === 0) {
      console.warn(
        `New chapters empty after ${MAX_ATTEMPTS} attempts and no previous cache exists. Skipping write to avoid publishing empty feed.`,
      );
      return;
    }

    const writeJsonIfChanged = (filePath, data) => {
        const fullPath = path.join(process.cwd(), filePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, JSON.stringify(data, null, 2));
    };

    writeJsonIfChanged(CONFIG.API_PATHS.MANGA_NEW_CHAPTERS, finalItems);
    console.log(`Manga new chapters refreshed with ${finalItems.length} titles (cutoff: ${latestAttempt.cutoffIso}).`);
  } finally {
    pruneRequestHealthState();
    if (requestHealthDirty) {
      writeRequestHealth(requestHealthState);
      requestHealthDirty = false;
    }
    const requestHealthAfter = getRequestHealthSummary();
    console.log(
      `Request health after run: hosts=${requestHealthAfter.hosts}, cooling=${requestHealthAfter.cooling}, open-circuits=${requestHealthAfter.openCircuits}.`,
    );
  }
}

module.exports = fetchMangaNewChapters;
