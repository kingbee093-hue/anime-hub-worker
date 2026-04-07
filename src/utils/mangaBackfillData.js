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

  const direct = String(item.chapterIndexId || item.mangadexId || '').trim();
  if (direct) {
    return sanitizeFilePart(direct);
  }

  const provider = String(
    item.chapterSourceProvider ||
      item.provider ||
      '',
  ).trim();
  const ownerId = String(item.anilistId || item.mangaId || '').trim();
  if (!provider || !ownerId) {
    return null;
  }

  return sanitizeFilePart(`src-${provider}-${ownerId}`);
}

module.exports = {
  readJsonFile,
  getMangaCatalogEntries,
  getChapterManifest,
  getUniverseManifest,
  getChapterIndex,
  getPageManifest,
  sanitizeFilePart,
  buildChapterIndexId,
};
