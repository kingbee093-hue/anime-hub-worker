const axios = require('axios');
const CONFIG = require('../config/constants');
const { delay } = require('./formatters');

async function fetchGraphQL(query, variables) {
  let retries = 0;
  while (retries < CONFIG.MAX_RETRIES) {
    try {
      const response = await axios.post(CONFIG.ANILIST_API, {
        query, variables
      }, {
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        timeout: 30000,
      });

      if (response.data.errors) {
        console.error('⚠️  GraphQL Errors detected:');
        response.data.errors.forEach((err, i) => console.error(`   Error ${i + 1}: ${err.message}`));
      }
      return response.data?.data;
    } catch (error) {
      retries++;
      const isRateLimited = error.response && error.response.status === 429;
      const statusText = error.response ? `[${error.response.status}]` : '[Network]';
      console.error(`❌ API request failed ${statusText} (Attempt ${retries}/${CONFIG.MAX_RETRIES}): ${error.message}`);
      
      if (retries < CONFIG.MAX_RETRIES) {
        let waitTimeMs = CONFIG.RETRY_DELAY * Math.pow(2, retries); // Exponential backoff
        
        // Obey Retry-After header if given by rate limiter
        if (isRateLimited && error.response.headers && error.response.headers['retry-after']) {
           const retryAfterSec = parseInt(error.response.headers['retry-after'], 10);
           if (!isNaN(retryAfterSec)) {
               waitTimeMs = retryAfterSec * 1000 + 500; // Add 500ms padding
           }
           console.log(`⏳ Rate Limited (429)! Server requested wait. Backing off for ${(waitTimeMs/1000).toFixed(1)}s...`);
        } else {
           console.log(`🔌 Retrying in ${(waitTimeMs/1000).toFixed(1)}s...`);
        }
        
        await delay(waitTimeMs);
      }
    }
  }
  return null;
}

module.exports = { fetchGraphQL };
