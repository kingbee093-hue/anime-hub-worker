const fs = require('fs');
const path = require('path');

const MAPPING_PATH = 'api/manga/mangadex_mapping.json';
const CHAPTERS_DIR = 'api/manga/chapters';

async function auditGaps() {
    console.log('🔍 Starting Manga Integrity Audit...');
    
    if (!fs.existsSync(MAPPING_PATH)) {
        console.error('❌ Mapping file not found!');
        return;
    }

    const mapping = JSON.parse(fs.readFileSync(MAPPING_PATH, 'utf8'));
    const allAnilistIds = Object.keys(mapping);
    const totalTitles = allAnilistIds.length;
    
    console.log(`📚 Total Titles in Master Mapping: ${totalTitles}`);

    // Get list of existing chapter files
    const existingFiles = new Set(
        fs.readdirSync(CHAPTERS_DIR)
          .filter(f => f.endsWith('.json'))
          .map(f => f.replace('.json', '').toLowerCase())
    );

    console.log(`📂 Total Files in Chapters Directory: ${existingFiles.size}`);

    let healthyCount = 0;
    let missingCount = 0;
    const missingTitles = [];

    for (const anilistId of allAnilistIds) {
        const entry = mapping[anilistId];
        const mdId = entry.mangadexId ? entry.mangadexId.toLowerCase() : null;
        
        // Check if a file exists for THIS entry
        // We check for AniList ID or MangaDex ID as filenames
        if (existingFiles.has(String(anilistId)) || (mdId && existingFiles.has(mdId))) {
            healthyCount++;
        } else {
            missingCount++;
            if (missingTitles.length < 10) {
                missingTitles.push(`${entry.title} (AniList: ${anilistId}${mdId ? ', MD: ' + mdId : ''})`);
            }
        }
    }

    const gapPercentage = ((missingCount / totalTitles) * 100).toFixed(2);

    console.log('\n========================================');
    console.log('        Integrity Audit Report');
    console.log('========================================');
    console.log(`✅ Healthy Titles (Found):        ${healthyCount}`);
    console.log(`⚠️  Missing Titles (Not Found):   ${missingCount}`);
    console.log(`📊 Data Integrity Gap:            ${gapPercentage}%`);
    console.log('========================================');
    
    if (missingTitles.length > 0) {
        console.log('\nSample of missing titles (First 10):');
        missingTitles.forEach(t => console.log(` - ${t}`));
        if (missingCount > 10) console.log(` ... and ${missingCount - 10} more.`);
    }

    console.log('\nAudit complete.');
}

auditGaps();
