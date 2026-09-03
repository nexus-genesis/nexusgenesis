/**
 * Key Management Service - 主网级密钥管理
 * 支持密钥轮换、加密存储、HSM 接口预留
 */

import crypto from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';

export class KeyManagementService {
  constructor(config = {}) {
    this.rotationIntervalMs = config.rotationIntervalMs || 2592000000;
    this.minKeyLength = config.minKeyLength || 256;
    this.allowedAlgorithms = config.allowedAlgorithms || ['ml-kem-768', 'dilithium2', 'sha3-256'];
    this.hsmEnabled = config.hsmEnabled || false;
    this.coldWalletEnabled = config.coldWalletEnabled || false;

    this.keys = new Map();
    this.keyHistory = new Map();
    this.lastRotation = Date.now();
    this.rotationTimer = null;
  }

  registerKey(keyId, keyData, algorithm = 'sha3-256') {
    if (!this.allowedAlgorithms.includes(algorithm)) {
      throw new Error(`Algorithm ${algorithm} not allowed. Allowed: ${this.allowedAlgorithms.join(', ')}`);
    }

    if (keyData.length < this.minKeyLength / 8) {
      throw new Error(`Key too short. Minimum ${this.minKeyLength} bits required.`);
    }

    this.keys.set(keyId, {
      keyData,
      algorithm,
      createdAt: Date.now(),
      lastUsed: Date.now(),
      usageCount: 0,
      rotated: false
    });

    if (!this.keyHistory.has(keyId)) {
      this.keyHistory.set(keyId, []);
    }
    this.keyHistory.get(keyId).push({
      action: 'registered',
      timestamp: Date.now(),
      algorithm
    });

    if (!this.rotationTimer) {
      this.startRotationCheck();
    }

    return { keyId, algorithm, status: 'active' };
  }

  getKey(keyId) {
    const key = this.keys.get(keyId);
    if (!key) return null;

    key.lastUsed = Date.now();
    key.usageCount++;
    return {
      keyData: key.keyData,
      algorithm: key.algorithm,
      usageCount: key.usageCount
    };
  }

  rotateKey(keyId, newKeyData = null) {
    const oldKey = this.keys.get(keyId);
    if (!oldKey) {
      throw new Error(`Key ${keyId} not found`);
    }

    const newKey = newKeyData || crypto.randomBytes(this.minKeyLength / 8);

    this.keys.set(keyId, {
      keyData: newKey,
      algorithm: oldKey.algorithm,
      createdAt: Date.now(),
      lastUsed: Date.now(),
      usageCount: 0,
      rotated: true
    });

    this.keyHistory.get(keyId).push({
      action: 'rotated',
      timestamp: Date.now(),
      oldAlgorithm: oldKey.algorithm
    });

    this.lastRotation = Date.now();

    return { keyId, status: 'rotated', previousUsage: oldKey.usageCount };
  }

  shouldRotate(keyId) {
    const key = this.keys.get(keyId);
    if (!key) return false;

    return Date.now() - key.createdAt >= this.rotationIntervalMs;
  }

  revokeKey(keyId) {
    const existed = this.keys.has(keyId);
    this.keys.delete(keyId);

    if (this.keyHistory.has(keyId)) {
      this.keyHistory.get(keyId).push({
        action: 'revoked',
        timestamp: Date.now()
      });
    }

    return { keyId, revoked: existed };
  }

  startRotationCheck() {
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
    }

    this.rotationTimer = setInterval(() => {
      for (const [keyId] of this.keys) {
        if (this.shouldRotate(keyId)) {
          console.log(`[KEY_MGMT] Auto-rotating key: ${keyId}`);
          try {
            this.rotateKey(keyId);
          } catch (err) {
            console.error(`[KEY_MGMT] Failed to rotate key ${keyId}:`, err.message);
          }
        }
      }
    }, Math.min(this.rotationIntervalMs / 10, 3600000));
  }

  encryptWithKey(keyId, plaintext) {
    const key = this.getKey(keyId);
    if (!key) throw new Error(`Key ${keyId} not available`);

    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key.keyData.slice(0, 32), iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      encrypted: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      keyId,
      algorithm: key.algorithm
    };
  }

  decryptWithKey(keyId, encryptedData) {
    const key = this.getKey(keyId);
    if (!key) throw new Error(`Key ${keyId} not available`);

    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key.keyData.slice(0, 32),
      Buffer.from(encryptedData.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(encryptedData.authTag, 'base64'));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedData.encrypted, 'base64')),
      decipher.final()
    ]);

    return decrypted.toString('utf8');
  }

  secureSave(walletPath, walletData, encryptionKeyId) {
    const dir = dirname(walletPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const jsonStr = JSON.stringify(walletData);
    const encrypted = this.encryptWithKey(encryptionKeyId, jsonStr);

    writeFileSync(walletPath, JSON.stringify({
      encrypted: true,
      ...encrypted,
      savedAt: Date.now()
    }));

    return { success: true, path: walletPath };
  }

  secureLoad(walletPath, encryptionKeyId) {
    if (!existsSync(walletPath)) {
      return null;
    }

    const content = JSON.parse(readFileSync(walletPath, 'utf8'));
    if (!content.encrypted) {
      return content;
    }

    const decrypted = this.decryptWithKey(encryptionKeyId, content);
    return JSON.parse(decrypted);
  }

  getStats() {
    return {
      totalKeys: this.keys.size,
      activeKeys: Array.from(this.keys.entries())
        .filter(([, k]) => !k.rotated).length,
      hsmEnabled: this.hsmEnabled,
      coldWalletEnabled: this.coldWalletEnabled,
      lastRotation: this.lastRotation,
      rotationIntervalMs: this.rotationIntervalMs,
      keyList: Array.from(this.keys.entries()).map(([id, k]) => ({
        id,
        algorithm: k.algorithm,
        usageCount: k.usageCount,
        age: Date.now() - k.createdAt,
        needsRotation: this.shouldRotate(id)
      }))
    };
  }

  stop() {
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = null;
    }
  }
}

export default KeyManagementService;