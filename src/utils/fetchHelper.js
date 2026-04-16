const axios = require('axios');
const CONFIG = require('../config/constants');
const { delay } = require('./formatters');

const DEFAULT_HTTP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': 'AnimeHubWorker/1.0 (+https://github.com/mauiww11/anime-hub-worker)',
};

function computeRetryDelayMs(retries, error) {
  const isRateLimited = error.response && error.response.status === 429;
  let waitTimeMs = CONFIG.RETRY_DELAY * Math.pow(2, retries);

  if (isRateLimited && error.response.headers && error.response.headers['retry-after']) {
    const retryAfterSec = parseInt(error.response.headers['retry-after'], 10);
    if (!Number.isNaN(retryAfterSec)) {
      waitTimeMs = retryAfterSec * 1000 + 500;
    }
  }

  const jitterMs = Math.floor(Math.random() * 400);
  return waitTimeMs + jitterMs;
}

async function fetchGraphQL(query, variables) {
  let retries = 0;
  while (retries < CONFIG.MAX_RETRIES) {
    try {
      const response = await axios.post(
        CONFIG.ANILIST_API,
        { query, variables },
        {
          headers: DEFAULT_HTTP_HEADERS,
          timeout: 30000,
        },
      );

      if (response.data.errors) {
        console.error('GraphQL errors detected:');
        response.data.errors.forEach((err, i) => console.error(`  Error ${i + 1}: ${err.message}`));
      }
      return response.data?.data;
    } catch (error) {
      retries += 1;
      const isRateLimited = error.response && error.response.status === 429;
      const statusText = error.response ? `[${error.response.status}]` : '[Network]';
      console.error(`API request failed ${statusText} (Attempt ${retries}/${CONFIG.MAX_RETRIES}): ${error.message}`);

      if (retries < CONFIG.MAX_RETRIES) {
        const waitTimeMs = computeRetryDelayMs(retries, error);
        if (isRateLimited) {
          console.log(`Rate limited (429). Backing off for ${(waitTimeMs / 1000).toFixed(1)}s...`);
        } else {
          console.log(`Retrying in ${(waitTimeMs / 1000).toFixed(1)}s...`);
        }
        await delay(waitTimeMs);
      }
    }
  }
  return null;
}

module.exports = {
  DEFAULT_HTTP_HEADERS,
  computeRetryDelayMs,
  fetchGraphQL,
};
