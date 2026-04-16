const fs = require('fs');
const path = require('path');

function writeJsonIfChanged(relativeApiPath, data) {
  const apiFile = path.join(__dirname, '../../api', `${relativeApiPath}.json`);
  fs.mkdirSync(path.dirname(apiFile), { recursive: true });

  let existingContent = '';
  if (fs.existsSync(apiFile)) {
    existingContent = fs.readFileSync(apiFile, 'utf8');
  }

  const nextContent = JSON.stringify(data, null, 2);
  if (existingContent === nextContent) {
    return { changed: false, file: apiFile };
  }

  fs.writeFileSync(apiFile, nextContent, 'utf8');
  return { changed: true, file: apiFile };
}

function readJson(relativeApiPath) {
  const apiFile = path.join(__dirname, '../../api', `${relativeApiPath}.json`);
  if (!fs.existsSync(apiFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(apiFile, 'utf8'));
  } catch (e) {
    return null;
  }
}

module.exports = { writeJsonIfChanged, readJson };
