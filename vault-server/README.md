# GHL Payload Harvester — Local Vault

Tiny zero-dependency Node server that lets multiple Chrome profiles
running the harvester sync into one shared dataset.

## Run it

```bash
cd vault-server
node server.js
```

You should see:

```
GHL Vault listening on http://127.0.0.1:7777
Data file: /Users/.../vault-server/vault-data.json
Auth: disabled
Loaded: 0 endpoints, 0 payloads
```

## Configure each Chrome profile

In each profile, open the harvester popup → **Settings** tab → **GHL Vault**:

- **Vault URL:** `http://127.0.0.1:7777/api/ingest`
- **Vault Secret:** leave blank (unless you set `VAULT_SECRET`)
- **Auto-sync:** on (recommended)

Click **Save Settings**, then **Sync Now**. The first push uploads
everything captured in that profile. Switch profiles and click Sync
Now there too — the second profile's captures get merged with the
first's, then both pull the union back.

## Optional: set a shared secret

```bash
VAULT_SECRET=mysecret node server.js
```

Then put `mysecret` in each profile's Vault Secret field.

## Optional: pick a custom port / data file

```bash
VAULT_PORT=9000 VAULT_DATA_FILE=~/ghl-vault.json node server.js
```

## Endpoints

| Method | Path                | Purpose                                    |
|--------|---------------------|--------------------------------------------|
| GET    | `/api/health`       | Counts + last-updated timestamp            |
| GET    | `/api/state`        | Full merged state (extension pull)         |
| POST   | `/api/ingest`       | Single payload push                        |
| POST   | `/api/ingest/bulk`  | Bulk endpoints + payloads push (sync)      |
| POST   | `/api/clear`        | Wipe vault                                 |

## How merging works

- **Endpoints:** hitCounts sum, queryParams/statusCodes/sampleUrls/tags
  union, `firstSeen` keeps the earliest, `lastSeen` keeps the latest,
  `authType` upgrades (bearer > apikey > firebase-jwt > other > none),
  `apiStatus` upgrades to `official` if any profile saw it that way.
- **Payloads:** sample arrays union, deduped by request-body fingerprint,
  sorted by `capturedAt` desc, top 5 kept per endpoint.

The vault is the source of truth after a sync. Local state is replaced
with the merged result on pull.

## Run on boot (macOS)

Use the install script — it wraps the server in a proper `.app` bundle so
it shows as **"GHL Vault"** (not a generic "node") in System Settings >
Login Items, ad-hoc code-signs it, and registers the launchd agent:

```bash
./install-macos.sh
```

This creates:
- `~/Applications/GHL Vault.app` — the named, signed bundle
- `~/Library/LaunchAgents/com.ventryx.ghl-vault.plist` — the launchd agent

It auto-starts on every login and restarts if it crashes (`KeepAlive`).

Uninstall:

```bash
./install-macos.sh remove
```

(`vault-data.json` is kept.)

### Why the bundle?

launchd running the bare `node` binary makes macOS label the background
item "node — Item from unidentified developer". The `.app` bundle gives
it a real `CFBundleDisplayName` so it appears as "GHL Vault" with a
stable code identity.
