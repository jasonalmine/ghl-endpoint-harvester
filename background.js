/**
 * GHL Endpoint Harvester - Background Service Worker
 * Intercepts GHL API requests and catalogs normalized endpoint patterns.
 */

const GHL_DOMAINS = [
  'services.leadconnectorhq.com',
  'backend.leadconnectorhq.com',
  'api.msgsndr.com',
  'rest.gohighlevel.com',
  // Firebase domains (GHL uses these under the hood)
  'firebasestorage.googleapis.com',
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com'
];

// Static asset extensions to ignore
const IGNORED_EXTENSIONS = new Set([
  '.js', '.mjs', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg',
  '.webp', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.map', '.json.map', '.ts'
]);

// HMR / webpack noise patterns
const IGNORED_PATH_PATTERNS = [
  /\/__webpack_hmr/,
  /\/sockjs-node/,
  /\/hot-update\./,
  /\/@vite\//,
  /\/@fs\//,
  /\/node_modules\//
];

// Default settings
const DEFAULT_SETTINGS = {
  autoCaptureOnStartup: true,
  maxEndpoints: 500,
  domains: [...GHL_DOMAINS],
  exportFormat: 'json'
};

// -------------------------------------------------------------------------
// Official GHL API v2 endpoint patterns (for auto-classification)
// These are the published endpoints at developers.gohighlevel.com
// Patterns use {param} placeholders and match normalized paths.
// -------------------------------------------------------------------------

const OFFICIAL_API_PATTERNS = [
  // Contacts
  '/contacts/', '/contacts/{contactId}', '/contacts/{contactId}/tasks',
  '/contacts/{contactId}/tasks/{taskId}', '/contacts/{contactId}/notes',
  '/contacts/{contactId}/notes/{noteId}', '/contacts/{contactId}/tags',
  '/contacts/{contactId}/tags/{tagId}', '/contacts/{contactId}/campaigns',
  '/contacts/{contactId}/campaigns/{campaignId}',
  '/contacts/{contactId}/workflow', '/contacts/{contactId}/workflow/{workflowId}',
  '/contacts/{contactId}/appointments', '/contacts/upsert',
  '/contacts/businessId/{id}', '/contacts/search', '/contacts/search/duplicate',
  '/contacts/bulk/business/{id}',

  // Opportunities
  '/opportunities/', '/opportunities/{opportunityId}', '/opportunities/upsert',
  '/opportunities/search', '/opportunities/{opportunityId}/status',
  '/opportunities/pipelines', '/opportunities/pipelines/{pipelineId}',

  // Conversations
  '/conversations/', '/conversations/{conversationId}',
  '/conversations/{conversationId}/messages', '/conversations/messages',
  '/conversations/messages/{messageId}', '/conversations/messages/upload',
  '/conversations/search', '/conversations/messages/{messageId}/schedule',
  '/conversations/messages/{messageId}/status',
  '/conversations/messages/inbound',
  '/conversations/providers/install',

  // Calendars & Events
  '/calendars/', '/calendars/{calendarId}', '/calendars/events',
  '/calendars/events/{eventId}', '/calendars/events/appointments',
  '/calendars/events/appointments/{eventId}', '/calendars/events/block-slots',
  '/calendars/{calendarId}/free-slots', '/calendars/groups',
  '/calendars/groups/{groupId}', '/calendars/resources',
  '/calendars/resources/{resourceId}',

  // Payments & Invoices
  '/payments/transactions', '/payments/orders/{orderId}',
  '/payments/orders/{orderId}/fulfillments',
  '/payments/subscriptions/{subscriptionId}',
  '/payments/custom-provider/connect', '/payments/custom-provider/disconnect',
  '/invoices/', '/invoices/{invoiceId}', '/invoices/{invoiceId}/void',
  '/invoices/{invoiceId}/send', '/invoices/{invoiceId}/record-payment',
  '/invoices/generate-invoice-number', '/invoices/templates',
  '/invoices/templates/{templateId}', '/invoices/schedule',
  '/invoices/schedule/{scheduleId}', '/invoices/text2pay',

  // Products
  '/products/', '/products/{productId}', '/products/{productId}/price',
  '/products/{productId}/price/{priceId}',
  '/products/collections/', '/products/collections/{id}',

  // Campaigns
  '/campaigns/', '/campaigns/{campaignId}',

  // Workflows
  '/workflows/', '/workflows/{workflowId}',

  // Users
  '/users/', '/users/{userId}',

  // Custom Fields & Values
  '/custom-fields/', '/custom-fields/{fieldId}',
  '/custom-values/', '/custom-values/{valueId}',
  '/locations/{locationId}/customFields',
  '/locations/{locationId}/customValues',

  // Locations
  '/locations/', '/locations/{locationId}', '/locations/search',
  '/locations/{locationId}/tags', '/locations/{locationId}/tags/{tagId}',
  '/locations/{locationId}/tasks/search',
  '/locations/{locationId}/timezone',
  '/locations/{locationId}/templates',

  // Companies
  '/companies/', '/companies/{companyId}',

  // Forms & Surveys
  '/forms/', '/forms/{formId}', '/forms/submissions',
  '/forms/upload-custom-files',
  '/surveys/', '/surveys/{surveyId}', '/surveys/submissions',

  // Blogs
  '/blogs/', '/blogs/{blogId}', '/blogs/authors', '/blogs/categories',
  '/blogs/{blogId}/posts', '/blogs/{blogId}/posts/{postId}',
  '/blogs/check-slug',

  // Social Media Posting (official v2)
  '/social-media-posting/', '/social-media-posting/{id}/posts',
  '/social-media-posting/{id}/posts/{postId}',
  '/social-media-posting/{id}/accounts',
  '/social-media-posting/statistics',
  '/social-media-posting/oauth/{platform}/start',

  // Notes
  '/notes/', '/notes/{noteId}',

  // Tags
  '/tags/', '/tags/{tagId}',

  // Tasks
  '/tasks/', '/tasks/{taskId}', '/tasks/search',

  // Funnels (official - very limited)
  '/funnels/', '/funnels/{funnelId}',
  '/funnels/page', '/funnels/page/{pageId}',
  '/funnels/lookup/redirect', '/funnels/lookup/redirect/{redirectId}',

  // Businesses
  '/businesses/', '/businesses/{id}',

  // Triggers
  '/triggers/', '/triggers/{triggerId}',

  // Webhooks
  '/webhooks/', '/webhooks/{webhookId}',

  // OAuth
  '/oauth/token', '/oauth/locationToken',
  '/oauth/installedLocations',

  // Media / Files
  '/medias/', '/medias/{mediaId}',
  '/medias/upload-file', '/medias/files',

  // SaaS
  '/saas-api/public-api/bulk-disable-saas/',
  '/saas-api/public-api/enable-saas/',
  '/saas-api/public-api/update-rebilling/',

  // Associations
  '/associations/',

  // Courses / Memberships
  '/courses/', '/courses/{courseId}',

  // Email Verification
  '/emails/verify',

  // Snapshots
  '/snapshots/', '/snapshots/{snapshotId}',
  '/snapshots/share/link',
];

