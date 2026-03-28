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

module.exports = { AIRING_ANIME_QUERY, GENERIC_MEDIA_QUERY };
