const fs = require('fs');
const path = require('path');

const DEFAULT_PAGE_SIZE = 10;

function writePaginatedNewsArtifacts(apiDir, articles, pageSize = DEFAULT_PAGE_SIZE) {
  fs.mkdirSync(apiDir, { recursive: true });

  const newsPath = path.join(apiDir, 'news.json');
  fs.writeFileSync(newsPath, JSON.stringify(articles, null, 2), 'utf8');

  const totalArticles = articles.length;
  const totalPages = Math.ceil(totalArticles / pageSize);

  for (const file of fs.readdirSync(apiDir)) {
    if (/^news_page_\d+\.json$/.test(file)) {
      fs.rmSync(path.join(apiDir, file), { force: true });
    }
  }

  for (let page = 1; page <= totalPages; page++) {
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const pageArticles = articles.slice(start, end);
    const pagePath = path.join(apiDir, `news_page_${page}.json`);
    fs.writeFileSync(pagePath, JSON.stringify(pageArticles, null, 2), 'utf8');
  }

  const manifest = {
    pageSize,
    totalArticles,
    totalPages,
    lastUpdated: new Date().toISOString(),
  };

  const manifestPath = path.join(apiDir, 'news_manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  writePaginatedNewsArtifacts,
};
