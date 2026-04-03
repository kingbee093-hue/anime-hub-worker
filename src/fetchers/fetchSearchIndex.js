const fetchAnimeCatalog = require('./fetchAnimeCatalog');

async function fetchSearchIndex() {
  return fetchAnimeCatalog();
}

module.exports = fetchSearchIndex;