/**
 * Classify an endpoint as 'official' or 'undocumented' by matching
 * against known published API v2 patterns.
 *
 * Matching strategy:
 * - Normalize both the captured pattern and official patterns for comparison
 * - Replace all {xxxId} and {id} etc. with a generic placeholder for matching
 * - Strip trailing slashes for comparison
 * - OPTIONS requests inherit the classification of their corresponding method
 */
function classifyEndpoint(method, normalizedPattern) {
  // OPTIONS are just CORS preflight, always classify as 'preflight'
  if (method === 'OPTIONS') return 'preflight';

  // Normalize for matching: replace all {xxxxx} with {_} and strip trailing /
  const normalize = (p) => p.replace(/\{[^}]+\}/g, '{_}').replace(/\/+$/, '').toLowerCase();
  const captured = normalize(normalizedPattern);

  for (const official of OFFICIAL_API_PATTERNS) {
    if (normalize(official) === captured) return 'official';
  }

  return 'undocumented';
}

// -------------------------------------------------------------------------
// Path normalization
// -------------------------------------------------------------------------

/**
 * Normalize a URL path by replacing dynamic ID segments with typed placeholders.
 * Order matters: more specific patterns first.
 */
function normalizePath(pathname) {
  const segments = pathname.split('/').map(seg => {
    if (!seg) return seg;

    // UUID (8-4-4-4-12 hex)
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) {
      return '{uuid}';
    }

    // MongoDB ObjectId (exactly 24 hex chars)
    if (/^[0-9a-f]{24}$/i.test(seg)) {
      return '{objectId}';
    }

    // Pure numeric ID
    if (/^\d{4,}$/.test(seg)) {
      return '{numId}';
    }

    // GHL-style alphanumeric IDs (15+ chars, mixed case/numbers, no hyphens)
    // These are the typical GHL location/contact/opportunity IDs
    if (/^[a-zA-Z0-9]{15,}$/.test(seg)) {
      return '{id}';
    }

    // Alphanumeric with hyphens/underscores, 10+ chars (likely a generated ID)
    if (/^[a-zA-Z0-9_-]{10,}$/.test(seg) && /[0-9]/.test(seg) && /[a-zA-Z]/.test(seg)) {
      return '{id}';
    }

    return seg;
  });

  // Second pass: apply semantic names based on position after known path words
  const result = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const prev = segments[i - 1] || '';

    if (seg === '{id}') {
      // Apply semantic naming based on preceding path word
      switch (prev) {
        case 'locations':      result.push('{locationId}'); break;
        case 'contacts':       result.push('{contactId}'); break;
        case 'opportunities':  result.push('{opportunityId}'); break;
        case 'conversations':  result.push('{conversationId}'); break;
        case 'messages':       result.push('{messageId}'); break;
        case 'campaigns':      result.push('{campaignId}'); break;
        case 'workflows':      result.push('{workflowId}'); break;
        case 'pipelines':      result.push('{pipelineId}'); break;
        case 'stages':         result.push('{stageId}'); break;
        case 'calendars':      result.push('{calendarId}'); break;
        case 'appointments':   result.push('{appointmentId}'); break;
        case 'funnels':        result.push('{funnelId}'); break;
        case 'pages':          result.push('{pageId}'); break;
        case 'forms':          result.push('{formId}'); break;
        case 'surveys':        result.push('{surveyId}'); break;
        case 'users':          result.push('{userId}'); break;
        case 'teams':          result.push('{teamId}'); break;
        case 'tags':           result.push('{tagId}'); break;
        case 'tasks':          result.push('{taskId}'); break;
        case 'notes':          result.push('{noteId}'); break;
        case 'products':       result.push('{productId}'); break;
        case 'invoices':       result.push('{invoiceId}'); break;
        case 'payments':       result.push('{paymentId}'); break;
        case 'subscriptions':  result.push('{subscriptionId}'); break;
        case 'memberships':    result.push('{membershipId}'); break;
        case 'courses':        result.push('{courseId}'); break;
        case 'emails':         result.push('{emailId}'); break;
        case 'templates':      result.push('{templateId}'); break;
        case 'companies':      result.push('{companyId}'); break;
        case 'agencies':       result.push('{agencyId}'); break;
        case 'media':          result.push('{mediaId}'); break;
        case 'blogs':          result.push('{blogId}'); break;
        case 'posts':          result.push('{postId}'); break;
        case 'categories':     result.push('{categoryId}'); break;
        case 'triggers':       result.push('{triggerId}'); break;
        case 'automations':    result.push('{automationId}'); break;
        case 'snapshots':      result.push('{snapshotId}'); break;
        case 'funnelsteps':    result.push('{stepId}'); break;
        case 'customfields':   result.push('{fieldId}'); break;
        case 'attributes':     result.push('{attributeId}'); break;
        default:               result.push('{id}'); break;
      }
    } else {
      result.push(seg);
    }
  }

  return result.join('/');
}

// -------------------------------------------------------------------------
// Static asset / noise filtering
// -------------------------------------------------------------------------

function shouldIgnore(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();

    // Check extension
    for (const ext of IGNORED_EXTENSIONS) {
      if (path.endsWith(ext)) return true;
    }

    // Check HMR/webpack patterns
    for (const pat of IGNORED_PATH_PATTERNS) {
      if (pat.test(u.pathname)) return true;
    }

    return false;
  } catch {
    return true;
  }
}

