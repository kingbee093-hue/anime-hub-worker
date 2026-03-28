const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const PLACEHOLDER = 'https://placehold.co/600x400/1a1a2e/7c3aed/png?text=Anime+News';
const TARGET_YEAR = 2019; // Stop scraping when we reach articles older than this

function formatDate(dateObj) {
  if (!dateObj || isNaN(dateObj.getTime())) return '';
  const options = { month: 'short', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true };
  return dateObj.toLocaleString('en-US', options).replace(',', ' •');
}

function classifyCategory(text) {
  const lower = text.toLowerCase();
  if (lower.includes('shonen') || lower.includes('shounen') || lower.includes('jump')) return 'Shonen';
  if (lower.includes('action') || lower.includes('fight') || lower.includes('battle')) return 'Action';
  if (lower.includes('adventure') || lower.includes('quest')) return 'Adventure';
  if (lower.includes('romance') || lower.includes('love')) return 'Romance';
  if (lower.includes('comedy') || lower.includes('funny') || lower.includes('humor')) return 'Comedy';
  if (lower.includes('drama') || lower.includes('slice of life')) return 'Drama';
  if (lower.includes('fantasy') || lower.includes('magic') || lower.includes('isekai')) return 'Fantasy';
  if (lower.includes('horror') || lower.includes('thriller')) return 'Horror';
  if (lower.includes('sci-fi') || lower.includes('mecha') || lower.includes('robot')) return 'Sci-Fi';
  if (lower.includes('sports') || lower.includes('tournament')) return 'Sports';
  if (lower.includes('industry') || lower.includes('studio') || lower.includes('box office')) return 'Industry';
  if (lower.includes('music') || lower.includes('song') || lower.includes('opening') || lower.includes('ending')) return 'Music';
  if (lower.includes('manga') || lower.includes('chapter') || lower.includes('volume')) return 'Manga';
  if (lower.includes('season') || lower.includes('episode') || lower.includes('trailer') || lower.includes('preview')) return 'Announcements';
  return 'News';
}

// Fetch a single paginated page from ANN news list
// ANN uses ?p= for page number (each page has ~25 articles)
async function fetchANNPage(pageNum) {
  const url = `https://www.animenewsnetwork.com/news/?p=${pageNum}`;
  try {
    const { data } = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 20000
    });

    const $ = cheerio.load(data);
    const articles = [];
    let oldestDateOnPage = null;

    $('.herald.box.news, .herald.box').each((i, el) => {
      const $el = $(el);
      const title = $el.find('h3 a, h2 a').first().text().trim();
      const excerpt = $el.find('.preview, p').first().text().trim();
      const dateAttr = $el.find('time').attr('datetime') || $el.find('.byline time').attr('datetime');
      const linkEl = $el.find('h3 a, h2 a').first();
      const link = linkEl.attr('href');

      if (!title || !link) return;

      const sourceUrl = link.startsWith('http') ? link : `https://www.animenewsnetwork.com${link}`;
      const dateObj = dateAttr ? new Date(dateAttr) : null;
      
      if (dateObj && !isNaN(dateObj.getTime())) {
        if (!oldestDateOnPage || dateObj < oldestDateOnPage) {
          oldestDateOnPage = dateObj;
        }
      }

      const slug = link.split('/').filter(Boolean).pop() || '';
      const category = classifyCategory(title + ' ' + excerpt);

      articles.push({
        id: `ann-${slug || `p${pageNum}-${i}`}`,
        title,
        content: excerpt || title,
        sourceUrl,
        author: 'ANN',
        publishedAt: dateObj ? formatDate(dateObj) : '',
        _rawDate: dateObj ? dateObj.toISOString() : '',
        category,
        imageUrl: PLACEHOLDER
      });
    });

    return { articles, oldestDateOnPage };
  } catch (e) {
    console.error(`  Page ${pageNum}: ERROR - ${e.message}`);
    return { articles: [], oldestDateOnPage: null };
  }
}

