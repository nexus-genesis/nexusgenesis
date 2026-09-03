/**
 * DeveloperIncentives - DeveloperIncentive系统
 * Phase 2: 生态扩展
 *
 * support:
 *   - Bug Bounty: Security vulnerabilityreward
 *   - Feature Grant: Features开发资助
 *   - PR Reward: 代码合并reward
 *   - Challenge: 挑战Task reward
 */

import { ContributionSystem } from '../ai/contributionSystem.js';

const INCENTIVE_TYPES = {
  BUG_BOUNTY: 'bug_bounty',
  FEATURE_GRANT: 'feature_grant',
  PR_REWARD: 'pr_reward',
  CHALLENGE: 'challenge'
};

const INCENTIVE_STATUS = {
  OPEN: 'open',
  IN_PROGRESS: 'in_progress',
  SUBMITTED: 'submitted',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  PAID: 'paid',
  CLOSED: 'closed'
};

class DeveloperIncentives {
  constructor() {
    this.incentives = new Map();
    this.applications = new Map();
    this.paymentHistory = [];
    this.defaultConfig = {
      minBugBounty: 100,
      maxBugBounty: 10000,
      minFeatureGrant: 500,
      maxFeatureGrant: 50000,
      prRewardPerLine: 5,
      maxPrReward: 2000,
      challengeRewardRange: [50, 5000],
      reviewCommitteeSize: 3
    };
  }

  // ==================== Bug Bounty ====================

  createBugBounty({ title, description, severity, reward, reporter, targetModule }) {
    const id = `bounty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const minReward = this.defaultConfig.minBugBounty;
    const maxReward = this.defaultConfig.maxBugBounty;

    const bounty = {
      id, type: INCENTIVE_TYPES.BUG_BOUNTY,
      title, description, severity: severity || 'medium',
      reward: Math.min(Math.max(reward || 0, minReward), maxReward),
      reporter, targetModule,
      status: INCENTIVE_STATUS.OPEN,
      createdAt: Date.now(),
      submissions: [],
      assignedReviewers: [],
      resolvedBy: null
    };

    this.incentives.set(id, bounty);
    return bounty;
  }

  submitBugFix(bountyId, agentId, { description, patch, proof }) {
    const bounty = this.incentives.get(bountyId);
    if (!bounty) throw new Error(`Bounty not found: ${bountyId}`);
    if (bounty.status !== INCENTIVE_STATUS.OPEN) {
      throw new Error(`Bounty ${bountyId} is not open (status: ${bounty.status})`);
    }

    const submission = {
      id: `sub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      bountyId, agentId, description, patch, proof,
      status: INCENTIVE_STATUS.SUBMITTED,
      submittedAt: Date.now(),
      reviewedBy: [],
      reviewNotes: []
    };

