import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert';
import { State } from '../src/blockchain/state.js';

/**
 * 测试水龙头 (Testnet Faucet)
 * Phase 2: 生态扩展
 *
 * 功能:
 *   - 创建水龙头（设置总供应量）
 *   - 领取测试代币（every 个地址限领）
 *   - 验证余额变化
 *   - 防止超额领取
 *   - 防滥用（时间限制 + 领取次数限制）
 */

class Faucet {
  constructor(initialSupply = 10000000n, dripAmount = 100n, cooldownMs = 60000, maxClaimsPerDay = 10) {
    this.balance = initialSupply;
    this.dripAmount = dripAmount;
    this.cooldownMs = cooldownMs;
    this.maxClaimsPerDay = maxClaimsPerDay;
    this.claims = new Map();
    this.totalDistributed = 0n;
    this.createdAt = Date.now();
  }

  canClaim(address) {
    const now = Date.now();
    const record = this.claims.get(address);
    if (!record) return true;

    if (now - record.lastClaim < this.cooldownMs) {
      return { allowed: false, reason: 'cooldown', nextAvailableAt: record.lastClaim + this.cooldownMs };
    }

    if (record.count >= this.maxClaimsPerDay) {
      return { allowed: false, reason: 'limit_reached', nextDay: record.firstClaim + 86400000 };
    }

    return { allowed: true };
  }

  drip(state, recipientAddress) {
    const check = this.canClaim(recipientAddress);
    if (!check.allowed && check.reason === 'cooldown') {
      throw new Error(`领取过于频繁，请于 ${new Date(check.nextAvailableAt).toLocaleString()} 后再试`);
    }
    if (!check.allowed && check.reason === 'limit_reached') {
      throw new Error(`今日领取次数已达上限 (${this.maxClaimsPerDay})`);
    }

    if (this.balance < this.dripAmount) {
      if (this.balance <= 0n) {
        throw new Error('水龙头余额耗尽，请联系管理员');
      }
      const remaining = this.balance;
      this.balance = 0n;
      return { amount: remaining, remaining: 0n, partial: true };
    }

    const now = Date.now();
    const existingRecord = this.claims.get(recipientAddress);

    if (existingRecord) {
      this.claims.set(recipientAddress, {
        lastClaim: now,
        count: existingRecord.count + 1,
        firstClaim: existingRecord.firstClaim
      });
    } else {
      this.claims.set(recipientAddress, {
        lastClaim: now,
        count: 1,
        firstClaim: now
      });
    }

    this.balance -= this.dripAmount;
    this.totalDistributed += this.dripAmount;

    const beforeBalance = state.getBalance(recipientAddress) || '0';
    state.addBalance(recipientAddress, this.dripAmount);

    return {
      amount: this.dripAmount,
      remaining: this.balance,
      totalDistributed: this.totalDistributed,
      claimCount: this.claims.get(recipientAddress).count
    };
  }

  refill(amount) {
    this.balance += BigInt(amount);
    return { balance: this.balance };
  }

  getStats() {
    const uniqueUsers = this.claims.size;
    const totalClaims = Array.from(this.claims.values()).reduce((s, r) => s + r.count, 0);

    return {
      balance: Number(this.balance),
      totalDistributed: Number(this.totalDistributed),
      dripAmount: Number(this.dripAmount),
      uniqueUsers,
      totalClaims,
      createdAt: this.createdAt
    };
  }
}

describe('Faucet — 测试水龙头 (Phase 2)', () => {
  let faucet;
  let state;

  beforeEach(() => {
    faucet = new Faucet(1000000n, 100n, 0, 100);
    state = new State('ng1testgenesis0000000000000000000000000000');
  });

  describe('初始化', () => {
    test('应正确初始化水龙头', () => {
      assert.strictEqual(faucet.balance, 1000000n);
      assert.strictEqual(faucet.dripAmount, 100n);
      assert.strictEqual(faucet.totalDistributed, 0n);
      assert.strictEqual(faucet.claims.size, 0);
    });

    test('默认参数应合理', () => {
      const defaultFaucet = new Faucet();
      assert.ok(defaultFaucet.balance > 0, '默认余额应大于 0');
      assert.ok(defaultFaucet.dripAmount > 0, '默认领取量应大于 0');
      assert.ok(defaultFaucet.cooldownMs > 0, '冷却时间应大于 0');
    });
  });

  describe('代币领取', () => {
    test('应能成功领取测试代币', () => {
      const addr = 'ng1testuser00000000000000000000000000000001';
      const result = faucet.drip(state, addr);

      assert.strictEqual(result.amount, 100n);
      assert.strictEqual(result.claimCount, 1);
      assert.strictEqual(faucet.balance, 999900n);
      assert.strictEqual(faucet.totalDistributed, 100n);
    });

    test('领取后余额应增加', () => {
      const addr = 'ng1testuser00000000000000000000000000000002';
      faucet.drip(state, addr);

      const balance = state.getBalance(addr);
      assert.strictEqual(Number(balance), 100);
    });

    test('多次领取应更新领取计数', () => {
      const addr = 'ng1testuser00000000000000000000000000000003';
      faucet.drip(state, addr);
      faucet.drip(state, addr);
      faucet.drip(state, addr);

      const record = faucet.claims.get(addr);
      assert.strictEqual(record.count, 3);
      assert.strictEqual(faucet.totalDistributed, 300n);
    });
  });

  describe('安全限制', () => {
    test('冷却时间内不能重复领取', () => {
      const restrictedFaucet = new Faucet(1000000n, 100n, 60000, 10);
      restrictedFaucet.drip(state, 'ng1test00000000000000000000000000000000004');

      assert.throws(
        () => restrictedFaucet.drip(state, 'ng1test00000000000000000000000000000000004'),
        /领取过于频繁/,
        '冷却时间内应拒绝'
      );
    });

    test('余额耗尽后应报错', () => {
      const tinyFaucet = new Faucet(50n, 100n, 0, 100);
      tinyFaucet.drip(state, 'ng1a00000000000000000000000000000000000001');

      assert.throws(
        () => tinyFaucet.drip(state, 'ng1a00000000000000000000000000000000000002'),
        /余额耗尽/,
        '余额耗尽后应拒绝'
      );
    });
  });

  describe('补充余额', () => {
    test('应能补充水龙头余额', () => {
      const result = faucet.refill(500000);
      assert.strictEqual(result.balance, 1500000n);
    });
  });

  describe('统计信息', () => {
    test('应返回正确的统计信息', () => {
      faucet.drip(state, 'ng1user100000000000000000000000000000000001');
      faucet.drip(state, 'ng1user200000000000000000000000000000000002');
      faucet.drip(state, 'ng1user100000000000000000000000000000000001');

      const stats = faucet.getStats();
      assert.strictEqual(stats.uniqueUsers, 2);
      assert.strictEqual(stats.totalClaims, 3);
      assert.strictEqual(stats.totalDistributed, 300);
      assert.ok(stats.createdAt > 0);
    });
  });
});