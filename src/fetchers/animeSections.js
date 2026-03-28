const fetchSection = require('./fetchSection');
const CONFIG = require('../config/constants');

// Generic sections wrapped around fetchSection helper

async function fetchTrending() {
    return fetchSection(CONFIG.FIRESTORE_COLLECTIONS.TRENDING, {
        page: 1, perPage: CONFIG.MEDIA_PER_PAGE, sort: ['TRENDING_DESC', 'POPULARITY_DESC']
    }, 'Trending Anime');
}

async function fetchTopRated() {
    return fetchSection(CONFIG.FIRESTORE_COLLECTIONS.TOP_RATED, {
        page: 1, perPage: CONFIG.MEDIA_PER_PAGE, sort: ['SCORE_DESC']
    }, 'Top Rated All Time');
}

async function fetchPopularSeason() {
    // Current season calculation
    const currentMonth = new Date().getMonth() + 1;
    let season;
    if (currentMonth >= 3 && currentMonth <= 5) season = 'SPRING';
    else if (currentMonth >= 6 && currentMonth <= 8) season = 'SUMMER';
    else if (currentMonth >= 9 && currentMonth <= 11) season = 'FALL';
    else season = 'WINTER';
    
    return fetchSection(CONFIG.FIRESTORE_COLLECTIONS.POPULAR_SEASON, {
        page: 1, perPage: CONFIG.MEDIA_PER_PAGE, 
        season: season, seasonYear: new Date().getFullYear(), sort: ['POPULARITY_DESC']
    }, 'Popular This Season');
}

async function fetchUpcoming() {
    return fetchSection(CONFIG.FIRESTORE_COLLECTIONS.UPCOMING, {
        page: 1, perPage: CONFIG.MEDIA_PER_PAGE, status: 'NOT_YET_RELEASED', sort: ['POPULARITY_DESC']
    }, 'Upcoming Next Season');
}

async function fetchTopAiring() {
    return fetchSection(CONFIG.FIRESTORE_COLLECTIONS.TOP_AIRING, {
        page: 1, perPage: CONFIG.MEDIA_PER_PAGE, status: 'RELEASING', sort: ['POPULARITY_DESC']
    }, 'Top Airing Now');
}

module.exports = {
    fetchTrending, fetchTopRated, fetchPopularSeason, fetchUpcoming, fetchTopAiring
};