function isGHLDomain(url, activeDomains) {
  try {
    const hostname = new URL(url).hostname;
    return activeDomains.some(d => hostname === d || hostname.endsWith('.' + d));
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------------
// Auth type detection
// -------------------------------------------------------------------------

function detectAuthType(headers) {
  if (!headers) return 'none';
  let hasTokenId = false;
  for (const h of headers) {
    const name = h.name.toLowerCase();
    const val = h.value || '';
    if (name === 'authorization') {
      if (val.startsWith('Bearer ')) return 'bearer';
      if (val.startsWith('Basic ')) return 'basic';
      return 'other';
    }
    if (name === 'x-api-key' || name === 'api-key') return 'apikey';
    if (name === 'token-id') hasTokenId = true;
  }
  // token-id header without Authorization = Firebase JWT auth
  if (hasTokenId) return 'firebase-jwt';
  return 'none';
}

// -------------------------------------------------------------------------
// Storage helpers
// -------------------------------------------------------------------------

async function getEndpoints() {
  const result = await chrome.storage.local.get('endpoints');
  return result.endpoints || {};
}

async function getCaptureState() {
  const result = await chrome.storage.local.get('captureState');
  return result.captureState || {
    isCapturing: true,
    startedAt: Date.now(),
    totalRequests: 0
  };
}

async function getSettings() {
  const result = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(result.settings || {}) };
}

// -------------------------------------------------------------------------
// Vault config + delivery
// -------------------------------------------------------------------------

async function getVaultConfig() {
  const result = await chrome.storage.local.get('vaultConfig');
  return {
    vaultUrl: '',
    vaultSecret: '',
    autoPush: false,
    autoSync: false,
    syncIntervalMinutes: 5,
    lastPushAt: null,
    lastPushStatus: null,
    pushCount: 0,
    lastPullAt: null,
    lastPullStatus: null,
    pullCount: 0,
    lastSyncAt: null,
    ...(result.vaultConfig || {})
  };
}

// -------------------------------------------------------------------------
// Vault: pull + merge (multi-profile sync)
// -------------------------------------------------------------------------

const AUTH_RANK = { bearer: 4, apikey: 3, 'firebase-jwt': 2, other: 1, none: 0 };

function uniq(arr) { return [...new Set(arr)]; }

function mergeEndpointShape(target, incoming) {
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

function sigOfSampleClient(s) {
  const body = s && s.requestBody ? String(s.requestBody) : '';
  return `${(s && s.status) || 0}|${body.length}|${body.substring(0, 200)}`;
}

function mergePayloadShape(target, incoming) {
  if (!target) return JSON.parse(JSON.stringify(incoming));
  const stripSamples = (p) => { if (!p) return p; const { samples, captureCount, ...rest } = p; return rest; };
  const incomingSamples = incoming.samples && incoming.samples.length > 0 ? incoming.samples : [stripSamples(incoming)];
  const targetSamples = target.samples && target.samples.length > 0 ? target.samples : [stripSamples(target)];

  const all = [...incomingSamples, ...targetSamples];
  const seen = new Set();
  const deduped = [];
  for (const s of all) {
    const sig = sigOfSampleClient(s);
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

async function pullFromVault() {
  const vc = await getVaultConfig();
  if (!vc.vaultUrl) throw new Error('Vault URL not configured');

  const stateUrl = vc.vaultUrl.replace(/\/api\/ingest(\/bulk)?$/, '/api/state');
  const resp = await fetch(stateUrl, {
    method: 'GET',
    headers: { ...(vc.vaultSecret ? { 'X-Secret': vc.vaultSecret } : {}) }
  });
  if (!resp.ok) throw new Error(`Vault pull failed: ${resp.status}`);
  const remote = await resp.json();

  const [endpoints, payloads, settings] = await Promise.all([
    getEndpoints(), getPayloads(), getSettings()
  ]);

  // Merge remote into local (conflict resolution favors union)
  let epAdded = 0, epMerged = 0, plAdded = 0, plMerged = 0;
  for (const [k, v] of Object.entries(remote.endpoints || {})) {
    if (endpoints[k]) epMerged++; else epAdded++;
    endpoints[k] = mergeEndpointShape(endpoints[k], v);
  }
  for (const [k, v] of Object.entries(remote.payloads || {})) {
    if (payloads[k]) plMerged++; else plAdded++;
    payloads[k] = mergePayloadShape(payloads[k], v);
  }

  // Enforce caps after merge
  const epKeys = Object.keys(endpoints);
  if (epKeys.length > (settings.maxEndpoints || 500)) {
    const sorted = epKeys.sort((a, b) => (endpoints[b].lastSeen || 0) - (endpoints[a].lastSeen || 0));
    const toKeep = sorted.slice(0, settings.maxEndpoints || 500);
    const next = {};
    for (const k of toKeep) next[k] = endpoints[k];
    for (const k of Object.keys(endpoints)) if (!next[k]) delete endpoints[k];
  }
  const plKeys = Object.keys(payloads);
  if (plKeys.length > MAX_PAYLOAD_ENTRIES) {
    const sorted = plKeys.sort((a, b) => (payloads[b].capturedAt || 0) - (payloads[a].capturedAt || 0));
    const toKeep = new Set(sorted.slice(0, MAX_PAYLOAD_ENTRIES));
    for (const k of plKeys) if (!toKeep.has(k)) delete payloads[k];
  }

  await chrome.storage.local.set({ endpoints, payloads });

  vc.lastPullAt = Date.now();
  vc.lastPullStatus = 'ok';
  vc.pullCount = (vc.pullCount || 0) + 1;
  await chrome.storage.local.set({ vaultConfig: vc });

  updateBadge();

  return {
    ok: true,
    endpointsAdded: epAdded, endpointsMerged: epMerged,
    payloadsAdded: plAdded, payloadsMerged: plMerged,
    totalEndpoints: Object.keys(endpoints).length,
    totalPayloads: Object.keys(payloads).length
  };
}

async function syncWithVault() {
  // Push local -> server (server merges) -> pull merged state -> merge into local
  const pushResult = await pushBulkToVault();
  const pullResult = await pullFromVault();
  const vc = await getVaultConfig();
  vc.lastSyncAt = Date.now();
  await chrome.storage.local.set({ vaultConfig: vc });
  return { ok: true, push: pushResult, pull: pullResult };
}

async function pushPayloadToVault(epKey, payloadData) {
  try {
    const vc = await getVaultConfig();
    if (!vc.vaultUrl) return;

    const endpoints = await getEndpoints();
    const ep = endpoints[epKey] || {};

    const body = {
      type: 'payload',
      epKey,
      endpoint: {
        method: ep.method || epKey.split(' ')[0],
        pattern: ep.pattern || epKey.split(' ').slice(1).join(' '),
        domain: ep.domain || null,
        hitCount: ep.hitCount || 1,
        firstSeen: ep.firstSeen || null,
        lastSeen: ep.lastSeen || null,
        queryParams: ep.queryParams || [],
        statusCodes: ep.statusCodes || [],
        authType: ep.authType || 'none',
        apiStatus: ep.apiStatus || 'undocumented'
      },
      payload: {
        method: payloadData.method || null,
        url: payloadData.url || null,
        status: payloadData.status || null,
        contentType: payloadData.contentType || null,
        requestBody: payloadData.requestBody || null,
        responseBody: payloadData.responseBody || null,
        requestHeaders: payloadData.requestHeaders || null,
        responseHeaders: payloadData.responseHeaders || null,
        authHeaders: payloadData.authHeaders || null,
        capturedAt: payloadData.capturedAt || Date.now(),
        samples: payloadData.samples || null
      },
      source: 'ghl-endpoint-harvester',
      pushedAt: new Date().toISOString()
    };

    const resp = await fetch(vc.vaultUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(vc.vaultSecret ? { 'X-Secret': vc.vaultSecret } : {})
      },
      body: JSON.stringify(body)
    });

    vc.lastPushAt = Date.now();
    vc.lastPushStatus = resp.ok ? 'ok' : 'error';
    vc.pushCount = (vc.pushCount || 0) + 1;
    await chrome.storage.local.set({ vaultConfig: vc });
  } catch {
    try {
      const vc = await getVaultConfig();
      vc.lastPushStatus = 'error';
      vc.lastPushAt = Date.now();
      await chrome.storage.local.set({ vaultConfig: vc });
    } catch {}
  }
}

async function pushBulkToVault() {
  const vc = await getVaultConfig();
  if (!vc.vaultUrl) throw new Error('Vault URL not configured');

  const [endpoints, payloads] = await Promise.all([getEndpoints(), getPayloads()]);
  const bulkUrl = vc.vaultUrl.replace(/\/api\/ingest$/, '/api/ingest/bulk');

  const resp = await fetch(bulkUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(vc.vaultSecret ? { 'X-Secret': vc.vaultSecret } : {})
    },
    body: JSON.stringify({
      type: 'bulk',
      endpoints,
      payloads,
      source: 'ghl-endpoint-harvester',
      pushedAt: new Date().toISOString()
    })
  });

  vc.lastPushAt = Date.now();
  vc.lastPushStatus = resp.ok ? 'ok' : 'error';
  vc.pushCount = (vc.pushCount || 0) + 1;
  await chrome.storage.local.set({ vaultConfig: vc });

  if (!resp.ok) throw new Error(`Vault returned ${resp.status}`);
  return await resp.json();
}

