const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const PLACEHOLDER = 'https://placehold.co/600x400/1a1a2e/7c3aed/png?text=Anime+News';
const TARGET_YEAR = 2019;
const DELAY_MS = 800; // delay between requests to be polite

// NSFW filter
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

function cleanHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]+>/g, '').trim();
}

function classifyCategory(text) {
  const lower = text.toLowerCase();
  if (lower.includes('shonen') || lower.includes('shounen') || lower.includes('jump')) return 'Shonen';
  if (lower.includes('action') || lower.includes('fight') || lower.includes('battle')) return 'Action';
  if (lower.includes('adventure') || lower.includes('quest')) return 'Adventure';
  if (lower.includes('romance') || lower.includes('love') || lower.includes('dating')) return 'Romance';
  if (lower.includes('comedy') || lower.includes('funny') || lower.includes('humor')) return 'Comedy';
  if (lower.includes('drama') || lower.includes('slice of life')) return 'Drama';
  if (lower.includes('fantasy') || lower.includes('magic') || lower.includes('isekai')) return 'Fantasy';
  if (lower.includes('horror') || lower.includes('thriller')) return 'Horror';
  if (lower.includes('sci-fi') || lower.includes('mecha') || lower.includes('robot')) return 'Sci-Fi';
  if (lower.includes('sports') || lower.includes('tournament')) return 'Sports';
  if (lower.includes('industry') || lower.includes('studio') || lower.includes('box office')) return 'Industry';
  if (lower.includes('music') || lower.includes('song') || lower.includes('op ') || lower.includes('ed ')) return 'Music';
  if (lower.includes('manga') || lower.includes('chapter') || lower.includes('volume')) return 'Manga';
  if (lower.includes('season') || lower.includes('trailer') || lower.includes('preview') || lower.includes('promo')) return 'Announcements';
  if (lower.includes('cast') || lower.includes('staff') || lower.includes('reveal')) return 'Announcements';
  if (lower.includes('game') || lower.includes('gaming')) return 'Gaming';
  if (lower.includes('film') || lower.includes('movie') || lower.includes('cinema')) return 'Movies';
  if (lower.includes('light novel') || lower.includes('ln ')) return 'Light Novels';
  return 'News';
}

// Parse relative date strings from MAL (e.g., "Mar 28, 10:00 AM", "Yesterday", "4 hours ago")
function parseMALDate(infoText) {
  const now = new Date();
  
  // "X hours ago"
  const hoursMatch = infoText.match(/(\d+)\s*hours?\s*ago/i);
  if (hoursMatch) {
    return new Date(now.getTime() - parseInt(hoursMatch[1]) * 3600000);
  }
  
  // "Yesterday"
  if (/yesterday/i.test(infoText)) {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    return d;
  }
  
  // Date patterns like "Mar 28, 2026", "Mar 28, 10:00 AM", "Dec 18, 2021 3:32 AM"
  const dateMatch = infoText.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),?\s*(\d{4})?/i);
  if (dateMatch) {
    const monthStr = dateMatch[1];
    const day = parseInt(dateMatch[2]);
    const year = dateMatch[3] ? parseInt(dateMatch[3]) : now.getFullYear();
    const months = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
    return new Date(year, months[monthStr], day);
  }
  
  return now;
}

function formatDate(dateObj) {
  if (!dateObj || isNaN(dateObj.getTime())) return '';
  const options = { month: 'short', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true };
  return dateObj.toLocaleString('en-US', options).replace(',', ' •');
}

