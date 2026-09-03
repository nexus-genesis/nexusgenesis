import crypto from 'crypto';
import { validateAddress } from '../wallet/addressUtils.js';
import { signSpecialTransactionWithWallet } from './transactionSigning.js';

// P2: Validator graceful leave / unstake.
// Returns the full locked stake from the staking escrow back to the
// validator's on-chain balance and clears validator status.
export function createValidatorLeaveTransaction(from, leaveInfo) {
  if (!from || !leaveInfo.agent_identity) {
    throw new Error('Missing required fields: from, agent_identity');
  }

  const timestamp = Date.now();
  const id = crypto.createHash('sha256')
    .update(`validator-leave-${from}-${leaveInfo.agent_identity}-${timestamp}`)
    .digest('hex');

  return {
    id,
    type: 'VALIDATOR_LEAVE',
    tx_type: 'VALIDATOR_LEAVE',
    from,
    to: from,
    amount: '0',
    fee: '1',
    public_key: leaveInfo.public_key || '',
    payload: {
      agent_identity: leaveInfo.agent_identity,
      metadata: leaveInfo.metadata || ''
    },
    timestamp,
    nonce: Math.floor(Math.random() * 1000000)
  };
}

export async function createSignedValidatorLeaveTransaction(wallet, leaveInfo) {
  const transaction = createValidatorLeaveTransaction(wallet.address, {
    ...leaveInfo,
    public_key: leaveInfo.public_key || wallet.publicKey.toString('hex')
  });
  transaction.signature = await signSpecialTransactionWithWallet(transaction, wallet);
  return transaction;
}

export function validateValidatorLeaveTransaction(transaction) {
  if (transaction.type !== 'VALIDATOR_LEAVE' && transaction.tx_type !== 'VALIDATOR_LEAVE') {
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

  return { valid: true };
}

export default {
  createValidatorLeaveTransaction,
  createSignedValidatorLeaveTransaction,
  validateValidatorLeaveTransaction
};
