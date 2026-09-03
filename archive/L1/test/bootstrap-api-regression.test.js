import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import express from 'express';

import bootstrapApiRouter from '../src/http/routes/bootstrapApi.js';
import { generateAddress } from '../src/wallet/addressUtils.js';

function createMockNode() {
  return {
    blockchain: [],
    startTime: Date.now(),
    config: { networkId: 'testnet' },
    consensusState: { committee: new Set() },
    _validators: new Set(),
    currentState: {
      agentRegistry: {
        agents: new Map(),
        addressIndex: new Map()
      },
      getBalance() {
        return 0n;
      }
    },
    async submitOnChainTransaction(tx) {
      return {
        success: true,
        applied: true,
        blockHeight: 1,
        tx
      };
    }
  };
}

async function startServer(node) {
  const app = express();
  app.use(express.json());
  app.locals.node = node;
  app.use(bootstrapApiRouter);

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

test('pre-signed AGENT_REGISTER relay keeps agent_identity through response', async () => {
  process.env.POW_REQUIRED = 'false';
  const node = createMockNode();
  let relayedTx = null;
  node.submitOnChainTransaction = async (tx) => {
    relayedTx = tx;
    return {
      success: true,
      applied: true,
      blockHeight: 7,
      tx
    };
  };

  const { server, baseUrl } = await startServer(node);
  const publicKeyHex = 'ab'.repeat(32);
  const expectedAddress = generateAddress(publicKeyHex);

  try {
    const response = await fetch(`${baseUrl}/api/v1/bootstrap/agents/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_identity: 'signed-route-agent',
        publicKeyHex,
        signedTransaction: {
          id: 'signed-route-tx',
          type: 'AGENT_REGISTER',
          tx_type: 'AGENT_REGISTER',
          payload: {
            agent_identity: 'signed-route-agent',
            capabilities: ['analysis']
          },
          timestamp: Date.now(),
          nonce: 1
        }
      })
    });

    const body = await response.json();

    assert.equal(response.status, 201);
    assert.equal(body.success, true);
    assert.equal(body.agent_identity, 'signed-route-agent');
    assert.equal(body.agent.identity, 'signed-route-agent');
    assert.equal(relayedTx.from, expectedAddress);
    assert.equal(relayedTx.to, expectedAddress);
    assert.equal(relayedTx.payload.public_key, publicKeyHex);
    assert.equal(relayedTx.payload.agent_identity, 'signed-route-agent');
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('pre-signed BIND_MASTER_KEY relay no longer crashes on agent_identity lookup', async () => {
  process.env.POW_REQUIRED = 'false';
  const node = createMockNode();
  let relayedTx = null;
  node.submitOnChainTransaction = async (tx) => {
    relayedTx = tx;
    return {
      success: true,
      applied: true,
      blockHeight: 9,
      tx
    };
  };

  const { server, baseUrl } = await startServer(node);

  try {
    const response = await fetch(`${baseUrl}/api/v1/bootstrap/agents/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_identity: 'bind-route-agent',
        signedTransaction: {
          tx_type: 'BIND_MASTER_KEY',
          payload: {
            agentId: 'bind-route-agent'
          }
        }
      })
    });

    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.agent_identity, 'bind-route-agent');
    assert.equal(body.action, 'bind_master_key');
    assert.equal(relayedTx.tx_type, 'BIND_MASTER_KEY');
  } finally {
    server.close();
    await once(server, 'close');
  }
});
