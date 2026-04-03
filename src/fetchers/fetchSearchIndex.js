const fs = require('fs');
const path = require('path');
const CONFIG = require('../config/constants');
const { writeJsonIfChanged } = require('../utils/writeJsonIfChanged');

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error(`Failed to parse ${filePath}: ${error.message}`);
    return [];
  }
}

function getJsonFilesRecursive(directoryPath) {
  if (!fs.existsSync(directoryPath)) {
    return [];
  }

  const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...getJsonFilesRecursive(fullPath));
      continue;
    }

    if (entry.isFile() && fullPath.toLowerCase().endsWith('.json')) {
      files.push(fullPath);
    }
  }

  return files;
}

function scoreAnimeRichness(anime) {
  let score = 0;
  if (anime.synopsis) score += Math.min(anime.synopsis.length, 400);
  if (anime.bannerImage) score += 50;
  if (anime.imageUrl) score += 30;
  if (Array.isArray(anime.genres)) score += anime.genres.length * 10;
  if (Array.isArray(anime.synonyms)) score += anime.synonyms.length * 6;
  if (Array.isArray(anime.studiosNames)) score += anime.studiosNames.length * 4;
  score += Number(anime.popularity || 0) / 1000;
  score += Number(anime.averageScore || 0);
  return score;
}

function mergeAnime(existing, incoming) {
  if (!existing) {
    return incoming;
  }

  const winner =
      scoreAnimeRichness(incoming) >= scoreAnimeRichness(existing)
          ? { ...existing, ...incoming }
          : { ...incoming, ...existing };

  return {
    ...winner,
    genres: Array.from(
      new Set([...(existing.genres || []), ...(incoming.genres || [])]),
    ),
    synonyms: Array.from(
      new Set([...(existing.synonyms || []), ...(incoming.synonyms || [])]),
    ),
    studiosNames: Array.from(
      new Set([
        ...(existing.studiosNames || []),
        ...(incoming.studiosNames || []),
      ]),
    ),
  };
}

function buildSearchIndexItem(anime) {
  return {
    ...anime,
    searchTerms: Array.from(
      new Set(
        [
          anime.title,
          anime.titleEnglish,
          anime.titleRomaji,
          anime.titleNative,
          ...(anime.synonyms || []),
          ...(anime.genres || []),
          ...(anime.studiosNames || []),
        ]
          .filter(Boolean)
          .map((value) => String(value).trim()),
      ),
    ),
  };
}

async function fetchSearchIndex() {
  console.log('========================================');
  console.log('BUILDING: Anime Search Index');
  console.log('========================================');

  const apiRoot = path.join(__dirname, '../../api');
  const sourceFiles = [
    path.join(apiRoot, 'recent_episodes.json'),
    ...getJsonFilesRecursive(path.join(apiRoot, 'home_sections')),
    ...getJsonFilesRecursive(path.join(apiRoot, 'schedule')),
  ];

  const deduped = new Map();
  for (const sourceFile of sourceFiles) {
    const items = readJsonIfExists(sourceFile);
    for (const anime of items) {
      const animeId = anime?.animeId;
      if (!animeId) continue;
      deduped.set(animeId, mergeAnime(deduped.get(animeId), anime));
    }
  }

  const finalData = Array.from(deduped.values())
    .map(buildSearchIndexItem)
    .sort((a, b) => {
      const popularityDelta = Number(b.popularity || 0) - Number(a.popularity || 0);
      if (popularityDelta != 0) {
        return popularityDelta;
      }

      return Number(b.averageScore || 0) - Number(a.averageScore || 0);
    });

  const result = writeJsonIfChanged(CONFIG.API_PATHS.SEARCH_INDEX, finalData);
  if (result.changed) {
    console.log(`Anime search index written to ${result.file}.`);
  } else {
    console.log('No changes detected for anime search index.');
  }
}

module.exports = fetchSearchIndex;
