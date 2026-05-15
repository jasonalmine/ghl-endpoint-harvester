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

## Run on boot (macOS launchd)

Create `~/Library/LaunchAgents/com.ventryx.ghl-vault.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>          <string>com.ventryx.ghl-vault</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/jasonalmine/Projects/ghl-endpoint-harvester/vault-server/server.js</string>
  </array>
  <key>RunAtLoad</key>      <true/>
  <key>KeepAlive</key>      <true/>
  <key>StandardOutPath</key><string>/tmp/ghl-vault.log</string>
  <key>StandardErrorPath</key><string>/tmp/ghl-vault.err</string>
</dict>
</plist>
```

Then:

```bash
launchctl load ~/Library/LaunchAgents/com.ventryx.ghl-vault.plist
```
