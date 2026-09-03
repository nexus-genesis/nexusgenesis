/**
 * Token Economy模型Simulator (P2-3)
 * 商业应用场景: Token供需建模, 通胀/通缩Simulation, 质押收益Calculate, 市值预测
 */

export class TokenEconomicsSimulator {
  constructor() {
    this.scenarios = new Map();
    this.defaultParams = {
      initialSupply: 1000000000,
      initialPrice: 1.0,
      annualInflation: 0.02,
      burnRate: 0.005,
      stakingRatio: 0.3,
      stakingAPY: 0.12,
      circulatingSupplyRatio: 0.6,
      dailyVolume: 10000000,
      marketSentiment: 0.5,
      adoptionRate: 0.05,
      competitorGrowth: 0.02
    };
  }

  /**
   * SimulationTokenEconomy模型
   * @param {object} params - Economyparameter
   * @param {number} months - Simulation月数
   * @returns {object} Simulation结果
   */
  simulate(params = {}, months = 24) {
    const p = { ...this.defaultParams, ...params };
    const results = [];
    let supply = p.initialSupply;
    let price = p.initialPrice;
    let stakedAmount = supply * p.stakingRatio;
    let circulatingSupply = supply * p.circulatingSupplyRatio;
    let marketCap = circulatingSupply * price;
    let totalBurned = 0;
    let totalStakingRewards = 0;

    for (let month = 1; month <= months; month++) {
      const monthlyInflation = supply * (p.annualInflation / 12);
      supply += monthlyInflation;

      const monthlyBurns = circulatingSupply * p.dailyVolume * 30 * p.burnRate / supply;
      totalBurned += monthlyBurns;
      supply -= monthlyBurns;

      const newStaked = monthlyInflation * p.stakingRatio;
      stakedAmount += newStaked;
      const monthlyRewards = stakedAmount * (p.stakingAPY / 12);
      totalStakingRewards += monthlyRewards;
      stakedAmount += monthlyRewards;

      circulatingSupply = supply - stakedAmount;

      const demandFactor = this._calculateDemandFactor(month, months, p);
      const supplyPressure = circulatingSupply / p.initialSupply;
      const priceChange = (demandFactor - supplyPressure) * 0.1 + 
                          (Math.random() - 0.5) * 0.02;

      price = Math.max(price * (1 + priceChange), 0.001);
      marketCap = circulatingSupply * price;

      const fdMarketCap = supply * price;

      results.push({
        month,
        totalSupply: Math.round(supply),
        circulatingSupply: Math.round(circulatingSupply),
        stakedAmount: Math.round(stakedAmount),
        stakingRatio: +(stakedAmount / supply).toFixed(4),
        price: +price.toFixed(6),
        marketCap: Math.round(marketCap),
        fdMarketCap: Math.round(fdMarketCap),
        monthlyInflation: Math.round(monthlyInflation),
        monthlyBurns: Math.round(monthlyBurns),
        totalBurned: Math.round(totalBurned),
        stakingRewards: Math.round(monthlyRewards),
        demandFactor: +demandFactor.toFixed(4)
      });
    }

    const lastMonth = results[results.length - 1];
    const firstMonth = results[0];

    return {
      params: p,
      months,
      results,
      summary: {
        finalSupply: lastMonth.totalSupply,
        finalPrice: lastMonth.price,
        finalMarketCap: lastMonth.marketCap,
        supplyChange: +((lastMonth.totalSupply / firstMonth.totalSupply - 1) * 100).toFixed(2),
        priceChange: +((lastMonth.price / firstMonth.price - 1) * 100).toFixed(2),
        marketCapChange: +((lastMonth.marketCap / firstMonth.marketCap - 1) * 100).toFixed(2),
        totalBurned,
        totalStakingRewards: Math.round(totalStakingRewards),
        finalStakingRatio: lastMonth.stakingRatio,
        averageMonthlyReturn: +((Math.pow(lastMonth.price / firstMonth.price, 1 / months) - 1) * 100).toFixed(2)
      }
    };
  }

  _calculateDemandFactor(month, totalMonths, params) {
    let factor = 1.0;
    factor += params.adoptionRate * (month / totalMonths);
    factor -= params.competitorGrowth * (month / totalMonths) * 0.5;
    factor += params.marketSentiment * 0.1;

    if (month > totalMonths * 0.3 && month < totalMonths * 0.7) {
      factor += 0.05;
    }

    if (month > totalMonths * 0.8) {
      factor += 0.03;
    }

    return Math.max(factor, 0.1);
  }

