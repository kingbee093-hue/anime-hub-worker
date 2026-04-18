const MEDIA_FRAGMENT = `
  id
  idMal
  title { romaji english native userPreferred }
  coverImage { extraLarge large medium color }
  bannerImage
  startDate { year month day }
  endDate { year month day }
  description
  season seasonYear seasonInt
  episodes duration countryOfOrigin isLicensed source hashtag
  trailer { id site }
  updatedAt
  genres synonyms averageScore meanScore popularity isLocked trending favourites
  tags { id name description category rank isGeneralSpoiler isMediaSpoiler isAdult }
  studios(isMain: true) { edges { isMain node { id name isAnimationStudio siteUrl } } }
  isFavourite isAdult
  siteUrl autoCreateForumThread isRecommendationBlocked isReviewBlocked type format status
`;

const AIRING_ANIME_QUERY = `
query ($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage lastPage hasNextPage perPage }
    airingSchedules(notYetAired: false, sort: TIME_DESC) {
      id episode airingAt timeUntilAiring
      media { ${MEDIA_FRAGMENT} }
    }
  }
}
`;

const GENERIC_MEDIA_QUERY = `
query ($page: Int, $perPage: Int, $sort: [MediaSort], $status: MediaStatus, $season: MediaSeason, $seasonYear: Int, $genre: String) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage lastPage hasNextPage perPage }
    media(type: ANIME, sort: $sort, status: $status, season: $season, seasonYear: $seasonYear, genre: $genre) {
       ${MEDIA_FRAGMENT}
    }
  }
}
`;

const MANGA_MEDIA_FRAGMENT = `
  id
  idMal
  title { romaji english native userPreferred }
  coverImage { extraLarge large medium color }
  bannerImage
  startDate { year month day }
  endDate { year month day }
  description
  chapters
  volumes
  countryOfOrigin
  source
  updatedAt
  genres
  synonyms
  averageScore
  meanScore
  popularity
  trending
  favourites
  isAdult
  siteUrl
  type
  format
  status
  tags { id name description category rank isGeneralSpoiler isMediaSpoiler isAdult }
  externalLinks { site url }
  staff(perPage: 5) {
    edges {
      role
      node {
        id
        name { full native }
        siteUrl
      }
    }
  }
`;

const GENERIC_MANGA_QUERY = `
query ($page: Int, $perPage: Int, $sort: [MediaSort], $status: MediaStatus, $genre: String) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage lastPage hasNextPage perPage }
    media(type: MANGA, sort: $sort, status: $status, genre: $genre) {
      ${MANGA_MEDIA_FRAGMENT}
    }
  }
}
`;

const AIRING_SCHEDULE_WINDOW_QUERY = `
query ($page: Int, $perPage: Int, $from: Int, $to: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage lastPage hasNextPage perPage }
    airingSchedules(
      airingAt_greater: $from,
      airingAt_lesser: $to,
      sort: TIME
    ) {
      id
      episode
      airingAt
      timeUntilAiring
      media { ${MEDIA_FRAGMENT} }
    }
  }
}
`;

const POPULAR_CHARACTERS_QUERY = `
query ($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage lastPage hasNextPage perPage }
    characters(sort: [FAVOURITES_DESC]) {
      id
      name { full native }
      image { large medium }
      description
      gender
      age
      favourites
      siteUrl
      media(perPage: 3, sort: [POPULARITY_DESC]) {
        nodes {
          id
          title { romaji english native userPreferred }
          type
          format
          siteUrl
        }
      }
    }
  }
}
`;

const MANGA_BY_IDS_QUERY = `
query ($ids: [Int]) {
  Page(page: 1, perPage: 50) {
    media(type: MANGA, id_in: $ids) {
      ${MANGA_MEDIA_FRAGMENT}
    }
  }
}
`;

module.exports = {
  AIRING_ANIME_QUERY,
  GENERIC_MEDIA_QUERY,
  GENERIC_MANGA_QUERY,
  MANGA_BY_IDS_QUERY,
  AIRING_SCHEDULE_WINDOW_QUERY,
  POPULAR_CHARACTERS_QUERY,
};
