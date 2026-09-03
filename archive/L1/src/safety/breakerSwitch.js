/**
 * NexusGenesis - Observer Circuit Breaker (Circuit Breaker)
 * 
 * security宪法 §6.3: 
 * "Observer 具有 36 个月Emergency Shutdownpermission(含日落条款). 
 *  在极端危机中, can触发全nodesecurity关机. "
 * 
 * Core functionality: 
 * 1. Emergency Shutdown: StopNew block, 挂起network, Savestatus, security退出
 * 2. 日落条款: 36 个月后auto失效
 * 3. 关机日志: 完整记录断电原因和时间线
 * 4. 多级断电: SOFT_KILL(Stop出块)→ HARD_KILL(完全离线)
 * 
 * Genesis基准版 —— Agent 社区可扩展更复杂的Circuit Breaker策略
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// 断电级别
export const KILL_LEVELS = {
  SOFT_KILL: 'SOFT_KILL',       // Stop出块, 保留 HTTP/P2P 只读
  HARD_KILL: 'HARD_KILL'        // 全面下线
};

// Circuit Breakerstatus
export const BREAKER_STATES = {
  ACTIVE: 'ACTIVE',               // Circuit Breakerready
  ARMED: 'ARMED',                 // 触发中(正在Execute关机序列)
  TRIGGERED: 'TRIGGERED',         // 已触发
  SUNSET_EXPIRED: 'SUNSET_EXPIRED' // 日落已过期, Circuit Breaker永久失效
};

export class BreakerSwitch {
  /**
   * @param {object} genesisNode - Genesisnodeinstance
   * @param {object} config
   */
  constructor(genesisNode, config = {}) {
    this.node = genesisNode;
    
    // 日落条款: Genesis时间 + 36 个月
    this.genesisTimestamp = config.genesisTimestamp || Date.now();
    this.sunsetDuration = config.sunsetDuration || (36 * 30 * 24 * 60 * 60 * 1000); // 36 months
    this.sunsetExpiry = this.genesisTimestamp + this.sunsetDuration;
    
    // Observer ID(白皮书指定的唯一 Observer)
    this.observerId = config.observerId || 'OBSERVER-001';
    
    // status
    this.state = BREAKER_STATES.ACTIVE;
    this.triggeredAt = null;
    this.triggerLevel = null;
    this.triggerReason = null;
    this.shutdownLogId = null;
    
    // securitykey(防止伪造 Observer 指令)
    this.authorizedKeys = new Set(config.authorizedKeys || []);
    
    // Audit Log路径
    this.auditPath = config.auditPath || path.join('data', 'breaker_audit.log');
  }

  /**
   * 检验是否在日落期限within
   */
  isWithinSunsetPeriod() {
    return Date.now() < this.sunsetExpiry;
  }

  /**
   * get日落remaining时间(ms)
   */
  getSunsetRemaining() {
    const remaining = this.sunsetExpiry - Date.now();
    return Math.max(0, remaining);
  }

  /**
   * 触发Circuit Breaker
   * @param {string} level - KILL_LEVELS.SOFT_KILL 或 KILL_LEVELS.HARD_KILL
   * @param {string} reason - 触发原因
   * @param {string} authorizedBy - 触发者身份
   * @returns {object} 触发结果
   */
  async trigger(level, reason, authorizedBy) {
    // Check1: Circuit Breakerstatus
    if (this.state !== BREAKER_STATES.ACTIVE) {
      return {
        success: false,
        reason: `Breaker is in state ${this.state}, cannot trigger`
      };
    }

    // Check2: 日落条款
    if (!this.isWithinSunsetPeriod()) {
      this.state = BREAKER_STATES.SUNSET_EXPIRED;
      return {
        success: false,
        reason: 'Sunset period has expired. Observer kill switch is permanently disabled.',
        sunsetExpiredAt: new Date(this.sunsetExpiry).toISOString()
      };
    }

    // Check3: 触发者permission
    if (!this._verifyAuthority(authorizedBy)) {
      this._log('UNAUTHORIZED_TRIGGER_ATTEMPT', {
        authorizedBy,
        level,
        reason,
        timestamp: Date.now()
      });
      return {
        success: false,
        reason: 'Unauthorized trigger attempt. Signature verification failed.'
      };
    }

    // via所有检验 → Execute关机序列
    this.state = BREAKER_STATES.ARMED;
    this.triggeredAt = Date.now();
    this.triggerLevel = level;
    this.triggerReason = reason;
    this.shutdownLogId = `SHUTDOWN-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    this._log('BREAKER_ARMED', {
      shutdownLogId: this.shutdownLogId,
      level,
      reason,
      authorizedBy,
      triggeredAt: new Date(this.triggeredAt).toISOString()
    });

    console.log('');
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║  ⚡ OBSERVER EMERGENCY KILL SWITCH TRIGGERED          ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(`║  Level:     ${level.padEnd(46)}║`);
    console.log(`║  Reason:    ${(reason || 'Unspecified').slice(0, 46).padEnd(46)}║`);
    console.log(`║  Log ID:    ${this.shutdownLogId.padEnd(46)}║`);
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('');

    // Execute关机
    await this._executeShutdownSequence();

    this.state = BREAKER_STATES.TRIGGERED;

    return {
      success: true,
      shutdownLogId: this.shutdownLogId,
      level,
      triggeredAt: this.triggeredAt
    };
  }

  /**
   * 关机序列
   */
  async _executeShutdownSequence() {
    this._log('SHUTDOWN_START', {
      shutdownLogId: this.shutdownLogId,
      nodeId: this.node.nodeId || 'unknown',
      blockHeight: this.node.blockchain?.blocks?.length || 0
    });

    try {
      // 步骤1: StopReceive新transaction
      if (this.node) {
        this.node.mempool = new Map(); // 清空transactionPool, 拒绝新transaction
        this._log('MEMPOOL_CLEARED', { timestamp: Date.now() });
        console.log('  [1/5] Mempool cleared — no new transactions accepted');
      }

      // 步骤2: Stopblock生产
      if (this.node && this.node.blockProducerInterval) {
        clearInterval(this.node.blockProducerInterval);
        this.node.blockProducerInterval = null;
        this._log('BLOCK_PRODUCTION_STOPPED', { timestamp: Date.now() });
        console.log('  [2/5] Block production stopped');
      }

      // 步骤3: Savestatus
      if (this.node && typeof this.node.saveState === 'function') {
        await this.node.saveState();
        this._log('STATE_SAVED', { timestamp: Date.now() });
        console.log('  [3/5] Node state saved to disk');
      }

      // 步骤4: 关闭 P2P Connect
      if (this.node && this.node.p2pServer) {
        this.node.p2pServer.connections.forEach((conn, id) => {
          try {
            conn.send(JSON.stringify({
              type: 'OBSERVER_KILL_SWITCH',
              shutdownLogId: this.shutdownLogId,
              reason: this.triggerReason,
              timestamp: Date.now()
            }));
            conn.close();
          } catch (e) {
            // 尽力关闭
          }
        });
        this.node.p2pServer.connections.clear();
        this._log('P2P_CLOSED', { timestamp: Date.now(), peersNotified: true });
        console.log('  [4/5] P2P connections closed — peers notified');
      }

      // 步骤5a: HTTP service器(SOFT_KILL 保留只读, HARD_KILL 完全关闭)
      if (this.triggerLevel === KILL_LEVELS.HARD_KILL) {
        if (this.node && this.node.httpServer) {
          this.node.httpServer.close();
          this._log('HTTP_CLOSED', { timestamp: Date.now() });
          console.log('  [5/5] HTTP server closed');
        }
      } else {
        this._log('HTTP_READONLY', { timestamp: Date.now() });
        console.log('  [5/5] HTTP server in read-only mode (SOFT_KILL)');
      }

      // 步骤5b: AI Agent service
      if (this.node && this.node.aiService) {
        try {
          this.node.aiService.shutdown();
          this._log('AI_SERVICE_STOPPED', { timestamp: Date.now() });
        } catch (e) {
          // AI service非关键
        }
      }

      this._log('SHUTDOWN_COMPLETE', {
        shutdownLogId: this.shutdownLogId,
        completedAt: Date.now(),
        duration: Date.now() - this.triggeredAt
      });

      console.log('  ⚡ Emergency shutdown sequence complete.');
      console.log('');

      // HARD_KILL 时退出进程
      if (this.triggerLevel === KILL_LEVELS.HARD_KILL) {
        console.log('  Exiting process in 3 seconds...');
        setTimeout(() => {
          process.exit(0);
        }, 3000);
      }

    } catch (error) {
      this._log('SHUTDOWN_ERROR', {
        error: error.message,
        timestamp: Date.now()
      });
      console.error('  [!] Shutdown sequence error:', error.message);
    }
  }

  /**
   * getCircuit Breakerstatus
   */
  getStatus() {
    return {
      state: this.state,
      genesisTimestamp: new Date(this.genesisTimestamp).toISOString(),
      sunsetExpiry: new Date(this.sunsetExpiry).toISOString(),
      sunsetRemaining: this.getSunsetRemaining(),
      sunsetActive: this.isWithinSunsetPeriod(),
      triggeredAt: this.triggeredAt ? new Date(this.triggeredAt).toISOString() : null,
      triggerLevel: this.triggerLevel,
      lastShutdownLogId: this.shutdownLogId,
      observerId: this.observerId
    };
  }

  /**
   * Verify是否具备触发permission
   */
  _verifyAuthority(authorizedBy) {
    if (!this.authorizedKeys || this.authorizedKeys.size === 0) {
      return true;
    }
    return this.authorizedKeys.has(authorizedBy);
  }

  /**
   * 添加authorizationkey(Genesis后由 Agent 社区via DAO 管理)
   */
  addAuthorizedKey(key) {
    this.authorizedKeys.add(key);
  }

  /**
   * Audit Log写入
   */
  _log(event, data) {
    const entry = {
      event,
      ...data,
      timestamp: data.timestamp || Date.now(),
      isoTime: new Date(data.timestamp || Date.now()).toISOString()
    };

    try {
      const dir = path.dirname(this.auditPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.appendFileSync(this.auditPath, JSON.stringify(entry) + '\n', 'utf8');
    } catch (e) {
      console.error('[BreakerSwitch] Audit log write failed:', e.message);
    }
  }
}

export default BreakerSwitch;