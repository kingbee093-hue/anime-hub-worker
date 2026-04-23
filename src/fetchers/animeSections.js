const fetchSection = require('./fetchSection');
const CONFIG = require('../config/constants');

// Generic sections wrapped around fetchSection helper

async function fetchTrending() {
    // Fetch trending exactly as AniList ranks it — no status filter, no cap on pages.
    // Will scan as many pages as needed until 2000 valid items are collected.
    return fetchSection(CONFIG.API_PATHS.TRENDING, {
        perPage: 50,
        sort: ['TRENDING_DESC']
    }, 'Trending Anime', { accumulate: false, maxItems: 2000 });
}

async function fetchFeatured() {
    return fetchSection(CONFIG.API_PATHS.FEATURED, {
        perPage: 50,
        sort: ['TRENDING_DESC', 'SCORE_DESC', 'POPULARITY_DESC']
    }, 'Featured Anime', { accumulate: false, maxPages: 5 }); // Top 250 is enough for featured banner
}

async function fetchTopRated() {
    return fetchSection(CONFIG.API_PATHS.TOP_RATED, {
        perPage: 50,
        sort: ['SCORE_DESC']
    }, 'Top Rated All Time', { accumulate: true, maxItems: 2000 });
}

async function fetchPopularSeason() {
    const currentMonth = new Date().getMonth() + 1;
    let season;
    if (currentMonth >= 3 && currentMonth <= 5) season = 'SPRING';
    else if (currentMonth >= 6 && currentMonth <= 8) season = 'SUMMER';
    else if (currentMonth >= 9 && currentMonth <= 11) season = 'FALL';
    else season = 'WINTER';

    return fetchSection(CONFIG.API_PATHS.POPULAR_SEASON, {
        perPage: 50,
        season: season,
        seasonYear: new Date().getFullYear(),
        sort: ['POPULARITY_DESC']
    }, 'Popular This Season', { accumulate: false, maxItems: 2000 });
}

async function fetchUpcoming() {
    return fetchSection(CONFIG.API_PATHS.UPCOMING, {
        perPage: 50,
        status: 'NOT_YET_RELEASED',
        sort: ['POPULARITY_DESC']
    }, 'Upcoming Next Season', { accumulate: false, maxItems: 2000 });
}

async function fetchTopAiring() {
    return fetchSection(CONFIG.API_PATHS.TOP_AIRING, {
        perPage: 50,
        status: 'RELEASING',
        sort: ['POPULARITY_DESC']
    }, 'Top Airing Now', { accumulate: false, maxItems: 2000 });
}

module.exports = {
    fetchFeatured, fetchTrending, fetchTopRated, fetchPopularSeason, fetchUpcoming, fetchTopAiring
};
