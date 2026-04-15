const fs = require('fs');
const path = require('path');

const CONFIG = require('../config/constants');
const { delay } = require('../utils/formatters');
const { buildNewChaptersSection, DEFAULT_SECTION_LIMIT } = require('../utils/mangaSections');
const { getMangaCatalogEntries, getChapterManifest } = require('../utils/mangaBackfillData');
const { writeJsonIfChanged } = require('../utils/writeJsonIfChanged');

const FRESH_HOURS = Number(process.env.MANGA_NEW_CHAPTERS_FRESH_HOURS || 48);
const MAX_ATTEMPTS = Number(process.env.MANGA_NEW_CHAPTERS_MAX_ATTEMPTS || 4);
const RETRY_DELAY_MS = Number(process.env.MANGA_NEW_CHAPTERS_RETRY_DELAY_MS || 3000);

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

function isWithinFreshWindow(updatedAt, cutoffMs) {
  const time = new Date(updatedAt || 0).getTime();
  if (!Number.isFinite(time) || time <= 0) return false;
  return time >= cutoffMs;
}

function collectFreshNewChapterItems() {
  const catalogEntries = getMangaCatalogEntries();
  const chapterManifest = getChapterManifest();
  const manifestItems = Array.isArray(chapterManifest?.items) ? chapterManifest.items : [];
  const cutoffMs = Date.now() - (FRESH_HOURS * 60 * 60 * 1000);
  const freshManifest = {
    items: manifestItems.filter((item) => isWithinFreshWindow(item.updatedAt, cutoffMs)),
  };

  const items = buildNewChaptersSection(catalogEntries, freshManifest, DEFAULT_SECTION_LIMIT);
  return {
    items,
    catalogCount: catalogEntries.length,
    manifestCount: manifestItems.length,
    freshManifestCount: freshManifest.items.length,
    cutoffIso: new Date(cutoffMs).toISOString(),
  };
}

async function fetchMangaNewChapters() {
  console.log('========================================');
  console.log('REFRESHING MANGA NEW CHAPTERS');
  console.log('========================================');

  const outputPath = path.join(__dirname, '../../api', `${CONFIG.API_PATHS.MANGA_NEW_CHAPTERS}.json`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const previousItems = parseExistingItems(outputPath);
  console.log(
    `Window: last ${FRESH_HOURS} hours. Previous file entries: ${previousItems.length}.`,
  );

  let latestAttempt = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    latestAttempt = collectFreshNewChapterItems();

    console.log(
      `Attempt ${attempt}/${MAX_ATTEMPTS}: catalog=${latestAttempt.catalogCount}, manifest=${latestAttempt.manifestCount}, fresh-window=${latestAttempt.freshManifestCount}, section=${latestAttempt.items.length}.`,
    );

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

  writeJsonIfChanged(CONFIG.API_PATHS.MANGA_NEW_CHAPTERS, finalItems);
  console.log(
    `Manga new chapters refreshed with ${finalItems.length} titles (cutoff: ${latestAttempt.cutoffIso}).`,
  );
}

module.exports = fetchMangaNewChapters;

