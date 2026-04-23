const fetchSection = require('./fetchSection');
const CONFIG = require('../config/constants');

// Generic sections wrapped around fetchSection helper

async function fetchTrending() {
    return fetchSection(CONFIG.API_PATHS.TRENDING, {
        page: 1, perPage: CONFIG.MEDIA_PER_PAGE, sort: ['TRENDING_DESC', 'POPULARITY_DESC']
    }, 'Trending Anime', { accumulate: true });
}

async function fetchFeatured() {
    return fetchSection(CONFIG.API_PATHS.FEATURED, {
        page: 1,
        perPage: 8,
        sort: ['TRENDING_DESC', 'SCORE_DESC', 'POPULARITY_DESC']
    }, 'Featured Anime', { accumulate: true });
}

async function fetchTopRated() {
    return fetchSection(CONFIG.API_PATHS.TOP_RATED, {
        page: 1, perPage: CONFIG.MEDIA_PER_PAGE, sort: ['SCORE_DESC']
    }, 'Top Rated All Time', { accumulate: true });
}

async function fetchPopularSeason() {
    // Current season calculation
    const currentMonth = new Date().getMonth() + 1;
    let season;
    if (currentMonth >= 3 && currentMonth <= 5) season = 'SPRING';
    else if (currentMonth >= 6 && currentMonth <= 8) season = 'SUMMER';
    else if (currentMonth >= 9 && currentMonth <= 11) season = 'FALL';
    else season = 'WINTER';
    
    return fetchSection(CONFIG.API_PATHS.POPULAR_SEASON, {
        page: 1, perPage: CONFIG.MEDIA_PER_PAGE, 
        season: season, seasonYear: new Date().getFullYear(), sort: ['POPULARITY_DESC']
    }, 'Popular This Season', { accumulate: true });
}

async function fetchUpcoming() {
    return fetchSection(CONFIG.API_PATHS.UPCOMING, {
        page: 1, perPage: CONFIG.MEDIA_PER_PAGE, status: 'NOT_YET_RELEASED', sort: ['POPULARITY_DESC']
    }, 'Upcoming Next Season', { accumulate: true });
}

async function fetchTopAiring() {
    return fetchSection(CONFIG.API_PATHS.TOP_AIRING, {
        page: 1, perPage: CONFIG.MEDIA_PER_PAGE, status: 'RELEASING', sort: ['POPULARITY_DESC']
    }, 'Top Airing Now', { accumulate: true });
}

module.exports = {
    fetchFeatured, fetchTrending, fetchTopRated, fetchPopularSeason, fetchUpcoming, fetchTopAiring
};
