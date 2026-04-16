const axios = require('axios');
const fs = require('fs');
const path = require('path');
const CONFIG = require('./src/config/constants');
const { delay } = require('./src/utils/formatters');
const { 
  getSecureHeaders, 
  computeRetryDelayMs, 
  getStealthDelay, 
  performCamouflageRequest,
  fetchGraphQL,
  getRequestHealthSummary,
  pruneRequestHealthState,
  markRequestSuccess,
  markRequestFailure
} = require('./fetchHelper_stealth');

const { isAdultContent, isManga } = require('./src/utils/filters');
const {
  getMangaCatalogEntries,
  writeCatalogArtifacts,
  sortCatalog,
  buildCatalogMaps
} = require('./src/utils/catalog');
const {
  getChapterManifest,
  getChapterManifestMap,
  writeDiscoveredChapterIndex
} = require('./src/utils/manifest');
const {
  normalizeStoredChapter,
  buildChapterIndexPayload,
  parseIntegerChapter
} = require('./src/utils/mappers');

const MANGADEX_API = 'https://api.mangadex.org';
const MANGADEX_REQUEST_RETRIES = 3;
const REQUEST_DELAY_MS = 2000;
const FRESH_HOURS = Math.max(1, Number(process.env.MANGA_NEW_CHAPTERS_FRESH_HOURS || 48));
const DISCOVERY_LIMIT = Math.max(1, Number(process.env.MANGA_NEW_CHAPTERS_DISCOVERY_LIMIT || 20));
const FAILURE_COOLDOWN_HOURS = 168; // 1 week
const MATCHER_VERSION = 2;

async function fetchMangaNewChapters() {
  console.log('========================================');
  console.log('REFRESHING MANGA NEW CHAPTERS [STEALTH MODE]');
  console.log('========================================');
  
  try {
    let latestAttempt = null;
    const MAX_ATTEMPTS = 3;
    
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      latestAttempt = await collectFreshNewChapterItems();
      
      console.log(
        `Attempt ${attempt}/${MAX_ATTEMPTS}: catalog=${latestAttempt.catalogCount}, feed-pages=${latestAttempt.feedPages}, feed-rows=${latestAttempt.feedRows}, fresh-feed=${latestAttempt.freshFeedItems}, discovered=${latestAttempt.discoveredCount}, matched=${latestAttempt.matchedCount}, limit=${latestAttempt.sectionLimit}, section=${latestAttempt.items.length}.`
      );
      
      console.log(
        `Discovery details: already-known=${latestAttempt.discoveryAlreadyKnown}, failed=${latestAttempt.discoveryFailedCount}, skipped-recent-failure=${latestAttempt.discoverySkippedRecentFailure}, skipped-limit=${latestAttempt.discoverySkippedByLimit}.`
      );

      if (latestAttempt.failedItems && latestAttempt.failedItems.length > 0) {
        console.log('\n---------- DISCOVERY FAILURE REPORT ----------');
        latestAttempt.failedItems.forEach((f, i) => {
          const title = f.title || f.mangaId || 'Unknown';
          console.log(`${i + 1}. "${title}" -> Reason: ${f.reason}`);
        });
        console.log('----------------------------------------------\n');
      }

      if (latestAttempt.items.length > 0) break;
      if (attempt < MAX_ATTEMPTS) {
        console.log(`Retrying entire process in 5s...`);
        await delay(5000);
      }
    }

    const finalPath = path.join(__dirname, 'api', `${CONFIG.API_PATHS.MANGA_NEW_CHAPTERS}.json`);
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.writeFileSync(finalPath, JSON.stringify(latestAttempt.items, null, 2));
    
    console.log(`Refreshed ${latestAttempt.items.length} chapters. SUCCESS.`);
  } catch (error) {
    console.error('FATAL ERROR in manga chapters worker:', error);
    process.exit(1);
  }
}

async function collectFreshNewChapterItems() {
  const recentFeed = await fetchRecentMangaDexFeed();
  const catalogEntries = getMangaCatalogEntries();
  const discovery = await discoverMissingRecentCatalogEntries(recentFeed.items, catalogEntries);
  
  const built = buildRecentFeedItems(
    recentFeed.items,
    discovery.catalogEntries,
    discovery.manifestMap,
    discovery.discoveredMangaIds
  );

  return {
    ...built,
    feedRows: recentFeed.totalRows,
    feedPages: recentFeed.fetchedPages,
    freshFeedItems: recentFeed.items.length,
    cutoffIso: recentFeed.cutoffIso,
    discoveredCount: discovery.discoveredCount,
    discoveryAttempts: discovery.discoveryAttempts,
    discoverySkippedByLimit: discovery.skippedByLimit,
    discoverySkippedRecentFailure: discovery.skippedRecentFailure,
    discoveryAlreadyKnown: discovery.alreadyKnown,
    discoveryFailedCount: discovery.failedCount,
    failedItems: discovery.failedItems
  };
}

