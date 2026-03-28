async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatTimestamp(unixTimestamp) {
  return new Date(unixTimestamp * 1000).toISOString();
}

function cleanHtmlTags(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
}

/**
 * Shared method to convert AniList node/media to a consistent Firestore map
 */
function convertToFirestoreFormat(media, extra = {}) {
  try {
    const animeId = media.idMal || media.id;
    const title = media.title?.english || media.title?.romaji || media.title?.userPreferred || 'Unknown';
    
    let imageUrl = media.coverImage?.extraLarge || 
                     media.coverImage?.large || 
                     media.coverImage?.medium ||
                     media.bannerImage || '';
    
    // Fallback if banner image exists but cover is missing
    if (!imageUrl && media.bannerImage) {
        imageUrl = media.bannerImage;
    }
    
    const synopsis = cleanHtmlTags(media.description || '').substring(0, 1000);
    
    return {
      animeId,
      anilistId: media.id,
      title,
      titleRomaji: media.title?.romaji || '',
      titleEnglish: media.title?.english || '',
      titleNative: media.title?.native || '',
      synonyms: media.synonyms || [],
      imageUrl,
      coverImageLarge: media.coverImage?.large || '',
      coverImageMedium: media.coverImage?.medium || '',
      coverImageColor: media.coverImage?.color || '',
      bannerImage: media.bannerImage || '',
      synopsis,
      type: media.type || 'TV',
      format: media.format || '',
      status: media.status || 'UNKNOWN',
      season: media.season || '',
      seasonYear: media.seasonYear || null,
      seasonInt: media.seasonInt || null,
      episodes: media.episodes || 0,
      duration: media.duration || 0,
      genres: media.genres || [],
      tags: (media.tags || []).map(tag => ({
        id: tag.id, name: tag.name, description: tag.description,
        category: tag.category, rank: tag.rank,
        isGeneralSpoiler: tag.isGeneralSpoiler || false,
        isMediaSpoiler: tag.isMediaSpoiler || false,
        isAdult: tag.isAdult || false,
      })),
      studios: (media.studios?.edges || []).map(edge => ({
        id: edge.node.id, name: edge.node.name,
        isMain: edge.isMain || false, isAnimationStudio: edge.node.isAnimationStudio || false,
        siteUrl: edge.node.siteUrl || '',
      })),
      studiosNames: (media.studios?.edges || []).map(edge => edge.node.name),
      rating: media.averageScore ? media.averageScore / 10 : 0,
      averageScore: media.averageScore || 0,
      meanScore: media.meanScore || 0,
      popularity: media.popularity || 0,
      trending: media.trending || 0,
      favourites: media.favourites || 0,
      source: media.source || '',
      countryOfOrigin: media.countryOfOrigin || '',
      isLicensed: media.isLicensed || false,
      isAdult: media.isAdult || false,
      hashtag: media.hashtag || '',
      startDate: media.startDate && media.startDate.year ? 
        `${media.startDate.year}-${String(media.startDate.month || 1).padStart(2, '0')}-${String(media.startDate.day || 1).padStart(2, '0')}` : null,
      endDate: media.endDate && media.endDate.year ? 
        `${media.endDate.year}-${String(media.endDate.month || 1).padStart(2, '0')}-${String(media.endDate.day || 1).padStart(2, '0')}` : null,
      mal_url: media.idMal ? `https://myanimelist.net/anime/${media.idMal}` : '',
      anilist_url: media.siteUrl || '',
      trailer: media.trailer ? {
        id: media.trailer.id, site: media.trailer.site,
        url: media.trailer.site === 'youtube' ? `https://www.youtube.com/watch?v=${media.trailer.id}` : null,
      } : null,
      ...extra 
    };
  } catch (error) {
    console.error(`Error formatting media ${media?.id}: ${error.message}`);
    return null;
  }
}

module.exports = { delay, formatTimestamp, cleanHtmlTags, convertToFirestoreFormat };