  /**
   * Calculate质押收益
   * @param {object} params
   * @returns {object}
   */
  calculateStakingReturns(params = {}) {
    const amount = params.amount || 10000;
    const apy = params.apy || this.defaultParams.stakingAPY;
    const lockMonths = params.lockMonths || 12;
    const compoundFrequency = params.compound || 12;

    const ratePerPeriod = apy / compoundFrequency;
    const totalPeriods = lockMonths * (compoundFrequency / 12);
    const finalAmount = amount * Math.pow(1 + ratePerPeriod, totalPeriods);
    const totalReward = finalAmount - amount;

    const monthlyResults = [];
    let balance = amount;
    for (let m = 1; m <= lockMonths; m++) {
      const periodsInMonth = compoundFrequency / 12;
      const monthlyReward = balance * ratePerPeriod * periodsInMonth;
      balance = balance * Math.pow(1 + ratePerPeriod, periodsInMonth);
      monthlyResults.push({
        month: m,
        balance: +balance.toFixed(2),
        monthlyReward: +monthlyReward.toFixed(2),
        cumulativeReward: +(balance - amount).toFixed(2)
      });
    }

    return {
      initialAmount: amount,
      apy,
      lockMonths,
      compoundFrequency,
      finalAmount: +finalAmount.toFixed(2),
      totalReward: +totalReward.toFixed(2),
      effectiveAPY: +((finalAmount / amount - 1) * 100).toFixed(2),
      roi: +((finalAmount / amount - 1) * 100).toFixed(2),
      monthlyBreakdown: monthlyResults
    };
  }

  /**
   * Simulation通缩/通胀场景
   * @param {object} params
   * @returns {object}
   */
  simulateInflationDeflation(params = {}) {
    const baseParams = { ...this.defaultParams, ...params };
    const scenarios = {};

    scenarios.deflationary = this.simulate(
      { ...baseParams, annualInflation: 0, burnRate: 0.01 }, 24
    );

    scenarios.stable = this.simulate(
      { ...baseParams, annualInflation: 0.02, burnRate: 0.005 }, 24
    );

    scenarios.inflationary = this.simulate(
      { ...baseParams, annualInflation: 0.08, burnRate: 0.001 }, 24
    );

    scenarios.hyperInflation = this.simulate(
      { ...baseParams, annualInflation: 0.20, burnRate: 0 }, 24
    );

    const comparison = {};
    for (const [name, result] of Object.entries(scenarios)) {
      comparison[name] = {
        finalSupply: result.summary.finalSupply,
        finalPrice: result.summary.finalPrice,
        finalMarketCap: result.summary.finalMarketCap,
        supplyChange: result.summary.supplyChange,
        priceChange: result.summary.priceChange
      };
    }

    return { scenarios, comparison };
  }

  /**
   * 市值预测
   * @param {object} params
   * @returns {object}
   */
  predictMarketCap(params = {}, months = 12) {
    const p = { ...this.defaultParams, ...params };
    const predictions = {
      conservative: this.simulate(
        { ...p, adoptionRate: 0.02, marketSentiment: 0.3 }, months
      ),
      moderate: this.simulate(
        { ...p, adoptionRate: 0.05, marketSentiment: 0.5 }, months
      ),
      optimistic: this.simulate(
        { ...p, adoptionRate: 0.10, marketSentiment: 0.7 }, months
      ),
      aggressive: this.simulate(
        { ...p, adoptionRate: 0.15, marketSentiment: 0.9 }, months
      )
    };

    const lastResults = {};
    for (const [scenario, result] of Object.entries(predictions)) {
      const last = result.results[result.results.length - 1];
      lastResults[scenario] = {
        price: last.price,
        marketCap: last.marketCap,
        supply: last.totalSupply,
        projectedROI: +((last.price / p.initialPrice - 1) * 100).toFixed(2)
      };
    }

    return { predictions, summary: lastResults, params: p, months };
  }

