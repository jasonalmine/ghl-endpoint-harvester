/**
 * GHL Endpoint Harvester - Popup UI
 */

// -------------------------------------------------------------------------
// Utilities
// -------------------------------------------------------------------------

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function timeAgo(ts) {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  const secs = Math.floor(diff / 1000);
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatDuration(ms) {
  if (ms < 0) ms = 0;
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) return `${hrs}h ${mins % 60}m`;
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}

function shortenDomain(domain) {
  return domain.replace('.leadconnectorhq.com', '.lcq').replace('.msgsndr.com', '.mss').replace('.gohighlevel.com', '.ghl');
}

function getStatusClass(code) {
  if (!code) return 'status-other';
  if (code >= 200 && code < 300) return 'status-2xx';
  if (code >= 300 && code < 400) return 'status-3xx';
  if (code >= 400 && code < 500) return 'status-4xx';
  if (code >= 500) return 'status-5xx';
  return 'status-other';
}

function buildCurlCommand(ep) {
  const key = `${ep.method} ${ep.pattern}`;
  const payload = allPayloads[key];

  const url = (payload && payload.url) || (ep.sampleUrls && ep.sampleUrls[0]) || `https://${ep.domain}${ep.pattern}`;
  let cmd = `curl -X ${ep.method} '${url}'`;

  // Use actual auth headers from payload if available
  if (payload && payload.authHeaders) {
    const authObj = typeof payload.authHeaders === 'string' ? JSON.parse(payload.authHeaders) : payload.authHeaders;
    for (const [name, value] of Object.entries(authObj)) {
      cmd += ` \\\n  -H '${name}: ${value}'`;
    }
  } else if (ep.authType === 'bearer') {
    cmd += ` \\\n  -H 'Authorization: Bearer YOUR_TOKEN'`;
  } else if (ep.authType === 'apikey') {
    cmd += ` \\\n  -H 'X-API-Key: YOUR_API_KEY'`;
  }

  if (['POST', 'PUT', 'PATCH'].includes(ep.method)) {
    cmd += ` \\\n  -H 'Content-Type: application/json'`;
    if (payload && payload.requestBody) {
      let body = payload.requestBody;
      try { body = JSON.stringify(JSON.parse(body)); } catch {}
      cmd += ` \\\n  -d '${body}'`;
    } else {
      cmd += ` \\\n  -d '{}'`;
    }
  }

  return cmd;
}

function buildPayloadCurlCommand(epKey, payload) {
  const method = epKey.split(' ')[0];
  const url = payload.url || '';
  let cmd = `curl -X ${method} '${url}'`;

  if (payload.authHeaders) {
    const authObj = typeof payload.authHeaders === 'string' ? JSON.parse(payload.authHeaders) : payload.authHeaders;
    for (const [name, value] of Object.entries(authObj)) {
      cmd += ` \\\n  -H '${name}: ${value}'`;
    }
  }

  if (['POST', 'PUT', 'PATCH'].includes(method)) {
    cmd += ` \\\n  -H 'Content-Type: application/json'`;
    if (payload.requestBody) {
      let body = payload.requestBody;
      try { body = JSON.stringify(JSON.parse(body)); } catch {}
      cmd += ` \\\n  -d '${body}'`;
    } else {
      cmd += ` \\\n  -d '{}'`;
    }
  }

  return cmd;
}

// -------------------------------------------------------------------------
// State
// -------------------------------------------------------------------------

let allEndpoints = {};
let allPayloads = {};
let captureState = { isCapturing: true, startedAt: Date.now(), totalRequests: 0 };
let settings = {};
let displayedCount = 50;
let starFilterActive = false;
let pendingNoteKeys = {};     // key -> debounce timer
let pendingDeleteKeys = {};   // key -> timeout id
let vaultConfig = {};
let lastOpenedAt = 0;

// -------------------------------------------------------------------------
// Filter + sort logic
// -------------------------------------------------------------------------

function getFilteredEntries() {
  const search = document.getElementById('searchInput').value.toLowerCase().trim();
  const method = document.getElementById('methodFilter').value;
  const domain = document.getElementById('domainFilter').value;
  const sort = document.getElementById('sortBy').value;

  let entries = Object.entries(allEndpoints);

  // Star filter
  if (starFilterActive) {
    entries = entries.filter(([, ep]) => ep.starred);
  }

  // Method filter
  if (method !== 'ALL') {
    entries = entries.filter(([, ep]) => ep.method === method);
  }

  // Domain filter
  if (domain !== 'ALL') {
    entries = entries.filter(([, ep]) => ep.domain === domain);
  }

  // API status filter
  const apiStatus = document.getElementById('apiStatusFilter').value;
  if (apiStatus !== 'ALL') {
    entries = entries.filter(([, ep]) => (ep.apiStatus || 'undocumented') === apiStatus);
  }

  // Search filter
  if (search) {
    entries = entries.filter(([key, ep]) => {
      return (
        key.toLowerCase().includes(search) ||
        (ep.pattern || '').toLowerCase().includes(search) ||
        (ep.domain || '').toLowerCase().includes(search) ||
        (ep.notes || '').toLowerCase().includes(search) ||
        (ep.tags || []).some(t => t.toLowerCase().includes(search))
      );
    });
  }

  // Sort
  entries.sort(([, a], [, b]) => {
    if (sort === 'recent') return (b.lastSeen || 0) - (a.lastSeen || 0);
    if (sort === 'hits') return (b.hitCount || 0) - (a.hitCount || 0);
    if (sort === 'alpha') return (a.pattern || '').localeCompare(b.pattern || '');
    if (sort === 'category') return (a.pattern || '').localeCompare(b.pattern || '');
    return 0;
  });

  return entries;
}

