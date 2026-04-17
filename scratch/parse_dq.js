const fs = require('fs');
const newChapters = JSON.parse(fs.readFileSync('api/manga/new_chapters.json', 'utf8'));
const dq = newChapters.find(m => String(m.title).toLowerCase().includes('dragon quest'));
console.log(dq ? dq.mangadexId : 'Not found');