// -------------------------------------------------------------------------
// Badge
// -------------------------------------------------------------------------

async function updateBadge() {
  try {
    const endpoints = await getEndpoints();
    const count = Object.keys(endpoints).length;
    const text = count > 0 ? (count > 999 ? '999+' : String(count)) : '';
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
  } catch (e) {
    console.warn('GHL Endpoint Harvester: badge update failed', e.message);
  }
}

// -------------------------------------------------------------------------
// Query param extraction
// -------------------------------------------------------------------------

function extractQueryParams(url) {
  try {
    const u = new URL(url);
    const params = [];
    for (const key of u.searchParams.keys()) {
      if (!params.includes(key)) params.push(key);
    }
    return params;
  } catch {
    return [];
  }
}

// -------------------------------------------------------------------------
// Core endpoint recording
// -------------------------------------------------------------------------

// In-memory write buffer to batch storage writes
let writeBuffer = {};
let writeTimer = null;

function scheduleFlush() {
  if (writeTimer) return;
  writeTimer = setTimeout(flushBuffer, 500);
}

async function flushBuffer() {
  writeTimer = null;
  if (Object.keys(writeBuffer).length === 0) return;

  const toFlush = writeBuffer;
  writeBuffer = {};

  const [endpoints, captureState, settings] = await Promise.all([
    getEndpoints(),
    getCaptureState(),
    getSettings()
  ]);

  let changed = false;

  for (const [epKey, update] of Object.entries(toFlush)) {
    const existing = endpoints[epKey];

    if (existing) {
      // Merge into existing
      existing.hitCount = (existing.hitCount || 1) + update.hitCount;
      existing.lastSeen = update.lastSeen;

      // Merge query params
      for (const p of update.queryParams) {
        if (!existing.queryParams.includes(p)) existing.queryParams.push(p);
      }

      // Merge status codes
      for (const sc of update.statusCodes) {
        if (!existing.statusCodes.includes(sc)) existing.statusCodes.push(sc);
      }

      // Keep last 3 sample URLs, deduped
      for (const su of update.sampleUrls) {
        if (!existing.sampleUrls.includes(su)) {
          existing.sampleUrls.unshift(su);
          if (existing.sampleUrls.length > 3) existing.sampleUrls.pop();
        }
      }

      // Auth type: prefer bearer > apikey > other > none
      if (update.authType === 'bearer') existing.authType = 'bearer';
      else if (update.authType === 'apikey' && existing.authType === 'none') existing.authType = 'apikey';

    } else {
      // Enforce max endpoints limit
      const currentCount = Object.keys(endpoints).length;
      if (currentCount >= (settings.maxEndpoints || 500)) continue;

      endpoints[epKey] = {
        method: update.method,
        pattern: update.pattern,
        domain: update.domain,
        hitCount: update.hitCount,
        firstSeen: update.firstSeen,
        lastSeen: update.lastSeen,
        sampleUrls: update.sampleUrls,
        queryParams: update.queryParams,
        statusCodes: update.statusCodes,
        authType: update.authType,
        apiStatus: classifyEndpoint(update.method, update.pattern),
        tags: [],
        notes: '',
        starred: false
      };
    }

    changed = true;
  }

  // Increment total requests
  captureState.totalRequests = (captureState.totalRequests || 0) + Object.values(toFlush).reduce((sum, u) => sum + u.hitCount, 0);

  if (changed) {
    await chrome.storage.local.set({ endpoints, captureState });
    updateBadge();
  } else {
    await chrome.storage.local.set({ captureState });
  }
}

