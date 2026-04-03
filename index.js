/**
 * Anime Hub Worker Orchestrator
 */

require('dotenv').config();

const fetchRecentEpisodes = require('./src/fetchers/fetchRecentEpisodes');
const { fetchFeatured, fetchTrending, fetchTopRated, fetchPopularSeason, fetchUpcoming, fetchTopAiring } = require('./src/fetchers/animeSections');
const fetchByGenre = require('./src/fetchers/fetchByGenre');
const fetchNews = require('./src/fetchers/fetchNews');

async function run() {
    const args = process.argv.slice(2);
    const target = args[0] ? args[0].toLowerCase() : 'all';

    console.log(`🚀 Starting Anime Hub Worker... Target: [${target.toUpperCase()}]`);

    try {
        if (target === 'recent' || target === 'all') await fetchRecentEpisodes();
        if (target === 'featured' || target === 'all') await fetchFeatured();
        if (target === 'trending' || target === 'all') await fetchTrending();
        if (target === 'toprated' || target === 'all') await fetchTopRated();
        if (target === 'popular' || target === 'all') await fetchPopularSeason();
        if (target === 'upcoming' || target === 'all') await fetchUpcoming();
        if (target === 'topairing' || target === 'all') await fetchTopAiring();
        if (target === 'genres' || target === 'all') await fetchByGenre();
        if (target === 'news' || target === 'all') await fetchNews();

        console.log('\n🎉 All tasks completed successfully!');
        process.exit(0);
    } catch (error) {
        console.error('❌ FATAL ERROR during execution:', error);
        process.exit(1);
    }
}

run();
