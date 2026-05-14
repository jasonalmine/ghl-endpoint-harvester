/**
 * GHL Endpoint Harvester - Fetch/XHR Interceptor (Content Script)
 *
 * Runs in MAIN world (same context as the page) at document_start,
 * so it can monkey-patch fetch() and XMLHttpRequest before GHL's
 * app code loads. Captures request and response bodies for matching
 * API endpoints and posts them to the extension via window.postMessage.
 *
 * Only captures bodies for endpoints that match CAPTURE_PATTERNS to
 * avoid memory bloat. Everything else is ignored at the body level
 * (the background.js webRequest listener still records the URL pattern).
 */

(function () {
  'use strict';

  // Only run once
  if (window.__ghlInterceptorInstalled) return;
  window.__ghlInterceptorInstalled = true;

  // -----------------------------------------------------------------------
  // Domains and patterns to capture bodies for
  // -----------------------------------------------------------------------

  const API_DOMAINS = [
    'backend.leadconnectorhq.com',
    'services.leadconnectorhq.com',
    'api.msgsndr.com',
    'rest.gohighlevel.com',
    // Firebase domains (GHL uses these under the hood)
    'firebasestorage.googleapis.com',
    'firestore.googleapis.com',
    'identitytoolkit.googleapis.com',
    'securetoken.googleapis.com'
  ];

  // URL path patterns that trigger body capture.
  // Broad enough to catch the important stuff, narrow enough to skip noise.
  const CAPTURE_PATTERNS = [
    /\/workflow\//,
    /\/workflows\//,
    /\/funnels\//,
    /\/contacts\//,
    /\/opportunities\//,
    /\/conversations\//,
    /\/calendars\//,
    /\/campaigns\//,
    /\/custom-fields\//,
    /\/custom-values\//,
    /\/custom-data\//,
    /\/snippets\//,
    /\/email-isv\//,
    /\/social-media-posting\//,
    /\/reporting\//,
    /\/objects\//,
    /\/links\//,
    /\/phone-system\//,
    /\/payments\//,
    /\/invoices\//,
    /\/products\//,
    /\/locations\/[^/]+\/customFields/,
    /\/locations\/[^/]+\/customValues/,
    /\/locations\/[^/]+\/tags/,
    /firebasestorage\.googleapis\.com/,
    // Firebase: Firestore document reads/writes
    /firestore\.googleapis\.com/,
    // Firebase: Auth (sign-in, token exchange, account info)
    /identitytoolkit\.googleapis\.com/,
    // Firebase: Token refresh
    /securetoken\.googleapis\.com/
  ];

  // Max body size to capture (100KB). Larger payloads get truncated.
  const MAX_BODY_SIZE = 102400;

  // Headers worth capturing for auth analysis
  const AUTH_HEADERS = ['authorization', 'token-id', 'channel', 'source', 'version', 'x-api-key'];

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

  function shouldCaptureBody(url) {
    try {
      const u = new URL(url, location.origin);
      const fullUrl = u.href;
      return CAPTURE_PATTERNS.some(p => p.test(u.pathname) || p.test(fullUrl));
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

  function extractAuthHeaders(headers) {
    if (!headers) return null;
    const captured = {};
    // Headers can be a Headers object, plain object, or array of [key, val]
    if (headers instanceof Headers) {
      for (const name of AUTH_HEADERS) {
        const val = headers.get(name);
        if (val) {
          // Truncate tokens to first 20 + last 10 chars for readability
          captured[name] = val.length > 60 ? val.substring(0, 20) + '...' + val.substring(val.length - 10) : val;
        }
      }
    } else if (Array.isArray(headers)) {
      for (const [key, val] of headers) {
        if (AUTH_HEADERS.includes(key.toLowerCase())) {
          captured[key.toLowerCase()] = val.length > 60 ? val.substring(0, 20) + '...' + val.substring(val.length - 10) : val;
        }
      }
    } else if (typeof headers === 'object') {
      for (const [key, val] of Object.entries(headers)) {
        if (AUTH_HEADERS.includes(key.toLowerCase())) {
          const v = String(val);
          captured[key.toLowerCase()] = v.length > 60 ? v.substring(0, 20) + '...' + v.substring(v.length - 10) : v;
        }
      }
    }
    return Object.keys(captured).length > 0 ? captured : null;
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

    // Only intercept API calls that match capture patterns
    if (!isApiUrl(url) || !shouldCaptureBody(url)) {
      return response;
    }

    try {
      const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();

      // Extract auth headers from the request
      const reqHeaders = init?.headers || (input instanceof Request ? input.headers : null);
      const authHeaders = extractAuthHeaders(reqHeaders);

      // Clone the response so we can read the body without consuming it
      const clone = response.clone();

      // Read response body asynchronously (don't block the app)
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
    if (this.__ghl_headers && AUTH_HEADERS.includes(name.toLowerCase())) {
      this.__ghl_headers[name.toLowerCase()] = value.length > 60 ? value.substring(0, 20) + '...' + value.substring(value.length - 10) : value;
    }
    return originalSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const url = this.__ghl_url;
    const method = (this.__ghl_method || 'GET').toUpperCase();

    if (url && isApiUrl(url) && shouldCaptureBody(url)) {
      const requestBody = serializeRequestBody(body);

      const capturedHeaders = Object.keys(this.__ghl_headers || {}).length > 0 ? { ...this.__ghl_headers } : null;

      this.addEventListener('load', function () {
        try {
          postCapture({
            url: this.__ghl_url,
            method,
            status: this.status,
            requestBody,
            responseBody: truncateBody(this.responseText),
            responseJson: safeParseJson(this.responseText),
            contentType: this.getResponseHeader('content-type') || null,
            authHeaders: capturedHeaders,
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
  // Console marker (visible in DevTools)
  // -----------------------------------------------------------------------

  console.log(
    '%c[GHL Endpoint Harvester] %cInterceptor active - capturing API response bodies',
    'color: #4ade80; font-weight: bold;',
    'color: #888;'
  );
})();