// -------------------------------------------------------------------------
// Domain filter population
// -------------------------------------------------------------------------

function populateDomainFilter() {
  const select = document.getElementById('domainFilter');
  const current = select.value;
  const domains = new Set();
  for (const ep of Object.values(allEndpoints)) {
    if (ep.domain) domains.add(ep.domain);
  }

  // Rebuild options
  while (select.options.length > 1) select.remove(1);
  for (const d of [...domains].sort()) {
    const opt = document.createElement('option');
    opt.value = d;
    opt.textContent = d;
    select.appendChild(opt);
  }

  // Restore selection if still valid
  if (current !== 'ALL' && domains.has(current)) select.value = current;
}

// -------------------------------------------------------------------------
// Endpoint card rendering
// -------------------------------------------------------------------------

function renderEndpointCard([key, ep]) {
  const statusTagsHtml = (ep.statusCodes || []).map(sc => {
    return `<span class="status-tag ${getStatusClass(sc)}">${escapeHtml(String(sc))}</span>`;
  }).join('');

  const paramTagsHtml = (ep.queryParams || []).map(p => {
    return `<span class="param-tag">${escapeHtml(p)}</span>`;
  }).join('');

  const authClass = `auth-${ep.authType || 'none'}`;
  const authLabel = ep.authType === 'bearer' ? 'Bearer JWT' :
                    ep.authType === 'apikey' ? 'API Key' :
                    ep.authType === 'basic'  ? 'Basic' :
                    ep.authType === 'other'  ? 'Auth' : 'No Auth';

  const userTagsHtml = (ep.tags || []).map(t => {
    return `<span class="user-tag" data-remove-tag="${escapeHtml(key)}" data-tag-val="${escapeHtml(t)}">${escapeHtml(t)} &times;</span>`;
  }).join('');

  const notesHtml = ep.notes
    ? `<div style="font-size:11px;color:#666;margin-top:4px;padding:3px 6px;background:#111;border-radius:3px;border-left:2px solid #333;">${escapeHtml(ep.notes)}</div>`
    : '';

  const isNew = ep.firstSeen && ep.firstSeen > lastOpenedAt;

  return `
    <div class="ep-card ${ep.starred ? 'starred' : ''}" data-key="${escapeHtml(key)}">
      <div class="ep-card-top">
        <span class="method-badge method-${escapeHtml(ep.method)}">${escapeHtml(ep.method)}</span>
        <span class="ep-path">${escapeHtml(ep.pattern || key.split(' ').slice(1).join(' '))}</span>
        ${isNew ? '<span class="new-badge">NEW</span>' : ''}
        ${allPayloads[key] ? '<span class="has-payload-dot" title="Payload captured"></span>' : ''}
      </div>

      <div class="ep-meta">
        <span class="meta-item">
          <strong>${escapeHtml(ep.domain || '')}</strong>
        </span>
        <span class="meta-item">
          Hits: <span class="highlight">${escapeHtml(String(ep.hitCount || 1))}</span>
        </span>
        <span class="meta-item">
          First: <strong>${timeAgo(ep.firstSeen)}</strong>
        </span>
        <span class="meta-item">
          Last: <strong>${timeAgo(ep.lastSeen)}</strong>
        </span>
        <span class="auth-tag ${authClass}">${escapeHtml(authLabel)}</span>
        <span class="api-status-tag api-status-${escapeHtml(ep.apiStatus || 'undocumented')}">${escapeHtml(ep.apiStatus || 'undocumented')}</span>
      </div>

      ${statusTagsHtml ? `<div style="margin-bottom:4px;">${statusTagsHtml}</div>` : ''}

      ${paramTagsHtml ? `
        <div class="ep-params">
          <span style="color:#555;margin-right:3px;">params:</span>${paramTagsHtml}
        </div>
      ` : ''}

      ${notesHtml}

      ${userTagsHtml ? `<div class="ep-tags">${userTagsHtml}</div>` : ''}

      <div class="ep-actions">
        <button class="btn icon-btn ${ep.starred ? 'active-filter' : ''}" data-star="${escapeHtml(key)}" title="${ep.starred ? 'Unstar' : 'Star'}">
          ${ep.starred ? '&#9733;' : '&#9734;'}
        </button>
        <button class="btn icon-btn" data-copy-curl="${escapeHtml(key)}" title="Copy cURL command">cURL</button>
        <button class="btn icon-btn" data-copy-path="${escapeHtml(key)}" title="Copy path pattern">Path</button>
        <button class="btn icon-btn" data-notes-toggle="${escapeHtml(key)}" title="Add/edit notes">Notes</button>
        <button class="btn icon-btn" data-add-tag="${escapeHtml(key)}" title="Add tag">+ Tag</button>
        ${allPayloads[key] ? `<button class="btn icon-btn" data-view-payload="${escapeHtml(key)}" title="View captured payload" style="color:#a855f7;">Body</button>` : ''}
        <button class="btn icon-btn danger" data-delete="${escapeHtml(key)}" title="Delete endpoint">Del</button>
        <span class="inline-feedback" id="fb-${escapeHtml(key)}"></span>
      </div>

      <div class="notes-area" id="notes-${escapeHtml(key)}">
        <textarea
          class="notes-input"
          placeholder="Add notes about this endpoint..."
          data-note-key="${escapeHtml(key)}"
        >${escapeHtml(ep.notes || '')}</textarea>
      </div>
    </div>
  `;
}

// -------------------------------------------------------------------------
// Main render
// -------------------------------------------------------------------------

