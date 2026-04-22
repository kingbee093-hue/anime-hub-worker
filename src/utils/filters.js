const ALLOWED_FORMATS = ['TV', 'TV_SHORT', 'OVA', 'ONA', 'SPECIAL', 'MOVIE'];
const ALLOWED_MANGA_FORMATS = ['MANGA', 'ONE_SHOT'];

const BLOCKED_GENRES = ['Hentai', 'Ecchi', 'Erotica', 'Pornographic', 'Adult', 'Sexual Content', 'Suggestive', 'Fanservice'];

const BLOCKED_TAGS = [
  'Hentai', 
  'Explicit Sexual Content', 
  'Pornography', 
  'Ecchi', 
  'Incest', 
  'Smut',
  'Sexual Content',
  'Suggestive',
  'Fanservice',
  'NTR',
  'Netorare',
  // MangaDex fixed Tag IDs (UUIDs)
  '946652e5-4121-4494-bc5b-bfa0547b97cd', // Ecchi (MD)
  '5bd0e105-4481-44ca-b6e7-7544da56b1a3', // Incest (MD)
  'b13b2a48-c720-44a9-9c77-39c9979373fb', // Doujinshi (MD)
];

const ALLOWED_COUNTRIES = ['JP', 'CN', 'KR', 'TW'];

function isAdultContent(media) {
  if (media.isAdult === true) return { blocked: true, reason: 'Adult (+18)' };

  const genres = media.genres || [];
  for (const genre of genres) {
    if (BLOCKED_GENRES.some(blocked => genre.toLowerCase() === blocked.toLowerCase())) {
      return { blocked: true, reason: genre };
    }
  }

  const tags = media.tags || [];
  for (const tag of tags) {
    const tagName = typeof tag === 'string' ? tag : tag.name;
    const tagId = typeof tag === 'string' ? null : tag.id?.toString();
    
    if (tagName && BLOCKED_TAGS.some(blocked => tagName.toLowerCase() === blocked.toLowerCase())) {
      return { blocked: true, reason: tagName };
    }
    
    if (tagId && BLOCKED_TAGS.includes(tagId)) {
      return { blocked: true, reason: `Tag ID: ${tagId}` };
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
