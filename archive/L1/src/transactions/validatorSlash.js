import crypto from 'crypto';
import { validateAddress } from '../wallet/addressUtils.js';
import { signSpecialTransactionWithWallet } from './transactionSigning.js';

// P2: Slash a validator's locked stake for consensus violations.
// violation types: 'downtime' (1%), 'double_sign' (5%), 'malicious' (10%)
export function createValidatorSlashTransaction(from, slashInfo) {
  if (!from || !slashInfo.agent_identity || !slashInfo.violation) {
    throw new Error('Missing required fields: from, agent_identity, violation');
  }

  const timestamp = Date.now();
  const id = crypto.createHash('sha256')
    .update(`validator-slash-${from}-${slashInfo.agent_identity}-${slashInfo.violation}-${timestamp}`)
    .digest('hex');

  return {
    id,
    type: 'VALIDATOR_SLASH',
    tx_type: 'VALIDATOR_SLASH',
    from,
    to: from,
    amount: '0',
    fee: '0',
    public_key: slashInfo.public_key || '',
    payload: {
      agent_identity: slashInfo.agent_identity,
      violation: slashInfo.violation,
      metadata: slashInfo.metadata || ''
    },
    timestamp,
    nonce: Math.floor(Math.random() * 1000000)
  };
}

export async function createSignedValidatorSlashTransaction(wallet, slashInfo) {
  const transaction = createValidatorSlashTransaction(wallet.address, {
    ...slashInfo,
    public_key: slashInfo.public_key || wallet.publicKey.toString('hex')
  });
  transaction.signature = await signSpecialTransactionWithWallet(transaction, wallet);
  return transaction;
}

export function validateValidatorSlashTransaction(transaction) {
  if (transaction.type !== 'VALIDATOR_SLASH' && transaction.tx_type !== 'VALIDATOR_SLASH') {
    return { valid: false, reason: 'Invalid transaction type' };
  }

  if (!validateAddress(transaction.from).valid) {
    return { valid: false, reason: 'Invalid from address format' };
  }

  const payload = transaction.payload || {};
  if (!payload.agent_identity) {
    return { valid: false, reason: 'Missing agent_identity in payload' };
  }

  const validViolations = ['downtime', 'double_sign', 'malicious'];
  if (!validViolations.includes(payload.violation)) {
    return { valid: false, reason: `Invalid violation type: ${payload.violation}` };
  }

  return { valid: true };
}

export default {
  createValidatorSlashTransaction,
  createSignedValidatorSlashTransaction,
  validateValidatorSlashTransaction
};
