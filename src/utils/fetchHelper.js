const axios = require('axios');
const fs = require('fs');
const path = require('path');
const CONFIG = require('../config/constants');
const { delay } = require('./formatters');

const MODERN_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.4; rv:124.0) Gecko/20100101 Firefox/124.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Edge/123.0.2420.81',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
];

function getRandomUA() {
  return MODERN_USER_AGENTS[Math.floor(Math.random() * MODERN_USER_AGENTS.length)];
}

function getSecureHeaders(url = '') {
  const host = getRequestHostKey(url);
  const ua = getRandomUA();
  
  const headers = {
    'User-Agent': ua,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'DNT': '1',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site',
    'Pragma': 'no-cache',
    'Cache-Control': 'no-cache',
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

const GRAPHQL_HOST_COOLDOWN_MS = Math.max(1000, Number(process.env.WORKER_GRAPHQL_HOST_COOLDOWN_MS || 10000));
const GRAPHQL_HOST_CIRCUIT_THRESHOLD = Math.max(2, Number(process.env.WORKER_GRAPHQL_HOST_CIRCUIT_THRESHOLD || 4));
const GRAPHQL_HOST_CIRCUIT_MS = Math.max(10000, Number(process.env.WORKER_GRAPHQL_HOST_CIRCUIT_MS || 120000));
const GRAPHQL_HOST_PREWAIT_MAX_MS = Math.max(5000, Number(process.env.WORKER_GRAPHQL_HOST_PREWAIT_MAX_MS || 60000));
const GRAPHQL_REQUEST_HEALTH_PRUNE_HOURS = Math.max(12, Number(process.env.WORKER_REQUEST_HEALTH_PRUNE_HOURS || 168));
const REQUEST_HEALTH_FILE = path.join(__dirname, '../../api', `${CONFIG.API_PATHS.REQUEST_HEALTH}.json`);

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function getRequestHealthState() {
  const parsed = readJsonFile(REQUEST_HEALTH_FILE, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

let requestHealthState = getRequestHealthState();
let requestHealthDirty = false;

function computeRetryDelayMs(retries, error) {
  const status = error.response ? error.response.status : 0;
  const isRateLimited = status === 429 || status === 403;
  
  let waitTimeMs = CONFIG.RETRY_DELAY * Math.pow(2.5, retries);

  if (isRateLimited && error.response.headers && error.response.headers['retry-after']) {
    const retryAfterSec = parseInt(error.response.headers['retry-after'], 10);
    if (!Number.isNaN(retryAfterSec)) {
      waitTimeMs = retryAfterSec * 1000 + 1000;
    }
  } else if (status === 403) {
    waitTimeMs = Math.max(waitTimeMs, 10000);
  }

  const jitterMs = Math.floor(Math.random() * 1000);
  return waitTimeMs + jitterMs;
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
      new Date(entry?.lastSuccessAt || 0).getTime(),
    );
    const activeWaitMs = getRequestHealthWaitMs(entry);
    if ((Number.isFinite(lastTouchedMs) && lastTouchedMs > 0 && lastTouchedMs < cutoffMs) && activeWaitMs <= 0) {
      delete requestHealthState[hostKey];
      requestHealthDirty = true;
    }
  }
}

async function waitForHostAvailability(hostKey, label) {
  const entry = getRequestHealthEntry(hostKey);
  const waitMs = getRequestHealthWaitMs(entry);
  if (waitMs <= 0) {
    return;
  }

  if (waitMs > GRAPHQL_HOST_PREWAIT_MAX_MS) {
    throw new Error(
      `host cooldown active for ${hostKey} before ${label}; remaining ${(waitMs / 1000).toFixed(1)}s exceeds prewait cap`,
    );
  }

  console.log(`Host ${hostKey} cooling down before ${label}; waiting ${(waitMs / 1000).toFixed(1)}s...`);
  await delay(waitMs);
}

function markRequestSuccess(hostKey) {
  const entry = getRequestHealthEntry(hostKey);
  entry.consecutiveFailures = 0;
  entry.totalSuccesses = Number(entry.totalSuccesses || 0) + 1;
  entry.lastSuccessAt = new Date().toISOString();
  entry.lastStatus = 200;
  entry.cooldownUntil = null;
  entry.circuitOpenUntil = null;
  entry.lastError = null;
  requestHealthDirty = true;
}

function markRequestFailure(hostKey, error, waitTimeMs) {
  const entry = getRequestHealthEntry(hostKey);
  const status = Number(error?.response?.status || 0) || null;
  const isRateLimited = status === 429;
  const isTemporary =
    isRateLimited ||
    status === 403 ||
    status === 408 ||
    status === 409 ||
    status === 423 ||
    status === 425 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    !status;

  entry.consecutiveFailures = Number(entry.consecutiveFailures || 0) + 1;
  entry.totalFailures = Number(entry.totalFailures || 0) + 1;
  entry.lastFailureAt = new Date().toISOString();
  entry.lastStatus = status;
  entry.lastError = String(error?.message || 'request_failed');

  const cooldownMs = Math.max(waitTimeMs || 0, isTemporary ? GRAPHQL_HOST_COOLDOWN_MS : 0);
  if (cooldownMs > 0) {
    const nextIso = new Date(Date.now() + cooldownMs).toISOString();
    if (!entry.cooldownUntil || new Date(entry.cooldownUntil).getTime() < new Date(nextIso).getTime()) {
      entry.cooldownUntil = nextIso;
    }
  }

  if (isTemporary && entry.consecutiveFailures >= GRAPHQL_HOST_CIRCUIT_THRESHOLD) {
    entry.circuitOpenUntil = new Date(Date.now() + GRAPHQL_HOST_CIRCUIT_MS).toISOString();
  }

  requestHealthDirty = true;
}

function flushRequestHealthState() {
  pruneRequestHealthState();
  if (!requestHealthDirty) {
    return;
  }

  writeJsonFile(REQUEST_HEALTH_FILE, requestHealthState);
  requestHealthDirty = false;
}

/** 🚀 ADVANCED STEALTH / BYPASS UTILITIES 🚀 **/

async function getStealthDelay(baseDelayMs) {
  const multiplier = 0.3 + (Math.random() * 1.5);
  const finalDelay = Math.floor(baseDelayMs * multiplier);
  return finalDelay;
}

async function performCamouflageRequest() {
  const roll = Math.random();
  if (roll > 0.08) return;

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

      if (retries < CONFIG.MAX_RETRIES) {
        if (isRateLimited) {
          console.log(`Rate limited/Blocked (${status}). Backing off for ${(waitTimeMs / 1000).toFixed(1)}s...`);
        } else {
          console.log(`Retrying in ${(waitTimeMs / 1000).toFixed(1)}s...`);
        }
        await delay(waitTimeMs);
      }
    }
  }
  flushRequestHealthState();
  return null;
}

module.exports = {
  DEFAULT_HTTP_HEADERS,
  getSecureHeaders,
  computeRetryDelayMs,
  getStealthDelay,
  performCamouflageRequest,
  fetchGraphQL,
};