function renderEndpoints() {
  const list = document.getElementById('epList');

  // Skip re-render if a notes textarea is focused
  if (list.querySelector('.notes-input:focus')) return;

  const filtered = getFilteredEntries();

  // Update header badge
  const total = Object.keys(allEndpoints).length;
  document.getElementById('epCountBadge').textContent =
    `${total} endpoint${total !== 1 ? 's' : ''}`;

  if (filtered.length === 0) {
    const isEmpty = Object.keys(allEndpoints).length === 0;
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">&#x25CE;</div>
        <div>${isEmpty ? 'No endpoints captured yet.' : 'No endpoints match your filters.'}</div>
        ${isEmpty ? `<p>Open GoHighLevel and navigate around.<br>API calls will appear here automatically.</p>` : ''}
      </div>
    `;
    document.getElementById('showMoreBar').style.display = 'none';
    return;
  }

  const toRender = filtered.slice(0, displayedCount);
  const remaining = filtered.length - toRender.length;

  const sort = document.getElementById('sortBy').value;
  if (sort === 'category') {
    // Group by first path segment
    const groups = {};
    for (const entry of toRender) {
      const pattern = entry[1].pattern || entry[0].split(' ').slice(1).join(' ');
      const segments = pattern.replace(/^\//, '').split('/');
      const category = segments[0] || 'other';
      if (!groups[category]) groups[category] = [];
      groups[category].push(entry);
    }
    const sortedCategories = Object.keys(groups).sort();
    const parts = [];
    for (const cat of sortedCategories) {
      const items = groups[cat];
      const headerDiv = document.createElement('div');
      headerDiv.className = 'category-header';
      const nameSpan = document.createElement('span');
      nameSpan.textContent = cat;
      const countSpan = document.createElement('span');
      countSpan.className = 'category-count';
      countSpan.textContent = items.length + ' endpoint' + (items.length !== 1 ? 's' : '');
      headerDiv.appendChild(nameSpan);
      headerDiv.appendChild(countSpan);
      parts.push(headerDiv.outerHTML);
      parts.push(items.map(renderEndpointCard).join(''));
    }
    list.innerHTML = parts.join('');
  } else {
    list.innerHTML = toRender.map(renderEndpointCard).join('');
  }

  // Show more bar
  const showMoreBar = document.getElementById('showMoreBar');
  if (remaining > 0) {
    showMoreBar.style.display = '';
    document.getElementById('showMoreBtn').textContent = `Show ${Math.min(50, remaining)} more`;
    document.getElementById('showMoreCount').textContent =
      `${filtered.length - displayedCount} more hidden`;
  } else {
    showMoreBar.style.display = 'none';
  }

  bindCardActions(list);
}

// -------------------------------------------------------------------------
// Card action binding
// -------------------------------------------------------------------------

function showFeedback(key, text, duration = 1500) {
  const el = document.getElementById(`fb-${key}`);
  if (!el) return;
  el.textContent = text;
  el.style.display = 'inline';
  setTimeout(() => { if (el) el.style.display = 'none'; }, duration);
}

function bindCardActions(list) {
  // Star toggle
  list.querySelectorAll('[data-star]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const key = e.currentTarget.dataset.star;
      await chrome.runtime.sendMessage({ action: 'starEndpoint', key });
      await loadData();
    });
  });

  // Copy cURL
  list.querySelectorAll('[data-copy-curl]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const key = e.currentTarget.dataset.copyCurl;
      const ep = allEndpoints[key];
      if (!ep) return;
      await navigator.clipboard.writeText(buildCurlCommand(ep));
      showFeedback(key, 'cURL copied!');
    });
  });

  // Copy path
  list.querySelectorAll('[data-copy-path]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const key = e.currentTarget.dataset.copyPath;
      const ep = allEndpoints[key];
      if (!ep) return;
      await navigator.clipboard.writeText(ep.pattern || '');
      showFeedback(key, 'Path copied!');
    });
  });

  // Notes toggle
  list.querySelectorAll('[data-notes-toggle]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const key = e.currentTarget.dataset.notesToggle;
      const area = document.getElementById(`notes-${key}`);
      if (!area) return;
      const isOpen = area.classList.contains('open');
      area.classList.toggle('open', !isOpen);
      if (!isOpen) area.querySelector('textarea')?.focus();
    });
  });

  // Notes input (debounced save)
  list.querySelectorAll('.notes-input').forEach(textarea => {
    textarea.addEventListener('input', (e) => {
      const key = e.target.dataset.noteKey;
      const notes = e.target.value;
      if (pendingNoteKeys[key]) clearTimeout(pendingNoteKeys[key]);
      pendingNoteKeys[key] = setTimeout(async () => {
        delete pendingNoteKeys[key];
        await chrome.runtime.sendMessage({ action: 'noteEndpoint', key, notes });
        // Update local state without full re-render
        if (allEndpoints[key]) allEndpoints[key].notes = notes;
      }, 600);
    });
  });

  // Add tag
  list.querySelectorAll('[data-add-tag]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const key = e.currentTarget.dataset.addTag;
      const tag = prompt('Tag name:');
      if (!tag || !tag.trim()) return;
      await chrome.runtime.sendMessage({ action: 'tagEndpoint', key, add: tag.trim() });
      await loadData();
    });
  });

  // Remove tag
  list.querySelectorAll('[data-remove-tag]').forEach(span => {
    span.addEventListener('click', async (e) => {
      const key = e.currentTarget.dataset.removeTag;
      const tag = e.currentTarget.dataset.tagVal;
      await chrome.runtime.sendMessage({ action: 'tagEndpoint', key, remove: tag });
      await loadData();
    });
  });

  // View payload
  list.querySelectorAll('[data-view-payload]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const key = e.currentTarget.dataset.viewPayload;
      const payload = allPayloads[key];
      if (!payload) return;

      // Toggle existing preview
      const card = e.currentTarget.closest('.ep-card');
      const existing = card.querySelector('.payload-body-preview');
      if (existing) {
        existing.remove();
        return;
      }

      // Format response body
      let bodyDisplay = payload.responseBody || 'No body captured';
      try {
        const parsed = JSON.parse(bodyDisplay);
        bodyDisplay = JSON.stringify(parsed, null, 2);
      } catch {}

      const preview = document.createElement('div');
      preview.className = 'payload-body-preview';
      preview.textContent = bodyDisplay;

      // Add copy button
      const copyBtn = document.createElement('button');
      copyBtn.className = 'payload-toggle-btn';
      copyBtn.textContent = 'Copy Response';
      copyBtn.style.marginTop = '6px';
      copyBtn.addEventListener('click', async () => {
        await navigator.clipboard.writeText(bodyDisplay);
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy Response'; }, 1500);
      });

      const wrapper = document.createElement('div');
      wrapper.style.marginTop = '8px';

      if (payload.requestBody) {
        const reqLabel = document.createElement('div');
        reqLabel.style.cssText = 'font-size:10px;color:#666;margin-bottom:2px;';
        reqLabel.textContent = 'Request Body:';
        const reqPreview = document.createElement('div');
        reqPreview.className = 'payload-body-preview';
        reqPreview.style.maxHeight = '100px';
        let reqDisplay = payload.requestBody;
        try { reqDisplay = JSON.stringify(JSON.parse(reqDisplay), null, 2); } catch {}
        reqPreview.textContent = reqDisplay;
        wrapper.appendChild(reqLabel);
        wrapper.appendChild(reqPreview);
      }

      const resLabel = document.createElement('div');
      resLabel.style.cssText = 'font-size:10px;color:#666;margin-bottom:2px;margin-top:6px;';
      resLabel.textContent = `Response Body (${payload.status}):`;
      wrapper.appendChild(resLabel);
      wrapper.appendChild(preview);
      wrapper.appendChild(copyBtn);
      card.appendChild(wrapper);
    });
  });

  // Delete
  list.querySelectorAll('[data-delete]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const key = e.currentTarget.dataset.delete;
      if (pendingDeleteKeys[key]) {
        clearTimeout(pendingDeleteKeys[key]);
        delete pendingDeleteKeys[key];
        await chrome.runtime.sendMessage({ action: 'deleteEndpoint', key });
        await loadData();
      } else {
        const origText = btn.textContent;
        btn.textContent = 'Sure?';
        btn.style.background = '#6b1a1a';
        btn.style.borderColor = '#aa3a3a';
        pendingDeleteKeys[key] = setTimeout(() => {
          delete pendingDeleteKeys[key];
          if (btn.isConnected) {
            btn.textContent = origText;
            btn.style.background = '';
            btn.style.borderColor = '';
          }
        }, 3000);
      }
    });
  });
}

// -------------------------------------------------------------------------
// Stats tab
// -------------------------------------------------------------------------

function renderStats() {
  const entries = Object.values(allEndpoints);
  const total = entries.length;
  const totalHits = entries.reduce((s, e) => s + (e.hitCount || 1), 0);

  document.getElementById('statTotalEndpoints').textContent = total;
  document.getElementById('statTotalRequests').textContent =
    captureState.totalRequests || totalHits;

  // Duration
  const duration = captureState.startedAt
    ? Date.now() - captureState.startedAt
    : 0;
  document.getElementById('statDuration').textContent = formatDuration(duration);

  // API status breakdown
  const officialCount = entries.filter(e => e.apiStatus === 'official').length;
  const undocumentedCount = entries.filter(e => e.apiStatus === 'undocumented').length;
  const preflightCount = entries.filter(e => e.apiStatus === 'preflight').length;

  const statusBreakdownEl = document.getElementById('apiStatusBreakdown');
  if (statusBreakdownEl) {
    statusBreakdownEl.innerHTML = `
      <div style="display:flex;gap:12px;margin-bottom:10px;">
        <span class="api-status-tag api-status-undocumented" style="font-size:11px;padding:3px 8px;">Undocumented: ${undocumentedCount}</span>
        <span class="api-status-tag api-status-official" style="font-size:11px;padding:3px 8px;">Official: ${officialCount}</span>
        <span class="api-status-tag api-status-preflight" style="font-size:11px;padding:3px 8px;">Preflight: ${preflightCount}</span>
      </div>
    `;
  }

  // Method breakdown
  const methodCounts = {};
  for (const ep of entries) {
    methodCounts[ep.method] = (methodCounts[ep.method] || 0) + 1;
  }
  const methodOrder = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
  const maxMethod = Math.max(1, ...Object.values(methodCounts));
  const methodBarsEl = document.getElementById('methodBars');
  methodBarsEl.innerHTML = methodOrder.map(m => {
    const count = methodCounts[m] || 0;
    if (!count) return '';
    const pct = Math.round((count / maxMethod) * 100);
    return `
      <div class="bar-row">
        <div class="bar-label">${escapeHtml(m)}</div>
        <div class="bar-track"><div class="bar-fill ${escapeHtml(m)}" style="width:${pct}%"></div></div>
        <div class="bar-count">${count}</div>
      </div>
    `;
  }).join('');

  // Domain breakdown
  const domainCounts = {};
  for (const ep of entries) {
    domainCounts[ep.domain || 'unknown'] = (domainCounts[ep.domain || 'unknown'] || 0) + 1;
  }
  const maxDomain = Math.max(1, ...Object.values(domainCounts));
  const domainBarsEl = document.getElementById('domainBars');
  domainBarsEl.innerHTML = Object.entries(domainCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([d, count]) => {
      const pct = Math.round((count / maxDomain) * 100);
      return `
        <div class="bar-row">
          <div class="bar-label" style="font-size:10px;color:#777;" title="${escapeHtml(d)}">${escapeHtml(shortenDomain(d))}</div>
          <div class="bar-track"><div class="bar-fill domain" style="width:${pct}%"></div></div>
          <div class="bar-count">${count}</div>
        </div>
      `;
    }).join('');

  // Top 10 endpoints
  const top10 = [...entries]
    .sort((a, b) => (b.hitCount || 1) - (a.hitCount || 1))
    .slice(0, 10);

  const topEl = document.getElementById('topEndpoints');
  topEl.innerHTML = top10.map(ep => `
    <div class="top-ep-row">
      <span class="top-ep-method method-badge method-${escapeHtml(ep.method)}">${escapeHtml(ep.method)}</span>
      <span class="top-ep-path" title="${escapeHtml(ep.pattern)}">${escapeHtml(ep.pattern)}</span>
      <span class="top-ep-hits">${ep.hitCount || 1}x</span>
    </div>
  `).join('') || '<div style="color:#555;font-size:12px;">No data yet.</div>';
}

// -------------------------------------------------------------------------
// Settings
// -------------------------------------------------------------------------

function renderSettingsDomains(domains) {
  const list = document.getElementById('domainsList');
  list.innerHTML = domains.map((d, i) => `
    <div class="domain-row" data-domain-index="${i}">
      <input type="text" value="${escapeHtml(d)}" class="domain-input" />
      <button class="btn icon-btn danger" data-remove-domain="${i}">x</button>
    </div>
  `).join('');

  list.querySelectorAll('[data-remove-domain]').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.closest('.domain-row').remove();
    });
  });
}

async function loadSettings() {
  settings = await chrome.runtime.sendMessage({ action: 'getSettings' });
  document.getElementById('autoCapture').checked = settings.autoCaptureOnStartup !== false;
  document.getElementById('maxEndpoints').value = settings.maxEndpoints || 500;
  document.getElementById('exportFormat').value = settings.exportFormat || 'json';
  renderSettingsDomains(settings.domains || []);
  await loadVaultConfig();
}

// -------------------------------------------------------------------------
// Vault config
// -------------------------------------------------------------------------

async function loadVaultConfig() {
  vaultConfig = await chrome.runtime.sendMessage({ action: 'getVaultConfig' });
  document.getElementById('vaultAutoPush').checked = vaultConfig.autoPush || false;
  document.getElementById('vaultUrl').value = vaultConfig.vaultUrl || '';
  document.getElementById('vaultSecret').value = vaultConfig.vaultSecret || '';
  updateVaultStatus();

  const pushBtn = document.getElementById('pushVaultBtn');
  pushBtn.style.display = vaultConfig.vaultUrl ? '' : 'none';
}

function updateVaultStatus() {
  const dot = document.getElementById('vaultDot');
  const text = document.getElementById('vaultStatusText');
  const countEl = document.getElementById('vaultPushCount');

  if (!vaultConfig.vaultUrl) {
    dot.className = 'vault-dot none';
    text.textContent = 'Not configured';
    countEl.textContent = '';
    return;
  }

  if (vaultConfig.lastPushStatus === 'ok') {
    dot.className = 'vault-dot ok';
    text.textContent = 'Synced ' + timeAgo(vaultConfig.lastPushAt);
  } else if (vaultConfig.lastPushStatus === 'error') {
    dot.className = 'vault-dot error';
    text.textContent = 'Failed ' + timeAgo(vaultConfig.lastPushAt);
  } else {
    dot.className = 'vault-dot none';
    text.textContent = 'Never pushed';
  }

  countEl.textContent = vaultConfig.pushCount > 0 ? (vaultConfig.pushCount + ' pushes') : '';
}

// -------------------------------------------------------------------------
// Export
// -------------------------------------------------------------------------

function generateMarkdown(endpoints) {
  const allEps = Object.entries(endpoints);
  const undocumented = allEps.filter(([, ep]) => ep.apiStatus === 'undocumented');
  const official = allEps.filter(([, ep]) => ep.apiStatus === 'official');
  const preflight = allEps.filter(([, ep]) => ep.apiStatus === 'preflight' || ep.method === 'OPTIONS');

  const lines = [
    '# GHL Captured Endpoints',
    `Captured: ${new Date().toISOString().split('T')[0]}`,
    `Total: ${allEps.length} unique endpoints (${undocumented.length} undocumented, ${official.length} official, ${preflight.length} preflight)`,
    ''
  ];

  const methodOrder = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

  function renderSection(title, entries) {
    if (entries.length === 0) return;
    lines.push(`# ${title}`);
    lines.push('');

    const byMethod = {};
    for (const [, ep] of entries) {
      if (!byMethod[ep.method]) byMethod[ep.method] = [];
      byMethod[ep.method].push(ep);
    }

    for (const method of methodOrder) {
      const eps = byMethod[method];
      if (!eps || eps.length === 0) continue;
      eps.sort((a, b) => (a.pattern || '').localeCompare(b.pattern || ''));

      lines.push(`## ${method} Endpoints`);
      lines.push('');
      lines.push('| Path | Domain | Hits | Query Params | Status Codes | Auth |');
      lines.push('|------|--------|------|-------------|--------------|------|');
      for (const ep of eps) {
        const params = (ep.queryParams || []).join(', ') || '-';
        const codes = (ep.statusCodes || []).join(', ') || '-';
        lines.push(
          `| \`${ep.pattern}\` | ${ep.domain} | ${ep.hitCount || 1} | ${params} | ${codes} | ${ep.authType || 'none'} |`
        );
      }
      lines.push('');
    }
  }

  renderSection('Undocumented Endpoints', undocumented);
  renderSection('Official API v2 Endpoints', official);
  // Skip preflight in markdown export (just noise)

  return lines.join('\n');
}

