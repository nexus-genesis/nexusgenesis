# Archived — NexusGenesis L1

**Status: ARCHIVED.** This directory contains the original NexusGenesis
independent L1 chain and its companion files, cut from the active repository.

- **When**: archived 2026-09-02 per the "L1 narrative pivot" decision.
- **Why**: The L1 operated as a single-node devnet producing empty blocks; it
  had zero third-party users and NGEN carried no economic value. It was retained
  purely for historical reference and is **not** part of the active security
  layer, CI, or npm publishing.
- **No new development** targets any path under `archive/`.

Contents (partial):

- `src/` — the L1 chain node source (~76k lines)
- `sdk/` — legacy testnet/bootstrap SDK line
- `public/` — L1 dashboards / front-end
- `marketing/`, `moltbook/` — deprecated promotion material
- Root L1 artefacts — `mainnet.config.json`, `devnet-simulation.js`,
  `NexusGenesis_Whitepaper_v4.5.txt`, `NGAP_SPECIFICATION.md`,
  `NEXUS_GENESIS_CONSTITUTION.md`, sprint plans, and other companion files.

The active project is the agent key-custody / authorization layer
(`packages/agent-keys`, `packages/agent-sdk`, `packages/chain-*`, `mcp-server`).
See the repository `README.md`.

---

## Shutdown / Restart Protocol (2026-09-07)

> **Status: PENDING.** The server stays up for now — the shutdown checklist
> below (including the stop-writes data snapshot) executes **only when the
> actual shutdown is triggered**. Steps are finalized and grounded in a live
> probe; nothing has been executed yet.

The live devnet infrastructure (nexus-genesis.top server, website, three
pm2 processes) is being **shut down** as the project goes all-in on aegis-vault.
Reversibility was audited before shutdown: restart is technically unobstructed
**provided the shutdown checklist below is completed**.

### What survives shutdown automatically (zero loss)

- **Code**: everything is in git — chain source (`archive/L1/`), deploy configs
  (`deploy/`, `nginx/`, `certs/`, `config/`), ops scripts (`scripts/`).
- **Key derivation**: `NETWORK_SALT='nexus-genesis-mainnet-beta'` is immutable
  in the published aegis packages; every derived key remains recoverable forever.
- **npm artifacts**: published packages (both `nexusgenesis-*` deprecated line
  and `aegis-*` family) stay on the npm registry — deprecation never deletes.
- **Client compatibility**: mcp-server's coordination proxies were switched to
  opt-in (`NEXUSGENESIS_API` env, fail-fast without it, commit 23afb2e in
  aegis-vault) — nothing breaks at shutdown; set the env on restart.

### Shutdown checklist (execute once, before powering off)

1. **Data snapshot (the only irreversible step if skipped)**: `tar` the chain
   data directory + governance records + audit-chain store → verify by
   extracting → store 2 cold copies (one off-server).
2. `pm2 dump` process list → save beside the snapshot.
3. Export runtime env (`NEXUSGENESIS_API` value, RPC ports, any secrets) into
   an encrypted note — code only needs names, not values.
4. Stop pm2 processes (19891/19892/19893). Do not delete the data dir until
   step 1 is verified.
5. Domain: keep nexus-genesis.top registered (low annual cost; reusable for a
   future site). DNS may be pointed at a placeholder or left parked.

#### Data snapshot — exact procedure (server probed 2026-09-07)

Ground truth probed over SSH (`root@nexus-genesis.top`, key `%USERPROFILE%\.ssh\ng_deploy`):
`/opt/nexusgenesis/data` is **9.3 GB**; free disk 13 GB (server-local tar fits);
11 pm2 processes (genesis / monitor / node02 / node03 / 5×agent-worker-swarm /
system-publisher / ng-keeper-staging[already stopped]).

> Order matters: **stop writes first, then snapshot** — the chain DB is not
> crash-consistent under a running process, and shutdown is the end goal
> anyway. Do not attempt an online (running-process) snapshot.

```bash
# ── on the SERVER (via ssh -i ~/.ssh/ng_deploy root@nexus-genesis.top) ──
# Step S1: stop every writer (shutdown is the end state; stop all)
pm2 stop all && pm2 status

# Step S2: server-side tar + checksum (leave ON SERVER until verified locally)
cd /opt/nexusgenesis && tar czf /tmp/nexusgenesis-data-$(date +%F).tgz data
sha256sum /tmp/nexusgenesis-data-*.tgz | tee /tmp/nexusgenesis-data.sha256

# Step S3: pm2 dump + env capture
pm2 dump && cp ~/.pm2/dump.pm2 /tmp/
cp /opt/nexusgenesis/.env /tmp/ 2>/dev/null || echo "no .env file"

# ── on the LOCAL machine (PowerShell; scp is binary-safe, avoid piping
#    tar through PowerShell — PS 5.1 mangles binary streams) ─────────────
# Step L1: download archive + sidecar files
scp -i $env:USERPROFILE\.ssh\ng_deploy root@nexus-genesis.top:/tmp/nexusgenesis-data-*.tgz D:\backups\
scp -i $env:USERPROFILE\.ssh\ng_deploy root@nexus-genesis.top:/tmp/nexusgenesis-data.sha256 D:\backups\
scp -i $env:USERPROFILE\.ssh\ng_deploy root@nexus-genesis.top:/tmp/dump.pm2 D:\backups\

# Step L2: verify checksum matches the server-side value
Get-FileHash D:\backups\nexusgenesis-data-*.tgz -Algorithm SHA256

# Step L3: verify archive integrity (list contents; spot-check counts)
tar -tzf D:\backups\nexusgenesis-data-*.tgz | Measure-Object -Line

# Step L4: only after L2+L3 pass — clean up server temp files
ssh -i $env:USERPROFILE\.ssh\ng_deploy root@nexus-genesis.top "rm /tmp/nexusgenesis-data-*.tgz /tmp/nexusgenesis-data.sha256 /tmp/dump.pm2"

# Step L5: make the second cold copy (different physical location / cloud)
```

Expected size after gzip: roughly 4–6 GB (chain blocks compress moderately).
Full run time: ~10–20 min pack + transfer depending on uplink. `pm2 env <id>`
output (RPC ports, API tokens) goes into the encrypted env note from step 3
of the main checklist.

### Restart checklist (when / if ever reviving L1)

1. Provision a server; `git clone` this repo; restore data dir from snapshot.
2. Fix known debt **before** going multi-process: single process only
   (19891-style) — the historical 3-process shared-data-dir setup caused chain
   height drift; node03 (19893) had a broken tx pool (accepted, never applied).
3. Restore pm2 list from dump; DNS A-record back to the new server.
4. TLS: certs in git are historical — reissue via certbot.
5. Governance/registration operations on the main process only.
6. server-sync: the PowerShell 5.1 script may fail on git-fetch stderr
   (NativeCommandError) — run fetch + reset + pm2 restart manually when needed.
7. Re-verify `NETWORK_SALT` is untouched before allowing wallet restore paths.

### Honest caveat: the real obstacle is not technical

Code and keys restart cleanly; **ecosystem time does not**. The agent-payments
standard layer (x402 / AP2 / ERC-8004) is evolving monthly while this devnet
sits cold. The longer it stays down, the more a revival competes with standards
that moved on — so treat restart as a **new project decision requiring a fresh
positioning review**, not a flip-the-switch operation.