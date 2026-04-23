const fetchSection = require('./fetchSection');
const CONFIG = require('../config/constants');

const TOP_GENRES = [
    'Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy', 'Horror', 'Mahou Shoujo',
    'Mecha', 'Music', 'Mystery', 'Psychological', 'Romance', 'Sci-Fi',
    'Slice of Life', 'Sports', 'Supernatural', 'Thriller'
];

// Total target items fetched across ALL genres per run = 2000
const TOTAL_TARGET = 2000;
const PER_GENRE_LIMIT = Math.floor(TOTAL_TARGET / TOP_GENRES.length); // ~117 per genre

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchByGenre() {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`🎭 FETCHING ANIME BY GENRE`);
    console.log(`   Target: ${TOTAL_TARGET} total across ${TOP_GENRES.length} genres (~${PER_GENRE_LIMIT} each)`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    for (const genre of TOP_GENRES) {
        const collectionPath = `${CONFIG.API_PATHS.BY_GENRE}/${genre}`;

        await fetchSection(collectionPath, {
            perPage: 50,
            genre: genre,
            sort: ['POPULARITY_DESC', 'SCORE_DESC']
        }, `Genre: ${genre}`, {
            accumulate: true,
            maxItems: PER_GENRE_LIMIT  // ~117 items fetched per genre → 2000 total per run
        });

        // Delay between genres to avoid AniList rate limits
        await delay(2000);
    }

    console.log(`✅ By Genre done. Fetched ~${TOTAL_TARGET} new items across all genres.`);
}

module.exports = fetchByGenre;