function recordEndpoint({ method, url, headers, statusCode }) {
  if (shouldIgnore(url)) return;

  try {
    const u = new URL(url);
    const normalizedPath = normalizePath(u.pathname);
    const epKey = `${method} ${normalizedPath}`;
    const now = Date.now();
    const queryParams = extractQueryParams(url);
    const authType = detectAuthType(headers);
    const domain = u.hostname;

    if (writeBuffer[epKey]) {
      // Accumulate in buffer
      writeBuffer[epKey].hitCount++;
      writeBuffer[epKey].lastSeen = now;
      for (const p of queryParams) {
        if (!writeBuffer[epKey].queryParams.includes(p)) writeBuffer[epKey].queryParams.push(p);
      }
      if (statusCode && !writeBuffer[epKey].statusCodes.includes(statusCode)) {
        writeBuffer[epKey].statusCodes.push(statusCode);
      }
      if (!writeBuffer[epKey].sampleUrls.includes(url)) {
        writeBuffer[epKey].sampleUrls.unshift(url);
        if (writeBuffer[epKey].sampleUrls.length > 3) writeBuffer[epKey].sampleUrls.pop();
      }
      if (authType === 'bearer') writeBuffer[epKey].authType = 'bearer';
    } else {
      writeBuffer[epKey] = {
        method,
        pattern: normalizedPath,
        domain,
        hitCount: 1,
        firstSeen: now,
        lastSeen: now,
        sampleUrls: [url],
        queryParams,
        statusCodes: statusCode ? [statusCode] : [],
        authType
      };
    }

    scheduleFlush();
  } catch (e) {
    console.warn('GHL Endpoint Harvester: recordEndpoint error', e.message);
  }
}

// -------------------------------------------------------------------------
// In-flight request tracking (to correlate headers with status codes)
// -------------------------------------------------------------------------

// requestId -> { method, url, headers }
const inFlight = new Map();

// requestId -> { body, url, method, timestamp } - captured by onBeforeRequest
const requestBodies = new Map();

// -------------------------------------------------------------------------
// webRequest listeners
// -------------------------------------------------------------------------

async function setupListeners() {
  const settings = await getSettings();
  const captureState = await getCaptureState();

  // Build URL patterns from active domains
  const urlPatterns = settings.domains.flatMap(d => [
    `*://${d}/*`
  ]);

  // Capture request bodies for POST/PUT/PATCH/DELETE via webRequest (reliable fallback)
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(details.method)) return;
      if (shouldIgnore(details.url)) return;

      let body = null;
      if (details.requestBody?.raw) {
        try {
          const parts = details.requestBody.raw
            .filter(r => r.bytes)
            .map(r => new Uint8Array(r.bytes));
          if (parts.length > 0) {
            const total = parts.reduce((sum, p) => sum + p.length, 0);
            const combined = new Uint8Array(total);
            let offset = 0;
            for (const p of parts) { combined.set(p, offset); offset += p.length; }
            body = new TextDecoder().decode(combined);
            // Truncate large bodies (1 MB cap — workflow payloads can be huge)
            if (body.length > 1048576) body = body.substring(0, 1048576) + '...[TRUNCATED]';
          }
        } catch {}
      } else if (details.requestBody?.formData) {
        try { body = JSON.stringify(details.requestBody.formData); } catch {}
      }

      if (body) {
        requestBodies.set(details.requestId, {
          body,
          url: details.url,
          method: details.method,
          timestamp: Date.now()
        });
        // Evict old entries
        if (requestBodies.size > 1000) {
          const oldest = requestBodies.keys().next().value;
          requestBodies.delete(oldest);
        }
      }
    },
    { urls: urlPatterns },
    ['requestBody']
  );

  // Capture request headers (method + auth type)
  chrome.webRequest.onBeforeSendHeaders.addListener(
    async (details) => {
      // Check live capture state
      const state = await getCaptureState();
      if (!state.isCapturing) return;

      if (shouldIgnore(details.url)) return;

      // Store in-flight info for correlation with response
      inFlight.set(details.requestId, {
        method: details.method,
        url: details.url,
        headers: details.requestHeaders || []
      });

      // Clean up stale entries (older than 30s via size cap)
      if (inFlight.size > 2000) {
        const firstKey = inFlight.keys().next().value;
        inFlight.delete(firstKey);
      }
    },
    { urls: urlPatterns },
    ['requestHeaders', 'extraHeaders']
  );

  // Capture response status
  chrome.webRequest.onCompleted.addListener(
    async (details) => {
      const state = await getCaptureState();
      if (!state.isCapturing) return;

      if (shouldIgnore(details.url)) return;

      const inFlightEntry = inFlight.get(details.requestId);
      inFlight.delete(details.requestId);

      const method = inFlightEntry?.method || details.method || 'GET';
      const headers = inFlightEntry?.headers || [];

      recordEndpoint({
        method,
        url: details.url,
        headers,
        statusCode: details.statusCode || null
      });

      // If we captured a request body via onBeforeRequest, store as payload
      const bodyEntry = requestBodies.get(details.requestId);
      if (bodyEntry) {
        requestBodies.delete(details.requestId);
        try {
          const u = new URL(details.url);
          const normalizedPath = normalizePath(u.pathname);
          const epKey = `${method} ${normalizedPath}`;

          // Capture ALL request headers (with token redaction) so requests
          // can be replayed / inspected for workflow extraction.
          let requestHeaders = null;
          let authHeaders = null;
          if (headers && headers.length > 0) {
            const SENSITIVE = new Set(['authorization', 'token-id', 'x-api-key', 'api-key', 'cookie']);
            const AUTH_KEYS = new Set(['authorization', 'token-id', 'channel', 'source', 'version', 'x-api-key', 'version-control']);
            requestHeaders = {};
            const auth = {};
            for (const h of headers) {
              const name = h.name.toLowerCase();
              const val = h.value || '';
              const stored = SENSITIVE.has(name) && val.length > 60
                ? val.substring(0, 20) + '...' + val.substring(val.length - 10)
                : val;
              requestHeaders[name] = stored;
              if (AUTH_KEYS.has(name)) auth[name] = stored;
            }
            if (Object.keys(auth).length > 0) authHeaders = auth;
            if (Object.keys(requestHeaders).length === 0) requestHeaders = null;
          }

          storePayload(epKey, {
            method,
            url: details.url,
            status: details.statusCode || null,
            contentType: null,
            requestBody: bodyEntry.body,
            responseBody: null,
            requestHeaders,
            responseHeaders: null,
            authHeaders,
            timestamp: bodyEntry.timestamp
          });
        } catch {}
      }
    },
    { urls: urlPatterns }
  );

  // Also handle errors (still want to log the endpoint attempt)
  chrome.webRequest.onErrorOccurred.addListener(
    async (details) => {
      const state = await getCaptureState();
      if (!state.isCapturing) return;

      if (shouldIgnore(details.url)) return;

      const inFlightEntry = inFlight.get(details.requestId);
      inFlight.delete(details.requestId);

      const method = inFlightEntry?.method || details.method || 'GET';
      const headers = inFlightEntry?.headers || [];

      // Record with no status code (error)
      recordEndpoint({ method, url: details.url, headers, statusCode: null });
    },
    { urls: urlPatterns }
  );
}

