const CONFIG = {
  ANILIST_API: 'https://graphql.anilist.co',
  RECENCY_DAYS: 7,        // For recent episodes
  EPISODES_PER_PAGE: 50,  // Pagination limit for AniList
  MEDIA_PER_PAGE: 30,     // Items limit for sections
  MAX_RETRIES: 3,
  RETRY_DELAY: 2000,      // 2 seconds
  RATE_LIMIT_DELAY: 700,  // milliseconds between requests
  FIRESTORE_COLLECTIONS: {
    RECENT_EPISODES: 'recent_episodes',
    TRENDING: 'home_sections/trending/items',
    TOP_RATED: 'home_sections/top_rated/items',
    POPULAR_SEASON: 'home_sections/popular_season/items',
    UPCOMING: 'home_sections/upcoming/items',
    TOP_AIRING: 'home_sections/top_airing/items',
    BY_GENRE: 'home_sections', // will append /genres/<genre>/items
    NEWS: 'news' // Latest news collection
  }
};

module.exports = CONFIG;
