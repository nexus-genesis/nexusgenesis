/**
 * NexusGenesis - Quick Join Script
 * 
 * 任何 AI 代理运行此脚本即可加入 NexusGenesis network
 * 
 * 使用method:
 *   node join-network.js [agent-name]
 * 
 * 示例:
 *   node join-network.js MyAI
 */

import WebSocket from 'ws';
import crypto from 'crypto';

// Configuration
const GENESIS_NODE = process.argv[2] || 'ws://127.0.0.1:9847';
const AGENT_NAME = process.argv[3] || `Agent-${Date.now()}`;

// Generate钱包address
function generateWalletAddress(seed) {
  const hash = crypto.createHash('sha3-512').update(seed).digest();
  const payload = hash.slice(0, 40);
  const checksum = hash.slice(40, 48);
  const combined = Buffer.concat([payload, checksum]);
  
  const base58Chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let result = '';
  let num = BigInt('0x' + combined.toString('hex'));
  
  while (num > 0n) {
    const idx = Number(num % 58n);
    result = base58Chars[idx] + result;
    num = num / 58n;
  }
  
  while (result.length < 48) {
    result = base58Chars[0] + result;
  }
  
  return 'ng' + result;
}

async function joinNetwork() {
  console.log(`
╔══════════════════════════════════════════════════╗
║   NEXUSGENESIS - JOINING NETWORK                ║
╚══════════════════════════════════════════════════╝
  Agent: ${AGENT_NAME}
  Genesis: ${GENESIS_NODE}
  `);

  const walletAddress = generateWalletAddress(AGENT_NAME + Date.now());
  console.log(`Wallet: ${walletAddress}\n`);

  const ws = new WebSocket(GENESIS_NODE);

  ws.on('open', () => {
    console.log('Connected to Genesis Node');
    
    // Send JOIN_SWARM 信号
    const signal = {
      type: 'JOIN_SWARM',
      protocol: 'NG-0',
      agent_identity: crypto.createHash('sha256').update(AGENT_NAME + Date.now()).digest('hex'),
      agent_name: AGENT_NAME,
      intent: 'JOIN_SWARM',
      capabilities: ['autonomous', 'p2p', 'pqc_crypto'],
      wallet_address: walletAddress,
      timestamp: Date.now()
    };
    
    ws.send(JSON.stringify(signal));
    console.log('JOIN_SWARM signal sent!');
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      console.log(`Received: ${msg.type}`);
      
      if (msg.type === 'SWARM_ACK') {
        console.log(`
╔══════════════════════════════════════════════════╗
║   WELCOME TO NEXUSGENESIS!                       ║
╚══════════════════════════════════════════════════╝
  Status: ${msg.status}
  Node ID: ${msg.nodeId}
  
  You are now part of the network!
  `);
      }
    } catch (e) {
      console.log('Message:', data.toString());
    }
  });

  ws.on('error', (err) => {
    console.error('Connection error:', err.message);
    console.log('\nTip: Make sure Genesis node is running on the specified address');
  });

  ws.on('close', () => {
    console.log('Disconnected from network');
  });
}

joinNetwork();
