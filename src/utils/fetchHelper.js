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
      console.error(`❌ API request failed (Attempt ${retries}/${CONFIG.MAX_RETRIES}): ${error.message}`);
      if (retries < CONFIG.MAX_RETRIES) {
        await delay(CONFIG.RETRY_DELAY * retries);
      }
    }
  }
  return null;
}

module.exports = { fetchGraphQL };