// -------------------------------------------------------------------------
// Initialization
// -------------------------------------------------------------------------

async function init() {
  const settings = await getSettings();
  const stored = await chrome.storage.local.get('captureState');

  // Initialize capture state
  if (!stored.captureState) {
    const autoCapture = settings.autoCaptureOnStartup !== false;
    await chrome.storage.local.set({
      captureState: {
        isCapturing: autoCapture,
        startedAt: Date.now(),
        totalRequests: 0
      }
    });
  }

  await setupListeners();
  updateBadge();
}

init();

// -------------------------------------------------------------------------
// Message handler for popup
// -------------------------------------------------------------------------

// -------------------------------------------------------------------------
// Payload storage (response/request bodies)
// -------------------------------------------------------------------------

async function getPayloads() {
  const result = await chrome.storage.local.get('payloads');
  return result.payloads || {};
}

// -------------------------------------------------------------------------
// Workflow recipe extraction
// -------------------------------------------------------------------------

/**
 * Pull workflow IDs out of a URL — covers the patterns GHL uses internally:
 *   /workflows/{id}
 *   /workflows/v2/locations/{loc}/workflows/{id}
 *   /workflows/v2/locations/{loc}/workflows/{id}/builder
 *   ?workflowId={id}  /  ?id={id}
 * Returns the first ID found, or null.
 */
function extractWorkflowId(url) {
  if (!url) return null;
  try {
    const u = new URL(url, 'https://app.gohighlevel.com');
    // Path-based
    const m1 = u.pathname.match(/\/workflows\/(?:v\d+\/)?(?:locations\/[^/]+\/workflows\/)?([a-zA-Z0-9]{15,})/);
    if (m1) return m1[1];
    // Query-based
    const wid = u.searchParams.get('workflowId') || u.searchParams.get('id');
    if (wid && wid.length >= 15) return wid;
    return null;
  } catch {
    return null;
  }
}

/**
 * Try to pull a workflow ID out of a JSON request/response body — covers
 * cases where the URL doesn't carry it (e.g. POST .../workflows with body).
 */
function extractWorkflowIdFromBody(bodyStr) {
  if (!bodyStr || typeof bodyStr !== 'string') return null;
  // Cheap regex search - avoids parsing huge JSON
  const m = bodyStr.match(/"(?:workflowId|workflow_id|_id|id)"\s*:\s*"([a-zA-Z0-9]{15,})"/);
  return m ? m[1] : null;
}

/**
 * Build per-workflow deploy recipes from captured payloads.
 *
 * For each workflow ID found, returns:
 *   {
 *     workflowId,
 *     name (best-effort, parsed from response bodies),
 *     ops: [{ method, pattern, url, status, requestBody, responseBody, contentType, capturedAt }],
 *     create: <op or null>,   // POST that created/saved the workflow
 *     update: <op or null>,   // most recent PUT/PATCH
 *     read:   <op or null>,   // most recent GET (the canonical workflow shape)
 *     publish: <op or null>,  // any /publish op
 *     duplicate: <op or null> // any /duplicate op
 *   }
 *
 * Plus an "_orphans" bucket — interesting workflow-related ops where we
 * couldn't pin a specific workflow ID (e.g. listings, creates pre-id).
 */
async function buildWorkflowRecipes() {
  const payloads = await getPayloads();
  const recipes = {};
  const orphans = [];

  for (const [epKey, p] of Object.entries(payloads)) {
    const isWorkflowy =
      /workflow/i.test(epKey) ||
      /workflow/i.test(p.url || '') ||
      /workflow/i.test(p.pattern || '');

    if (!isWorkflowy) continue;

    const samples = p.samples && p.samples.length > 0 ? p.samples : [p];

    for (const s of samples) {
      const wid =
        extractWorkflowId(s.url) ||
        extractWorkflowIdFromBody(s.requestBody) ||
        extractWorkflowIdFromBody(s.responseBody);

      const op = {
        method: s.method,
        pattern: epKey.split(' ').slice(1).join(' '),
        url: s.url,
        status: s.status,
        contentType: s.contentType,
        requestBody: s.requestBody,
        responseBody: s.responseBody,
        requestHeaders: s.requestHeaders,
        responseHeaders: s.responseHeaders,
        authHeaders: s.authHeaders,
        capturedAt: s.capturedAt
      };

      if (!wid) {
        orphans.push(op);
        continue;
      }

      if (!recipes[wid]) {
        recipes[wid] = {
          workflowId: wid,
          name: null,
          ops: [],
          create: null,
          update: null,
          read: null,
          publish: null,
          duplicate: null
        };
      }
      const r = recipes[wid];
      r.ops.push(op);

      // Best-effort name extraction
      if (!r.name && s.responseBody) {
        const m = s.responseBody.match(/"name"\s*:\s*"([^"]{1,120})"/);
        if (m) r.name = m[1];
      }

      // Categorize by intent
      const path = (op.pattern || '').toLowerCase();
      const method = (op.method || '').toUpperCase();
      if (/\/publish/.test(path)) r.publish = r.publish || op;
      else if (/\/duplicate/.test(path)) r.duplicate = r.duplicate || op;
      else if (method === 'GET') {
        if (!r.read || (op.capturedAt > (r.read.capturedAt || 0))) r.read = op;
      } else if (method === 'POST') {
        if (!r.create || (op.capturedAt > (r.create.capturedAt || 0))) r.create = op;
      } else if (method === 'PUT' || method === 'PATCH') {
        if (!r.update || (op.capturedAt > (r.update.capturedAt || 0))) r.update = op;
      }
    }
  }

  // Sort each workflow's ops chronologically
  for (const r of Object.values(recipes)) {
    r.ops.sort((a, b) => (a.capturedAt || 0) - (b.capturedAt || 0));
  }

  return {
    workflows: recipes,
    orphans,
    workflowCount: Object.keys(recipes).length,
    orphanCount: orphans.length,
    generatedAt: new Date().toISOString()
  };
}

