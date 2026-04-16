const axios = require('axios');
const fs = require('fs');
const path = require('path');
const CONFIG = require('./src/config/constants');
const { delay } = require('./src/utils/formatters');

const MODERN_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
];

function getRandomUA() {
  return MODERN_USER_AGENTS[Math.floor(Math.random() * MODERN_USER_AGENTS.length)];
}

function getSecureHeaders(url = '') {
  const host = getRequestHostKey(url);
  // Using a consistent modern Chrome profile to match Sec-CH-UA hints
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
  
  const headers = {
    'User-Agent': ua,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'DNT': '1',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
    'Sec-Ch-Ua': '"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Pragma': 'no-cache',
    'Cache-Control': 'no-cache',
    'Content-Type': 'application/json'
  };

  if (host.includes('anilist')) {
    headers['Origin'] = 'https://anilist.co';
    headers['Referer'] = 'https://anilist.co/';
  } else if (host.includes('mangadex')) {
    headers['Origin'] = 'https://mangadex.org';
    headers['Referer'] = 'https://mangadex.org/';
  }

  return headers;
}

const DEFAULT_HTTP_HEADERS = getSecureHeaders();

const GRAPHQL_HOST_COOLDOWN_MS = Math.max(1000, Number(process.env.WORKER_GRAPHQL_HOST_COOLDOWN_MS || 15000));
const GRAPHQL_CIRCUIT_BREAKER_THRESHOLD = 5;
const GRAPHQL_CIRCUIT_OPEN_MS = 60000;
const GRAPHQL_REQUEST_HEALTH_PRUNE_HOURS = 24;

let requestHealthState = readRequestHealth();
let requestHealthDirty = false;

function readRequestHealth() {
  const healthPath = path.join(__dirname, 'request_health.json');
  try {
    if (fs.existsSync(healthPath)) {
      return JSON.parse(fs.readFileSync(healthPath, 'utf8'));
    }
  } catch (_) { /* ignore */ }
  return {};
}

function writeRequestHealth(state) {
  try {
    fs.writeFileSync(path.join(__dirname, 'request_health.json'), JSON.stringify(state, null, 2));
  } catch (_) { /* ignore */ }
}

function computeRetryDelayMs(attempt, error = null) {
  let baseMs = 2000;
  const status = error?.response?.status || 0;
  
  if (status === 429) {
    baseMs = 15000; // Solid backoff for rate limits
  } else if (status === 403) {
    baseMs = 10000;
  }

  const jitterMs = Math.floor(Math.random() * 1000);
  return (baseMs * Math.pow(2, attempt - 1)) + jitterMs;
}

function getRequestHostKey(url, fallbackLabel = 'request') {
  try {
    return new URL(url).host || fallbackLabel;
  } catch (_) {
    return fallbackLabel;
  }
}

function getRequestHealthEntry(hostKey) {
  if (!requestHealthState[hostKey] || typeof requestHealthState[hostKey] !== 'object') {
    requestHealthState[hostKey] = {
      host: hostKey,
      consecutiveFailures: 0,
      totalFailures: 0,
      totalSuccesses: 0,
      lastFailureAt: null,
      lastSuccessAt: null,
      lastStatus: null,
      cooldownUntil: null,
      circuitOpenUntil: null,
      lastError: null,
    };
    requestHealthDirty = true;
  }

  return requestHealthState[hostKey];
}

function getRequestHealthWaitMs(entry) {
  const now = Date.now();
  const cooldownUntil = new Date(entry?.cooldownUntil || 0).getTime();
  const circuitOpenUntil = new Date(entry?.circuitOpenUntil || 0).getTime();
  return Math.max(
    Number.isFinite(cooldownUntil) ? Math.max(0, cooldownUntil - now) : 0,
    Number.isFinite(circuitOpenUntil) ? Math.max(0, circuitOpenUntil - now) : 0,
  );
}

function pruneRequestHealthState() {
  const cutoffMs = Date.now() - (GRAPHQL_REQUEST_HEALTH_PRUNE_HOURS * 60 * 60 * 1000);
  for (const [hostKey, entry] of Object.entries(requestHealthState)) {
    const lastTouchedMs = Math.max(
      new Date(entry?.lastFailureAt || 0).getTime(),
      new Date(entry?.lastSuccessAt || 0).getTime()
    );
    if (lastTouchedMs < cutoffMs) {
      delete requestHealthState[hostKey];
      requestHealthDirty = true;
    }
  }
}

function markRequestSuccess(hostKey) {
  const entry = getRequestHealthEntry(hostKey);
  entry.consecutiveFailures = 0;
  entry.totalSuccesses += 1;
  entry.lastSuccessAt = new Date().toISOString();
  entry.lastStatus = 'healthy';
  entry.cooldownUntil = null;
  entry.circuitOpenUntil = null;
  requestHealthDirty = true;
}

