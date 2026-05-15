#!/usr/bin/env node
/**
 * GHL Payload Harvester — Local Vault Server
 *
 * Zero-dependency Node.js HTTP server that acts as a shared merge point
 * for multiple Chrome profiles running the harvester. Each profile pushes
 * its captured endpoints + payloads here, the server merges them, and
 * any profile can pull the union back.
 *
 * Run:
 *     node server.js
 *
 * Optional env vars:
 *     VAULT_PORT        default 7777
 *     VAULT_HOST        default 127.0.0.1 (localhost only)
 *     VAULT_SECRET      if set, requires X-Secret header on all requests
 *     VAULT_DATA_FILE   default ./vault-data.json
 *
 * Endpoints:
 *     GET  /api/health           -> { ok, endpointCount, payloadCount, updatedAt }
 *     GET  /api/state            -> { endpoints, payloads, updatedAt }
 *     POST /api/ingest           -> single payload push (existing extension format)
 *     POST /api/ingest/bulk      -> bulk endpoints + payloads push
 *     POST /api/clear            -> wipe vault (requires secret if configured)
 *
 * Pair with the extension's "Sync Now" button — it pushes local data here,
 * the server merges, then the extension pulls the merged state back.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.VAULT_PORT || 7777);
const HOST = process.env.VAULT_HOST || '127.0.0.1';
const SECRET = process.env.VAULT_SECRET || '';
const DATA_FILE = process.env.VAULT_DATA_FILE
  ? path.resolve(process.env.VAULT_DATA_FILE)
  : path.join(__dirname, 'vault-data.json');

// -------------------------------------------------------------------------
// State (in-memory, persisted to disk)
// -------------------------------------------------------------------------

let state = { endpoints: {}, payloads: {}, updatedAt: null };

try {
  if (fs.existsSync(DATA_FILE)) {
    state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    if (!state.endpoints) state.endpoints = {};
    if (!state.payloads) state.payloads = {};
  }
} catch (e) {
  console.warn(`[vault] failed to load state from ${DATA_FILE}: ${e.message}. Starting fresh.`);
  state = { endpoints: {}, payloads: {}, updatedAt: null };
}

let writeTimer = null;
function persist() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const tmp = DATA_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(state), (err) => {
      if (err) {
        console.warn(`[vault] write failed: ${err.message}`);
        return;
      }
      fs.rename(tmp, DATA_FILE, (err2) => {
        if (err2) console.warn(`[vault] rename failed: ${err2.message}`);
      });
    });
  }, 250);
}

// -------------------------------------------------------------------------
// Merge logic
// -------------------------------------------------------------------------

const AUTH_RANK = { bearer: 4, apikey: 3, 'firebase-jwt': 2, other: 1, none: 0 };

function mergeEndpoint(target, incoming) {
  if (!target) return JSON.parse(JSON.stringify(incoming));
  target.hitCount = (target.hitCount || 0) + (incoming.hitCount || 0);
  target.lastSeen = Math.max(target.lastSeen || 0, incoming.lastSeen || 0);
  target.firstSeen = Math.min(
    target.firstSeen || incoming.firstSeen || Date.now(),
    incoming.firstSeen || target.firstSeen || Date.now()
  );
  target.queryParams = uniq([...(target.queryParams || []), ...(incoming.queryParams || [])]);
  target.statusCodes = uniq([...(target.statusCodes || []), ...(incoming.statusCodes || [])]);
  target.sampleUrls = uniq([...(incoming.sampleUrls || []), ...(target.sampleUrls || [])]).slice(0, 3);
  target.tags = uniq([...(target.tags || []), ...(incoming.tags || [])]);
  if (incoming.starred) target.starred = true;
  if (incoming.notes && !target.notes) target.notes = incoming.notes;
  if ((AUTH_RANK[incoming.authType] || 0) > (AUTH_RANK[target.authType] || 0)) {
    target.authType = incoming.authType;
  }
  if (incoming.apiStatus === 'official') target.apiStatus = 'official';
  return target;
}

function sigOfSample(s) {
  const body = s && s.requestBody ? String(s.requestBody) : '';
  return `${(s && s.status) || 0}|${body.length}|${body.substring(0, 200)}`;
}

function mergePayload(target, incoming) {
  if (!target) return JSON.parse(JSON.stringify(incoming));

  const incomingSamples = incoming.samples && incoming.samples.length > 0
    ? incoming.samples
    : [stripSamples(incoming)];
  const targetSamples = target.samples && target.samples.length > 0
    ? target.samples
    : [stripSamples(target)];

  const all = [...incomingSamples, ...targetSamples];
  const seen = new Set();
  const deduped = [];
  for (const s of all) {
    const sig = sigOfSample(s);
    if (seen.has(sig)) continue;
    seen.add(sig);
    deduped.push(s);
  }
  deduped.sort((a, b) => (b.capturedAt || 0) - (a.capturedAt || 0));
  const top = deduped.slice(0, 5);

  return {
    ...top[0],
    samples: top,
    captureCount: (target.captureCount || 0) + (incoming.captureCount || 0)
  };
}

function stripSamples(p) {
  if (!p) return p;
  const { samples, captureCount, ...rest } = p;
  return rest;
}

function uniq(arr) {
  return [...new Set(arr)];
}

// -------------------------------------------------------------------------
// HTTP helpers
// -------------------------------------------------------------------------

function checkAuth(req) {
  if (!SECRET) return true;
  return req.headers['x-secret'] === SECRET;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Secret'
};

function jsonResponse(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify(body));
}

function readBody(req, maxBytes = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// -------------------------------------------------------------------------
// Server
// -------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (!checkAuth(req)) {
    return jsonResponse(res, 401, { error: 'unauthorized' });
  }

  // GET /api/health
  if (req.method === 'GET' && req.url === '/api/health') {
    return jsonResponse(res, 200, {
      ok: true,
      endpointCount: Object.keys(state.endpoints).length,
      payloadCount: Object.keys(state.payloads).length,
      updatedAt: state.updatedAt,
      dataFile: DATA_FILE
    });
  }

  // GET /api/state
  if (req.method === 'GET' && req.url === '/api/state') {
    return jsonResponse(res, 200, state);
  }

  // POST /api/ingest/bulk
  if (req.method === 'POST' && req.url === '/api/ingest/bulk') {
    try {
      const data = await readBody(req);
      let epAdded = 0, epMerged = 0, plAdded = 0, plMerged = 0;
      for (const [k, v] of Object.entries(data.endpoints || {})) {
        if (state.endpoints[k]) epMerged++; else epAdded++;
        state.endpoints[k] = mergeEndpoint(state.endpoints[k], v);
      }
      for (const [k, v] of Object.entries(data.payloads || {})) {
        if (state.payloads[k]) plMerged++; else plAdded++;
        state.payloads[k] = mergePayload(state.payloads[k], v);
      }
      state.updatedAt = Date.now();
      persist();
      console.log(`[vault] bulk push: +${epAdded}/${epMerged} endpoints, +${plAdded}/${plMerged} payloads`);
      return jsonResponse(res, 200, {
        ok: true,
        endpointCount: Object.keys(state.endpoints).length,
        payloadCount: Object.keys(state.payloads).length,
        endpointsAdded: epAdded, endpointsMerged: epMerged,
        payloadsAdded: plAdded, payloadsMerged: plMerged
      });
    } catch (e) {
      return jsonResponse(res, 400, { error: e.message });
    }
  }

  // POST /api/ingest  (single payload, matches existing extension format)
  if (req.method === 'POST' && req.url === '/api/ingest') {
    try {
      const data = await readBody(req);
      if (data.epKey && data.endpoint) {
        state.endpoints[data.epKey] = mergeEndpoint(state.endpoints[data.epKey], data.endpoint);
      }
      if (data.epKey && data.payload) {
        state.payloads[data.epKey] = mergePayload(state.payloads[data.epKey], data.payload);
      }
      state.updatedAt = Date.now();
      persist();
      return jsonResponse(res, 200, { ok: true });
    } catch (e) {
      return jsonResponse(res, 400, { error: e.message });
    }
  }

  // POST /api/clear
  if (req.method === 'POST' && req.url === '/api/clear') {
    state = { endpoints: {}, payloads: {}, updatedAt: Date.now() };
    persist();
    console.log('[vault] cleared');
    return jsonResponse(res, 200, { ok: true });
  }

  jsonResponse(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log('--------------------------------------------------------');
  console.log(`GHL Vault listening on http://${HOST}:${PORT}`);
  console.log(`Data file: ${DATA_FILE}`);
  console.log(`Auth: ${SECRET ? 'enabled (X-Secret required)' : 'disabled'}`);
  console.log(`Loaded: ${Object.keys(state.endpoints).length} endpoints, ${Object.keys(state.payloads).length} payloads`);
  console.log('--------------------------------------------------------');
  console.log('Configure each Chrome profile:');
  console.log(`  Vault URL: http://${HOST}:${PORT}/api/ingest`);
  if (SECRET) console.log(`  Vault Secret: <your VAULT_SECRET>`);
  console.log('Then click "Sync Now" in the extension popup.');
});

process.on('SIGINT', () => {
  console.log('\n[vault] shutting down...');
  if (writeTimer) {
    clearTimeout(writeTimer);
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(state));
      console.log('[vault] state flushed');
    } catch (e) {
      console.warn(`[vault] flush failed: ${e.message}`);
    }
  }
  process.exit(0);
});
