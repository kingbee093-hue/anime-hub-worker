const axios = require('axios');
const fs = require('fs');
const path = require('path');
const CONFIG = require('../config/constants');
const { delay } = require('./formatters');

const DEFAULT_HTTP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': 'AnimeHubWorker/1.0 (+https://github.com/mauiww11/anime-hub-worker)',
};
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

async function fetchGraphQL(query, variables) {
  const hostKey = getRequestHostKey(CONFIG.ANILIST_API, 'graphql.anilist.co');
  let retries = 0;
  while (retries < CONFIG.MAX_RETRIES) {
    try {
      await waitForHostAvailability(hostKey, 'AniList GraphQL');
      const response = await axios.post(
        CONFIG.ANILIST_API,
        { query, variables },
        {
          headers: DEFAULT_HTTP_HEADERS,
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
      const isRateLimited = error.response && error.response.status === 429;
      const statusText = error.response ? `[${error.response.status}]` : '[Network]';
      console.error(`API request failed ${statusText} (Attempt ${retries}/${CONFIG.MAX_RETRIES}): ${error.message}`);
      const waitTimeMs = computeRetryDelayMs(retries, error);
      markRequestFailure(hostKey, error, waitTimeMs);
      flushRequestHealthState();

      if (retries < CONFIG.MAX_RETRIES) {
        if (isRateLimited) {
          console.log(`Rate limited (429). Backing off for ${(waitTimeMs / 1000).toFixed(1)}s...`);
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
  computeRetryDelayMs,
  fetchGraphQL,
};
