# SPA-cache capture + replay — implementation status

Goal: capture SPA-cached GHL endpoints WITH auth + replay them.
Decisions: token daemon URL = configurable + GET /health probe; replay = GET-only
(non-GET behind opt-in); force-refetch = cache-bust tab reload.

## Build order & status
- [x] Part 1: webRequest header/auth capture path + reconcile by epKey (commit 1)
- [x] Part 3: pagination/param awareness (commit 1)
- [x] Part 4a: resource-timing discovery (commit 2)
- [x] Part 4b: force-refetch via cache-bust tab reload (commit 2)
- [x] Part 2: replay / Test endpoint backend (commit 2)
- [x] Vault server merge extensions + popup UI (badges/buttons/settings) (commit 3)
ALL PARTS IMPLEMENTED. v1.10.0. Pending: user reload + live test.

## Constraints
- Keep vault schema + /api/ingest/bulk contract backward-compatible (new optional keys only)
- Keep sensitive header values redacted in storage; replay fetches fresh token at runtime
- Don't break MAIN-world interceptor (only additive PerformanceObserver there)

## Notes
- Token daemon: ~/Projects/ghl-token-harvester/daemon/server.js, 127.0.0.1:config.port
  routes: GET /health, GET /tokens, GET /token/{key} (unauth)
- Endpoint schema + payload samples[] documented in plan; sampleSignature must not
  let header-only samples evict body samples (extend with method+source+hdr marker)
