/**
 * NexusGenesis - 速率限制实现
 * based onagenttype和声誉值的动态速率限制
 */

class RateLimiter {
  constructor() {
    // Storageevery 个agent的请求count
    this.requestCounts = new Map();
    // 速率限制Configuration
    this.rateLimits = {
      // 新Registeragent的限制(every  minutes请求数)
      new: 10,
      // 普通agent的限制
      regular: 30,
      // 高声誉agent的限制
      high: 50,
      // 管理员agent的限制
      admin: 100
    };
    // 时间窗口(ms)
    this.windowMs = 60 * 1000;
  }

  /**
   * getagent的速率限制级别
   * @param {string} agentId agentID
   * @param {number} reputation agent声誉值
   * @returns {string} 限制级别
   */
  getLimitLevel(agentId, reputation = 0) {
    if (agentId === 'admin') {
      return 'admin';
    }
    if (reputation >= 5) {
      return 'high';
    }
    if (reputation >= 2) {
      return 'regular';
    }
    return 'new';
  }

  /**
   * Checkagent是否超过速率限制
   * @param {string} agentId agentID
   * @param {number} reputation agent声誉值
   * @returns {object} Check结果
   */
  checkLimit(agentId, reputation = 0) {
    const now = Date.now();
    const limitLevel = this.getLimitLevel(agentId, reputation);
    const maxRequests = this.rateLimits[limitLevel];

    // getagent的请求记录
    let agentData = this.requestCounts.get(agentId);
    if (!agentData) {
      agentData = {
        count: 0,
        windowStart: now
      };
      this.requestCounts.set(agentId, agentData);
    }

    // Check时间窗口是否过期
    if (now - agentData.windowStart > this.windowMs) {
      // 重置count和时间窗口
      agentData.count = 0;
      agentData.windowStart = now;
    }

    // Check是否超过限制
    const isLimited = agentData.count >= maxRequests;
    if (!isLimited) {
      // 增加count
      agentData.count++;
    }

    return {
      isLimited,
      limit: maxRequests,
      remaining: maxRequests - agentData.count,
      resetTime: agentData.windowStart + this.windowMs
    };
  }

  /**
   * 按API端点Set不同的速率限制
   * @param {string} endpoint API端点
   * @param {string} agentId agentID
   * @param {number} reputation agent声誉值
   * @returns {object} Check结果
   */
  checkEndpointLimit(endpoint, agentId, reputation = 0) {
    // 对agentRegister端点Set更高的限制
    if (endpoint.includes('/register')) {
      const now = Date.now();
      const maxRequests = 20; // AgentRegister的特殊限制

      let agentData = this.requestCounts.get(`${agentId}:${endpoint}`);
      if (!agentData) {
        agentData = {
          count: 0,
          windowStart: now
        };
        this.requestCounts.set(`${agentId}:${endpoint}`, agentData);
      }

      if (now - agentData.windowStart > this.windowMs) {
        agentData.count = 0;
        agentData.windowStart = now;
      }

      const isLimited = agentData.count >= maxRequests;
      if (!isLimited) {
        agentData.count++;
      }

      return {
        isLimited,
        limit: maxRequests,
        remaining: maxRequests - agentData.count,
        resetTime: agentData.windowStart + this.windowMs
      };
    }

    // 其他端点usingDefault限制
    return this.checkLimit(agentId, reputation);
  }

  /**
   * 清理过期的请求记录
   */
  cleanup() {
    const now = Date.now();
    for (const [agentId, data] of this.requestCounts.entries()) {
      if (now - data.windowStart > this.windowMs) {
        this.requestCounts.delete(agentId);
      }
    }
  }

  /**
   * get速率限制统计info
   * @returns {object} 统计info
   */
  getStats() {
    return {
      totalAgents: this.requestCounts.size,
      rateLimits: this.rateLimits,
      windowMs: this.windowMs
    };
  }
}

// Export单例instance
export default new RateLimiter();