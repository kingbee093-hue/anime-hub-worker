const fs = require('fs');
const path = require('path');

const DEFAULT_PAGE_SIZE = 10;
const PREVIEW_LENGTH = 320;
const LATEST_FEED_LIMIT = 5000;
const ARCHIVE_LIMIT = 300000;

function writePaginatedNewsArtifacts(apiDir, articles, pageSize = DEFAULT_PAGE_SIZE) {
  fs.mkdirSync(apiDir, { recursive: true });

  const archiveArticles = articles.slice(0, ARCHIVE_LIMIT);
  const latestArticles = archiveArticles.slice(0, LATEST_FEED_LIMIT);

  writeJson(path.join(apiDir, 'news.json'), archiveArticles);
  writePagedFeed(apiDir, 'news', archiveArticles, pageSize);

  const archiveIndexArticles = archiveArticles.map(buildIndexArticle);
  writeJson(path.join(apiDir, 'news_index.json'), archiveIndexArticles);
  writePagedFeed(apiDir, 'news_index', archiveIndexArticles, pageSize);

  writeJson(path.join(apiDir, 'news_latest.json'), latestArticles);
  writePagedFeed(apiDir, 'news_latest', latestArticles, pageSize);

  const latestIndexArticles = latestArticles.map(buildIndexArticle);
  writeJson(path.join(apiDir, 'news_latest_index.json'), latestIndexArticles);
  writePagedFeed(apiDir, 'news_latest_index', latestIndexArticles, pageSize);

  writeJson(path.join(apiDir, 'news_catalog_manifest.json'), {
    pageSize,
    archiveLimit: ARCHIVE_LIMIT,
    latestFeedLimit: LATEST_FEED_LIMIT,
    archiveCount: archiveArticles.length,
    latestCount: latestArticles.length,
    lastUpdated: new Date().toISOString(),
  });
}

function writePagedFeed(apiDir, baseName, articles, pageSize) {
  const totalArticles = articles.length;
  const totalPages = Math.ceil(totalArticles / pageSize);

  for (const file of fs.readdirSync(apiDir)) {
    if (new RegExp(`^${baseName}_page_\\d+\\.json$`).test(file)) {
      fs.rmSync(path.join(apiDir, file), { force: true });
    }
  }

  for (let page = 1; page <= totalPages; page++) {
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    writeJson(
      path.join(apiDir, `${baseName}_page_${page}.json`),
      articles.slice(start, end)
    );
  }

  writeJson(path.join(apiDir, `${baseName}_manifest.json`), {
    pageSize,
    totalArticles,
    totalPages,
    lastUpdated: new Date().toISOString(),
  });
}

function buildIndexArticle(article) {
  const fullText = normalizeWhitespace(article.content || '');
  const preview = truncatePreview(fullText, PREVIEW_LENGTH);

  return {
    id: article.id,
    title: article.title,
    content: preview,
    sourceUrl: article.sourceUrl,
    author: article.author,
    publishedAt: article.publishedAt,
    category: article.category,
    imageUrl: article.imageUrl,
    readingTime: estimateReadingTime(fullText),
    articleType: inferArticleType(article),
    isPartial: true,
  };
}

function inferArticleType(article) {
  const text = `${article.title || ''} ${article.content || ''}`.toLowerCase();
  const blocks = Array.isArray(article.contentBlocks) ? article.contentBlocks : [];
  const imageCount = blocks.filter((block) => block && block.type === 'image').length;

  if (imageCount >= 3) return 'Gallery';
  if (/\brelease list\b|\bnorth american\b|\bweek \d+:/.test(text)) return 'Release List';
  if (/\binterview\b|\bq&a\b|\bopens up\b/.test(text)) return 'Interview';
  if (/\btrailer\b|\bteaser\b|\bpromo\b|\bpv\b/.test(text)) return 'Trailer';
  if (/\bvisual\b|\bkey visual\b/.test(text)) return 'Visual Update';
  if (/\breveals\b|\bannounces\b|\bannounced\b|\bconfirms\b/.test(text)) return 'Announcement';
  if (/\branked\b|\btop \d+\b|\bbest\b|\bfeature\b/.test(text)) return 'Feature';
  return 'News';
}

function estimateReadingTime(text) {
  const words = normalizeWhitespace(text).split(' ').filter(Boolean);
  const minutes = Math.max(1, Math.ceil(words.length / 200));
  return `${minutes} min read`;
}

function truncatePreview(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }

  const sliced = text.slice(0, maxLength);
  const lastSentence = Math.max(
    sliced.lastIndexOf('. '),
    sliced.lastIndexOf('! '),
    sliced.lastIndexOf('? ')
  );

  if (lastSentence >= Math.floor(maxLength * 0.55)) {
    return sliced.slice(0, lastSentence + 1).trim();
  }

  const lastSpace = sliced.lastIndexOf(' ');
  return `${sliced.slice(0, lastSpace > 0 ? lastSpace : maxLength).trim()}…`;
}

function normalizeWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

module.exports = {
  ARCHIVE_LIMIT,
  DEFAULT_PAGE_SIZE,
  LATEST_FEED_LIMIT,
  writePaginatedNewsArtifacts,
};
