const CONFIG = require('../config/constants');
const { writeJsonIfChanged } = require('./writeJsonIfChanged');

const DEFAULT_SECTION_LIMIT = 24;

function buildCatalogEntryMaps(entries) {
  const byMangaId = new Map();
  const byAniListId = new Map();
  const byMangaDexId = new Map();
  const byChapterIndexId = new Map();

  for (const entry of entries || []) {
    if (!entry || !entry.mangaId) continue;
    byMangaId.set(String(entry.mangaId), entry);
    byAniListId.set(String(entry.anilistId || entry.mangaId), entry);
    if (entry.chapterIndexId) {
      byChapterIndexId.set(String(entry.chapterIndexId), entry);
    }
    if (entry.mangadexId) {
      byMangaDexId.set(String(entry.mangadexId), entry);
    }
  }

  return { byMangaId, byAniListId, byMangaDexId, byChapterIndexId };
}

function buildReleasingSection(catalogEntries, limit = DEFAULT_SECTION_LIMIT) {
  return (catalogEntries || [])
    .filter((item) => String(item?.status || '').toUpperCase() === 'RELEASING')
    .sort((a, b) => {
      const popularityDelta = Number(b.popularity || 0) - Number(a.popularity || 0);
      if (popularityDelta !== 0) return popularityDelta;

      const scoreDelta = Number(b.averageScore || 0) - Number(a.averageScore || 0);
      if (scoreDelta !== 0) return scoreDelta;

      return String(a.title || '').localeCompare(String(b.title || ''));
    })
    .slice(0, limit);
}

function writeReleasingSection(catalogEntries, limit = DEFAULT_SECTION_LIMIT) {
  const items = buildReleasingSection(catalogEntries, limit);
  writeJsonIfChanged(CONFIG.API_PATHS.MANGA_RELEASING, items);
  return items;
}

function getManifestTotalCount(item) {
  const counts = item?.counts || {};
  return Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
}

function buildNewChaptersSection(catalogEntries, chapterManifest, limit = DEFAULT_SECTION_LIMIT) {
  const manifestItems = Array.isArray(chapterManifest?.items) ? chapterManifest.items : [];
  const maps = buildCatalogEntryMaps(catalogEntries);
  const deduped = new Map();

  const ranked = manifestItems
    .map((item) => {
      const catalogEntry =
        maps.byChapterIndexId.get(String(item.chapterIndexId || '')) ||
        maps.byMangaDexId.get(String(item.mangadexId || '')) ||
        maps.byAniListId.get(String(item.anilistId || '')) ||
        maps.byMangaId.get(String(item.mangaId || ''));

      if (!catalogEntry) return null;
      const totalCount = getManifestTotalCount(item);
      if (totalCount <= 0) return null;

      return {
        ...catalogEntry,
        latestChapterUpdatedAt: item.updatedAt || null,
        chapterCoverageCount: totalCount,
        chapterCoverageLanguages: Array.isArray(item.availableLanguages) ? item.availableLanguages : [],
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const updatedDelta = new Date(b.latestChapterUpdatedAt || 0).getTime() - new Date(a.latestChapterUpdatedAt || 0).getTime();
      if (updatedDelta !== 0) return updatedDelta;

      const countDelta = Number(b.chapterCoverageCount || 0) - Number(a.chapterCoverageCount || 0);
      if (countDelta !== 0) return countDelta;

      return Number(b.popularity || 0) - Number(a.popularity || 0);
    });

  for (const item of ranked) {
    deduped.set(String(item.mangaId), item);
    if (deduped.size >= limit) break;
  }

  return Array.from(deduped.values());
}

function writeNewChaptersSection(catalogEntries, chapterManifest, limit = DEFAULT_SECTION_LIMIT) {
  const items = buildNewChaptersSection(catalogEntries, chapterManifest, limit);
  writeJsonIfChanged(CONFIG.API_PATHS.MANGA_NEW_CHAPTERS, items);
  return items;
}

module.exports = {
  DEFAULT_SECTION_LIMIT,
  buildReleasingSection,
  buildNewChaptersSection,
  writeReleasingSection,
  writeNewChaptersSection,
};
