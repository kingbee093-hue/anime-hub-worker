const fs = require('fs');
const path = require('path');

const CONFIG = require('../config/constants');
const { fetchGraphQL } = require('../utils/fetchHelper');
const { POPULAR_CHARACTERS_QUERY } = require('../utils/anilistQueries');
const { cleanHtmlTags, delay } = require('../utils/formatters');
const { writeJsonIfChanged, readJson } = require('../utils/writeJsonIfChanged');
const { writeSectionPages } = require('../utils/sectionPagination');

// ─── Page-state persistence (same pattern as fetchSection) ─────────────────
const STATE_FILE = path.join(__dirname, '../../api/section_state.json');

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (_) {}
  return {};
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    console.error('  [State] Failed to save state:', e.message);
  }
}

const CHARACTER_PAGE_SIZE = 50;
const TARGET_ITEMS = 2000;
const HARD_PAGE_LIMIT = 300;

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

/**
 * Fetch character catalog with accumulate strategy:
 *   1. Fetch page 1 first (guarantees latest/most popular characters)
 *   2. Continue from last saved page (discovers deeper catalog)
 *   3. Merge with existing data — no deletions
 */
async function fetchCharacterCatalog() {
  console.log('========================================');
  console.log('BUILDING: Character Catalog (ACCUMULATE)');
  console.log('========================================');

  const state = loadState();
  const stateKey = CONFIG.API_PATHS.CHARACTERS;
  const lastSavedPage = state[stateKey] || 0;

  console.log(`  [Strategy] Accumulate — fetching page 1 first, then from page ${lastSavedPage + 1}`);

  const collected = [];

  // Helper: fetch a single page
  async function fetchPage(pageNum) {
    console.log(`  Fetching page ${pageNum}...`);

    const data = await fetchGraphQL(POPULAR_CHARACTERS_QUERY, {
      page: pageNum,
      perPage: CHARACTER_PAGE_SIZE,
    });

    if (!data || !data.Page) {
      console.error(`  ✗ Failed on page ${pageNum}, stopping.`);
      return { items: 0, hasNext: false };
    }

    const characters = data.Page.characters || [];
    if (characters.length === 0) {
      console.log(`  [Info] Page ${pageNum} is empty.`);
      return { items: 0, hasNext: false };
    }

    let added = 0;
    for (const character of characters) {
      if (collected.length >= TARGET_ITEMS) break;
      if (!character?.id || !character?.name?.full) continue;
      collected.push(buildCharacterItem(character));
      added++;
    }

    console.log(`  Page ${pageNum} — +${added} items (total: ${collected.length}/${TARGET_ITEMS})`);
    return { items: added, hasNext: data.Page.pageInfo?.hasNextPage ?? false };
  }

  // Phase 1: Always fetch page 1 (latest data)
  const p1 = await fetchPage(1);
  if (p1.items === 0 && !p1.hasNext) {
    console.log(`  [Info] Page 1 empty, nothing to accumulate.`);
    return;
  }
  if (collected.length < TARGET_ITEMS && p1.hasNext) await delay(CONFIG.RATE_LIMIT_DELAY);

  // Phase 2: Continue from last saved page (skip pages 2..lastSavedPage)
  let page = lastSavedPage > 0 ? lastSavedPage + 1 : 2;
  let hasNextPage = true;

  while (hasNextPage && collected.length < TARGET_ITEMS && page <= HARD_PAGE_LIMIT) {
    const result = await fetchPage(page);
    hasNextPage = result.hasNext;
    if (collected.length < TARGET_ITEMS && hasNextPage) {
      await delay(CONFIG.RATE_LIMIT_DELAY);
      page++;
    }
  }

  // Save the last page we reached
  state[stateKey] = page;
  saveState(state);

  console.log(`  ✓ Finished fetching. Collected in this run: ${collected.length}`);

  // ── Accumulate (merge, no deletions) ────────────────────────────────────
  let finalOutput = collected;
  const existing = readJson(stateKey);
  if (Array.isArray(existing) && existing.length > 0) {
    const deduped = new Map();
    for (const item of existing) {
      if (item.id) deduped.set(String(item.id), item);
    }

    let newCount = 0;
    for (const item of collected) {
      if (item.id) {
        if (!deduped.has(String(item.id))) newCount++;
        deduped.set(String(item.id), item);
      }
    }
    finalOutput = Array.from(deduped.values());
    console.log(`  [Accumulate] +${newCount} new items added.`);
    console.log(`  [Accumulate] New total entries: ${finalOutput.length}`);
  } else {
    console.log(`  [Accumulate] No existing data found, creating new file with ${collected.length} items.`);
  }

  // Sort by favourites descending
  finalOutput.sort((a, b) => {
    const delta = Number(b.favourites || 0) - Number(a.favourites || 0);
    if (delta !== 0) return delta;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });

  writeJsonIfChanged(CONFIG.API_PATHS.CHARACTERS, finalOutput);
  writeSectionPages(CONFIG.API_PATHS.CHARACTERS, finalOutput);
  console.log(`Character catalog built with ${finalOutput.length} characters.`);
}

module.exports = fetchCharacterCatalog;
