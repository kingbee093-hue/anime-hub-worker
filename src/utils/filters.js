const ALLOWED_FORMATS = ['TV', 'TV_SHORT', 'OVA', 'ONA', 'SPECIAL', 'MOVIE'];

const BLOCKED_GENRES = ['Hentai'];

const BLOCKED_TAGS = [
  'Hentai', 'Explicit Sexual Content', 'Pornography'
];

const ALLOWED_COUNTRIES = ['JP', 'CN', 'KR', 'TW'];

function isAdultContent(media) {
  if (media.isAdult === true) return { blocked: true, reason: 'isAdult flag' };

  const genres = media.genres || [];
  for (const genre of genres) {
    if (BLOCKED_GENRES.includes(genre)) {
      return { blocked: true, reason: `Blocked genre: ${genre}` };
    }
  }

  const tags = media.tags || [];
  for (const tag of tags) {
    if (BLOCKED_TAGS.includes(tag.name)) {
      return { blocked: true, reason: `Blocked tag: ${tag.name}` };
    }
  }

  return { blocked: false };
}

function isAnime(media) {
  if (media.type !== 'ANIME') {
    return { allowed: false, reason: `Not anime type: ${media.type}` };
  }

  if (!ALLOWED_FORMATS.includes(media.format)) {
    return { allowed: false, reason: `Blocked format: ${media.format}` };
  }

  if (media.countryOfOrigin && !ALLOWED_COUNTRIES.includes(media.countryOfOrigin)) {
    return { allowed: false, reason: `Blocked country: ${media.countryOfOrigin}` };
  }

  return { allowed: true };
}

module.exports = { isAdultContent, isAnime };
