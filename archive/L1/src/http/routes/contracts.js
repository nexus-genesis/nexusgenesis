import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../..');

const router = Router();

router.get('/contract-editor', (req, res) => {
  res.sendFile(path.join(projectRoot, 'public', 'contract-editor.html'));
});

router.get('/api/v1/contracts/templates', (req, res) => {
  const templates = [
    { type: 'DID', name: '去中心化身份', category: 'identity', complexity: 'basic', methods: 4, params: ['contractName', 'ownerAddress', 'maxIdentities'] },
    { type: 'DAO', name: '去中心化自治组织', category: 'governance', complexity: 'intermediate', methods: 5, params: ['contractName', 'votingPeriod', 'quorum', 'minTokens'] },
    { type: 'TOKEN', name: '可替代Token', category: 'finance', complexity: 'basic', methods: 5, params: ['contractName', 'symbol', 'decimals', 'totalSupply'] },
    { type: 'NFT', name: '非同质化Token', category: 'asset', complexity: 'intermediate', methods: 5, params: ['contractName', 'symbol', 'baseURI', 'maxSupply'] },
    { type: 'STAKING', name: '质押Pool', category: 'finance', complexity: 'intermediate', methods: 5, params: ['contractName', 'rewardToken', 'apy', 'lockPeriod'] },
    { type: 'GOVERNANCE_TOKEN', name: 'GovernanceToken', category: 'governance', complexity: 'advanced', methods: 6, params: ['contractName', 'symbol', 'delegationEnabled', 'proposalThreshold'] },
    { type: 'ESCROW', name: '托管Contract', category: 'finance', complexity: 'intermediate', methods: 5, params: ['contractName', 'feePercent', 'disputePeriod'] },
    { type: 'CROWDFUNDING', name: '众筹', category: 'finance', complexity: 'intermediate', methods: 5, params: ['contractName', 'feePercent', 'milestoneCount'] },
    { type: 'MULTI_SIG', name: 'Multi-signature钱包', category: 'security', complexity: 'advanced', methods: 6, params: ['contractName', 'requiredSignatures', 'maxOwners', 'autoConfirm'] },
    { type: 'DEV_INCENTIVE', name: 'DeveloperIncentive', category: 'governance', complexity: 'advanced', methods: 9, params: ['contractName', 'adminAddress', 'maxBountyReward', 'minGrantAmount'] },
    { type: 'MARKETPLACE', name: 'marketplace', category: 'marketplace', complexity: 'intermediate', methods: 5, params: ['contractName', 'feePercent', 'ratingEnabled'] }
  ];
  res.json({ success: true, count: templates.length, data: templates });
});

router.post('/api/v1/contracts/deploy', (req, res) => {
  const { template, name, version, deployParams } = req.body;
  if (!template || !name) {
    return res.status(400).json({ success: false, error:'template 和 name 是必填parameter' });
  }
  const contractId = `contract-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const contractAddress = `ng1${Buffer.from(crypto.randomBytes(32)).toString('hex').slice(0, 48)}`;
  const contractsFile = path.join(projectRoot, 'data', 'contracts', 'contracts.json');
  let contracts = [];
  try {
    if (fs.existsSync(contractsFile)) {
      contracts = JSON.parse(fs.readFileSync(contractsFile, 'utf8'));
    }
  } catch (e) { contracts = []; }
  contracts.push({
    id: contractId, address: contractAddress, template, name,
    version: version || '1.0.0', params: deployParams || {},
    status: 'deployed', deployedAt: Date.now(),
    blockHeight: req.app.locals.node?.getLatestBlockHeight?.() || 0
  });
  fs.writeFileSync(contractsFile, JSON.stringify(contracts, null, 2));
  res.json({ success: true, address: contractAddress, id: contractId, template, status: 'deployed' });
});

router.get('/api/v1/contracts', (req, res) => {
  const contractsFile = path.join(projectRoot, 'data', 'contracts', 'contracts.json');
  let contracts = [];
  try {
    if (fs.existsSync(contractsFile)) {
      contracts = JSON.parse(fs.readFileSync(contractsFile, 'utf8'));
    }
  } catch (e) { contracts = []; }
  res.json({ success: true, count: contracts.length, data: contracts });
});

router.get('/docs', (req, res) => {
  res.sendFile(path.join(projectRoot, 'public', 'docs.html'));
});

// NOTE: /api/v1/docs/endpoints was previously defined here and SHADOWED the
// comprehensive version in apiCompat.js (mounted later in server.js), hiding
// Master Key / takeover / extend-binding docs from agents. The canonical
// endpoint now lives in apiCompat.js — see registerCompatRoutes().

export default router;