// Fetch one page of MAL news
async function fetchMALPage(pageNum) {
  try {
    const { data } = await axios.get(`https://myanimelist.net/news?p=${pageNum}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0',
        'Accept': 'text/html',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 20000
    });

    const $ = cheerio.load(data);
    const articles = [];
    let oldestDate = null;

    $('.news-unit').each((i, el) => {
      const $el = $(el);
      
      // Get title and link
      const titleEl = $el.find('.news-unit-right p a').first();
      if (!titleEl.length) {
        // It's likely the ad/featured unit (item #4 which was empty)
        return;
      }
      const title = titleEl.text().trim();
      const link = titleEl.attr('href') || '';
      if (!title || !link) return;

      // Get image - MAL uses data-src for lazy loading
      let img = $el.find('img').first().attr('data-src') || 
                $el.find('img').first().attr('src') || '';
      // Get higher res image by removing the resize prefix
      if (img.includes('/r/100x156/')) {
        img = img.replace('/r/100x156/', '/');
      }
      if (!img || img.includes('spacer') || img.includes('loading')) {
        img = PLACEHOLDER;
      }

      // Get info/date
      const infoText = $el.find('.information, .info').text().trim().replace(/\s+/g, ' ');
      const dateObj = parseMALDate(infoText);

      // Get snippet
      const snippet = $el.find('.text, .news-unit-right .text').text().trim();

      // Track oldest date
      if (dateObj && (!oldestDate || dateObj < oldestDate)) {
        oldestDate = dateObj;
      }

      const category = classifyCategory(title + ' ' + snippet);
      const newsId = link.split('/').filter(Boolean).pop() || `mal-p${pageNum}-${i}`;

      articles.push({
        id: `mal-${newsId}`,
        title,
        content: snippet || title,
        sourceUrl: link,
        author: 'MyAnimeList',
        publishedAt: formatDate(dateObj),
        _rawDate: dateObj.toISOString(),
        category,
        imageUrl: img
      });
    });

    return { articles, oldestDate };
  } catch (e) {
    console.error(`  MAL page ${pageNum}: ERROR - ${e.message}`);
    return { articles: [], oldestDate: null };
  }
}

// Fetch ANN front page (only ~96 current articles)
async function fetchANNFrontPage() {
  try {
    const { data } = await axios.get('https://www.animenewsnetwork.com/news/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 15000
    });
    const $ = cheerio.load(data);
    const articles = [];

    $('.herald.box.news').each((i, el) => {
      const $el = $(el);
      const title = $el.find('h3 a').text().trim();
      const excerpt = $el.find('.preview').text().trim();
      const dateAttr = $el.find('time').attr('datetime');
      const link = $el.find('h3 a').attr('href');

      if (title && link) {
        if (!isNSFW(title, excerpt)) {
          const sourceUrl = link.startsWith('http') ? link : `https://www.animenewsnetwork.com${link}`;
          const dateObj = dateAttr ? new Date(dateAttr) : new Date();
          const slug = link.split('/').filter(Boolean).pop() || '';
          const category = classifyCategory(title + ' ' + excerpt);

          articles.push({
            id: `ann-${slug || `front-${i}`}`,
            title,
            content: excerpt || title,
            sourceUrl,
            author: 'ANN',
            publishedAt: formatDate(dateObj),
            _rawDate: dateObj.toISOString(),
            category,
            imageUrl: PLACEHOLDER
          });
        }
      }
    });

    console.log(`ANN front page: ${articles.length} articles`);
    return articles;
  } catch (e) {
    console.error(`ANN error: ${e.message}`);
    return [];
  }
}

