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
];

const MAX_RETRIES = 3;
const RETRY_DELAY = 2000;

// Host-specific cooldown state (15s backoff if 429 encountered)
const requestHealthState = {
  hosts: {}, // host -> { nextRequestTime, cooldownCount, isCircuitOpen, openUntil }
};

let requestHealthDirty = false;

function getRequestHostKey(url) {
  try {
    const parsed = new URL(url);
    return parsed.host;
  } catch (e) {
    return 'unknown';
  }
}

function getSecureHeaders(url = '') {
  const host = getRequestHostKey(url);
  // Using a consistent modern Chrome profile to match Sec-CH-UA hints
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
  
  const headers = {
    'User-Agent': ua,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    // Modern Browser Client Hints to bypass advanced Cloudflare/WAF checks
    'Sec-Ch-Ua': '"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
  };

  if (host.includes('mangadex')) {
    headers['Origin'] = 'https://mangadex.org';
    headers['Referer'] = 'https://mangadex.org/';
  } else if (host.includes('anilist')) {
    headers['Origin'] = 'https://anilist.co';
    headers['Referer'] = 'https://anilist.co/';
  }

  return headers;
}

function getRequestHealthSummary() {
  const now = Date.now();
  let cooling = 0;
  let openCircuits = 0;
  
  for (const host in requestHealthState.hosts) {
    const h = requestHealthState.hosts[host];
    if (h.nextRequestTime > now) cooling++;
    if (h.isCircuitOpen && h.openUntil > now) openCircuits++;
  }
  
  return {
    hosts: Object.keys(requestHealthState.hosts).length,
    cooling,
    openCircuits
  };
}

function markRequestSuccess(url) {
  const host = getRequestHostKey(url);
  if (!requestHealthState.hosts[host]) return;
  
  const h = requestHealthState.hosts[host];
  h.cooldownCount = 0;
  h.isCircuitOpen = false;
  requestHealthDirty = true;
}

function markRequestFailure(url, error) {
  const host = getRequestHostKey(url);
  if (!requestHealthState.hosts[host]) {
    requestHealthState.hosts[host] = { nextRequestTime: 0, cooldownCount: 0, isCircuitOpen: false, openUntil: 0 };
  }
  
  const h = requestHealthState.hosts[host];
  const is429 = error?.response?.status === 429;
  
  if (is429) {
    h.cooldownCount++;
    // Progressive backoff: 15s, 30s, 60s...
    const waitMs = 15000 * Math.pow(2, Math.min(h.cooldownCount - 1, 4));
    h.nextRequestTime = Date.now() + waitMs;
    
    // If we hit 3 consecutive 429s, open circuit for 5 minutes
    if (h.cooldownCount >= 3) {
      h.isCircuitOpen = true;
      h.openUntil = Date.now() + (5 * 60 * 1000); // 5 minutes lockdown
      console.warn(`[CIRCUIT BREAKER] Opening for host ${host} until ${new Date(h.openUntil).toISOString()} due to excessive 429s.`);
    }
  } else if (error?.response?.status >= 500) {
    // Server error - shorter cooldown
    h.nextRequestTime = Date.now() + 5000;
  }
  
  requestHealthDirty = true;
}

async function checkRequestThrottle(url) {
  const host = getRequestHostKey(url);
  const h = requestHealthState.hosts[host];
  if (!h) return;
  
  const now = Date.now();
  
  // Check circuit breaker first
  if (h.isCircuitOpen) {
    if (now < h.openUntil) {
      const remaining = Math.ceil((h.openUntil - now) / 1000);
      throw new Error(`Circuit breaker open for ${host}. Waiting ${remaining}s.`);
    } else {
      h.isCircuitOpen = false; // Reset after time passes
      h.cooldownCount = 1; // Start with mild cooldown
    }
  }
  
  if (h.nextRequestTime > now) {
    const waitMs = h.nextRequestTime - now;
    console.log(`Host ${host} cooling down before request; waiting ${(waitMs/1000).toFixed(1)}s.`);
    await delay(waitMs);
  }
}

async function requestJsonWithRetries(url, options = {}, context = 'request') {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await checkRequestThrottle(url);
      
      const headers = {
        ...getSecureHeaders(url),
        ...(options.headers || {})
      };
      
      const response = await axios({
        url,
        method: options.method || 'GET',
        headers,
        params: options.params,
        data: options.data,
        timeout: options.timeout || 15000,
        validateStatus: status => status === 200,
      });
      
      markRequestSuccess(url);
      return response;
    } catch (error) {
      const isLastAttempt = attempt === MAX_RETRIES;
      const status = error.response?.status;
      const is404 = status === 404;
      const is429 = status === 429;
      
      markRequestFailure(url, error);

      if (is404) {
        // Don't retry 404s
        throw error;
      }

      if (isLastAttempt) {
        throw error;
      }

      const wait = is429 ? 15000 : RETRY_DELAY * attempt;
      console.log(`API request failed [${error.code || status}] for ${context} (Attempt ${attempt}/${MAX_RETRIES}): ${error.message}`);
      await delay(wait);
    }
  }
}

function writeRequestHealth(state) {
  try {
    const healthPath = path.join(process.cwd(), '.tmp_worker', 'request_health.json');
    fs.mkdirSync(path.dirname(healthPath), { recursive: true });
    // Filter out old hosts to keep file small
    const now = Date.now();
    const cleanHosts = {};
    for (const host in state.hosts) {
      const h = state.hosts[host];
      if (h.nextRequestTime > now || h.isCircuitOpen) {
        cleanHosts[host] = h;
      }
    }
    fs.writeFileSync(healthPath, JSON.stringify({ hosts: cleanHosts }, null, 2));
  } catch (e) {
    // Ignore health write errors
  }
}

function readRequestHealth() {
  try {
    const healthPath = path.join(process.cwd(), '.tmp_worker', 'request_health.json');
    if (fs.existsSync(healthPath)) {
      const data = JSON.parse(fs.readFileSync(healthPath, 'utf8'));
      if (data && data.hosts) return data;
    }
  } catch (e) {}
  return { hosts: {} };
}

function pruneRequestHealthState() {
  const now = Date.now();
  for (const host in requestHealthState.hosts) {
    const h = requestHealthState.hosts[host];
    // If no recent issues, remove from state
    if (h.nextRequestTime < now && !h.isCircuitOpen) {
       delete requestHealthState.hosts[host];
       requestHealthDirty = true;
    }
  }
}

// Initial load
const savedHealth = readRequestHealth();
requestHealthState.hosts = { ...requestHealthState.hosts, ...savedHealth.hosts };

module.exports = {
  requestJsonWithRetries,
  getSecureHeaders,
  getRequestHealthSummary,
  pruneRequestHealthState,
  writeRequestHealth,
  requestHealthState,
  get requestHealthDirty() { return requestHealthDirty; },
  set requestHealthDirty(v) { requestHealthDirty = v; }
};