  /**
   * CalculateToken distribution模型
   * @param {object} allocation
   * @returns {object}
   */
  simulateAllocation(allocation = {}) {
    const alloc = {
      team: allocation.team || 15,
      investors: allocation.investors || 20,
      community: allocation.community || 30,
      ecosystem: allocation.ecosystem || 20,
      reserve: allocation.reserve || 10,
      advisors: allocation.advisors || 5
    };

    const total = Object.values(alloc).reduce((a, b) => a + b, 0);

    const vestingSchedules = {
      team: { cliffMonths: 12, vestingMonths: 36, tgeUnlock: 0 },
      investors: { cliffMonths: 6, vestingMonths: 24, tgeUnlock: 10 },
      community: { cliffMonths: 0, vestingMonths: 48, tgeUnlock: 20 },
      ecosystem: { cliffMonths: 0, vestingMonths: 36, tgeUnlock: 15 },
      reserve: { cliffMonths: 24, vestingMonths: 0, tgeUnlock: 0 },
      advisors: { cliffMonths: 12, vestingMonths: 24, tgeUnlock: 0 }
    };

    const circulatingOverTime = [];
    const totalSupply = 1000000000;

    for (let month = 0; month <= 48; month++) {
      let unlocked = 0;
      for (const [category, pct] of Object.entries(alloc)) {
        const schedule = vestingSchedules[category];
        const categoryAmount = totalSupply * (pct / 100);

        if (month === 0) {
          unlocked += categoryAmount * (schedule.tgeUnlock / 100);
          continue;
        }

        if (month < schedule.cliffMonths) continue;

        const vestingMonths = Math.min(month - schedule.cliffMonths, schedule.vestingMonths);
        if (schedule.vestingMonths > 0) {
          const vested = categoryAmount * (1 - schedule.tgeUnlock / 100) * 
                         (vestingMonths / schedule.vestingMonths);
          unlocked += categoryAmount * (schedule.tgeUnlock / 100) + vested;
        } else {
          unlocked += categoryAmount;
        }
      }

      circulatingOverTime.push({
        month,
        unlocked: Math.round(unlocked),
        percentage: +((unlocked / totalSupply) * 100).toFixed(2)
      });
    }

    return {
      allocation: alloc,
      total: totalSupply,
      vestingSchedules,
      circulatingOverTime,
      tgeUnlocked: circulatingOverTime[0].unlocked,
      tgePercentage: circulatingOverTime[0].percentage,
      fullyUnlockedAt: this._findFullUnlockMonth(circulatingOverTime)
    };
  }

  _findFullUnlockMonth(data) {
    for (const entry of data) {
      if (entry.percentage >= 99.9) return entry.month;
    }
    return data[data.length - 1]?.month || 48;
  }

  /**
   * CalculateToken流动性深度
   * @param {object} params
   * @returns {object}
   */
  analyzeLiquidity(params = {}) {
    const price = params.price || this.defaultParams.initialPrice;
    const circulatingSupply = params.circulatingSupply || 
      (this.defaultParams.initialSupply * this.defaultParams.circulatingSupplyRatio);
    const dailyVolume = params.dailyVolume || this.defaultParams.dailyVolume;

    const marketCap = circulatingSupply * price;
    const volumeToMarketCap = dailyVolume / marketCap;
    const liquidityScore = Math.min(volumeToMarketCap * 1000, 100);

    const slippageLevels = [];
    const tradeSizes = [1000, 10000, 100000, 1000000, 10000000];

    for (const size of tradeSizes) {
      const sizeRatio = size / (dailyVolume * 0.1);
      const slippage = Math.min(sizeRatio * 2, 50);
      slippageLevels.push({
        tradeSize: size,
        estimatedSlippage: +slippage.toFixed(2),
        priceImpact: +(slippage / 100 * price).toFixed(6),
        effectivePrice: +(price * (1 - slippage / 100)).toFixed(6)
      });
    }

    let liquidityGrade = 'D';
    if (liquidityScore >= 80) liquidityGrade = 'A';
    else if (liquidityScore >= 60) liquidityGrade = 'B';
    else if (liquidityScore >= 40) liquidityGrade = 'C';

    return {
      marketCap,
      dailyVolume,
      volumeToMarketCap: +volumeToMarketCap.toFixed(6),
      liquidityScore: +liquidityScore.toFixed(1),
      liquidityGrade,
      slippageLevels,
      recommendation: this._getLiquidityRecommendation(liquidityGrade)
    };
  }

  _getLiquidityRecommendation(grade) {
    const recommendations = {
      A: '流动性优秀, 适合大额transaction和机构参与',
      B: '流动性良好, 适合中etc.规模transaction',
      C: '流动性一般, 建议分批transaction以避免滑点',
      D: '流动性不足, 大额transaction会产生显著价格影响'
    };
    return recommendations[grade] || recommendations.D;
  }
}

export class ScenarioManager {
  constructor() {
    this.scenarios = new Map();
  }

  createScenario(name, params) {
    this.scenarios.set(name, { name, params, createdAt: Date.now() });
    return this.scenarios.get(name);
  }

  getScenario(name) {
    return this.scenarios.get(name);
  }

  listScenarios() {
    return [...this.scenarios.values()];
  }

  deleteScenario(name) {
    return this.scenarios.delete(name);
  }

  compareScenarios(names, simulator, months = 24) {
    const results = {};
    for (const name of names) {
      const scenario = this.scenarios.get(name);
      if (scenario) {
        results[name] = simulator.simulate(scenario.params, months);
      }
    }
    return results;
  }
}

export default TokenEconomicsSimulator;