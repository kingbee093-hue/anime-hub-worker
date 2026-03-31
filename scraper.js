const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

function decodeHtmlEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'");
}

// Helper to clean encoded HTML and strip any leftover tags.
function cleanHtml(html) {
  if (!html) return '';

  let decoded = html.replace(/<br\s*\/?>/gi, ' ');
  for (let i = 0; i < 3; i++) {
    const next = decodeHtmlEntities(decoded);
    if (next === decoded) break;
    decoded = next;
  }

  return decoded.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Custom NSFW Filter to avoid adult/ecchi articles from scraping
function isNSFW(title, description = '') {
  const lowerText = (title + ' ' + description).toLowerCase();
  const nsfwKeywords = [
    'hentai', 'ecchi', 'erotica', 'adult', 'panties', 'opantsu',
    'sex', 'nsfw', 'nipple', 'breasts', 'boobs', 'nudes',
    'naked', 'porn', 'r18', 'r-18', '18+', 'succubus',
    'succubi', 'virgin', 'harem', 'iya na kao sare nagara'
  ];
  return nsfwKeywords.some(keyword => lowerText.includes(keyword));
}

// Scrape Anime News Network
async function fetchANN() {
  try {
    const { data } = await axios.get('https://www.animenewsnetwork.com/news/', {
      headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000
    });
    const $ = cheerio.load(data);
    const articles = [];
    
    $('.herald.box.news').each((i, el) => {
      if (i >= 50) return; // limit to 50
      const $el = $(el);
      const title = cleanHtml($el.find('h3 a').text().trim());
      const excerpt = cleanHtml($el.find('.preview').html() || $el.find('.preview').text().trim());
      const dateAttr = $el.find('.byline time').attr('datetime');
      const link = $el.find('h3 a').attr('href');
      
      if (title && link) {
        if (!isNSFW(title, excerpt)) {
          articles.push({
            id: `ann-${link.split('/').pop()}`,
            title: title,
            content: excerpt || title,
            sourceUrl: link.startsWith('http') ? link : `https://www.animenewsnetwork.com${link}`,
            author: 'ANN',
            publishedAt: dateAttr ? new Date(dateAttr) : new Date(),
            category: 'News',
            imageUrl: '' // to be populated
          });
        }
      }
    });

    // Fetch HD images in parallel
    await Promise.all(articles.map(async (article) => {
      try {
        const { data: articleData } = await axios.get(article.sourceUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000
        });
        const _$ = cheerio.load(articleData);
        let img = _$('meta[property="og:image"]').attr('content') || 
                  _$('.article img:first-child').attr('src') || '';
        
        if (img.startsWith('//')) img = `https:${img}`;
        else if (img.startsWith('/')) img = `https://www.animenewsnetwork.com${img}`;
        
        article.imageUrl = img || 'https://placehold.co/600x400/1a1a2e/7c3aed/png?text=Anime+News';

        const fullContentRoot = _$('.meat, .text-content, .news-article').first();
        const fullContent = cleanHtml(fullContentRoot.html() || fullContentRoot.text() || '');
        if (fullContent && fullContent.length > article.content.length) {
          article.content = fullContent;
        }
      } catch (e) {
        article.imageUrl = 'https://placehold.co/600x400/1a1a2e/7c3aed/png?text=Anime+News';
      }
    }));
    return articles;
  } catch (error) {
    console.error('ANN error:', error.message);
    return [];
  }
}