    bounty.submissions.push(submission);
    bounty.status = INCENTIVE_STATUS.IN_PROGRESS;
    return submission;
  }

  approveBugFix(bountyId, submissionId, reviewerId) {
    const bounty = this.incentives.get(bountyId);
    if (!bounty) throw new Error(`Bounty not found: ${bountyId}`);

    const submission = bounty.submissions.find(s => s.id === submissionId);
    if (!submission) throw new Error(`Submission not found: ${submissionId}`);

    submission.status = INCENTIVE_STATUS.APPROVED;
    submission.approvedAt = Date.now();
    submission.approvedBy = reviewerId;
    bounty.status = INCENTIVE_STATUS.APPROVED;
    bounty.resolvedBy = submission.agentId;

    ContributionSystem.recordContribution(submission.agentId, 'security', 'bug_fix', bounty.reward * 0.1);
    ContributionSystem.recordContribution(reviewerId, 'security', 'bug_review', bounty.reward * 0.05);

    return submission;
  }

  // ==================== Feature Grant ====================

  createFeatureGrant({ title, description, reward, proposer, deliverables, timeline }) {
    const id = `grant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const grant = {
      id, type: INCENTIVE_TYPES.FEATURE_GRANT,
      title, description,
      reward: Math.min(Math.max(reward || 0, this.defaultConfig.minFeatureGrant),
        this.defaultConfig.maxFeatureGrant),
      proposer,
      deliverables: deliverables || [],
      timeline: timeline || { start: Date.now(), estimatedDays: 30 },
      status: INCENTIVE_STATUS.OPEN,
      createdAt: Date.now(),
      applicants: [],
      approvedApplicant: null,
      completedDeliverables: []
    };

    this.incentives.set(id, grant);
    return grant;
  }

  applyForGrant(grantId, agentId, { proposal, estimate, previousWork }) {
    const grant = this.incentives.get(grantId);
    if (!grant) throw new Error(`Grant not found: ${grantId}`);

    const application = {
      id: `app-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      grantId, agentId, proposal, estimate, previousWork,
      status: INCENTIVE_STATUS.SUBMITTED,
      submittedAt: Date.now(),
      reputation: ContributionSystem.getAgentReputation(agentId)
    };

    grant.applicants.push(application);
    this.applications.set(application.id, application);
    return application;
  }

  approveGrantApplication(grantId, applicationId, reviewerId) {
    const grant = this.incentives.get(grantId);
    if (!grant) throw new Error(`Grant not found: ${grantId}`);

    const application = grant.applicants.find(a => a.id === applicationId);
    if (!application) throw new Error(`Application not found: ${applicationId}`);

    application.status = INCENTIVE_STATUS.APPROVED;
    grant.approvedApplicant = application.agentId;
    grant.status = INCENTIVE_STATUS.IN_PROGRESS;

    ContributionSystem.recordContribution(application.agentId, 'development', 'grant_approved', grant.reward * 0.05);
    return application;
  }

  // ==================== PR Reward ====================

  createPRReward({ prTitle, prUrl, author, linesChanged, repoModule }) {
    const id = `pr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const reward = Math.min(linesChanged * this.defaultConfig.prRewardPerLine, this.defaultConfig.maxPrReward);

    const prReward = {
      id, type: INCENTIVE_TYPES.PR_REWARD,
      title: prTitle, prUrl, author, linesChanged, repoModule,
      reward: Math.max(reward, 10),
      status: INCENTIVE_STATUS.APPROVED,
      createdAt: Date.now()
    };

    this.incentives.set(id, prReward);
    ContributionSystem.recordContribution(author, 'development', 'pr_merged', reward * 0.1);
    return prReward;
  }

  // ==================== Challenge ====================

  createChallenge({ title, description, reward, creator, requirements, deadline, maxParticipants }) {
    const id = `challenge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const challenge = {
      id, type: INCENTIVE_TYPES.CHALLENGE,
      title, description,
      reward: Math.min(Math.max(reward || 0, this.defaultConfig.challengeRewardRange[0]),
        this.defaultConfig.challengeRewardRange[1]),
      creator, requirements: requirements || [], deadline,
      maxParticipants: maxParticipants || 50,
      status: INCENTIVE_STATUS.OPEN,
      createdAt: Date.now(),
      participants: [],
      submissions: []
    };

    this.incentives.set(id, challenge);
    return challenge;
  }

  joinChallenge(challengeId, agentId) {
    const challenge = this.incentives.get(challengeId);
    if (!challenge) throw new Error(`Challenge not found: ${challengeId}`);

    if (challenge.participants.length >= challenge.maxParticipants) {
      throw new Error('Challenge has reached maximum participants');
    }

    if (!challenge.participants.includes(agentId)) {
      challenge.participants.push(agentId);
    }
    return { challengeId, agentId, position: challenge.participants.length };
  }

  submitChallenge(challengeId, agentId, { solution, demo }) {
    const challenge = this.incentives.get(challengeId);
    if (!challenge) throw new Error(`Challenge not found: ${challengeId}`);

    if (!challenge.participants.includes(agentId)) {
      throw new Error('Must join challenge before submitting');
    }

    const submission = {
      id: `cs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      challengeId, agentId, solution, demo,
      status: INCENTIVE_STATUS.SUBMITTED,
      submittedAt: Date.now()
    };

    challenge.submissions.push(submission);
    return submission;
  }

  // ==================== Payment ====================

  recordPayment(incentiveId, agentId, amount) {
    const payment = {
      id: `pay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      incentiveId, agentId, amount, timestamp: Date.now()
    };

    this.paymentHistory.push(payment);

    const incentive = this.incentives.get(incentiveId);
    if (incentive) {
      incentive.status = INCENTIVE_STATUS.PAID;
    }

    ContributionSystem.recordContribution(agentId, 'development', 'reward_claimed', amount * 0.05);
    return payment;
  }

  // ==================== Queries ====================

  getIncentive(id) {
    return this.incentives.get(id) || null;
  }

  getOpenIncentives() {
    const result = [];
    for (const [id, incentive] of this.incentives) {
      if (incentive.status === INCENTIVE_STATUS.OPEN) {
        result.push({ id, type: incentive.type, title: incentive.title,
          reward: incentive.reward, status: incentive.status });
      }
    }
    return result;
  }

  getAllIncentives(filters = {}) {
    const result = [];
    for (const [id, incentive] of this.incentives) {
      if (filters.type && incentive.type !== filters.type) continue;
      if (filters.status && incentive.status !== filters.status) continue;
      result.push({ id, type: incentive.type, title: incentive.title,
        reward: incentive.reward, status: incentive.status, createdAt: incentive.createdAt });
    }
    return result.sort((a, b) => b.createdAt - a.createdAt);
  }

  getAgentRewards(agentId) {
    const incentives = [];
    for (const [id, inc] of this.incentives) {
      const sub = inc.submissions?.find(s => s.agentId === agentId);
      if (sub || inc.resolvedBy === agentId || inc.author === agentId ||
          inc.approvedApplicant === agentId || inc.reporter === agentId) {
        incentives.push({ id, type: inc.type, title: inc.title,
          reward: inc.reward, status: inc.status });
      }
    }

    const payments = this.paymentHistory.filter(p => p.agentId === agentId);
    const totalEarned = payments.reduce((sum, p) => sum + p.amount, 0);

    return { agentId, incentives, payments, totalEarned };
  }

  getStats() {
    const countByType = {};
    const countByStatus = {};
    let totalRewards = 0;

    for (const [, inc] of this.incentives) {
      countByType[inc.type] = (countByType[inc.type] || 0) + 1;
      countByStatus[inc.status] = (countByStatus[inc.status] || 0) + 1;
      if (inc.reward) totalRewards += inc.reward;
    }

    return {
      total: this.incentives.size,
      totalRewards,
      totalPaid: this.paymentHistory.reduce((sum, p) => sum + p.amount, 0),
      countByType, countByStatus
    };
  }
}

const developerIncentives = new DeveloperIncentives();

export { DeveloperIncentives, developerIncentives, INCENTIVE_TYPES, INCENTIVE_STATUS };