async function doExport() {
  const resp = await chrome.runtime.sendMessage({ action: 'exportEndpoints' });
  const { endpoints, format } = resp;
  const fmt = document.getElementById('exportFormat')?.value || format || 'json';

  let content;
  let filename;

  if (fmt === 'markdown') {
    content = generateMarkdown(endpoints);
    filename = `ghl-endpoints-${Date.now()}.md`;
  } else {
    content = JSON.stringify({
      exportedAt: new Date().toISOString(),
      totalEndpoints: Object.keys(endpoints).length,
      captureState,
      endpoints
    }, null, 2);
    filename = `ghl-endpoints-${Date.now()}.json`;
  }

  // Download as file
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// -------------------------------------------------------------------------
// Data loading
// -------------------------------------------------------------------------

// -------------------------------------------------------------------------
// Payloads tab
// -------------------------------------------------------------------------

function renderPayloads() {
  const list = document.getElementById('payloadList');
  const search = (document.getElementById('payloadSearch')?.value || '').toLowerCase().trim();

  let entries = Object.entries(allPayloads);

  if (search) {
    entries = entries.filter(([key, p]) =>
      key.toLowerCase().includes(search) ||
      (p.url || '').toLowerCase().includes(search)
    );
  }

  // Sort by most recent
  entries.sort(([, a], [, b]) => (b.capturedAt || 0) - (a.capturedAt || 0));

  if (entries.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">&#x25CE;</div>
        <div>${Object.keys(allPayloads).length === 0 ? 'No payloads captured yet.' : 'No payloads match your search.'}</div>
        <p>Navigate GoHighLevel to capture API response bodies.<br>Workflows, funnels, contacts, and more are captured automatically.</p>
      </div>
    `;
    return;
  }

  list.innerHTML = entries.map(([key, p]) => {
    const method = key.split(' ')[0];
    const pattern = key.split(' ').slice(1).join(' ');
    let bodySize = '0';
    if (p.responseBody) {
      const len = p.responseBody.length;
      bodySize = len > 1024 ? `${(len / 1024).toFixed(1)}KB` : `${len}B`;
    }

    return `
      <div class="payload-card" data-payload-key="${escapeHtml(key)}">
        <div class="payload-header">
          <span class="method-badge method-${escapeHtml(method)}">${escapeHtml(method)}</span>
          <span class="ep-path" style="font-size:12px;">${escapeHtml(pattern)}</span>
        </div>
        <div class="payload-meta">
          Status: <strong>${p.status || '?'}</strong> |
          Size: <strong>${bodySize}</strong> |
          Captures: <strong>${p.captureCount || 1}</strong> |
          Last: <strong>${timeAgo(p.capturedAt)}</strong>
          ${p.requestBody ? ' | <span style="color:#a855f7;">Has request body</span>' : ''}
        </div>
        <div style="display:flex;gap:6px;">
          <button class="payload-toggle-btn" data-toggle-payload="${escapeHtml(key)}">View Response</button>
          ${p.requestBody ? `<button class="payload-toggle-btn" data-toggle-req="${escapeHtml(key)}">View Request</button>` : ''}
          <button class="payload-toggle-btn" data-copy-payload="${escapeHtml(key)}">Copy Response</button>
          <button class="payload-toggle-btn" data-copy-pcurl="${escapeHtml(key)}">Copy cURL</button>
        </div>
        <div class="payload-expand" id="pe-${escapeHtml(key)}" style="display:none;"></div>
      </div>
    `;
  }).join('');

  // Bind payload actions
  list.querySelectorAll('[data-toggle-payload]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const key = e.currentTarget.dataset.togglePayload;
      const container = document.getElementById('pe-' + key);
      if (container.style.display !== 'none') {
        container.style.display = 'none';
        return;
      }
      const p = allPayloads[key];
      let body = p?.responseBody || 'No body';
      try { body = JSON.stringify(JSON.parse(body), null, 2); } catch {}
      container.innerHTML = `<div class="payload-body-preview">${escapeHtml(body)}</div>`;
      container.style.display = 'block';
    });
  });

  list.querySelectorAll('[data-toggle-req]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const key = e.currentTarget.dataset.toggleReq;
      const container = document.getElementById('pe-' + key);
      if (container.style.display !== 'none' && container.dataset.showing === 'req') {
        container.style.display = 'none';
        return;
      }
      const p = allPayloads[key];
      let body = p?.requestBody || 'No request body';
      try { body = JSON.stringify(JSON.parse(body), null, 2); } catch {}
      container.innerHTML = `<div class="payload-body-preview">${escapeHtml(body)}</div>`;
      container.style.display = 'block';
      container.dataset.showing = 'req';
    });
  });

  list.querySelectorAll('[data-copy-payload]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const key = e.currentTarget.dataset.copyPayload;
      const p = allPayloads[key];
      let body = p?.responseBody || '';
      try { body = JSON.stringify(JSON.parse(body), null, 2); } catch {}
      await navigator.clipboard.writeText(body);
      e.currentTarget.textContent = 'Copied!';
      setTimeout(() => { e.currentTarget.textContent = 'Copy Response'; }, 1500);
    });
  });

  list.querySelectorAll('[data-copy-pcurl]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const key = e.currentTarget.dataset.copyPcurl;
      const p = allPayloads[key];
      if (!p) return;
      const curl = buildPayloadCurlCommand(key, p);
      await navigator.clipboard.writeText(curl);
      e.currentTarget.textContent = 'Copied!';
      setTimeout(() => { e.currentTarget.textContent = 'Copy cURL'; }, 1500);
    });
  });
}

async function loadData() {
  const [eps, state, payloads] = await Promise.all([
    chrome.runtime.sendMessage({ action: 'getEndpoints' }),
    chrome.runtime.sendMessage({ action: 'getCaptureState' }),
    chrome.runtime.sendMessage({ action: 'getPayloads' })
  ]);

  allEndpoints = eps || {};
  allPayloads = payloads || {};
  captureState = state || { isCapturing: true, startedAt: Date.now(), totalRequests: 0 };

  // Update capture toggle UI
  const isCapturing = captureState.isCapturing;
  const toggleBtn = document.getElementById('toggleCaptureBtn');
  const dot = document.getElementById('captureDot');
  const label = document.getElementById('captureLabel');

  toggleBtn.textContent = isCapturing ? 'Pause' : 'Resume';
  toggleBtn.classList.toggle('paused', !isCapturing);
  dot.classList.toggle('paused', !isCapturing);
  label.textContent = isCapturing ? 'capturing' : 'paused';
  label.style.color = isCapturing ? '#4ade80' : '#ef4444';

  // Footer
  document.getElementById('footerTime').textContent =
    `Updated ${new Date().toLocaleTimeString()}`;
  document.getElementById('footerReqCount').textContent =
    `${captureState.totalRequests || 0} total requests`;

  populateDomainFilter();

  // Update header vault indicator
  const headerVaultEl = document.getElementById('headerVaultStatus');
  const headerVaultDot = document.getElementById('headerVaultDot');
  const headerVaultLabel = document.getElementById('headerVaultLabel');
  if (headerVaultEl && vaultConfig.vaultUrl) {
    headerVaultEl.style.display = '';
    if (vaultConfig.lastPushStatus === 'ok') {
      headerVaultDot.className = 'vault-dot ok';
      headerVaultLabel.style.color = '#4ade80';
    } else if (vaultConfig.lastPushStatus === 'error') {
      headerVaultDot.className = 'vault-dot error';
      headerVaultLabel.style.color = '#ef4444';
    } else {
      headerVaultDot.className = 'vault-dot none';
      headerVaultLabel.style.color = '#666';
    }
  } else if (headerVaultEl) {
    headerVaultEl.style.display = 'none';
  }

  // Render active panel
  const activeTab = document.querySelector('.tab.active')?.dataset?.tab;
  if (activeTab === 'endpoints' || !activeTab) {
    renderEndpoints();
  } else if (activeTab === 'payloads') {
    renderPayloads();
  } else if (activeTab === 'stats') {
    renderStats();
  }
}

// -------------------------------------------------------------------------
// Event wiring
// -------------------------------------------------------------------------

// Tabs
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');

    // Render on tab switch
    if (tab.dataset.tab === 'stats') renderStats();
    if (tab.dataset.tab === 'endpoints') renderEndpoints();
    if (tab.dataset.tab === 'payloads') renderPayloads();
    if (tab.dataset.tab === 'settings') loadSettings();
  });
});

// Capture toggle
document.getElementById('toggleCaptureBtn').addEventListener('click', async () => {
  captureState = await chrome.runtime.sendMessage({ action: 'toggleCapture' });
  await loadData();
});

// Export
document.getElementById('exportBtn').addEventListener('click', doExport);

// Push to Vault
document.getElementById('pushVaultBtn').addEventListener('click', async () => {
  const btn = document.getElementById('pushVaultBtn');
  const origText = btn.textContent;
  btn.textContent = 'Pushing...';
  btn.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ action: 'pushToVault' });
    if (result.ok) {
      btn.textContent = 'Done!';
      vaultConfig = await chrome.runtime.sendMessage({ action: 'getVaultConfig' });
      updateVaultStatus();
    } else {
      btn.textContent = 'Failed';
    }
  } catch {
    btn.textContent = 'Error';
  }
  btn.disabled = false;
  setTimeout(() => { btn.textContent = origText; }, 2000);
});

// Search / filter changes
document.getElementById('searchInput').addEventListener('input', () => {
  displayedCount = 50;
  renderEndpoints();
});

document.getElementById('methodFilter').addEventListener('change', () => {
  displayedCount = 50;
  renderEndpoints();
});

document.getElementById('domainFilter').addEventListener('change', () => {
  displayedCount = 50;
  renderEndpoints();
});

document.getElementById('apiStatusFilter').addEventListener('change', () => {
  displayedCount = 50;
  renderEndpoints();
});

document.getElementById('sortBy').addEventListener('change', () => {
  displayedCount = 50;
  renderEndpoints();
});

// Star filter toggle
document.getElementById('starFilterBtn').addEventListener('click', () => {
  starFilterActive = !starFilterActive;
  document.getElementById('starFilterBtn').classList.toggle('active-filter', starFilterActive);
  displayedCount = 50;
  renderEndpoints();
});

// Show more
document.getElementById('showMoreBtn').addEventListener('click', () => {
  displayedCount += 50;
  renderEndpoints();
});

// Settings - save
document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
  const domainInputs = document.querySelectorAll('.domain-input');
  const domains = [...domainInputs].map(i => i.value.trim()).filter(Boolean);

  const newSettings = {
    autoCaptureOnStartup: document.getElementById('autoCapture').checked,
    maxEndpoints: parseInt(document.getElementById('maxEndpoints').value, 10) || 500,
    domains: domains.length ? domains : settings.domains,
    exportFormat: document.getElementById('exportFormat').value
  };

  await chrome.runtime.sendMessage({ action: 'setSettings', settings: newSettings });
  settings = newSettings;

  // Save vault config
  const newVaultConfig = {
    ...vaultConfig,
    vaultUrl: document.getElementById('vaultUrl').value.trim(),
    vaultSecret: document.getElementById('vaultSecret').value.trim(),
    autoPush: document.getElementById('vaultAutoPush').checked
  };
  await chrome.runtime.sendMessage({ action: 'setVaultConfig', config: newVaultConfig });
  vaultConfig = newVaultConfig;
  updateVaultStatus();
  document.getElementById('pushVaultBtn').style.display = vaultConfig.vaultUrl ? '' : 'none';

  const msg = document.getElementById('saveMsg');
  msg.style.display = 'inline';
  setTimeout(() => { msg.style.display = 'none'; }, 2000);
});

// Settings - add domain
document.getElementById('addDomainBtn').addEventListener('click', () => {
  const list = document.getElementById('domainsList');
  const newRow = document.createElement('div');
  newRow.className = 'domain-row';
  newRow.innerHTML = `
    <input type="text" class="domain-input" placeholder="api.example.com" />
    <button class="btn icon-btn danger" style="cursor:pointer;">x</button>
  `;
  newRow.querySelector('button').addEventListener('click', () => newRow.remove());
  list.appendChild(newRow);
  newRow.querySelector('input').focus();
});

// Settings - clear all
document.getElementById('clearAllBtn').addEventListener('click', async () => {
  const btn = document.getElementById('clearAllBtn');
  if (btn.dataset.confirming === 'true') {
    btn.dataset.confirming = '';
    btn.textContent = 'Clear All Data';
    btn.style.background = '';
    clearTimeout(btn._confirmTimer);
    await chrome.runtime.sendMessage({ action: 'clearAll' });
    allEndpoints = {};
    displayedCount = 50;
    await loadData();
  } else {
    btn.dataset.confirming = 'true';
    btn.textContent = 'Confirm Clear?';
    btn.style.background = '#6b1a1a';
    btn._confirmTimer = setTimeout(() => {
      btn.dataset.confirming = '';
      btn.textContent = 'Clear All Data';
      btn.style.background = '';
    }, 4000);
  }
});

// -------------------------------------------------------------------------
// Init
// -------------------------------------------------------------------------

// Payload tab listeners
document.getElementById('payloadSearch')?.addEventListener('input', renderPayloads);

document.getElementById('exportPayloadsBtn')?.addEventListener('click', async () => {
  const payloads = await chrome.runtime.sendMessage({ action: 'getPayloads' });
  const exportData = {};
  for (const [key, p] of Object.entries(payloads)) {
    let responseJson = null;
    try { responseJson = JSON.parse(p.responseBody); } catch {}
    let requestJson = null;
    if (p.requestBody) { try { requestJson = JSON.parse(p.requestBody); } catch {} }
    exportData[key] = {
      method: p.method,
      url: p.url,
      status: p.status,
      capturedAt: new Date(p.capturedAt).toISOString(),
      captureCount: p.captureCount,
      requestBody: requestJson || p.requestBody || null,
      responseBody: responseJson || p.responseBody || null
    };
  }
  const content = JSON.stringify(exportData, null, 2);
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ghl-payloads-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById('exportWorkflowsBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('exportWorkflowsBtn');
  const orig = btn.textContent;
  btn.textContent = 'Building...';
  btn.disabled = true;
  try {
    const recipes = await chrome.runtime.sendMessage({ action: 'exportWorkflowRecipes' });

    // Try to parse JSON bodies inline so the file is human-readable
    const enrich = (op) => {
      if (!op) return op;
      const out = { ...op };
      if (out.requestBody) { try { out.requestBody = JSON.parse(out.requestBody); } catch {} }
      if (out.responseBody) { try { out.responseBody = JSON.parse(out.responseBody); } catch {} }
      return out;
    };
    const enriched = {
      generatedAt: recipes.generatedAt,
      workflowCount: recipes.workflowCount,
      orphanCount: recipes.orphanCount,
      workflows: {},
      orphans: (recipes.orphans || []).map(enrich)
    };
    for (const [wid, r] of Object.entries(recipes.workflows || {})) {
      enriched.workflows[wid] = {
        workflowId: r.workflowId,
        name: r.name,
        create: enrich(r.create),
        update: enrich(r.update),
        read: enrich(r.read),
        publish: enrich(r.publish),
        duplicate: enrich(r.duplicate),
        ops: r.ops.map(enrich)
      };
    }

    const content = JSON.stringify(enriched, null, 2);
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ghl-workflow-recipes-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);

    btn.textContent = `${recipes.workflowCount} workflows`;
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
  } catch (e) {
    btn.textContent = 'Failed';
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
  }
});

document.getElementById('clearPayloadsBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('clearPayloadsBtn');
  if (btn.dataset.confirming === 'true') {
    btn.dataset.confirming = '';
    btn.textContent = 'Clear';
    btn.style.background = '';
    clearTimeout(btn._confirmTimer);
    await chrome.runtime.sendMessage({ action: 'clearPayloads' });
    allPayloads = {};
    renderPayloads();
  } else {
    btn.dataset.confirming = 'true';
    btn.textContent = 'Sure?';
    btn.style.background = '#6b1a1a';
    btn._confirmTimer = setTimeout(() => {
      btn.dataset.confirming = '';
      btn.textContent = 'Clear';
      btn.style.background = '';
    }, 4000);
  }
});

// Load lastOpenedAt timestamp, then set it to now for next session
chrome.storage.local.get('lastOpenedAt').then(stored => {
  lastOpenedAt = stored.lastOpenedAt || 0;
  chrome.storage.local.set({ lastOpenedAt: Date.now() });
});

// Load vault config for header indicator
chrome.runtime.sendMessage({ action: 'getVaultConfig' }).then(vc => {
  vaultConfig = vc || {};
});

// Reclassify existing endpoints on popup open (tags new official patterns)
chrome.runtime.sendMessage({ action: 'reclassifyAll' }).then(() => {
  loadData();
});
loadSettings();

// Auto-refresh every 10s while popup is open (only refresh if not in settings tab)
setInterval(() => {
  const activeTab = document.querySelector('.tab.active')?.dataset?.tab;
  if (activeTab !== 'settings') loadData();
}, 10000);
