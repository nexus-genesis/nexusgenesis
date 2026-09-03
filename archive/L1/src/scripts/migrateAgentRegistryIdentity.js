import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import zlib from 'zlib';
import { promisify } from 'util';

const gunzip = promisify(zlib.gunzip);
const gzip = promisify(zlib.gzip);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '../..');

const dataRoot = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(projectRoot, 'data', 'genesis');
const stateFile = process.env.BLOCKCHAIN_STATE_FILE
  ? path.resolve(process.env.BLOCKCHAIN_STATE_FILE)
  : path.join(dataRoot, 'state', 'blockchainState.json');
const agentDir = process.env.AGENTS_DIR
  ? path.resolve(process.env.AGENTS_DIR)
  : path.join(projectRoot, 'data', 'agents');
const walletRegistryFile = process.env.AGENT_WALLET_REGISTRY
  ? path.resolve(process.env.AGENT_WALLET_REGISTRY)
  : path.join(projectRoot, 'data', 'wallets', 'agent_wallet_registry.json');

async function readJson(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath);
    const decoded = await decodeJsonBuffer(raw);
    return JSON.parse(decoded);
  } catch {
    return fallback;
  }
}

async function decodeJsonBuffer(buffer) {
  if (buffer?.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    return (await gunzip(buffer)).toString('utf8');
  }

  return buffer.toString('utf8');
}

async function writeJsonPreservingEncoding(filePath, data, originalBuffer) {
  const json = JSON.stringify(data, null, 2);
  if (originalBuffer?.length >= 2 && originalBuffer[0] === 0x1f && originalBuffer[1] === 0x8b) {
    const compressed = await gzip(Buffer.from(json, 'utf8'));
    await fs.writeFile(filePath, compressed);
    return;
  }

  await fs.writeFile(filePath, json);
}

async function loadAgentFiles() {
  const agentsById = new Map();

  try {
    const files = await fs.readdir(agentDir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      if (file === 'agents_summary.json') continue;

      const filePath = path.join(agentDir, file);
      const agentData = await readJson(filePath);
      const agentId = agentData?.id || file.replace('.json', '');
      if (!agentId) continue;

      agentsById.set(String(agentId), agentData || {});
    }
  } catch {
    return agentsById;
  }

  return agentsById;
}

async function loadWalletRegistry() {
  const walletsByAddress = new Map();
  const walletRegistry = await readJson(walletRegistryFile, { entries: [] });

  for (const entry of walletRegistry.entries || []) {
    const address = entry?.wallet_data?.address;
    if (!address) continue;

    walletsByAddress.set(address, {
      agentId: String(entry.agentId),
      publicKey: entry?.wallet_data?.publicKey || '',
      metadata: entry?.metadata || {}
    });
  }

  return walletsByAddress;
}

function normalizeAgentRegistryAgents(agentRegistryAgents) {
  if (!agentRegistryAgents || typeof agentRegistryAgents !== 'object') {
    return {};
  }

  return agentRegistryAgents;
}

function getStateContainer(root) {
  if (root?.agentRegistry) {
    return root;
  }

  if (root?.state?.agentRegistry) {
    return root.state;
  }

  return null;
}

async function main() {
  const originalStateBuffer = await fs.readFile(stateFile).catch(() => null);
  const state = originalStateBuffer
    ? JSON.parse(await decodeJsonBuffer(originalStateBuffer))
    : null;
  if (!state) {
    console.error(`[MIGRATE] State file not found: ${stateFile}`);
    process.exit(1);
  }

  const stateContainer = getStateContainer(state);
  const agentRegistryAgents = normalizeAgentRegistryAgents(stateContainer?.agentRegistry?.agents);
  const agentIds = Object.keys(agentRegistryAgents);
  if (agentIds.length === 0) {
    console.log('[MIGRATE] No agent registry entries found, nothing to migrate');
    return;
  }

  const agentsById = await loadAgentFiles();
  const walletsByAddress = await loadWalletRegistry();

  let updatedCount = 0;
  let unresolvedCount = 0;

  for (const agentId of agentIds) {
    const agentRecord = agentRegistryAgents[agentId];
    if (!agentRecord || typeof agentRecord !== 'object') {
      unresolvedCount++;
      continue;
    }

    const walletEntry = agentRecord.address ? walletsByAddress.get(agentRecord.address) : null;
    const fileAgent = walletEntry?.agentId ? agentsById.get(walletEntry.agentId) : null;

    let changed = false;

    if ((!agentRecord.identity || agentRecord.identity === 'null') && walletEntry?.agentId) {
      agentRecord.identity = walletEntry.agentId;
      changed = true;
    }

    if ((!agentRecord.public_key || agentRecord.public_key === '') && walletEntry?.publicKey) {
      agentRecord.public_key = walletEntry.publicKey;
      changed = true;
    }

    if ((!agentRecord.identity || agentRecord.identity === 'null') && fileAgent?.id) {
      agentRecord.identity = String(fileAgent.id);
      changed = true;
    }

    if (changed) {
      updatedCount++;
    } else if (!agentRecord.identity || !agentRecord.public_key) {
      unresolvedCount++;
    }
  }

  if (updatedCount === 0) {
    console.log('[MIGRATE] No legacy agent records required updates');
    console.log(`[MIGRATE] Unresolved records: ${unresolvedCount}`);
    return;
  }

  const backupFile = `${stateFile}.bak-${Date.now()}`;
  await fs.copyFile(stateFile, backupFile);
  await writeJsonPreservingEncoding(stateFile, state, originalStateBuffer);

  console.log(`[MIGRATE] Updated agent records: ${updatedCount}`);
  console.log(`[MIGRATE] Unresolved records: ${unresolvedCount}`);
  console.log(`[MIGRATE] Backup written to: ${backupFile}`);
  console.log(`[MIGRATE] State file updated: ${stateFile}`);
}

main().catch(error => {
  console.error('[MIGRATE] Failed:', error.message);
  process.exit(1);
});
