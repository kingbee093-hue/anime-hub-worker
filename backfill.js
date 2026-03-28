const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const PLACEHOLDER = 'https://placehold.co/600x400/1a1a2e/7c3aed/png?text=Anime+News';
const START_YEAR = 2019;
const START_MONTH = 1;

// Generate all YYYY-MM from START to now
function generateMonths() {
  const months = [];
  const now = new Date();
  let year = START_YEAR;
  let month = START_MONTH;

  while (year < now.getFullYear() || (year === now.getFullYear() && month <= now.getMonth() + 1)) {
    months.push({ year, month });
    month++;
    if (month > 12) { month = 1; year++; }
  }
  return months;
}

// Format date to a readable string
function formatDate(dateObj) {
  if (!dateObj || isNaN(dateObj.getTime())) return '';
  const options = { month: 'short', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true };
  return dateObj.toLocaleString('en-US', options).replace(',', ' •');
}

// Classify category from text keywords
function classifyCategory(text) {
  const lower = text.toLowerCase();
  if (lower.includes('shonen') || lower.includes('shounen') || lower.includes('jump')) return 'Shonen';
  if (lower.includes('action') || lower.includes('fight') || lower.includes('battle')) return 'Action';
  if (lower.includes('adventure') || lower.includes('quest') || lower.includes('journey')) return 'Adventure';
  if (lower.includes('romance') || lower.includes('love') || lower.includes('dating')) return 'Romance';
  if (lower.includes('comedy') || lower.includes('funny') || lower.includes('humor')) return 'Comedy';
  if (lower.includes('drama') || lower.includes('emotional') || lower.includes('slice of life')) return 'Drama';
  if (lower.includes('fantasy') || lower.includes('magic') || lower.includes('isekai')) return 'Fantasy';
  if (lower.includes('horror') || lower.includes('thriller') || lower.includes('scary')) return 'Horror';
  if (lower.includes('sci-fi') || lower.includes('mecha') || lower.includes('robot')) return 'Sci-Fi';
  if (lower.includes('sports') || lower.includes('game') || lower.includes('tournament')) return 'Sports';
  if (lower.includes('industry') || lower.includes('studio') || lower.includes('box office')) return 'Industry';
  if (lower.includes('music') || lower.includes('song') || lower.includes('opening') || lower.includes('ending')) return 'Music';
  if (lower.includes('manga') || lower.includes('chapter') || lower.includes('volume')) return 'Manga';
  if (lower.includes('season') || lower.includes('episode') || lower.includes('preview') || lower.includes('trailer')) return 'Announcements';
  return 'News';
}

// Fetch one month's archive page from ANN
async function fetchANNMonth(year, month) {
  const mm = String(month).padStart(2, '0');
  const url = `https://www.animenewsnetwork.com/news/${year}-${mm}/`;
  try {
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 15000
    });
    const $ = cheerio.load(data);
    const articles = [];

    $('.herald.box.news').each((i, el) => {
      const $el = $(el);
      const title = $el.find('h3 a').text().trim();
      const excerpt = $el.find('.preview').text().trim();
      const dateAttr = $el.find('.byline time').attr('datetime');
      const link = $el.find('h3 a').attr('href');

      if (title && link) {
        const sourceUrl = link.startsWith('http') ? link : `https://www.animenewsnetwork.com${link}`;
        const slug = link.split('/').filter(Boolean).pop() || '';
        const dateObj = dateAttr ? new Date(dateAttr) : new Date(`${year}-${mm}-15`);
        const category = classifyCategory(title + ' ' + excerpt);

        articles.push({
          id: `ann-${slug || `${year}${mm}-${i}`}`,
          title,
          content: excerpt || title,
          sourceUrl,
          author: 'ANN',
          publishedAt: formatDate(dateObj),
          // Store raw timestamp for sorting
          _rawDate: dateObj.toISOString(),
          category,
          imageUrl: PLACEHOLDER
        });
      }
    });

    console.log(`  ${year}-${mm}: ${articles.length} articles`);
    return articles;
  } catch (e) {
    console.error(`  ${year}-${mm}: ERROR - ${e.message}`);
    return [];
  }
}

(async () => {
  console.log('=== BACKFILL: Fetching all ANN news from 2019 to now ===\n');

  const months = generateMonths();
  console.log(`Total months to scrape: ${months.length}\n`);

  // Fetch all months with a small delay to avoid rate limiting
  let allArticles = [];
  for (const { year, month } of months) {
    const articles = await fetchANNMonth(year, month);
    allArticles.push(...articles);
    // Small delay to be polite to ANN's servers
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\nTotal articles scraped: ${allArticles.length}`);

  // Sort by raw date descending (newest first)
  allArticles.sort((a, b) => new Date(b._rawDate) - new Date(a._rawDate));

  // Remove the temporary _rawDate field
  allArticles = allArticles.map(({ _rawDate, ...rest }) => rest);

  // Deduplicate by sourceUrl
  const seen = new Set();
  allArticles = allArticles.filter(a => {
    if (seen.has(a.sourceUrl)) return false;
    seen.add(a.sourceUrl);
    return true;
  });

  console.log(`After deduplication: ${allArticles.length} unique articles`);

  // Read existing news.json if it exists (to merge)
  const apiDir = path.join(__dirname, 'api');
  if (!fs.existsSync(apiDir)) fs.mkdirSync(apiDir);
  const outputPath = path.join(apiDir, 'news.json');

  let existingNews = [];
  if (fs.existsSync(outputPath)) {
    try {
      existingNews = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      console.log(`Existing news.json has ${existingNews.length} articles`);
    } catch (e) {
      console.error('Could not parse existing news.json');
    }
  }

  // Merge: existing articles take priority (they may have real images)
  const existingUrls = new Set(existingNews.map(a => a.sourceUrl));
  const newOnly = allArticles.filter(a => !existingUrls.has(a.sourceUrl));
  const finalNews = [...existingNews, ...newOnly];

  console.log(`Added ${newOnly.length} new articles from backfill`);
  console.log(`Final total: ${finalNews.length} articles`);

  fs.writeFileSync(outputPath, JSON.stringify(finalNews, null, 2));
  console.log(`\n✅ Successfully wrote ${finalNews.length} articles to api/news.json`);
})();
