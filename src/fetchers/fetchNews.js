const Parser = require('rss-parser');
const crypto = require('crypto');
const { db, admin } = require('../config/firebase');
const CONFIG = require('../config/constants');
const { cleanHtmlTags } = require('../utils/formatters');

async function fetchNews() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📰 FETCHING LATEST ANIME NEWS');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

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
          pubDate: item.pubDate ? new Date(item.pubDate) : new Date(),
          source: feed.title || 'Anime News',
          author: item.creator || item.author || '',
          insertedAt: admin.firestore.FieldValue.serverTimestamp(),
          // Don't overwrite comments or likes on set with merge:true
        };
        toUpload.push(newsData);
      }
    } catch (error) {
       console.error(`❌ Failed to fetch feed ${feedUrl}:`, error.message);
    }
  }

  if (toUpload.length > 0) {
    console.log(`\n🚀 Uploading ${toUpload.length} news articles to Firestore...`);
    let batch = db.batch();
    let count = 0;

    for (const news of toUpload) {
      const docRef = db.collection(CONFIG.FIRESTORE_COLLECTIONS.NEWS).doc(news.id);
      
      // Merge: true is CRITICAL to keep likes, comments, and stats from users intact!
      batch.set(docRef, news, { merge: true });
      count++;

      if (count % 400 === 0) {
        await batch.commit();
        batch = db.batch();
      }
    }
    
    if (count % 400 !== 0) {
      await batch.commit();
    }
    
    console.log(`✅ ${toUpload.length} News successfully uploaded.`);
  } else {
    console.log('\n✅ No news articles found.');
  }
}

module.exports = fetchNews;