function markRequestFailure(hostKey, error, retryAfterMs = 5000) {
  const entry = getRequestHealthEntry(hostKey);
  const status = error?.response?.status || 500;
  
  entry.consecutiveFailures += 1;
  entry.totalFailures += 1;
  entry.lastFailureAt = new Date().toISOString();
  entry.lastError = {
    message: error.message,
    status: status,
    code: error.code || 'UNKNOWN',
  };

  entry.cooldownUntil = new Date(Date.now() + retryAfterMs).toISOString();

  if (entry.consecutiveFailures >= GRAPHQL_CIRCUIT_BREAKER_THRESHOLD) {
    entry.lastStatus = 'circuit-open';
    entry.circuitOpenUntil = new Date(Date.now() + GRAPHQL_CIRCUIT_OPEN_MS).toISOString();
    console.warn(`[Stealth] Circuit breaker OPEN for ${hostKey} until ${entry.circuitOpenUntil}`);
  } else {
    entry.lastStatus = 'cooling-down';
  }

  requestHealthDirty = true;
}

async function waitForHostAvailability(hostKey, label = 'host') {
  const entry = getRequestHealthEntry(hostKey);
  const waitMs = getRequestHealthWaitMs(entry);
  if (waitMs > 100) {
    console.log(`Host ${hostKey} cooling down before ${label}; waiting ${(waitMs / 1000).toFixed(1)}s...`);
    await delay(waitMs);
  }
}

function flushRequestHealthState() {
  if (requestHealthDirty) {
    writeRequestHealth(requestHealthState);
    requestHealthDirty = false;
  }
}

function getRequestHealthSummary() {
  const entries = Object.values(requestHealthState);
  const now = Date.now();
  const cooling = entries.filter((entry) => new Date(entry?.cooldownUntil || 0).getTime() > now).length;
  const openCircuits = entries.filter((entry) => new Date(entry?.circuitOpenUntil || 0).getTime() > now).length;
  return {
    hosts: entries.length,
    cooling,
    openCircuits,
  };
}

async function getStealthDelay(baseDelayMs) {
  // Adds 20% to 150% jitter to ensure non-sequential patterns
  const multiplier = 0.2 + (Math.random() * 1.3);
  const finalDelay = Math.floor(baseDelayMs * multiplier);
  return finalDelay;
}

async function performCamouflageRequest() {
  const roll = Math.random();
  // Hit harmless metadata endpoints sparingly (5% chance)
  if (roll > 0.05) return;

  const targets = [
    { url: 'https://api.mangadex.org/manga/tag', label: 'camouflage_tags' },
    { url: 'https://api.mangadex.org/manga/random', label: 'camouflage_random' },
  ];

  const target = targets[Math.floor(Math.random() * targets.length)];
  try {
    await axios.get(target.url, {
      headers: getSecureHeaders(target.url),
      timeout: 10000
    });
    console.log(`[Stealth] Camouflage: ${target.label} triggered`);
  } catch (_) { /* ignore */ }
}

async function fetchGraphQL(query, variables) {
  const hostKey = getRequestHostKey(CONFIG.ANILIST_API, 'graphql.anilist.co');
  let retries = 0;
  while (retries < CONFIG.MAX_RETRIES) {
    try {
      await waitForHostAvailability(hostKey, 'AniList GraphQL');
      await performCamouflageRequest();

      const response = await axios.post(
        CONFIG.ANILIST_API,
        { query, variables },
        {
          headers: getSecureHeaders(CONFIG.ANILIST_API),
          timeout: 30000,
        },
      );
      markRequestSuccess(hostKey);

      if (response.data.errors) {
        console.error('GraphQL errors detected:');
        response.data.errors.forEach((err, i) => console.error(`  Error ${i + 1}: ${err.message}`));
      }
      flushRequestHealthState();
      return response.data?.data;
    } catch (error) {
      retries += 1;
      const status = error.response ? error.response.status : 0;
      const isRateLimited = status === 429 || status === 403;
      const statusText = error.response ? `[${status}]` : '[Network]';
      console.error(`API request failed ${statusText} (Attempt ${retries}/${CONFIG.MAX_RETRIES}): ${error.message}`);
      const waitTimeMs = computeRetryDelayMs(retries, error);
      markRequestFailure(hostKey, error, waitTimeMs);
      flushRequestHealthState();

      if (retries >= CONFIG.MAX_RETRIES) {
        throw error;
      }
      console.log(`Retrying AniList GraphQL in ${(waitTimeMs / 1000).toFixed(1)}s...`);
      await delay(waitTimeMs);
    }
  }
}

module.exports = {
  getSecureHeaders,
  computeRetryDelayMs,
  getStealthDelay,
  performCamouflageRequest,
  fetchGraphQL,
  getRequestHealthSummary,
  pruneRequestHealthState,
  markRequestSuccess,
  markRequestFailure
};
