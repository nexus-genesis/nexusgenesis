import { startMainNode } from '../index.js';

export async function bootstrap() {
  console.log('[Bootstrap] Reusing the main GenesisNode stack for bootstrap mode');

  return startMainNode({
    defaults: {
      HTTP_PORT: process.env.PORT || '19890',
      P2P_PORT: process.env.P2P_PORT || '9848',
      DATA_DIR: process.env.DATA_DIR || 'data/bootstrap-genesis',
      NODE_ROLE: process.env.NODE_ROLE || 'genesis',
      SEED_NODES: process.env.SEED_NODES || '',
      ALLOW_SINGLE_NODE_BLOCKS: process.env.ALLOW_SINGLE_NODE_BLOCKS || 'true'
    },
    attachStdin: true
  });
}

// Legacy exports are kept for compatibility while the runtime converges on GenesisNode.
export { BootstrapAgentNetwork } from './BootstrapAgentNetwork.js';
export * from './crypto.js';