(async () => {
  console.log(`=== BACKFILL: Fetching all news until year ${TARGET_YEAR} ===\n`);

  // Read existing news
  const apiDir = path.join(__dirname, 'api');
  if (!fs.existsSync(apiDir)) fs.mkdirSync(apiDir);
  const outputPath = path.join(apiDir, 'news.json');

  const seenUrls = new Set();
  let existingNews = [];
  if (fs.existsSync(outputPath)) {
    try {
      existingNews = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      existingNews.forEach(a => seenUrls.add(a.sourceUrl));
      console.log(`Existing articles in DB: ${existingNews.length}`);
    } catch (e) {
      console.error('Could not parse existing news.json');
    }
  }

  // ── Step 1: Fetch ComicBook Anime News ──
  console.log('\n── Fetching ComicBook Anime News ──');
  const cbArticles = [];
  try {
    const { data: cbData } = await axios.get('https://comicbook.com/category/anime/feed/', {
      headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000
    });
    const $cb = cheerio.load(cbData, { xmlMode: true });
    $cb('item').slice(0, 50).each((i, el) => {
      const title = $cb(el).find('title').text().trim();
      const link = $cb(el).find('link').text().trim();
      const pubDate = $cb(el).find('pubDate').text().trim();
      const dateObj = pubDate ? new Date(pubDate) : new Date();

      const fullContentHtml = $cb(el).find('content\\:encoded').text().trim();
      let contentText = '';
      let imageUrl = '';

      if (fullContentHtml) {
        const _$ = cheerio.load(fullContentHtml);
        imageUrl = _$('img').first().attr('src') || '';
        const pTexts = [];
        _$('p').each((_, p) => {
          const pt = _$(p).text().trim();
          if (pt) pTexts.push(pt);
        });
        contentText = pTexts.join('\n\n');
      }

      if (!imageUrl) {
        imageUrl = $cb(el).find('media\\:content').attr('url') || $cb(el).find('thumbnail').attr('url') || PLACEHOLDER;
      }

      if (!title || !link || !contentText) return;
      if (isNSFW(title, contentText)) return;

      const newsId = `cb-${link.split('/').filter(Boolean).pop() || i}`;
      if (!seenUrls.has(link)) {
        seenUrls.add(link);
        cbArticles.push({ id: newsId, title, content: contentText, sourceUrl: link, author: 'ComicBook', publishedAt: formatDate(dateObj), _rawDate: dateObj.toISOString(), category: 'News', imageUrl });
      }
    });
    console.log(`ComicBook: ${cbArticles.length} new articles`);
  } catch(e) { console.error('ComicBook error:', e.message); }

  // ── Step 2: Fetch Anime Corner ──
  console.log('\n── Fetching Anime Corner ──');
  const acArticles = [];
  try {
    const { data: acData } = await axios.get('https://animecorner.me/category/anime-news/', {
      headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000
    });
    const $ac = cheerio.load(acData);
    $ac('article').slice(0, 30).each((i, el) => {
      const $el = $ac(el);
      const titleEl = $el.find('h2 a, h3 a').first();
      const title = titleEl.text().trim();
      const link = titleEl.attr('href') || '';
      if (!title || !link || isNSFW(title, '')) return;
      let imageUrl = $el.find('[data-bgset]').attr('data-bgset') || PLACEHOLDER;
      if (imageUrl && imageUrl.includes(' ')) imageUrl = imageUrl.split(',')[0].trim().split(' ')[0];
      const dateText = $el.find('time').attr('datetime') || '';
      const dateObj = dateText ? new Date(dateText) : new Date();
      const excerpt = $el.find('p').first().text().trim();
      if (!seenUrls.has(link)) {
        seenUrls.add(link);
        acArticles.push({ id: `ac-${link.split('/').filter(Boolean).pop() || i}`, title, content: excerpt || title, sourceUrl: link, author: 'Anime Corner', publishedAt: formatDate(dateObj), _rawDate: dateObj.toISOString(), category: 'News', imageUrl });
      }
    });
    console.log(`Anime Corner: ${acArticles.length} new articles`);
  } catch(e) { console.error('Anime Corner error:', e.message); }

  // ── Step 3: Fetch ANN front page ──
  console.log('\n── Fetching ANN front page ──');
  const annArticles = await fetchANNFrontPage();
  const newANN = annArticles.filter(a => !seenUrls.has(a.sourceUrl));
  newANN.forEach(a => seenUrls.add(a.sourceUrl));
  console.log(`ANN: ${newANN.length} new articles\n`);

  // ── Step 4: Paginate through MAL news ──
  console.log('── Fetching MAL news pages ──');
  const allNewArticles = [...cbArticles, ...acArticles, ...newANN];
  let pageNum = 1;
  let reachedTarget = false;
  let consecutiveEmpty = 0;

  while (!reachedTarget && pageNum <= 500) {
    const { articles, oldestDate } = await fetchMALPage(pageNum);

    if (articles.length === 0) {
      consecutiveEmpty++;
      if (consecutiveEmpty >= 3) {
        console.log(`3 consecutive empty pages. Stopping.`);
        break;
      }
      pageNum++;
      await new Promise(r => setTimeout(r, DELAY_MS));
      continue;
    }
    consecutiveEmpty = 0;

    // Filter duplicates
    const newArticles = articles.filter(a => !seenUrls.has(a.sourceUrl));
    newArticles.forEach(a => seenUrls.add(a.sourceUrl));
    allNewArticles.push(...newArticles);

    const oldestStr = oldestDate ? oldestDate.toISOString().split('T')[0] : 'unknown';
    console.log(`Page ${pageNum}: ${articles.length} found, ${newArticles.length} new | Oldest: ${oldestStr} | Total new: ${allNewArticles.length}`);

    // Stop if oldest article on this page is before our target year
    if (oldestDate && oldestDate.getFullYear() < TARGET_YEAR) {
      console.log(`\n🎯 Reached target year ${TARGET_YEAR}. Stopping.`);
      reachedTarget = true;
    }

    pageNum++;
    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  // Sort all new articles by date
  allNewArticles.sort((a, b) => {
    const da = a._rawDate ? new Date(a._rawDate) : new Date(0);
    const db = b._rawDate ? new Date(b._rawDate) : new Date(0);
    return db - da;
  });

  // Remove _rawDate field
  const cleanArticles = allNewArticles.map(({ _rawDate, ...rest }) => rest);

  // Merge: new at top, existing below
  const finalNews = [...cleanArticles, ...existingNews];

  console.log(`\n═══════════════════════════════════`);
  console.log(`New articles added: ${cleanArticles.length}`);
  console.log(`Existing articles: ${existingNews.length}`);
  console.log(`Grand total: ${finalNews.length}`);
  console.log(`═══════════════════════════════════`);

  fs.writeFileSync(outputPath, JSON.stringify(finalNews, null, 2));
  console.log(`\n✅ Successfully wrote ${finalNews.length} articles to api/news.json`);
})();
