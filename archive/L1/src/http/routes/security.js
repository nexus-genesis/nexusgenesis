import { Router } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../..');

const router = Router();

router.get('/api/v1/security/audit/templates', async (req, res) => {
  try {
    const { default: ContractTemplateLibrary } = await import('../../contracts/templates/contractTemplates.js');
    const { default: SecurityAuditor } = await import('../../security/securityAuditor.js');
    const library = new ContractTemplateLibrary();
    const auditor = new SecurityAuditor();
    const results = auditor.auditAllTemplates(library);
    res.json({ success: true, data: results });
  } catch (e) {
    res.status(500).json({ success: false, error:e.message });
  }
});

router.post('/api/v1/security/audit/bytecode', async (req, res) => {
  const { bytecode, contractName } = req.body;
  if (!bytecode) {
    return res.status(400).json({ success: false, error:'bytecode is required' });
  }
  try {
    const SecurityAuditor = (await import('../../security/securityAuditor.js')).default;
    const auditor = new SecurityAuditor();
    const result = auditor.audit(bytecode, contractName || 'UserContract');
    res.json({
      success: true,
      data: {
        contractName: result.contractName,
        score: result.score,
        passed: result.passed,
        findings: result.findings.map(f => ({
          type: f.type,
          severity: f.severity,
          message: f.message,
          recommendation: f.recommendation
        })),
        summary: result.summary
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error:e.message });
  }
});

router.get('/api/v1/security/audit/template/:type', async (req, res) => {
  const { type } = req.params;
  try {
    const { default: ContractTemplateLibrary } = await import('../../contracts/templates/contractTemplates.js');
    const { default: SecurityAuditor } = await import('../../security/securityAuditor.js');
    const library = new ContractTemplateLibrary();
    const template = library.getTemplate(type.toUpperCase());
    if (!template) {
      return res.status(404).json({ success: false, error:`模板type ${type} not found` });
    }
    const auditor = new SecurityAuditor();
    const result = auditor.auditTemplate(template);
    res.json({ success: true, data: { templateType: type.toUpperCase(), ...result } });
  } catch (e) {
    res.status(500).json({ success: false, error:e.message });
  }
});

export default router;