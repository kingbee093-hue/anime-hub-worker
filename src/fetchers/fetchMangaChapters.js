const fs = require('fs');
const path = require('path');
const axios = require('axios');

const CONFIG = require('../config/constants');
const { delay } = require('../utils/formatters');
const { writeJsonIfChanged } = require('../utils/writeJsonIfChanged');

const MANGADEX_API = 'https://api.mangadex.org';
const CHAPTER_LANGUAGES = ['en', 'ar', 'ja'];
const CHAPTER_PAGE_SIZE = 500;
const CHAPTER_DELAY_MS = 250;

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

function getCatalogEntries() {
  const catalogDir = path.join(__dirname, '../../api/manga/catalog');
  if (!fs.existsSync(catalogDir)) {
    return [];
  }

  const pageFiles = fs.readdirSync(catalogDir)
    .filter((file) => /^manga_page_\d+\.json$/i.test(file))
    .sort((a, b) => {
      const aNum = Number(a.match(/(\d+)/)?.[1] || 0);
      const bNum = Number(b.match(/(\d+)/)?.[1] || 0);
      return aNum - bNum;
    });

  return pageFiles.flatMap((file) => {
    const fullPath = path.join(catalogDir, file);
    const items = readJsonFile(fullPath, []);
    return Array.isArray(items) ? items : [];
  });
}

function normalizeChapterItem(raw, scanlationGroup) {
  const attributes = raw?.attributes || {};
  const chapter = {
    id: String(raw?.id || ''),
    title: String(attributes.title || ''),
    chapter: String(attributes.chapter || ''),
    volume: String(attributes.volume || ''),
    language: String(attributes.translatedLanguage || ''),
    pages: Number(attributes.pages || 0),
    publishedAt: attributes.publishAt || null,
    externalUrl: attributes.externalUrl || null,
    scanlationGroup: scanlationGroup || '',
    sourceType: attributes.externalUrl ? 'official_external' : 'reader',
  };

  if (!chapter.id || chapter.pages <= 0 || chapter.sourceType !== 'reader') {
    return null;
  }

  return chapter;
}

function dedupeChapters(chapters) {
  const grouped = new Map();
  for (const chapter of chapters) {
    const number = String(chapter.chapter || '').trim();
    const title = String(chapter.title || '').trim().toLowerCase();
    const key = number ? number : `title:${title || chapter.id}`;
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(chapter);
  }

  const resolved = Array.from(grouped.values()).map((variants) => {
    variants.sort((a, b) => {
      let scoreA = 0;
      let scoreB = 0;
      if (a.pages > 0) scoreA += 500;
      if (b.pages > 0) scoreB += 500;
      if (a.scanlationGroup) scoreA += 50;
      if (b.scanlationGroup) scoreB += 50;
      if (a.publishedAt) scoreA += new Date(a.publishedAt).getTime() / 86400000;
      if (b.publishedAt) scoreB += new Date(b.publishedAt).getTime() / 86400000;
      return scoreB - scoreA;
    });
    return variants[0];
  });

  resolved.sort((a, b) => {
    const chapterDiff = (parseFloat(b.chapter) || -1) - (parseFloat(a.chapter) || -1);
    if (chapterDiff !== 0) {
      return chapterDiff;
    }
    return new Date(b.publishedAt || 0).getTime() - new Date(a.publishedAt || 0).getTime();
  });

  return resolved;
}

async function fetchLanguageChapters(mangaDexId, language) {
  const items = [];
  let offset = 0;
  let total = null;

  while (total == null || offset < total) {
    const response = await axios.get(`${MANGADEX_API}/manga/${mangaDexId}/feed`, {
      params: {
        limit: CHAPTER_PAGE_SIZE,
        offset,
        'translatedLanguage[]': language,
        'order[chapter]': 'desc',
        'order[volume]': 'desc',
        'order[publishAt]': 'desc',
        'includes[]': 'scanlation_group',
      },
      timeout: 30000,
    });

    const body = response.data || {};
    const data = Array.isArray(body.data) ? body.data : [];
    total = Number(body.total || 0);

    for (const entry of data) {
      const relationships = Array.isArray(entry.relationships) ? entry.relationships : [];
      const scanlationGroup = relationships
        .filter((rel) => rel?.type === 'scanlation_group')
        .map((rel) => rel?.attributes?.name)
        .find(Boolean) || '';

      const normalized = normalizeChapterItem(entry, scanlationGroup);
      if (normalized) {
        items.push(normalized);
      }
    }

    offset += data.length;
    if (data.length === 0) {
      break;
    }
    await delay(CHAPTER_DELAY_MS);
  }

  return dedupeChapters(items);
}

async function fetchMangaChapters() {
  console.log('========================================');
  console.log('BUILDING: Manga Chapter Index');
  console.log('========================================');

  const catalogEntries = getCatalogEntries()
    .filter((item) => item && item.mangadexId)
    .map((item) => ({
      mangaId: item.mangaId,
      anilistId: item.anilistId || item.mangaId,
      title: item.title || '',
      mangadexId: item.mangadexId,
    }));

  const uniqueEntries = Array.from(
    new Map(catalogEntries.map((item) => [item.mangadexId, item])).values(),
  );

  const manifest = {
    generatedAt: new Date().toISOString(),
    totalTitles: uniqueEntries.length,
    items: [],
  };

  for (const entry of uniqueEntries) {
    console.log(`Fetching chapters for ${entry.title} (${entry.mangadexId})`);
    const languages = {};

    for (const language of CHAPTER_LANGUAGES) {
      try {
        const chapters = await fetchLanguageChapters(entry.mangadexId, language);
        if (chapters.length > 0) {
          languages[language] = chapters;
        }
      } catch (error) {
        console.error(`Failed to fetch ${language} chapters for ${entry.title}: ${error.message}`);
      }
      await delay(CHAPTER_DELAY_MS);
    }

    const availableLanguages = Object.keys(languages);
    const chapterIndex = {
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
    };

    writeJsonIfChanged(`${CONFIG.API_PATHS.MANGA_CHAPTERS}/${entry.mangadexId}`, chapterIndex);
    manifest.items.push({
      mangaId: entry.mangaId,
      anilistId: entry.anilistId,
      mangadexId: entry.mangadexId,
      title: entry.title,
      availableLanguages,
      counts: chapterIndex.counts,
    });
  }

  writeJsonIfChanged(`${CONFIG.API_PATHS.MANGA_CHAPTERS}/manifest`, manifest);
  console.log(`Saved chapter indexes for ${manifest.items.length} manga titles.`);
}

module.exports = fetchMangaChapters;
