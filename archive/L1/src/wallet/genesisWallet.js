/**
 * NexusGenesis - PQC Wallet Protocol
 * Post-quantum wallet implementation with CRYSTALS-Dilithium2 (NIST FIPS 204)
 * 
 * Specifications:
 * - Algorithm: CRYSTALS-Dilithium2 (ml_dsa44) via @noble/post-quantum
 * - Address format: ng + Base58
 * - Public key: 1312 bytes (Dilithium2)
 * - Signature: 2420 bytes (Dilithium2)
 */

import crypto from 'crypto';
import { encodeBase58, decodeBase58 } from './utils.js';
import { generateKeyPair, sign as pqcSign, verify as pqcVerify, hash } from '../crypto/pqc.js';
import { generateAddress } from './addressUtils.js';

const NGEN_SYMBOL = 'NGEN';
const TOTAL_SUPPLY = 1_000_000_000;

class GenesisWallet {
  constructor() {
    this.address = null;
    this.publicKey = null;
    this.secretKey = null;
    this.balance = 0;
  }
}

export async function generate() {
  const { publicKey, privateKey } = await generateKeyPair();
  
  const wallet = new GenesisWallet();
  wallet.publicKey = Buffer.from(publicKey).toString('hex');
  wallet.secretKey = Buffer.from(privateKey).toString('hex');
  
  wallet.address = generateAddress(Buffer.from(publicKey));
  
  wallet.balance = 50_000_000;
  
  return wallet;
}

// Sign message using CRYSTALS-Dilithium2
export async function sign(wallet, message) {
  const secretKeyBytes = Buffer.from(wallet.secretKey, 'hex');
  const signature = await pqcSign(message, secretKeyBytes);
  return Buffer.from(signature).toString('hex');
}

// Verify signature using CRYSTALS-Dilithium2
export async function verify(publicKeyHex, message, signatureHex) {
  const publicKey = Buffer.from(publicKeyHex, 'hex');
  const signature = Buffer.from(signatureHex, 'hex');
  return await pqcVerify(message, signature, publicKey);
}

// Create transaction
export async function createTransaction(fromWallet, toAddress, amount, memo = '') {
  if (fromWallet.balance < amount) {
    throw new Error('Insufficient NGEN balance');
  }
  
  const tx = {
    from: fromWallet.address,
    to: toAddress,
    amount: amount,
    memo: memo,
    timestamp: Date.now(),
    fee: Math.floor(amount * 0.001), // 0.1% metabolic tax
  };
  
  // Generate transaction ID
  const txData = JSON.stringify(tx);
  tx.id = crypto.createHash('sha3-256').update(txData).digest('hex');
  
  // Sign with Dilithium2
  tx.signature = await sign(fromWallet, txData);
  
  return tx;
}

export const genesisWallet = {
  generate,
  sign,
  verify,
  createTransaction
};