async function discoverMissingRecentCatalogEntries(recentFeedItems, catalogEntries) {
  const manifest = getChapterManifest();
  const discoveryState = readDiscoveryState();
  const catalog = [...catalogEntries];
  const catalogMaps = buildCatalogMaps(catalog);
  const discoveredMangaIds = new Set();
  
  const report = { failed: [], discovered: [], skippedByLimit: 0, skippedRecentFailure: 0, alreadyKnown: 0 };
  let attempted = 0;
  let created = 0;

  for (const item of recentFeedItems) {
    const mangaId = String(item.mangaId);
    if (catalogMaps.byMangadexId.has(mangaId)) {
      report.alreadyKnown++;
      continue;
    }

    const stateKey = `md:${mangaId}`;
    if (isRecentFailureState(discoveryState[stateKey], item)) {
      report.skippedRecentFailure++;
      continue;
    }

    if (attempted >= DISCOVERY_LIMIT) {
      report.skippedByLimit++;
      continue;
    }

    attempted++;
    try {
      const discovered = await discoverCatalogEntryForRecentItem(item);
      if (discovered.reason) {
        discoveryState[stateKey] = { status: 'failed', reason: discovered.reason, lastAttemptAt: new Date().toISOString() };
        
        const displayTitle = item.title || 
                             (discovered?.mangadexDetails?.attributes?.title?.en) || 
                             (discovered?.mangadexDetails?.attributes?.title?.[Object.keys(discovered?.mangadexDetails?.attributes?.title || {})[0]]) ||
                             `MangaDex:${item.mangaId}`;

        report.failed.push({ title: displayTitle, reason: discovered.reason, mangaId });
        continue;
      }

      const entry = discovered.entry;
      catalog.push(entry);
      catalogMaps.byMangadexId.set(mangaId, entry);
      discoveredMangaIds.add(mangaId);
      created++;
      
      discoveryState[stateKey] = { status: 'discovered', lastSuccessAt: new Date().toISOString() };
      console.log(`Discovered: "${entry.title}"`);
      
      await delay(await getStealthDelay(REQUEST_DELAY_MS));
    } catch (e) {
      report.failed.push({ title: item.title || mangaId, reason: 'exception', error: e.message });
    }
  }

  if (created > 0) writeCatalogArtifacts(catalog);
  writeDiscoveryState(discoveryState);

  return {
    catalogEntries: catalog,
    manifestMap: getChapterManifestMap(manifest),
    discoveredCount: created,
    discoveredMangaIds,
    discoveryAttempts: attempted,
    skippedByLimit: report.skippedByLimit,
    skippedRecentFailure: report.skippedRecentFailure,
    alreadyKnown: report.alreadyKnown,
    failedCount: report.failed.length,
    failedItems: report.failed
  };
}

async function discoverCatalogEntryForRecentItem(recentItem) {
  const mangadexDetails = await fetchMangaDexDetails(recentItem.mangaId);
  const titles = extractMangaTitles(mangadexDetails);
  const year = Number(mangadexDetails.attributes?.year || 0) || null;

  let media = await searchAniListMediaByTitles(titles, year);
  if (!media) return { reason: 'anilist_match_not_found', mangadexDetails };

  const adult = isAdultContent(media);
  if (adult.blocked) return { reason: `Blocked: ${adult.reason}`, mangadexDetails };

  const manga = isManga(media);
  if (!manga.allowed) return { reason: 'non_manga_filtered', mangadexDetails };

  const entry = buildCatalogEntryFromAniList(media, mangadexDetails, recentItem);
  const pageUrls = await fetchChapterPages(recentItem.chapterId);
  
  if (!pageUrls.length) return { reason: 'chapter_pages_missing', mangadexDetails };

  return { entry, pageUrls };
}

// ... Additional helper implementations (mocked/simplified for brevity in this response)
async function fetchRecentMangaDexFeed() {
  const cutoff = new Date(Date.now() - FRESH_HOURS * 60 * 60 * 1000).toISOString();
  // Simplified implementation
  return { items: [], totalRows: 0, fetchedPages: 0, cutoffIso: cutoff };
}

function readDiscoveryState() { return {}; }
function writeDiscoveryState() {}
function isRecentFailureState() { return false; }
async function fetchMangaDexDetails() { return { attributes: {} }; }
function extractMangaTitles() { return []; }
async function searchAniListMediaByTitles() { return null; }
function buildCatalogEntryFromAniList() { return {}; }
async function fetchChapterPages() { return []; }
function buildRecentFeedItems() { return { items: [] }; }

module.exports = fetchMangaNewChapters;
