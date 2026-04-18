const fs = require('fs');
const newChapters = JSON.parse(fs.readFileSync('api/manga/new_chapters.json', 'utf8'));
const girls = newChapters.find(m => String(m.title).toLowerCase().includes('girls x vampire'));
console.log(JSON.stringify(girls, null, 2));