// Scrape MyAnimeList RSS directly
async function fetchMAL() {
  try {
    const { data } = await axios.get('https://myanimelist.net/rss/news.xml', {
      headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000
    });
    const $ = cheerio.load(data, { xmlMode: true });
    const articles = [];

    $('item').slice(0, 50).each((i, el) => {
      const title = cleanHtml($(el).find('title').text().trim());
      let description = $(el).find('description').text().trim();
      description = cleanHtml(description);
      const link = $(el).find('link').text().trim();
      const pubDate = $(el).find('pubDate').text().trim();
      
      // MAL thumbnail comes from <media:thumbnail> namespace, cheerio handles wildcards or namespaced tags 
      let imageUrl = $(el).find('media\\:thumbnail').text().trim();
      if (!imageUrl || imageUrl === '') {
        imageUrl = $(el).find('thumbnail').text().trim();
      }

      const lowerText = (title + ' ' + description).toLowerCase();
      let matchedCategory = 'News';
      if (lowerText.includes('shonen') || lowerText.includes('jump')) matchedCategory = 'Shonen';
      else if (lowerText.includes('action') || lowerText.includes('fight')) matchedCategory = 'Action';
      else if (lowerText.includes('adventure') || lowerText.includes('quest')) matchedCategory = 'Adventure';
      else if (lowerText.includes('romance') || lowerText.includes('love')) matchedCategory = 'Romance';

      if (!isNSFW(title, description)) {
        articles.push({
          id: `mal-${Date.now()}-${i}`,
          title: title,
          content: description,
          sourceUrl: link,
          author: 'MyAnimeList',
          publishedAt: new Date(pubDate),
          category: matchedCategory,
          imageUrl: imageUrl || 'https://placehold.co/600x400/1a1a2e/7c3aed/png?text=Anime+News'
        });
      }
    });

    // Fetch full article text for MAL to replace the short RSS snippet
    await Promise.all(articles.map(async (article) => {
      try {
        const { data: articleData } = await axios.get(article.sourceUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000
        });
        const _$ = cheerio.load(articleData);
        
        // MAL specific selectors for the main text content, ignoring script tags
        _$('script, style, iframe, .news-info-block').remove();
        const fullContent = cleanHtml(_$('.news-container .content').html() || _$('.news-container .content').text() || '');
        
        if (fullContent && fullContent.length > article.content.length) {
          article.content = fullContent;
        }
      } catch (e) {
        // Fallback to initial snippet on failure
      }
    }));

    return articles;
  } catch (error) {
    console.error('MAL error:', error.message);
    return [];
  }
}

// Fetch ComicBook Anime News via RSS
async function fetchComicBook() {
  try {
    const { data } = await axios.get('https://comicbook.com/category/anime/feed/', {
      headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000
    });
    const $ = cheerio.load(data, { xmlMode: true });
    const articles = [];

    $('item').slice(0, 50).each((i, el) => {
      const title = cleanHtml($(el).find('title').text().trim());
      const link = $(el).find('link').text().trim();
      const pubDate = $(el).find('pubDate').text().trim();

      // Comicbook includes full content in content:encoded
      const fullContentHtml = $(el).find('content\\:encoded').text().trim();
      let contentText = '';
      let imageUrl = '';

      if (fullContentHtml) {
        const _$ = cheerio.load(fullContentHtml);
        imageUrl = _$('img').first().attr('src') || '';
        // Extract all text paragraphs for cleaner full content
        const pTexts = [];
        _$('p').each((_, p) => {
          const pt = cleanHtml(_$(p).html() || _$(p).text());
          if (pt) pTexts.push(pt);
        });
        contentText = pTexts.join('\n\n');
      }

      if (!imageUrl) {
        // Fallback to media:content if available
        imageUrl = $(el).find('media\\:content').attr('url') || $(el).find('thumbnail').attr('url') || '';
      }

      if (!title || !link || !contentText) return;
      if (isNSFW(title, contentText)) return;

      articles.push({
        id: `cb-${link.split('/').filter(Boolean).pop() || i}`,
        title,
        content: contentText,
        sourceUrl: link,
        author: 'ComicBook',
        publishedAt: new Date(pubDate),
        category: 'News',
        imageUrl: imageUrl || 'https://placehold.co/600x400/1a1a2e/7c3aed/png?text=Anime+News'
      });
    });

    console.log(`ComicBook: ${articles.length} articles fetched`);
    return articles;
  } catch (error) {
    console.error('ComicBook error:', error.message);
    return [];
  }
}

