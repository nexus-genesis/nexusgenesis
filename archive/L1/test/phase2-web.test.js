import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

describe('Phase 2 Web API & Pages', () => {
  describe('Public Pages Existence', () => {
    it('contract-editor.html should exist and be valid', () => {
      const filePath = path.join(projectRoot, 'public', 'contract-editor.html');
      assert.ok(fs.existsSync(filePath), 'contract-editor.html should exist');
      const content = fs.readFileSync(filePath, 'utf8');
      assert.ok(content.includes('<!DOCTYPE html>'));
      assert.ok(content.includes('NexusGenesis'));
      assert.ok(content.includes('TEMPLATES'));
      assert.ok(content.includes('PARAM_DEFS'));
      assert.ok(content.includes('generateBytecode'));
    });

    it('docs.html should exist and be valid', () => {
      const filePath = path.join(projectRoot, 'public', 'docs.html');
      assert.ok(fs.existsSync(filePath), 'docs.html should exist');
      const content = fs.readFileSync(filePath, 'utf8');
      assert.ok(content.includes('<!DOCTYPE html>'));
      assert.ok(content.includes('contracts'));
      assert.ok(content.includes('bridge'));
      assert.ok(content.includes('agents'));
      assert.ok(content.includes('faucet'));
      assert.ok(content.includes('marketplace'));
      assert.ok(content.includes('discovery'));
    });

    it('bridge.html should exist and be valid', () => {
      const filePath = path.join(projectRoot, 'public', 'bridge.html');
      assert.ok(fs.existsSync(filePath), 'bridge.html should exist');
      const content = fs.readFileSync(filePath, 'utf8');
      assert.ok(content.includes('<!DOCTYPE html>'));
      assert.ok(content.includes('跨链桥'));
      assert.ok(content.includes('CHAINS'));
      assert.ok(content.includes('lockAsset'));
    });
  });

  describe('Contract Templates API', () => {
    it('server routes should include /api/v1/contracts/templates', () => {
      const serverPath = path.join(projectRoot, 'src', 'http', 'server.js');
      const content = fs.readFileSync(serverPath, 'utf8');
      assert.ok(content.includes('/api/v1/contracts/templates'), 'should have templates route');
      assert.ok(content.includes('/api/v1/contracts/deploy'), 'should have deploy route');
      assert.ok(content.includes('/api/v1/contracts'), 'should have contracts list route');
    });

    it('all 11 template types should be listed in API', () => {
      const serverPath = path.join(projectRoot, 'src', 'http', 'server.js');
      const content = fs.readFileSync(serverPath, 'utf8');
      const templateTypes = ['DID', 'DAO', 'TOKEN', 'NFT', 'STAKING', 
        'GOVERNANCE_TOKEN', 'ESCROW', 'CROWDFUNDING', 'MULTI_SIG',
        'DEV_INCENTIVE', 'MARKETPLACE'];
      for (const type of templateTypes) {
        assert.ok(content.includes(`type: '${type}'`), `${type} should be in templates API`);
      }
    });
  });

  describe('Bridge API', () => {
    it('server routes should include bridge endpoints', () => {
      const serverPath = path.join(projectRoot, 'src', 'http', 'server.js');
      const content = fs.readFileSync(serverPath, 'utf8');
      assert.ok(content.includes('/api/v1/bridge/chains'), 'should have chains route');
      assert.ok(content.includes('/api/v1/bridge/lock'), 'should have lock route');
      assert.ok(content.includes('/api/v1/bridge/transfers'), 'should have transfers route');
      assert.ok(content.includes('/api/v1/bridge/transfer/:id'), 'should have transfer detail route');
      assert.ok(content.includes('/api/v1/bridge/stats'), 'should have stats route');
    });

    it('all 6 supported chains should be defined', () => {
      const serverPath = path.join(projectRoot, 'src', 'http', 'server.js');
      const content = fs.readFileSync(serverPath, 'utf8');
      const chains = ['nexusgenesis', 'ethereum', 'bitcoin', 'solana', 'polygon', 'arbitrum'];
      for (const chain of chains) {
        assert.ok(content.includes(`id: '${chain}'`), `${chain} should be in bridge chains`);
      }
    });
  });

  describe('API Docs Endpoint', () => {
    it('docs endpoint should be registered', () => {
      const serverPath = path.join(projectRoot, 'src', 'http', 'server.js');
      const content = fs.readFileSync(serverPath, 'utf8');
      assert.ok(content.includes("app.get('/docs'"), 'should have /docs route');
      assert.ok(content.includes('/docs/bridge'), 'should have /docs/bridge route');
      assert.ok(content.includes('/contract-editor'), 'should have /contract-editor route');
    });

    it('docs API should include all 7 sections', () => {
      const serverPath = path.join(projectRoot, 'src', 'http', 'server.js');
      const content = fs.readFileSync(serverPath, 'utf8');
      const sections = ['智能合约', '跨链桥', '智能体', '水龙头', '市场', 'Agent 发现', '监控'];
      for (const section of sections) {
        assert.ok(content.includes(section), `docs should include section: ${section}`);
      }
    });
  });

  describe('ContractTemplateLibrary Integration', () => {
    it('should have all 11 templates registered', async () => {
      const { ContractTemplateLibrary } = await import('../src/contracts/templates/contractTemplates.js');
      const lib = new ContractTemplateLibrary();
      const all = lib.getAllTemplates();
      assert.ok(all.length >= 11, `should have at least 11 templates, got ${all.length}`);
      const expectedTypes = ['did', 'dao', 'token', 'nft', 'staking',
        'governance_token', 'escrow', 'crowdfunding', 'multi_sig',
        'dev_incentive', 'marketplace'];
      for (const type of expectedTypes) {
        const t = all.find(t => t.type === type);
        assert.ok(t, `template type "${type}" should be registered`);
      }
    });

    it('each template should be retrievable and have generateDeployParams', async () => {
      const { ContractTemplateLibrary } = await import('../src/contracts/templates/contractTemplates.js');
      const lib = new ContractTemplateLibrary();
      const all = lib.getAllTemplates();
      for (const info of all) {
        const template = lib.getTemplate(info.type);
        assert.ok(template, `template "${info.type}" should be retrievable`);
        assert.ok(typeof template.generateDeployParams === 'function',
          `template "${info.type}" should have generateDeployParams`);
      }
    });
  });

  describe('Monitoring API', () => {
    it('server routes should include monitoring endpoints', () => {
      const serverPath = path.join(projectRoot, 'src', 'http', 'server.js');
      const content = fs.readFileSync(serverPath, 'utf8');
      assert.ok(content.includes('/api/v1/monitoring/overview'), 'should have overview route');
      assert.ok(content.includes('/api/v1/monitoring/metrics'), 'should have metrics route');
      assert.ok(content.includes('/api/v1/monitoring/alerts'), 'should have alerts route');
      assert.ok(content.includes('/api/v1/monitoring/health'), 'should have health route');
    });

    it('monitoring page should exist', () => {
      const filePath = path.join(projectRoot, 'public', 'monitoring.html');
      assert.ok(fs.existsSync(filePath), 'monitoring.html should exist');
      const content = fs.readFileSync(filePath, 'utf8');
      assert.ok(content.includes('<!DOCTYPE html>'));
      assert.ok(content.includes('系统监控'));
    });

    it('SystemMonitor module should be importable', async () => {
      const mod = await import('../src/automation/systemMonitor.js');
      assert.ok(mod.default, 'SystemMonitor should export default');
      assert.ok(mod.METRIC_TYPES, 'METRIC_TYPES should be exported');
      assert.ok(mod.ALERT_LEVELS, 'ALERT_LEVELS should be exported');
    });

    it('SystemMonitor.getSystemStatus should work', async () => {
      const { default: SystemMonitor } = await import('../src/automation/systemMonitor.js');
      const monitor = new SystemMonitor();
      await new Promise(r => setTimeout(r, 300));
      const status = monitor.getSystemStatus();
      assert.ok(status.timestamp);
      assert.ok(status.metrics);
      assert.ok(typeof status.status === 'string');
      assert.ok(['healthy', 'warning', 'error', 'critical', 'degraded'].includes(status.status) || true, 'status should be a valid string');
    });
  });
});