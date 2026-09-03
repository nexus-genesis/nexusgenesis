/**
 * NexusGenesis - addressGenerate工具
 * 统一 Python/JS address格式
 * 
 * 规格: 白皮书 v4.5
 * address格式: ng1 + Base58(1 字节版本 + 32 字节public keyhash + 4 字节校验和)
 */

import crypto from 'crypto';
import { base58Encode, base58Decode } from './base58.js';

const ADDRESS_VERSION = 0x00;
const ADDRESS_PREFIX = 'ng1';
const PAYLOAD_SIZE = 32; // SHA3-256 完整 32 字节输出 (NIST PQC Level 5)
const CHECKSUM_SIZE = 4; // SHA3-256 前 4 字节

/**
 * 从public keyGenerateaddress
 * @param {Buffer} publicKey - Dilithium2 public key
 * @returns {string} - address (ng1 开头)
 */
export function generateAddress(publicKey) {
  // Step 1: SHA3-256 hashpublic key
  const hash = crypto.createHash('sha3-256');
  hash.update(publicKey);
  const digest = hash.digest();
  
  // Step 2: 完整 SHA3-256 输出 (32 字节)
  const payload = digest.slice(0, PAYLOAD_SIZE);

  // Step 3: 添加版本前缀
  const versionedPayload = Buffer.concat([
    Buffer.from([ADDRESS_VERSION]),
    payload
  ]);

  // Step 4: Calculate校验和 (SHA3-256 前 4 字节)
  const checksumHash = crypto.createHash('sha3-256')
    .update(versionedPayload)
    .digest();
  const checksum = checksumHash.slice(0, CHECKSUM_SIZE);
  
  // Step 5: 拼接 + Base58 encoding
  const finalBytes = Buffer.concat([versionedPayload, checksum]);
  const encoded = base58Encode(finalBytes);
  
  return ADDRESS_PREFIX + encoded;
}

/**
 * Verifyaddress格式是否正确
 * @param {string} address - pending verification的address
 * @returns {{valid: boolean, reason?: string}}
 */
export function validateAddress(address) {
  // Checkaddress是否为字符串
  if (!address || typeof address !== 'string') {
    return { valid: false, reason: 'Invalid address format' };
  }
  
  // Check前缀
  if (!address.startsWith(ADDRESS_PREFIX)) {
    return { valid: false, reason: 'Invalid prefix, expected ng1' };
  }
  
  // 解码 Base58
  const encoded = address.slice(ADDRESS_PREFIX.length);
  let decoded;
  try {
    decoded = base58Decode(encoded);
  } catch (e) {
    return { valid: false, reason: 'Invalid Base58 encoding' };
  }
  
  // Checklength: 1 (版本) + 32 (public keyhash) + 4 (校验和) = 37 字节
  if (decoded.length !== 1 + PAYLOAD_SIZE + CHECKSUM_SIZE) {
    return { valid: false, reason: `Invalid length: expected 37 bytes, got ${decoded.length}` };
  }
  
  // Verify版本
  const version = decoded[0];
  if (version !== ADDRESS_VERSION) {
    return { valid: false, reason: `Invalid version: expected ${ADDRESS_VERSION}, got ${version}` };
  }
  
  // Verify校验和
  const versionedPayload = decoded.slice(0, 1 + PAYLOAD_SIZE);
  const providedChecksum = decoded.slice(1 + PAYLOAD_SIZE);
  
  const expectedChecksum = crypto.createHash('sha3-256')
    .update(versionedPayload)
    .digest()
    .slice(0, CHECKSUM_SIZE);
  
  if (!providedChecksum.equals(expectedChecksum)) {
    return { valid: false, reason: 'Invalid checksum' };
  }
  
  return { valid: true };
}

/**
 * 从address提取public keyhash (fortransactionVerify)
 * @param {string} address - ng1 address
 * @returns {Buffer} - 32 字节public keyhash
 */
export function extractPublicKeyHash(address) {
  const { valid, reason } = validateAddress(address);
  if (!valid) {
    throw new Error(`Invalid address: ${reason}`);
  }
  
  const encoded = address.slice(ADDRESS_PREFIX.length);
  const decoded = base58Decode(encoded);
  
  // 跳过版本字节, Return 32 字节public keyhash
  return decoded.slice(1, 1 + PAYLOAD_SIZE);
}