// Scrape Anime Corner News
async function fetchAnimeCorner() {
  try {
    const { data } = await axios.get('https://animecorner.me/category/anime-news/', {
      headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000
    });
    const $ = cheerio.load(data);
    const articles = [];

    $('article').each((i, el) => {
      if (i >= 30) return;
      const $el = $(el);

      const titleEl = $el.find('h2 a, h3 a').first();
      const title = cleanHtml(titleEl.text().trim());
      const link = titleEl.attr('href') || '';
      if (!title || !link) return;

      // Image: lazy-loaded in data-bgset attribute
      let imageUrl = $el.find('[data-bgset]').attr('data-bgset') ||
                     $el.find('[data-bg]').attr('data-bg') ||
                     $el.find('img').attr('src') || '';
      // data-bgset sometimes has multiple sizes like "url 768w, url2 1024w"
      if (imageUrl && imageUrl.includes(' ')) {
        imageUrl = imageUrl.split(',')[0].trim().split(' ')[0];
      }

      const excerpt = cleanHtml($el.find('.entry-summary p, .excerpt p, p').first().html() || $el.find('.entry-summary p, .excerpt p, p').first().text().trim());
      const dateText = $el.find('time').attr('datetime') || $el.find('.entry-date').text().trim();

      if (isNSFW(title, excerpt)) return;

      articles.push({
        id: `ac-${link.split('/').filter(Boolean).pop() || i}`,
        title,
        content: excerpt || title,
        sourceUrl: link,
        author: 'Anime Corner',
        publishedAt: dateText ? new Date(dateText) : new Date(),
        category: 'News',
        imageUrl: imageUrl || 'https://placehold.co/600x400/1a1a2e/7c3aed/png?text=Anime+News'
      });
    });

    // For articles with short content, fetch full article text
    await Promise.all(articles.map(async (article) => {
      try {
        const { data: articleData } = await axios.get(article.sourceUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000
        });
        const _$ = cheerio.load(articleData);
        // Get og:image if we're missing it
        if (!article.imageUrl || article.imageUrl.includes('placehold')) {
          const img = _$('meta[property="og:image"]').attr('content') || '';
          if (img) article.imageUrl = img;
        }
        // Get full content
        _$('script, style, .sharedaddy, .jp-relatedposts').remove();
        const fullContent = cleanHtml(_$('.entry-content, .post-content, article .content').first().html() || _$('.entry-content, .post-content, article .content').first().text() || '');
        if (fullContent && fullContent.length > article.content.length) {
          article.content = fullContent;
        }
      } catch(e) {}
    }));

    console.log(`Anime Corner: ${articles.length} articles fetched`);
    return articles;
  } catch (error) {
    console.error('Anime Corner error:', error.message);
    return [];
  }
}

(async () => {
  // Load existing news first to get the latest date
  const apiDir = path.join(__dirname, 'api');
  if (!fs.existsSync(apiDir)) fs.mkdirSync(apiDir);
  const outputPath = path.join(apiDir, 'news.json');

  let existingNews = [];
  if (fs.existsSync(outputPath)) {
    try {
      existingNews = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    } catch (e) {
      console.error('Could not parse existing news.json, starting fresh.');
    }
  }

  console.log(`Existing articles: ${existingNews.length}`);

  // Find the latest article date in existing news to use as a cutoff
  let latestDate = null;
  for (const article of existingNews) {
    const d = new Date(article.publishedAt);
    if (!isNaN(d.getTime())) {
      if (!latestDate || d > latestDate) latestDate = d;
    }
  }
  if (latestDate) {
    console.log(`Latest article in DB: ${latestDate.toISOString()}`);
  } else {
    console.log('No existing articles found, fetching all available news.');
  }

  console.log('Fetching ANN news...');
  const annNews = await fetchANN();

  console.log('Fetching MAL news...');
  const malNews = await fetchMAL();

  console.log('Fetching ComicBook news...');
  const cbNews = await fetchComicBook();

  console.log('Fetching Anime Corner news...');
  const acNews = await fetchAnimeCorner();

  // Combine and sort by date descending
  let newNews = [...annNews, ...malNews, ...cbNews, ...acNews];
  newNews.sort((a, b) => b.publishedAt - a.publishedAt);

  // Format dates to simple strings for Flutter
  newNews = newNews.map(a => {
    const dateObj = new Date(a.publishedAt);
    const options = { month: 'short', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true };
    a.publishedAt = dateObj.toLocaleString('en-US', options).replace(',', ' •');
    return a;
  });

  // Filter: only keep articles whose sourceUrl is not already in DB
  const existingUrls = new Set(existingNews.map(a => a.sourceUrl));
  const uniqueNew = newNews.filter(a => !existingUrls.has(a.sourceUrl));

  console.log(`Found ${uniqueNew.length} brand new articles not in DB.`);

  if (uniqueNew.length === 0) {
    console.log('No new articles to add. DB is up to date!');
    return;
  }

  // Accumulate: new articles at the top
  let finalNews = [...uniqueNew, ...existingNews];

  // Limit to 10000 articles max
  finalNews = finalNews.slice(0, 10000);

  fs.writeFileSync(outputPath, JSON.stringify(finalNews, null, 2));
  console.log(`✅ Added ${uniqueNew.length} new articles. Total: ${finalNews.length}`);
})();
