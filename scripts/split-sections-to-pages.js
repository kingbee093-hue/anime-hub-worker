/**
 * Split section JSON files into paginated page files (24 items per page).
 *
 * Structure:
 *   api/home_sections/trending.json           (original kept)
 *   api/home_sections/trending/page_1.json    (items 0-23)
 *   api/home_sections/trending/page_2.json    (items 24-47)
 *   ...
 *
 * Also creates a manifest.json per section with totalPages count.
 *
 * Usage:
 *   node scripts/split-sections-to-pages.js
 */

const fs = require('fs');
const path = require('path');

const PAGE_SIZE = 24;

const SECTION_GLOBS = [
  { base: 'api/home_sections', pattern: /\.json$/, exclude: ['manifest.json'] },
  { base: 'api/manga', pattern: /\.json$/, exclude: ['manifest.json', 'chapter_source_mapping.json', 'mangadex_mapping.json', 'mangadex_mapping_fallback.json'], skipDirs: ['pages', 'chapters', 'backfill', 'catalog', 'universe'] },
];

function splitJsonArrayFile(filePath, pageSize) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    console.warn(`  ⚠️ Skipping invalid JSON: ${filePath}`);
    return 0;
  }

  if (!Array.isArray(data)) {
    console.warn(`  ⚠️ Skipping non-array JSON: ${filePath}`);
    return 0;
  }

  if (data.length === 0) {
    console.log(`  ℹ️ Empty array, skipping: ${filePath}`);
    return 0;
  }

  const dir = filePath.replace(/\.json$/, '');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  } else {
    // Clean old page files
    const existing = fs.readdirSync(dir).filter(f => /^page_\d+\.json$/.test(f));
    for (const f of existing) {
      fs.unlinkSync(path.join(dir, f));
    }
  }

  let pageCount = 0;
  for (let i = 0; i < data.length; i += pageSize) {
    pageCount++;
    const chunk = data.slice(i, i + pageSize);
    const pagePath = path.join(dir, `page_${pageCount}.json`);
    fs.writeFileSync(pagePath, JSON.stringify(chunk, null, 2));
  }

  // Write manifest
  const manifestPath = path.join(dir, 'manifest.json');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({ totalPages: pageCount, totalItems: data.length, pageSize }, null, 2)
  );

  return pageCount;
}

function processDirectory(baseDir, options) {
  // Skip any subtree under excluded directory names (at any depth)
  if (options.skipDirs) {
    const parts = baseDir.split(path.sep);
    if (options.skipDirs.some(d => parts.includes(d))) {
      return;
    }
  }

  const entries = fs.readdirSync(baseDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(baseDir, entry.name);

    if (entry.isDirectory()) {
      // Recurse into subdirectories (e.g., genres/)
      processDirectory(fullPath, options);
      continue;
    }

    if (!entry.isFile() || !options.pattern.test(entry.name)) continue;
    if (options.exclude && options.exclude.includes(entry.name)) continue;

    const name = path.basename(entry.name, '.json');
    process.stdout.write(`  ${name} ... `);
    const pages = splitJsonArrayFile(fullPath, PAGE_SIZE);
    if (pages > 0) {
      console.log(`${pages} pages (${fs.readFileSync(fullPath, 'utf-8').length.toLocaleString()} bytes)`);
    }
  }
}

function main() {
  const rootDir = path.resolve(__dirname, '..');

  console.log(`\n📄 JSON Section Pagination (page size: ${PAGE_SIZE})`);
  console.log('=' .repeat(50));

  for (const { base, pattern, exclude } of SECTION_GLOBS) {
    const dir = path.join(rootDir, base);
    if (!fs.existsSync(dir)) {
      console.warn(`  ⚠️ Directory not found: ${dir}`);
      continue;
    }
    console.log(`\n📁 ${base}/`);
    processDirectory(dir, { pattern, exclude });
  }

  console.log('\n✅ Done. Original files preserved; page subfolders created.\n');
}

main();