// How many distinct samples to keep per endpoint pattern.
// Different request bodies (create vs update vs filter variants) get
// preserved so workflow extraction has the full request shape coverage.
const MAX_SAMPLES_PER_ENDPOINT = 5;
const MAX_PAYLOAD_ENTRIES = 1000;

function sampleSignature(data) {
  // Hash request body shape so we only keep meaningfully different samples.
  const body = data.requestBody || '';
  const status = data.status || 0;
  // Cheap fingerprint: status + body length + first 200 chars
  return `${status}|${body.length}|${body.substring(0, 200)}`;
}

async function storePayload(epKey, data) {
  const payloads = await getPayloads();
  const existing = payloads[epKey];

  const newSample = {
    method: data.method,
    url: data.url,
    status: data.status,
    contentType: data.contentType,
    requestBody: data.requestBody || null,
    responseBody: data.responseBody || null,
    requestHeaders: data.requestHeaders || null,
    responseHeaders: data.responseHeaders || null,
    authHeaders: data.authHeaders || null,
    capturedAt: data.timestamp || Date.now()
  };

  // Maintain a samples[] array so multiple distinct request shapes survive.
  // Top-level fields mirror the latest sample for backward-compat with popup.
  let samples = existing?.samples ? [...existing.samples] : [];
  // If a previous entry existed without samples[], seed from its top-level fields.
  if (existing && samples.length === 0 && (existing.requestBody || existing.responseBody)) {
    samples.push({
      method: existing.method,
      url: existing.url,
      status: existing.status,
      contentType: existing.contentType,
      requestBody: existing.requestBody,
      responseBody: existing.responseBody,
      requestHeaders: existing.requestHeaders || null,
      responseHeaders: existing.responseHeaders || null,
      authHeaders: existing.authHeaders,
      capturedAt: existing.capturedAt
    });
  }

  const newSig = sampleSignature(newSample);
  const dupeIdx = samples.findIndex(s => sampleSignature(s) === newSig);
  if (dupeIdx >= 0) {
    samples.splice(dupeIdx, 1);
  }
  samples.unshift(newSample);
  if (samples.length > MAX_SAMPLES_PER_ENDPOINT) samples = samples.slice(0, MAX_SAMPLES_PER_ENDPOINT);

  payloads[epKey] = {
    ...newSample,
    samples,
    captureCount: (existing?.captureCount || 0) + 1
  };

  // Enforce storage limit: evict oldest endpoints
  const keys = Object.keys(payloads);
  if (keys.length > MAX_PAYLOAD_ENTRIES) {
    const sorted = keys.sort((a, b) => (payloads[a].capturedAt || 0) - (payloads[b].capturedAt || 0));
    const toRemove = sorted.slice(0, keys.length - MAX_PAYLOAD_ENTRIES);
    toRemove.forEach(k => delete payloads[k]);
  }

  await chrome.storage.local.set({ payloads });

  // Auto-push to vault if configured
  const vc = await getVaultConfig();
  if (vc.autoPush && vc.vaultUrl) {
    pushPayloadToVault(epKey, payloads[epKey]);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // Handle clipboard captures (Copy step / Copy workflow in GHL UI)
  // Stored as a synthetic payload entry so the existing UI surfaces it.
  if (msg.action === 'captureClipboard') {
    const data = msg.data;
    if (!data) return;
    try {
      // Synthetic key: CLIPBOARD <pagePath>  (groups copies per surface)
      const path = (data.pagePath || '/').replace(/\/{2,}/g, '/');
      const normalizedPath = normalizePath(path);
      const epKey = `CLIPBOARD ${normalizedPath}`;
      const now = data.timestamp || Date.now();

      // Register a sibling endpoint entry so the main list surfaces it
      getEndpoints().then(async (endpoints) => {
        const ep = endpoints[epKey];
        if (ep) {
          ep.hitCount = (ep.hitCount || 0) + 1;
          ep.lastSeen = now;
          if (ep.sampleUrls && data.pageUrl && !ep.sampleUrls.includes(data.pageUrl)) {
            ep.sampleUrls.unshift(data.pageUrl);
            if (ep.sampleUrls.length > 3) ep.sampleUrls.pop();
          }
        } else {
          endpoints[epKey] = {
            method: 'CLIPBOARD',
            pattern: normalizedPath,
            domain: 'app.gohighlevel.com',
            hitCount: 1,
            firstSeen: now,
            lastSeen: now,
            sampleUrls: data.pageUrl ? [data.pageUrl] : [],
            queryParams: [],
            statusCodes: [],
            authType: 'none',
            apiStatus: 'clipboard',
            tags: ['clipboard'],
            notes: '',
            starred: false
          };
        }
        await chrome.storage.local.set({ endpoints });
        updateBadge();
      });

      storePayload(epKey, {
        method: 'CLIPBOARD',
        url: data.pageUrl || null,
        status: 0,
        contentType: data.looksLikeJson ? 'application/json' : 'text/plain',
        // Treat the copied content as the request body so the popup shows it
        requestBody: data.content || null,
        responseBody: null,
        requestHeaders: null,
        responseHeaders: null,
        authHeaders: { source: data.source || 'clipboard' },
        timestamp: data.timestamp || Date.now()
      });
    } catch (e) {
      console.warn('GHL Payload Harvester: captureClipboard error', e.message);
    }
    return;
  }

  // Handle body captures from the interceptor (via bridge.js)
  // This supplements the webRequest body capture with response bodies
  if (msg.action === 'captureBody') {
    const data = msg.data;
    if (!data || !data.url) return;
    try {
      const u = new URL(data.url);
      const normalizedPath = normalizePath(u.pathname);
      const epKey = `${data.method} ${normalizedPath}`;

      // Merge with existing payload if webRequest already captured request body
      getPayloads().then(payloads => {
        const existing = payloads[epKey];
        if (existing && existing.requestBody && !data.requestBody) {
          // Keep the webRequest's request body, add the interceptor's response body
          data.requestBody = existing.requestBody;
        }
        storePayload(epKey, data);
      });
    } catch (e) {
      console.warn('GHL Endpoint Harvester: captureBody error', e.message);
    }
    return;
  }

  if (msg.action === 'getEndpoints') {
    getEndpoints().then(sendResponse);
    return true;
  }

  if (msg.action === 'getCaptureState') {
    getCaptureState().then(sendResponse);
    return true;
  }

  if (msg.action === 'toggleCapture') {
    getCaptureState().then(async (state) => {
      state.isCapturing = !state.isCapturing;
      if (state.isCapturing) {
        state.startedAt = Date.now();
        state.totalRequests = 0;
      }
      await chrome.storage.local.set({ captureState: state });
      sendResponse(state);
    });
    return true;
  }

  if (msg.action === 'starEndpoint') {
    getEndpoints().then(async (endpoints) => {
      if (endpoints[msg.key]) {
        endpoints[msg.key].starred = !endpoints[msg.key].starred;
        await chrome.storage.local.set({ endpoints });
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.action === 'noteEndpoint') {
    getEndpoints().then(async (endpoints) => {
      if (endpoints[msg.key]) {
        endpoints[msg.key].notes = msg.notes || '';
        await chrome.storage.local.set({ endpoints });
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.action === 'tagEndpoint') {
    getEndpoints().then(async (endpoints) => {
      if (endpoints[msg.key]) {
        const ep = endpoints[msg.key];
        if (msg.add && !ep.tags.includes(msg.add)) {
          ep.tags.push(msg.add);
        }
        if (msg.remove) {
          ep.tags = ep.tags.filter(t => t !== msg.remove);
        }
        await chrome.storage.local.set({ endpoints });
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.action === 'deleteEndpoint') {
    getEndpoints().then(async (endpoints) => {
      delete endpoints[msg.key];
      await chrome.storage.local.set({ endpoints });
      updateBadge();
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.action === 'clearAll') {
    chrome.storage.local.set({
      endpoints: {},
      captureState: {
        isCapturing: true,
        startedAt: Date.now(),
        totalRequests: 0
      }
    }).then(() => {
      updateBadge();
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.action === 'reclassifyAll') {
    getEndpoints().then(async (endpoints) => {
      let changed = 0;
      for (const [key, ep] of Object.entries(endpoints)) {
        const newStatus = classifyEndpoint(ep.method, ep.pattern);
        if (ep.apiStatus !== newStatus) {
          ep.apiStatus = newStatus;
          changed++;
        }
      }
      if (changed > 0) await chrome.storage.local.set({ endpoints });
      sendResponse({ ok: true, changed });
    });
    return true;
  }

  if (msg.action === 'exportEndpoints') {
    Promise.all([getEndpoints(), getSettings()]).then(([endpoints, settings]) => {
      sendResponse({ endpoints, format: msg.format || settings.exportFormat || 'json' });
    });
    return true;
  }

  if (msg.action === 'getPayloads') {
    getPayloads().then(sendResponse);
    return true;
  }

  if (msg.action === 'getPayload') {
    getPayloads().then(payloads => {
      sendResponse(payloads[msg.key] || null);
    });
    return true;
  }

  if (msg.action === 'clearPayloads') {
    chrome.storage.local.set({ payloads: {} }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.action === 'exportWorkflowRecipes') {
    buildWorkflowRecipes().then(sendResponse);
    return true;
  }

  if (msg.action === 'getSettings') {
    getSettings().then(sendResponse);
    return true;
  }

  if (msg.action === 'setSettings') {
    chrome.storage.local.set({ settings: msg.settings }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.action === 'getVaultConfig') {
    getVaultConfig().then(sendResponse);
    return true;
  }

  if (msg.action === 'setVaultConfig') {
    chrome.storage.local.set({ vaultConfig: msg.config }).then(async () => {
      await rescheduleSyncAlarm();
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.action === 'pushToVault') {
    pushBulkToVault()
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.action === 'pushSingleToVault') {
    pushPayloadToVault(msg.epKey, msg.payload)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.action === 'pullFromVault') {
    pullFromVault()
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.action === 'syncWithVault') {
    syncWithVault()
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.action === 'reschedSync') {
    rescheduleSyncAlarm()
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

// Periodic cleanup alarm: flush any remaining buffer
chrome.alarms.create('bufferFlush', { periodInMinutes: 1 });

// Auto-sync alarm — re-created whenever vault config changes
async function rescheduleSyncAlarm() {
  await chrome.alarms.clear('vaultSync');
  const vc = await getVaultConfig();
  if (vc.autoSync && vc.vaultUrl) {
    const minutes = Math.max(1, Number(vc.syncIntervalMinutes) || 5);
    chrome.alarms.create('vaultSync', { periodInMinutes: minutes, delayInMinutes: minutes });
    console.log(`[vault] auto-sync scheduled every ${minutes} min`);
  } else {
    console.log('[vault] auto-sync disabled');
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'bufferFlush') {
    if (Object.keys(writeBuffer).length > 0) flushBuffer();
    return;
  }
  if (alarm.name === 'vaultSync') {
    try {
      const result = await syncWithVault();
      console.log('[vault] auto-sync done', result);
    } catch (e) {
      console.warn('[vault] auto-sync failed:', e.message);
    }
  }
});

// Initialize the sync alarm on startup
rescheduleSyncAlarm().catch(() => {});
