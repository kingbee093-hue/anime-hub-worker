/**
 * Split section JSON files into paginated page files (24 items per page).
 *
 * Only processes:
 *   api/home_sections/*.json
 *   api/home_sections/genres/*.json
 *   api/manga/*.json
 *   api/manga/genres/*.json
 *
 * Structure:
 *   api/home_sections/trending.json           (original kept)
 *   api/home_sections/trending/page_1.json    (items 0-23)
 *   api/home_sections/trending/page_2.json    (items 24-47)
 *   ...
 *
 * Usage:
 *   node scripts/split-sections-to-pages-v2.js
 */

const fs = require('fs');
const path = require('path');

const PAGE_SIZE = 24;

function splitJsonArrayFile(filePath, pageSize) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    console.warn(`  ⚠️  Skipping invalid JSON: ${path.basename(filePath)}`);
    return 0;
  }

  if (!Array.isArray(data)) {
    return 0;
  }

  if (data.length === 0) {
    return 0;
  }

  const dir = filePath.replace(/\.json$/, '');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  } else {
    const existing = fs.readdirSync(dir).filter(f => /^page_\d+\.json$/.test(f));
    for (const f of existing) fs.unlinkSync(path.join(dir, f));
    const mPath = path.join(dir, 'manifest.json');
    if (fs.existsSync(mPath)) fs.unlinkSync(mPath);
  }

  let pageCount = 0;
  for (let i = 0; i < data.length; i += pageSize) {
    pageCount++;
    const chunk = data.slice(i, i + pageSize);
    fs.writeFileSync(path.join(dir, `page_${pageCount}.json`), JSON.stringify(chunk, null, 2));
  }

  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ totalPages: pageCount, totalItems: data.length, pageSize }, null, 2)
  );

  return pageCount;
}

function processDir(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const fullPath = path.join(dirPath, entry.name);
    const name = path.basename(entry.name, '.json');
    process.stdout.write(`  ${name} ... `);
    const pages = splitJsonArrayFile(fullPath, PAGE_SIZE);
    if (pages > 0) {
      const size = fs.statSync(fullPath).size.toLocaleString();
      console.log(`${pages} page${pages === 1 ? '' : 's'} (${size} bytes)`);
    } else {
      console.log('skipped');
    }
  }
}

const root = path.resolve(__dirname, '..');

const targets = [
  path.join(root, 'api', 'home_sections'),
  path.join(root, 'api', 'home_sections', 'genres'),
  path.join(root, 'api', 'manga'),
  path.join(root, 'api', 'manga', 'genres'),
];

console.log(`\n📄 JSON Section Pagination (page size: ${PAGE_SIZE})`);
console.log('='.repeat(50));

for (const dir of targets) {
  if (!fs.existsSync(dir)) {
    console.log(`\n⚠️  Not found: ${path.relative(root, dir)}`);
    continue;
  }
  console.log(`\n📁 ${path.relative(root, dir)}/`);
  processDir(dir);
}

console.log('\n✅ Done. Original files preserved; page subfolders created.\n');
