const Parser = require('rss-parser');
const crypto = require('crypto');
const CONFIG = require('../config/constants');
const { cleanHtmlTags } = require('../utils/formatters');
const fs = require('fs');
const path = require('path');

async function fetchNews() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📰 FETCHING LATEST ANIME NEWS');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const apiFile = path.join(__dirname, '../../api', `${CONFIG.API_PATHS.NEWS}.json`);
  let existingNews = [];
  if (fs.existsSync(apiFile)) {
    existingNews = JSON.parse(fs.readFileSync(apiFile, 'utf8'));
  }

  const parser = new Parser({
    customFields: {
      item: [
        ['media:thumbnail', 'mediaThumbnail'],
        ['content:encoded', 'contentEncoded'],
      ]
    }
  });

  const feeds = [
    'https://www.animenewsnetwork.com/news/rss.xml', // Excellent quality ANN news
    'https://cr-news-api-service.crunchyroll.com/v1/en-US/rss' // Crunchyroll news
  ];

  const toUpload = [];

  for (const feedUrl of feeds) {
    console.log(`📡 Fetching from: ${feedUrl}`);
    try {
      let feed = await parser.parseURL(feedUrl);
      console.log(`   Found ${feed.items.length} articles`);

      for (const item of feed.items) {
        // Create unique ID based on URL
        const id = crypto.createHash('sha256').update(item.link || item.title).digest('hex').substring(0, 20);
        
        // Try to find image url 
        let imageUrl = '';
        if (item.mediaThumbnail && item.mediaThumbnail['$'] && item.mediaThumbnail['$'].url) {
            imageUrl = item.mediaThumbnail['$'].url;
        } else if (item.contentEncoded) {
            // extract img tag
            const imgMatch = item.contentEncoded.match(/<img[^>]+src="([^">]+)"/);
            if (imgMatch && imgMatch[1]) {
                imageUrl = imgMatch[1];
            }
        }
        
        const summary = cleanHtmlTags(item.contentSnippet || item.content || '').substring(0, 500);

        const newsData = {
          id: id,
          title: item.title,
          link: item.link,
          summary: summary,
          imageUrl: imageUrl,
          pubDate: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
          source: feed.title || 'Anime News',
          author: item.creator || item.author || '',
        };
        toUpload.push(newsData);
      }
    } catch (error) {
       console.error(`❌ Failed to fetch feed ${feedUrl}:`, error.message);
    }
  }

  // Merge new items with existing ones, deduplicate by id
  const newsMap = new Map();
  for (const n of existingNews) {
    newsMap.set(n.id, n);
  }
  for (const n of toUpload) {
    newsMap.set(n.id, n);
  }

  const combinedNews = Array.from(newsMap.values());
  // Sort by newest first
  combinedNews.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  
  // Keep only the most recent 100 articles
  const finalNews = combinedNews.slice(0, 100);

  fs.mkdirSync(path.dirname(apiFile), { recursive: true });
  
  const existingContent = JSON.stringify(existingNews, null, 2);
  const newContent = JSON.stringify(finalNews, null, 2);

  if (existingContent !== newContent) {
    fs.writeFileSync(apiFile, newContent, 'utf8');
    console.log(`✅ Uploaded ${finalNews.length} news articles to ${apiFile}.`);
  } else {
    console.log('\n✅ No new news articles found (API file is up to date).');
  }
}

module.exports = fetchNews;
