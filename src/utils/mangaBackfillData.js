const fs = require('fs');
const path = require('path');

const CONFIG = require('../config/constants');

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function getPagedItems(relativePath, pattern) {
  const dir = path.join(__dirname, '../../api', relativePath);
  if (!fs.existsSync(dir)) {
    return [];
  }

  const files = fs.readdirSync(dir)
    .filter((file) => pattern.test(file))
    .sort((a, b) => {
      const aNum = Number(a.match(/(\d+)/)?.[1] || 0);
      const bNum = Number(b.match(/(\d+)/)?.[1] || 0);
      return aNum - bNum;
    });

  return files.flatMap((file) => {
    const fullPath = path.join(dir, file);
    const items = readJsonFile(fullPath, []);
    return Array.isArray(items) ? items : [];
  });
}

function getMangaCatalogEntries() {
  return getPagedItems(CONFIG.API_PATHS.MANGA_CATALOG, /^manga_page_\d+\.json$/i);
}

function getMangaSectionEntries(sectionScope = '') {
  const scope = String(sectionScope || '').trim().toLowerCase();
  if (!scope) {
    return getMangaCatalogEntries();
  }

  const sectionPathMap = {
    trending: CONFIG.API_PATHS.MANGA_TRENDING,
    featured: CONFIG.API_PATHS.MANGA_FEATURED,
    top_rated: CONFIG.API_PATHS.MANGA_TOP_RATED,
    'top-rated': CONFIG.API_PATHS.MANGA_TOP_RATED,
    popular: CONFIG.API_PATHS.MANGA_POPULAR,
    releasing: CONFIG.API_PATHS.MANGA_RELEASING,
    new_chapters: CONFIG.API_PATHS.MANGA_NEW_CHAPTERS,
    'new-chapters': CONFIG.API_PATHS.MANGA_NEW_CHAPTERS,
  };

  if (sectionPathMap[scope]) {
    const fullPath = path.join(__dirname, '../../api', `${sectionPathMap[scope]}.json`);
    const items = readJsonFile(fullPath, []);
    return Array.isArray(items) ? items : [];
  }

  if (scope.startsWith('genre:')) {
    const genreName = scope.slice('genre:'.length).trim();
    if (!genreName) {
      return [];
    }
    const fullPath = path.join(__dirname, '../../api', `${CONFIG.API_PATHS.MANGA_BY_GENRE}/${genreName}.json`);
    const items = readJsonFile(fullPath, []);
    return Array.isArray(items) ? items : [];
  }

  return [];
}

function getChapterManifest() {
  const manifestPath = path.join(__dirname, '../../api', `${CONFIG.API_PATHS.MANGA_CHAPTERS}/manifest.json`);
  return readJsonFile(manifestPath, { items: [], totalTitles: 0 });
}

function getUniverseManifest() {
  const manifestPath = path.join(__dirname, '../../api', `${CONFIG.API_PATHS.MANGA_UNIVERSE}/manifest.json`);
  return readJsonFile(manifestPath, { items: [], totalTitles: 0 });
}

function getChapterIndex(mangadexId) {
  const chapterPath = path.join(__dirname, '../../api', `${CONFIG.API_PATHS.MANGA_CHAPTERS}/${mangadexId}.json`);
  return readJsonFile(chapterPath, null);
}

function getPageManifest() {
  const manifestPath = path.join(__dirname, '../../api', `${CONFIG.API_PATHS.MANGA_PAGES}/manifest.json`);
  return readJsonFile(manifestPath, { items: [], totalChapters: 0 });
}

function sanitizeFilePart(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'item';
}

function buildChapterIndexId(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const provider = String(
    item.chapterSourceProvider ||
      item.provider ||
      '',
  ).trim();
  const ownerId = String(item.anilistId || item.mangaId || '').trim();
  if (provider && ownerId) {
    return sanitizeFilePart(`src-${provider}-${ownerId}`);
  }

  const direct = String(item.chapterIndexId || item.mangadexId || '').trim();
  if (direct) {
    return sanitizeFilePart(direct);
  }

  return null;
}

module.exports = {
  readJsonFile,
  getMangaCatalogEntries,
  getMangaSectionEntries,
  getChapterManifest,
  getUniverseManifest,
  getChapterIndex,
  getPageManifest,
  sanitizeFilePart,
  buildChapterIndexId,
};
