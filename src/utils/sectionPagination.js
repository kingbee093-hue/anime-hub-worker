/**
 * Split section data into paginated page files inside a subfolder.
 *
 * Structure (subfolder approach):
 *   api/home_sections/trending.json           (original kept)
 *   api/home_sections/trending/page_1.json    (items 0-23)
 *   api/home_sections/trending/page_2.json    (items 24-47)
 *   api/home_sections/trending/manifest.json  (totalPages, totalItems, pageSize)
 *
 * Usage:
 *   const { writeSectionPages } = require('./sectionPagination');
 *   writeSectionPages('home_sections/trending', items);
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_PAGE_SIZE = 24;

/**
 * Write paginated page files for a section into a subfolder.
 * The original JSON file is NOT touched — only the subfolder is managed.
 *
 * @param {string} relativePath  e.g. 'home_sections/trending' (no .json)
 * @param {Array}  items         The full array of items
 * @param {number} [pageSize=24] Items per page
 */
function writeSectionPages(relativePath, items, pageSize = DEFAULT_PAGE_SIZE) {
  if (!Array.isArray(items) || items.length === 0) return;

  const apiRoot = path.join(__dirname, '../../api');
  const subDir = path.join(apiRoot, `${relativePath}`);

  // Create or clean the subfolder
  if (!fs.existsSync(subDir)) {
    fs.mkdirSync(subDir, { recursive: true });
  } else {
    // Remove old page files and manifest
    for (const file of fs.readdirSync(subDir)) {
      if (/^page_\d+\.json$/.test(file) || file === 'manifest.json') {
        fs.unlinkSync(path.join(subDir, file));
      }
    }
  }

  const totalPages = Math.ceil(items.length / pageSize);

  for (let page = 1; page <= totalPages; page++) {
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const pageItems = items.slice(start, end);
    fs.writeFileSync(
      path.join(subDir, `page_${page}.json`),
      JSON.stringify(pageItems, null, 2),
      'utf8',
    );
  }

  fs.writeFileSync(
    path.join(subDir, 'manifest.json'),
    JSON.stringify({
      totalPages,
      totalItems: items.length,
      pageSize,
      lastUpdated: new Date().toISOString(),
    }, null, 2),
    'utf8',
  );

  console.log(`  📄 Paginated "${relativePath}" → ${totalPages} page(s) (${items.length} items, ${pageSize}/page)`);
}

module.exports = { writeSectionPages, DEFAULT_PAGE_SIZE };
