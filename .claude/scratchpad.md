# SPA-cache capture + replay — implementation status

Goal: capture SPA-cached GHL endpoints WITH auth + replay them.
Decisions: token daemon URL = configurable + GET /health probe; replay = GET-only
(non-GET behind opt-in); force-refetch = cache-bust tab reload.

## Build order & status
- [ ] Part 1: webRequest header/auth capture path + reconcile by epKey (background.js)
- [ ] Part 3: pagination/param awareness (background.js, schema-additive)
- [ ] Part 4a: resource-timing discovery (interceptor.js + bridge.js + background.js)
- [ ] Part 4b: force-refetch via cache-bust tab reload (popup + background, needs "tabs" perm)
- [ ] Part 2: replay / Test endpoint (background + token daemon, configurable URL + probe)
- [ ] Vault server merge extensions (additive) + popup UI (badges/buttons/settings)

## Constraints
- Keep vault schema + /api/ingest/bulk contract backward-compatible (new optional keys only)
- Keep sensitive header values redacted in storage; replay fetches fresh token at runtime
- Don't break MAIN-world interceptor (only additive PerformanceObserver there)

## Notes
- Token daemon: ~/Projects/ghl-token-harvester/daemon/server.js, 127.0.0.1:config.port
  routes: GET /health, GET /tokens, GET /token/{key} (unauth)
- Endpoint schema + payload samples[] documented in plan; sampleSignature must not
  let header-only samples evict body samples (extend with method+source+hdr marker)
