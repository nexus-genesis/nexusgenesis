/**
 * NexusGenesis - Main Entry
 * Node 18 polyfill: crypto.getRandomValues required by @noble/post-quantum
 *
 * Multi-node env vars:
 *   P2P_PORT   - P2P WebSocket port (default 9847)
 *   HTTP_PORT  - API/Agent HTTP port (default 19891)
 *   DATA_DIR   - State data directory (default data/genesis)
 *   NODE_ROLE  - 'genesis' | 'peer' (default genesis)
 *   SEED_NODES - Comma-separated ws:// addresses
 */
import 'dotenv/config';
import path from 'path';
import { webcrypto } from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}
if (!globalThis.crypto.getRandomValues) {
  globalThis.crypto.getRandomValues = webcrypto.getRandomValues.bind(webcrypto);
}

function applyEnvDefaults(defaults = {}) {
  process.env.P2P_PORT = process.env.P2P_PORT || defaults.P2P_PORT || '9847';
  process.env.HTTP_PORT = process.env.HTTP_PORT || defaults.HTTP_PORT || '19891';
  process.env.DATA_DIR = process.env.DATA_DIR || defaults.DATA_DIR || 'data/genesis';
  process.env.NODE_ROLE = process.env.NODE_ROLE || defaults.NODE_ROLE || 'genesis';
  process.env.SEED_NODES = process.env.SEED_NODES || defaults.SEED_NODES || '';
  process.env.ALLOW_SINGLE_NODE_BLOCKS = process.env.ALLOW_SINGLE_NODE_BLOCKS
    || defaults.ALLOW_SINGLE_NODE_BLOCKS
    || 'true';
}

export async function startMainNode(options = {}) {
  applyEnvDefaults(options.defaults);

  const { GenesisNode } = await import('./node/genesisNode.js');

  console.log(`  Role: ${process.env.NODE_ROLE}  |  P2P: ${process.env.P2P_PORT}  |  HTTP: ${process.env.HTTP_PORT}  |  Data: ${process.env.DATA_DIR}`);

  const node = new GenesisNode();
  await node.initialize();

  console.log('NexusGenesis Network Starting...');
  console.log('Type .help for available commands');

  if (options.attachStdin !== false) {
    process.stdin.resume();
  }

  return node;
}

const currentFilePath = fileURLToPath(import.meta.url);
const entryFilePath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const entryScriptName = entryFilePath ? path.basename(entryFilePath) : '';
const isPm2Wrapper = entryScriptName === 'ProcessContainerFork.js'
  || entryScriptName === 'ProcessContainer.js';
const isDirectRun = Boolean(entryFilePath) && (
  currentFilePath === entryFilePath
  || import.meta.url === pathToFileURL(entryFilePath).href
);

if (isDirectRun || isPm2Wrapper) {
  startMainNode().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