// Fetch MAL news RSS (multiple pages if available)
async function fetchMALNews() {
  const urls = [
    'https://myanimelist.net/rss/news.xml',
  ];
  
  const allArticles = [];
  
  for (const url of urls) {
    try {
      const { data } = await axios.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 15000
      });
      const $ = cheerio.load(data, { xmlMode: true });

      $('item').each((i, el) => {
        const title = $(el).find('title').text().trim();
        let description = $(el).find('description').text().trim();
        description = description.replace(/<[^>]+>/g, '').trim();
        const link = $(el).find('link').text().trim();
        const pubDate = $(el).find('pubDate').text().trim();
        let imageUrl = $(el).find('media\\:thumbnail, thumbnail').attr('url') || 
                       $(el).find('media\\:thumbnail, thumbnail').text().trim() || PLACEHOLDER;

        if (!title || !link) return;

        const dateObj = pubDate ? new Date(pubDate) : new Date();
        const category = classifyCategory(title + ' ' + description);

        allArticles.push({
          id: `mal-${link.split('/').filter(Boolean).pop() || i}`,
          title,
          content: description || title,
          sourceUrl: link,
          author: 'MyAnimeList',
          publishedAt: formatDate(dateObj),
          _rawDate: dateObj.toISOString(),
          category,
          imageUrl: imageUrl || PLACEHOLDER
        });
      });
    } catch (e) {
      console.error(`MAL fetch error: ${e.message}`);
    }
  }
  
  return allArticles;
}

(async () => {
  console.log('=== BACKFILL: Fetching all ANN news pages until year', TARGET_YEAR, '===\n');

  const allArticles = [];
  const seenUrls = new Set();
  let pageNum = 1;
  let reachedTarget = false;

  // Read existing news.json to avoid duplicates
  const apiDir = path.join(__dirname, 'api');
  if (!fs.existsSync(apiDir)) fs.mkdirSync(apiDir);
  const outputPath = path.join(apiDir, 'news.json');

  let existingNews = [];
  if (fs.existsSync(outputPath)) {
    try {
      existingNews = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      console.log(`Existing articles in DB: ${existingNews.length}`);
      existingNews.forEach(a => seenUrls.add(a.sourceUrl));
    } catch (e) {
      console.error('Could not parse existing news.json');
    }
  }

  // Paginate through ANN news pages
  while (!reachedTarget && pageNum <= 300) {
    const { articles, oldestDateOnPage } = await fetchANNPage(pageNum);

    if (articles.length === 0) {
      console.log(`Page ${pageNum}: No articles found, stopping.`);
      break;
    }

    // Filter out duplicates
    const newArticles = articles.filter(a => !seenUrls.has(a.sourceUrl));
    newArticles.forEach(a => seenUrls.add(a.sourceUrl));
    allArticles.push(...newArticles);

    const oldestYear = oldestDateOnPage ? oldestDateOnPage.getFullYear() : null;
    console.log(`Page ${pageNum}: ${articles.length} articles (${newArticles.length} new) | Oldest: ${oldestDateOnPage ? oldestDateOnPage.toISOString().split('T')[0] : 'unknown'} | Total so far: ${allArticles.length}`);

    // Stop if we've reached our target year
    if (oldestDateOnPage && oldestDateOnPage.getFullYear() < TARGET_YEAR) {
      console.log(`\nReached target year ${TARGET_YEAR}. Stopping.`);
      reachedTarget = true;
    }

    pageNum++;
    // Small delay to be polite to ANN's servers
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\n--- ANN scraping done: ${allArticles.length} new articles ---`);

  // Also fetch MAL
  console.log('\nFetching MAL news...');
  const malArticles = await fetchMALNews();
  const newMalArticles = malArticles.filter(a => !seenUrls.has(a.sourceUrl));
  console.log(`MAL: ${newMalArticles.length} new articles`);
  allArticles.push(...newMalArticles);

  // Sort all new articles by date descending
  allArticles.sort((a, b) => {
    const da = a._rawDate ? new Date(a._rawDate) : new Date(0);
    const db = b._rawDate ? new Date(b._rawDate) : new Date(0);
    return db - da;
  });

  // Remove temporary _rawDate field
  const cleanArticles = allArticles.map(({ _rawDate, ...rest }) => rest);

  // Merge: new articles on top of existing
  const finalNews = [...cleanArticles, ...existingNews];

  console.log(`\nTotal new articles added: ${cleanArticles.length}`);
  console.log(`Grand total in DB: ${finalNews.length}`);

  fs.writeFileSync(outputPath, JSON.stringify(finalNews, null, 2));
  console.log(`\n✅ Successfully wrote ${finalNews.length} articles to api/news.json`);
})();
