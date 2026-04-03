const CONFIG = {
  ANILIST_API: 'https://graphql.anilist.co',
  RECENCY_DAYS: 7,        // For recent episodes
  EPISODES_PER_PAGE: 50,  // Pagination limit for AniList
  MEDIA_PER_PAGE: 30,     // Items limit for sections
  MAX_RETRIES: 3,
  RETRY_DELAY: 2000,      // 2 seconds
  RATE_LIMIT_DELAY: 700,  // milliseconds between requests
  API_PATHS: {
    RECENT_EPISODES: 'recent_episodes',
    FEATURED: 'home_sections/featured',
    TRENDING: 'home_sections/trending',
    TOP_RATED: 'home_sections/top_rated',
    POPULAR_SEASON: 'home_sections/popular_season',
    UPCOMING: 'home_sections/upcoming',
    TOP_AIRING: 'home_sections/top_airing',
    BY_GENRE: 'home_sections/genres', 
    SCHEDULE: 'schedule',
    CATALOG: 'catalog',
    CHARACTERS: 'catalog/characters',
    STUDIOS: 'catalog/studios',
    SEARCH_INDEX: 'search/anime_index',
    MANGA_FEATURED: 'manga/featured',
    MANGA_TRENDING: 'manga/trending',
    MANGA_TOP_RATED: 'manga/top_rated',
    MANGA_POPULAR: 'manga/popular',
    MANGA_BY_GENRE: 'manga/genres',
    MANGA_CATALOG: 'manga/catalog',
    MANGA_CHAPTERS: 'manga/chapters',
    MANGA_MAPPING: 'manga/mangadex_mapping',
    MANGA_SEARCH_INDEX: 'search/manga_index',
    NEWS: 'news' 
  }
};

module.exports = CONFIG;
