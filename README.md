# anime-hub-worker

Anime Hub data worker for GitHub Actions.

It generates and updates:
- `api/home_sections/*` for featured, trending, top rated, seasonal, upcoming, top airing, and genre feeds
- `api/recent_episodes.json`
- `api/schedule/*.json`
- `api/catalog/*` for anime, characters, studios, and genre catalogs
- `api/search/anime_index/*` for shard-based search
- `api/news*.json` for latest news, archives, and paginated news feeds

Main commands:
- `npm run fetch:news`
- `npm run fetch:recent`
- `npm run fetch:sections`
- `npm run fetch:schedule`
- `npm run fetch:genres`
- `npm run fetch:catalog`
- `npm run fetch:characters`
- `npm run backfill:news`
