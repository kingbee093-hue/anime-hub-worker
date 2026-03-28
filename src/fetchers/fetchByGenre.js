const fetchSection = require('./fetchSection');
const CONFIG = require('../config/constants');
const { delay } = require('../utils/formatters');

const TOP_GENRES = [
    'Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy', 'Horror', 'Mahou Shoujo',
    'Mecha', 'Music', 'Mystery', 'Psychological', 'Romance', 'Sci-Fi', 
    'Slice of Life', 'Sports', 'Supernatural', 'Thriller'
];

async function fetchByGenre() {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🎭 FETCHING ANIME BY GENRE');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    for (const genre of TOP_GENRES) {
        const collectionPath = `${CONFIG.API_PATHS.BY_GENRE}/${genre}`;
        
        await fetchSection(collectionPath, {
            page: 1,
            perPage: 40, // Expanded to top 40 for each genre
            genre: genre,
            sort: ['POPULARITY_DESC', 'SCORE_DESC']
        }, `Genre: ${genre}`);

        // Rate limit between multiple GraphQL queries
        await delay(CONFIG.RATE_LIMIT_DELAY); 
    }
    
    console.log('✅ All By Genre sections successfully uploaded.');
}

module.exports = fetchByGenre;
