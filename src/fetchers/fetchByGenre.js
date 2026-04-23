const fetchSection = require('./fetchSection');
const CONFIG = require('../config/constants');

const TOP_GENRES = [
    'Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy', 'Horror', 'Mahou Shoujo',
    'Mecha', 'Music', 'Mystery', 'Psychological', 'Romance', 'Sci-Fi',
    'Slice of Life', 'Sports', 'Supernatural', 'Thriller'
];

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchByGenre() {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🎭 FETCHING ANIME BY GENRE');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    for (const genre of TOP_GENRES) {
        const collectionPath = `${CONFIG.API_PATHS.BY_GENRE}/${genre}`;

        // fetchSection handles full pagination internally (up to 2000 items per genre)
        await fetchSection(collectionPath, {
            perPage: 50,
            genre: genre,
            sort: ['POPULARITY_DESC', 'SCORE_DESC']
        }, `Genre: ${genre}`, { accumulate: true });

        // Extra delay between genres to avoid hammering AniList rate limits
        await delay(3000);
    }

    console.log('✅ All By Genre sections successfully fetched and merged.');
}

module.exports = fetchByGenre;
