/**
 * cleanup_seen.js
 *
 * Runs once daily at 00:00 UTC (before the main fetch worker).
 * Removes entries older than 7 days from seen_cache.json
 * and commits the trimmed file back to the repo.
 */

const fs = require('fs');

const CACHE_FILE = 'seen_cache.json';
const RECENCY_DAYS = 7;

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🧹 DAILY CLEANUP — seen_cache.json');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`⏰ Started at: ${new Date().toISOString()}`);

if (!fs.existsSync(CACHE_FILE)) {
  console.log(`⚠️  ${CACHE_FILE} not found — nothing to clean`);
  process.exit(0);
}

const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
if (!raw.recent_episodes) raw.recent_episodes = {};
if (!raw.news) raw.news = {};
if (!raw.sections) raw.sections = {};
if (!raw.genres) raw.genres = {};

const now = Date.now() / 1000;
const cutoff = now - (RECENCY_DAYS * 24 * 60 * 60);

let removedEps = 0;
let removedNews = 0;

// Cleanup old recent episodes
for (const [key, timestamp] of Object.entries(raw.recent_episodes)) {
  if (timestamp < cutoff) {
    delete raw.recent_episodes[key];
    removedEps++;
  }
}

// Cleanup old news articles 
for (const [id, timestamp] of Object.entries(raw.news)) {
  if (timestamp < cutoff) {
    delete raw.news[id];
    removedNews++;
  }
}

fs.writeFileSync(CACHE_FILE, JSON.stringify(raw, null, 2), 'utf8');

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('📊 CLEANUP SUMMARY');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`🗑️  Removed old episodes (>7 days): ${removedEps}`);
console.log(`🗑️  Removed old news (>7 days): ${removedNews}`);
console.log(`✅ Remaining episodes: ${Object.keys(raw.recent_episodes).length}`);
console.log(`✅ Remaining news: ${Object.keys(raw.news).length}`);
console.log(`⏰ Finished at: ${new Date().toISOString()}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
