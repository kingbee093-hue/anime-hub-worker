const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// Helper to clean HTML from description
function cleanHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]+>/g, '').trim();
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
      const title = $el.find('h3 a').text().trim();
      const excerpt = $el.find('.preview').text().trim();
      const dateAttr = $el.find('.byline time').attr('datetime');
      const link = $el.find('h3 a').attr('href');
      
      if (title && link) {
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
      const title = $(el).find('title').text().trim();
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
    });

    return articles;
  } catch (error) {
    console.error('MAL error:', error.message);
    return [];
  }
}

(async () => {
  console.log('Fetching ANN news...');
  const annNews = await fetchANN();
  
  console.log('Fetching MAL news...');
  const malNews = await fetchMAL();

  // Combine and sort by date descending
  let newNews = [...annNews, ...malNews];
  newNews.sort((a, b) => b.publishedAt - a.publishedAt);

  // Format dates to simple strings for Flutter
  newNews = newNews.map(a => {
    const dateObj = new Date(a.publishedAt);
    const options = { month: 'short', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true };
    a.publishedAt = dateObj.toLocaleString('en-US', options).replace(',', ' •');
    return a;
  });

  // Ensure output directory 'api' exists
  const apiDir = path.join(__dirname, 'api');
  if (!fs.existsSync(apiDir)) {
    fs.mkdirSync(apiDir);
  }

  const outputPath = path.join(apiDir, 'news.json');

  // Load existing news if available to accumulate
  let existingNews = [];
  if (fs.existsSync(outputPath)) {
    try {
      existingNews = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    } catch (e) {
      console.error('Could not parse existing news.json, starting fresh.', e);
    }
  }

  // Find unique new articles by checking if sourceUrl already exists
  const existingUrls = new Set(existingNews.map(a => a.sourceUrl));
  const uniqueNewArticles = newNews.filter(a => !existingUrls.has(a.sourceUrl));

  console.log(`Found ${uniqueNewArticles.length} brand new articles.`);

  // Accumulate: put new articles at the top
  let finalNews = [...uniqueNewArticles, ...existingNews];

  // Limit database to 1500 articles to prevent performance issues in GitHub and App
  finalNews = finalNews.slice(0, 1500);

  fs.writeFileSync(outputPath, JSON.stringify(finalNews, null, 2));
  console.log(`Successfully wrote ${finalNews.length} total articles to news.json!`);
})();
