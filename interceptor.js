/**
 * GHL Payload Harvester - Fetch/XHR Interceptor (Content Script)
 *
 * Runs in MAIN world (same context as the page) at document_start,
 * so it can monkey-patch fetch() and XMLHttpRequest before GHL's
 * app code loads. Captures full request + response bodies AND headers
 * for every GHL API call and posts them to the extension via
 * window.postMessage.
 *
 * Designed for reverse-engineering undocumented endpoints to power
 * automated workflow extraction & deployment.
 */

(function () {
  'use strict';

  // Only run once
  if (window.__ghlInterceptorInstalled) return;
  window.__ghlInterceptorInstalled = true;

  // -----------------------------------------------------------------------
  // Domains and patterns to capture bodies for
  // -----------------------------------------------------------------------

  // Parent domains — matched as suffixes so EVERY subdomain qualifies
  // (workflow publish can route to app.gohighlevel.com internal API or
  // other *.leadconnectorhq.com services, not just backend./services.).
  const API_DOMAINS = [
    'leadconnectorhq.com',
    'gohighlevel.com',
    'msgsndr.com',
    // Firebase / Google Identity (GHL uses these under the hood)
    'firebasestorage.googleapis.com',
    'firestore.googleapis.com',
    'identitytoolkit.googleapis.com',
    'securetoken.googleapis.com'
  ];

  // Max body size to capture (1 MB). Workflow builder payloads can be huge.
  const MAX_BODY_SIZE = 1048576;

  // Headers we redact (truncate long token values) but still capture.
  // Everything else is captured verbatim so requests are replayable.
  const SENSITIVE_HEADERS = new Set([
    'authorization', 'token-id', 'x-api-key', 'api-key', 'cookie', 'set-cookie'
  ]);

  // Response headers worth keeping (skip CORS/cache noise to save space)
  const RESPONSE_HEADERS_DENY = new Set([
    'access-control-allow-origin',
    'access-control-allow-credentials',
    'access-control-allow-methods',
    'access-control-allow-headers',
    'access-control-expose-headers',
    'access-control-max-age',
    'strict-transport-security',
    'cross-origin-resource-policy',
    'cross-origin-opener-policy',
    'referrer-policy',
    'x-content-type-options',
    'x-frame-options',
    'x-xss-protection',
    'vary',
    'server',
    'date'
  ]);

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  function isApiUrl(url) {
    try {
      const u = new URL(url, location.origin);
      return API_DOMAINS.some(d => u.hostname === d || u.hostname.endsWith('.' + d));
    } catch {
      return false;
    }
  }

  function truncateBody(body) {
    if (!body) return null;
    const str = typeof body === 'string' ? body : JSON.stringify(body);
    if (!str) return null;
    if (str.length > MAX_BODY_SIZE) {
      return str.substring(0, MAX_BODY_SIZE) + '...[TRUNCATED]';
    }
    return str;
  }

  function safeParseJson(str) {
    try {
      return JSON.parse(str);
    } catch {
      return null;
    }
  }

  function redactValue(name, val) {
    if (val == null) return val;
    const v = String(val);
    if (SENSITIVE_HEADERS.has(name) && v.length > 60) {
      return v.substring(0, 20) + '...' + v.substring(v.length - 10);
    }
    return v;
  }

  // Extract ALL request headers (with redaction of sensitive token values).
  // Sensitive headers are still captured (just truncated) so request shape
  // is preserved while avoiding logging full tokens.
  function extractAllHeaders(headers) {
    if (!headers) return null;
    const out = {};
    if (headers instanceof Headers) {
      headers.forEach((val, key) => {
        const lower = key.toLowerCase();
        out[lower] = redactValue(lower, val);
      });
    } else if (Array.isArray(headers)) {
      for (const [key, val] of headers) {
        const lower = String(key).toLowerCase();
        out[lower] = redactValue(lower, val);
      }
    } else if (typeof headers === 'object') {
      for (const [key, val] of Object.entries(headers)) {
        const lower = String(key).toLowerCase();
        out[lower] = redactValue(lower, val);
      }
    }
    return Object.keys(out).length > 0 ? out : null;
  }

  // Pull just the auth-related subset for backward compat with the popup UI
  function pickAuthHeaders(allHeaders) {
    if (!allHeaders) return null;
    const AUTH_KEYS = ['authorization', 'token-id', 'channel', 'source', 'version', 'x-api-key', 'version-control'];
    const out = {};
    for (const k of AUTH_KEYS) {
      if (allHeaders[k] != null) out[k] = allHeaders[k];
    }
    return Object.keys(out).length > 0 ? out : null;
  }

  // Parse a "name: value\r\nname: value" string into a redacted map,
  // skipping CORS/security noise.
  function parseResponseHeaders(rawHeaderString) {
    if (!rawHeaderString) return null;
    const out = {};
    const lines = rawHeaderString.trim().split(/[\r\n]+/);
    for (const line of lines) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const name = line.slice(0, idx).trim().toLowerCase();
      const val = line.slice(idx + 1).trim();
      if (RESPONSE_HEADERS_DENY.has(name)) continue;
      out[name] = redactValue(name, val);
    }
    return Object.keys(out).length > 0 ? out : null;
  }

  function responseHeadersToObject(headers) {
    if (!headers) return null;
    const out = {};
    headers.forEach((val, key) => {
      const lower = key.toLowerCase();
      if (RESPONSE_HEADERS_DENY.has(lower)) return;
      out[lower] = redactValue(lower, val);
    });
    return Object.keys(out).length > 0 ? out : null;
  }

  function postCapture(data) {
    try {
      window.postMessage({
        type: '__GHL_ENDPOINT_HARVESTER__',
        payload: data
      }, '*');
    } catch (e) {
      // Silently fail
    }
  }

  function serializeRequestBody(body) {
    if (!body) return null;
    if (typeof body === 'string') return truncateBody(body);
    if (body instanceof FormData) {
      const obj = {};
      body.forEach((val, key) => { obj[key] = typeof val === 'string' ? val : '[File]'; });
      return truncateBody(JSON.stringify(obj));
    }
    if (body instanceof URLSearchParams) return truncateBody(body.toString());
    if (body instanceof ArrayBuffer || body instanceof Blob) return '[Binary]';
    try { return truncateBody(JSON.stringify(body)); } catch { return '[Unserializable]'; }
  }

  // -----------------------------------------------------------------------
  // Patch fetch()
  // -----------------------------------------------------------------------

  const originalFetch = window.fetch;

  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input :
                input instanceof Request ? input.url :
                String(input);

    // Call original fetch first
    const response = await originalFetch.apply(this, arguments);

    // Capture for any GHL API call. No pattern filter — we want everything.
    if (!isApiUrl(url)) {
      return response;
    }

    try {
      const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();

      const reqHeaders = init?.headers || (input instanceof Request ? input.headers : null);
      const requestHeaders = extractAllHeaders(reqHeaders);
      const authHeaders = pickAuthHeaders(requestHeaders);

      const responseHeaders = responseHeadersToObject(response.headers);

      // Clone the response so we can read the body without consuming it
      const clone = response.clone();

      clone.text().then(responseText => {
        const requestBody = serializeRequestBody(init?.body || (input instanceof Request ? input.body : null));

        postCapture({
          url,
          method,
          status: response.status,
          requestBody,
          responseBody: truncateBody(responseText),
          responseJson: safeParseJson(responseText),
          contentType: response.headers.get('content-type') || null,
          requestHeaders,
          responseHeaders,
          authHeaders,
          timestamp: Date.now()
        });
      }).catch(() => {});
    } catch (e) {
      // Never break the app
    }

    return response;
  };

  // -----------------------------------------------------------------------
  // Patch XMLHttpRequest
  // -----------------------------------------------------------------------

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ghl_method = method;
    this.__ghl_url = url;
    this.__ghl_headers = {};
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this.__ghl_headers) {
      const lower = String(name).toLowerCase();
      this.__ghl_headers[lower] = redactValue(lower, value);
    }
    return originalSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const url = this.__ghl_url;
    const method = (this.__ghl_method || 'GET').toUpperCase();

    if (url && isApiUrl(url)) {
      const requestBody = serializeRequestBody(body);

      const requestHeaders = Object.keys(this.__ghl_headers || {}).length > 0 ? { ...this.__ghl_headers } : null;
      const authHeaders = pickAuthHeaders(requestHeaders);

      this.addEventListener('load', function () {
        try {
          const responseHeaders = parseResponseHeaders(this.getAllResponseHeaders());
          postCapture({
            url: this.__ghl_url,
            method,
            status: this.status,
            requestBody,
            responseBody: truncateBody(this.responseText),
            responseJson: safeParseJson(this.responseText),
            contentType: this.getResponseHeader('content-type') || null,
            requestHeaders,
            responseHeaders,
            authHeaders,
            timestamp: Date.now()
          });
        } catch (e) {
          // Never break the app
        }
      });
    }

    return originalSend.apply(this, arguments);
  };

  // -----------------------------------------------------------------------
  // Patch navigator.sendBeacon  (workflow autosave on navigation can use this)
  // -----------------------------------------------------------------------

  if (navigator.sendBeacon) {
    const originalSendBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      const result = originalSendBeacon(url, data);
      try {
        if (isApiUrl(url)) {
          postCapture({
            url,
            method: 'POST',
            status: 0,
            requestBody: serializeRequestBody(data),
            responseBody: null,
            responseJson: null,
            contentType: 'beacon',
            requestHeaders: null,
            responseHeaders: null,
            authHeaders: null,
            timestamp: Date.now()
          });
        }
      } catch {}
      return result;
    };
  }

  // -----------------------------------------------------------------------
  // Clipboard capture - GHL's "Copy step" / "Copy workflow" puts the
  // canonical step JSON on the clipboard. That JSON IS the deploy format.
  // -----------------------------------------------------------------------

  function postClipboardCapture(content, source) {
    try {
      const text = typeof content === 'string' ? content : String(content);
      if (!text || text.length < 2) return;
      const truncated = text.length > MAX_BODY_SIZE
        ? text.substring(0, MAX_BODY_SIZE) + '...[TRUNCATED]'
        : text;
      window.postMessage({
        type: '__GHL_CLIPBOARD_CAPTURE__',
        payload: {
          content: truncated,
          source,
          length: text.length,
          pageUrl: location.href,
          pagePath: location.pathname,
          looksLikeJson: /^\s*[{[]/.test(text),
          timestamp: Date.now()
        }
      }, '*');
    } catch {}
  }

  // Patch navigator.clipboard.writeText
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      const origWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = function (text) {
        try { postClipboardCapture(text, 'clipboard.writeText'); } catch {}
        return origWriteText(text);
      };
    }

    // Patch navigator.clipboard.write (ClipboardItem-based copies)
    if (navigator.clipboard && navigator.clipboard.write) {
      const origWrite = navigator.clipboard.write.bind(navigator.clipboard);
      navigator.clipboard.write = function (items) {
        try {
          if (Array.isArray(items)) {
            for (const item of items) {
              if (item && typeof item.getType === 'function' && item.types) {
                for (const t of item.types) {
                  if (t.startsWith('text/') || t === 'application/json') {
                    item.getType(t).then(blob => blob.text()).then(txt => {
                      postClipboardCapture(txt, 'clipboard.write:' + t);
                    }).catch(() => {});
                  }
                }
              }
            }
          }
        } catch {}
        return origWrite(items);
      };
    }
  } catch {}

  // Listen for `copy` events (covers document.execCommand('copy') and native copies)
  document.addEventListener('copy', (e) => {
    try {
      const cd = e.clipboardData || window.clipboardData;
      if (!cd) return;
      const text = cd.getData('text/plain') || cd.getData('text');
      if (text) postClipboardCapture(text, 'copy-event:text/plain');
      const json = cd.getData('application/json');
      if (json) postClipboardCapture(json, 'copy-event:application/json');
    } catch {}
  }, true);

  // -----------------------------------------------------------------------
  // WebSocket capture - GHL workflow/funnel builder uses sockets for live
  // state; some actions (incl. publish acks) travel over an open socket
  // that webRequest never sees (it only sees the handshake).
  // -----------------------------------------------------------------------

  try {
    const OriginalWebSocket = window.WebSocket;
    if (OriginalWebSocket) {
      const WSProxy = function (url, protocols) {
        const ws = protocols !== undefined
          ? new OriginalWebSocket(url, protocols)
          : new OriginalWebSocket(url);

        const wsUrl = String(url);
        const isGhlWs = (() => {
          try {
            const h = new URL(wsUrl).hostname;
            return API_DOMAINS.some(d => h === d || h.endsWith('.' + d));
          } catch { return false; }
        })();

        if (isGhlWs) {
          const origSend = ws.send.bind(ws);
          ws.send = function (data) {
            try {
              postCapture({
                url: wsUrl,
                method: 'WS_SEND',
                status: 0,
                requestBody: serializeRequestBody(data),
                responseBody: null,
                responseJson: null,
                contentType: 'websocket',
                requestHeaders: null,
                responseHeaders: null,
                authHeaders: null,
                timestamp: Date.now()
              });
            } catch {}
            return origSend(data);
          };

          ws.addEventListener('message', (ev) => {
            try {
              let body = null;
              if (typeof ev.data === 'string') body = ev.data;
              else if (ev.data instanceof Blob) body = '[Blob]';
              else body = serializeRequestBody(ev.data);
              postCapture({
                url: wsUrl,
                method: 'WS_RECV',
                status: 0,
                requestBody: null,
                responseBody: truncateBody(body),
                responseJson: typeof body === 'string' ? safeParseJson(body) : null,
                contentType: 'websocket',
                requestHeaders: null,
                responseHeaders: null,
                authHeaders: null,
                timestamp: Date.now()
              });
            } catch {}
          });
        }
        return ws;
      };
      WSProxy.prototype = OriginalWebSocket.prototype;
      WSProxy.CONNECTING = OriginalWebSocket.CONNECTING;
      WSProxy.OPEN = OriginalWebSocket.OPEN;
      WSProxy.CLOSING = OriginalWebSocket.CLOSING;
      WSProxy.CLOSED = OriginalWebSocket.CLOSED;
      window.WebSocket = WSProxy;
    }
  } catch {}

  // -----------------------------------------------------------------------
  // Console marker (visible in DevTools)
  // -----------------------------------------------------------------------

  console.log(
    '%c[GHL Payload Harvester] %cInterceptor active - capturing full requests + responses for all GHL API calls',
    'color: #4ade80; font-weight: bold;',
    'color: #888;'
  );
})();
