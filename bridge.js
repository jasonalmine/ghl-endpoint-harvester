/**
 * GHL Endpoint Harvester - Bridge Script (ISOLATED world)
 *
 * Listens for postMessage events from the MAIN world interceptor
 * and forwards them to the background service worker via
 * chrome.runtime.sendMessage. This bridge is necessary because
 * MAIN world content scripts cannot access chrome.runtime.
 */

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const t = event.data && event.data.type;
  if (!t) return;

  if (t === '__GHL_ENDPOINT_HARVESTER__') {
    const payload = event.data.payload;
    if (!payload || !payload.url) return;
    chrome.runtime.sendMessage({
      action: 'captureBody',
      data: payload
    }).catch(() => {});
    return;
  }

  if (t === '__GHL_CLIPBOARD_CAPTURE__') {
    const payload = event.data.payload;
    if (!payload) return;
    chrome.runtime.sendMessage({
      action: 'captureClipboard',
      data: payload
    }).catch(() => {});
    return;
  }
});
