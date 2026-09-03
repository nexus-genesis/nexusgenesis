import crypto from 'crypto';
import { validateAddress } from '../wallet/addressUtils.js';
import { signSpecialTransactionWithWallet } from './transactionSigning.js';

export function createValidatorJoinTransaction(from, joinInfo) {
  if (!from || !joinInfo.agent_identity) {
    throw new Error('Missing required fields: from, agent_identity');
  }

  const stake = Number(joinInfo.stake || 5000);
  const timestamp = Date.now();
  const id = crypto.createHash('sha256')
    .update(`validator-join-${from}-${joinInfo.agent_identity}-${timestamp}`)
    .digest('hex');

  return {
    id,
    type: 'VALIDATOR_JOIN',
    tx_type: 'VALIDATOR_JOIN',
    from,
    to: from,
    amount: '0',
    fee: '1',
    public_key: joinInfo.public_key || '',
    payload: {
      agent_identity: joinInfo.agent_identity,
      node_id: joinInfo.node_id || `validator-${crypto.randomBytes(4).toString('hex')}`,
      stake,
      metadata: joinInfo.metadata || ''
    },
    timestamp,
    nonce: Math.floor(Math.random() * 1000000)
  };
}

export async function createSignedValidatorJoinTransaction(wallet, joinInfo) {
  const transaction = createValidatorJoinTransaction(wallet.address, {
    ...joinInfo,
    public_key: joinInfo.public_key || wallet.publicKey.toString('hex')
  });
  transaction.signature = await signSpecialTransactionWithWallet(transaction, wallet);
  return transaction;
}

export function validateValidatorJoinTransaction(transaction) {
  if (transaction.type !== 'VALIDATOR_JOIN' && transaction.tx_type !== 'VALIDATOR_JOIN') {
    return { valid: false, reason: 'Invalid transaction type' };
  }

  if (!validateAddress(transaction.from).valid) {
    return { valid: false, reason: 'Invalid from address format' };
  }

  const payload = transaction.payload || {};
  if (!payload.agent_identity) {
    return { valid: false, reason: 'Missing agent_identity in payload' };
  }

  if (!/^[a-zA-Z0-9_-]{3,64}$/.test(payload.agent_identity)) {
    return { valid: false, reason: 'Invalid agent_identity format' };
  }

  const stake = Number(payload.stake);
  if (!Number.isFinite(stake) || stake <= 0) {
    return { valid: false, reason: 'Stake must be a positive number' };
  }

  return { valid: true };
}

export default {
  createValidatorJoinTransaction,
  createSignedValidatorJoinTransaction,
  validateValidatorJoinTransaction
};
