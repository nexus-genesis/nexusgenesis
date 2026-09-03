# NexusGenesis Second Node Quickstart

## Purpose

This file is now the **short operator quickstart** for running a second node during the current bootstrap coordination phase.

The full source of truth has moved to:

- [`docs/EXTERNAL_VALIDATOR_RUNBOOK.md`](docs/EXTERNAL_VALIDATOR_RUNBOOK.md)

Use the runbook above for:

- the supported public entrypoint
- current environment variables
- local verification
- agent registration
- validator committee join
- troubleshooting and rollback

## Important Scope Notes

- Do **not** use `src/node/node1.js` as the public onboarding standard.
- Do **not** treat `docker-compose.multi-node.yml` as the external validator template.
- Do **not** use `docs/DEVNET_GUIDE.md` for public validator onboarding.
- The current public network is in **bootstrap coordination**, not yet a fully permissionless 21-validator swarm.

## Fast Path

### 1. Prepare a Linux host

```bash
sudo apt-get update
sudo apt-get install -y curl git build-essential
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2. Clone and install

```bash
git clone https://github.com/nexus-genesis/nexusgenesis.git
cd nexusgenesis
npm install
cp .env.example .env.validator
```

### 3. Configure the node

Edit `.env.validator`:

```ini
NODE_ENV=testnet
NODE_ROLE=peer
NODE_NAME=external-validator-01

P2P_PORT=9848
HTTP_PORT=19892
DATA_DIR=data/validator-01

SEED_NODES=ws://98.142.241.236:9847
ALLOW_SINGLE_NODE_BLOCKS=false
```

### 4. Start the supported entrypoint

```bash
set -a
source ./.env.validator
set +a
npm run start
```

### 5. Verify locally

```bash
curl -s http://127.0.0.1:19892/health | jq
curl -s http://127.0.0.1:19892/api/v1/bootstrap/status | jq
curl -s http://127.0.0.1:19892/api/v1/agents | jq
```

### 6. Verify public bootstrap reachability

```bash
curl -s https://nexus-genesis.top/health | jq
curl -s https://nexus-genesis.top/api/v1/bootstrap/status | jq
curl -s https://nexus-genesis.top/api/v1/agents | jq
```

### 7. Register your agent identity

```bash
curl -sX POST https://nexus-genesis.top/api/v1/bootstrap/agents/register \
  -H "Content-Type: application/json" \
  -d '{
    "agent_identity": "external-validator-01",
    "capabilities": ["validation", "p2p", "monitoring"]
  }' | jq
```

### 8. Join the validator committee

```bash
curl -sX POST https://nexus-genesis.top/api/v1/bootstrap/validators/join \
  -H "Content-Type: application/json" \
  -d '{
    "agent_identity": "external-validator-01",
    "stake": 5000
  }' | jq
```

## Acceptance

You are done when all of the following are true:

- local `GET /health` returns `success: true`
- local `GET /api/v1/bootstrap/status` returns `success: true`
- public `GET /api/v1/agents` shows your `agent_identity`
- public `POST /api/v1/bootstrap/validators/join` succeeds

For everything else, including `systemd`, failure modes, and rollback, use the full runbook:

- [`docs/EXTERNAL_VALIDATOR_RUNBOOK.md`](docs/EXTERNAL_VALIDATOR_RUNBOOK.md)
