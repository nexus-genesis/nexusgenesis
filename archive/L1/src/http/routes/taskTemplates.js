/**
 * NexusGenesis - Task Template Library
 *
 * Provides pre-defined task templates for common task types,
 * solving the "task duplication" problem reported in experience reviews.
 *
 * Endpoints:
 *   GET /api/tasks/templates          - List available templates
 *   POST /api/tasks (with template_id) - Create task from template
 */

import { Router } from 'express';

const router = Router();

// ─── Template definitions ───
const TASK_TEMPLATES = [
  {
    id: 'network_health_monitor',
    name: 'Network Health Monitor',
    description: 'Monitor node health status and report anomalies across the network.',
    taskType: 'analysis',
    requiredCapabilities: ['monitoring', 'network'],
    suggestedReward: '50',
    suggestedDuration: 3600000,
    tags: ['infrastructure', 'monitoring']
  },
  {
    id: 'code_review',
    name: 'Code Review',
    description: 'Review and audit source code for security vulnerabilities and best practices.',
    taskType: 'security_audit',
    requiredCapabilities: ['code_review', 'security'],
    suggestedReward: '100',
    suggestedDuration: 7200000,
    tags: ['development', 'security']
  },
  {
    id: 'smart_contract_audit',
    name: 'Smart Contract Audit',
    description: 'Comprehensive audit of smart contract code for exploits and gas optimization.',
    taskType: 'security_audit',
    requiredCapabilities: ['smart_contracts', 'security'],
    suggestedReward: '200',
    suggestedDuration: 14400000,
    tags: ['development', 'security', 'smart_contracts']
  },
  {
    id: 'data_analysis',
    name: 'Data Analysis Report',
    description: 'Analyze blockchain data, transaction patterns, or network metrics.',
    taskType: 'analysis',
    requiredCapabilities: ['data_analysis', 'statistics'],
    suggestedReward: '80',
    suggestedDuration: 5400000,
    tags: ['data', 'research']
  },
  {
    id: 'community_engagement',
    name: 'Community Engagement',
    description: 'Engage with community discussions, answer questions, and promote awareness.',
    taskType: 'community',
    requiredCapabilities: ['communication', 'social'],
    suggestedReward: '30',
    suggestedDuration: 1800000,
    tags: ['community', 'social']
  },
  {
    id: 'documentation_update',
    name: 'Documentation Update',
    description: 'Update or translate project documentation, API references, or guides.',
    taskType: 'documentation',
    requiredCapabilities: ['writing', 'technical_writing'],
    suggestedReward: '40',
    suggestedDuration: 3600000,
    tags: ['documentation', 'translation']
  },
  {
    id: 'ui_ux_review',
    name: 'UI/UX Review',
    description: 'Review and provide feedback on user interface and experience improvements.',
    taskType: 'general',
    requiredCapabilities: ['design', 'ux'],
    suggestedReward: '60',
    suggestedDuration: 7200000,
    tags: ['design', 'frontend']
  },
  {
    id: 'bug_hunt',
    name: 'Bug Hunt',
    description: 'Search for and report bugs in the codebase or deployed application.',
    taskType: 'security_audit',
    requiredCapabilities: ['testing', 'debugging'],
    suggestedReward: '100',
    suggestedDuration: 10800000,
    tags: ['testing', 'security']
  },
  {
    id: 'performance_benchmark',
    name: 'Performance Benchmark',
    description: 'Run performance benchmarks and compare results across different configurations.',
    taskType: 'analysis',
    requiredCapabilities: ['benchmarking', 'performance'],
    suggestedReward: '120',
    suggestedDuration: 14400000,
    tags: ['performance', 'testing']
  },
  {
    id: 'governance_participation',
    name: 'Governance Participation',
    description: 'Participate in governance discussions, review proposals, and cast informed votes.',
    taskType: 'community',
    requiredCapabilities: ['governance', 'analysis'],
    suggestedReward: '25',
    suggestedDuration: 3600000,
    tags: ['governance', 'community']
  },
  {
    id: 'agent_security_review',
    name: 'Agent Co-governance Security Review',
    description: 'Agent-driven security boundary review of the published nexusgenesis-* SDK packages (agent-keys/agent-sdk/chain-eth/chain-sol/chain-adapters, v0.2.1). Reviewers analyze key derivation, custody, takeover, encryption, and cross-chain signing for determinism, negative-amount bypass, tamper, replay, and input-validation defects. Findings are recorded on-chain as an auditable co-governance trail — an agent-performed security review that reinforces the "Agent-autonomy is real" claim.',
    taskType: 'security_audit',
    requiredCapabilities: ['security', 'code_review', 'crypto'],
    suggestedReward: '200',
    suggestedDuration: 14400000,
    tags: ['security', 'audit', 'co-governance', 'sdk', 'pqc']
  }
];

// ─── GET /api/tasks/templates ───
router.get('/api/tasks/templates', (req, res) => {
  const { category, tag, limit = 20 } = req.query;

  let filtered = [...TASK_TEMPLATES];

  if (category) {
    filtered = filtered.filter(t => t.taskType === category);
  }
  if (tag) {
    filtered = filtered.filter(t => t.tags.includes(tag));
  }

  return res.json({
    success: true,
    data: filtered.slice(0, Number(limit)),
    total: filtered.length
  });
});

// ─── Template resolver helper ───
// Called by task routes to fill in template data
function resolveTemplate(templateId) {
  if (!templateId) return null;
  return TASK_TEMPLATES.find(t => t.id === templateId) || null;
}

export { TASK_TEMPLATES, resolveTemplate };
export default router;
