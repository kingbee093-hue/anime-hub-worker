const ALLOWED_FORMATS = ['TV', 'TV_SHORT', 'OVA', 'ONA', 'SPECIAL', 'MOVIE'];
const ALLOWED_MANGA_FORMATS = ['MANGA', 'ONE_SHOT'];

const BLOCKED_GENRES = ['Hentai', 'Ecchi'];

const BLOCKED_TAGS = [
  'Hentai', 'Explicit Sexual Content', 'Pornography', 'Ecchi'
];

const ALLOWED_COUNTRIES = ['JP', 'CN', 'KR', 'TW'];

function isAdultContent(media) {
  if (media.isAdult === true) return { blocked: true, reason: 'Adult (+18)' };

  const genres = media.genres || [];
  for (const genre of genres) {
    if (BLOCKED_GENRES.includes(genre)) {
      return { blocked: true, reason: genre };
    }
  }

  const tags = media.tags || [];
  for (const tag of tags) {
    const tagName = typeof tag === 'string' ? tag : tag.name;
    if (BLOCKED_TAGS.includes(tagName)) {
      return { blocked: true, reason: tagName };
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

function isManga(media) {
  if (media.type !== 'MANGA') {
    return { allowed: false, reason: `Not manga type: ${media.type}` };
  }

  if (media.format && !ALLOWED_MANGA_FORMATS.includes(media.format)) {
    return { allowed: false, reason: `Blocked manga format: ${media.format}` };
  }

  return { allowed: true };
}

module.exports = { isAdultContent, isAnime, isManga };
