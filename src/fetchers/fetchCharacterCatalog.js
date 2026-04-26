const CONFIG = require('../config/constants');
const { fetchGraphQL } = require('../utils/fetchHelper');
const { POPULAR_CHARACTERS_QUERY } = require('../utils/anilistQueries');
const { cleanHtmlTags, delay } = require('../utils/formatters');
const { writeJsonIfChanged } = require('../utils/writeJsonIfChanged');
const { writeSectionPages } = require('../utils/sectionPagination');

const CHARACTER_PAGES = 40;
const CHARACTER_PAGE_SIZE = 50;

function buildCharacterItem(character) {
  const mediaNodes = character.media?.nodes || [];
  return {
    id: character.id,
    name: character.name?.full || '',
    nativeName: character.name?.native || '',
    imageUrl: character.image?.large || character.image?.medium || '',
    description: cleanHtmlTags(character.description || '').substring(0, 500),
    gender: character.gender || '',
    age: character.age || '',
    favourites: character.favourites || 0,
    siteUrl: character.siteUrl || '',
    mediaTitles: mediaNodes
      .map((media) =>
        media.title?.english ||
        media.title?.romaji ||
        media.title?.native ||
        media.title?.userPreferred ||
        '',
      )
      .filter(Boolean)
      .slice(0, 6),
    searchTerms: Array.from(
      new Set(
        [
          character.name?.full,
          character.name?.native,
          ...mediaNodes.map((media) =>
            media.title?.english ||
            media.title?.romaji ||
            media.title?.native ||
            media.title?.userPreferred ||
            '',
          ),
        ]
          .filter(Boolean)
          .map((value) => String(value).trim()),
      ),
    ),
  };
}

async function fetchCharacterCatalog() {
  console.log('========================================');
  console.log('BUILDING: Character Catalog');
  console.log('========================================');

  const deduped = new Map();
  for (let page = 1; page <= CHARACTER_PAGES; page++) {
    const data = await fetchGraphQL(POPULAR_CHARACTERS_QUERY, {
      page,
      perPage: CHARACTER_PAGE_SIZE,
    });

    if (!data || !data.Page) {
      console.error(`Failed to fetch character catalog page ${page}`);
      continue;
    }

    for (const character of data.Page.characters || []) {
      if (!character?.id || !character?.name?.full) continue;
      deduped.set(character.id, buildCharacterItem(character));
    }

    await delay(CONFIG.RATE_LIMIT_DELAY);
  }

  const catalog = Array.from(deduped.values()).sort((a, b) => {
    const favouritesDelta = Number(b.favourites || 0) - Number(a.favourites || 0);
    if (favouritesDelta !== 0) {
      return favouritesDelta;
    }
    return String(a.name || '').localeCompare(String(b.name || ''));
  });

  writeJsonIfChanged(CONFIG.API_PATHS.CHARACTERS, catalog);
  writeSectionPages(CONFIG.API_PATHS.CHARACTERS, catalog);
  console.log(`Character catalog built with ${catalog.length} characters.`);
}

module.exports = fetchCharacterCatalog;
