import { Router } from 'express';

const router = Router();

router.post('/api/v1/ai/contract/generate', async (req, res) => {
  const { description } = req.body;

  if (!description || typeof description !== 'string') {
    return res.status(400).json({ success: false, error:'description 是必填的字符串parameter' });
  }

  try {
    const { default: AIContractGenerator } = await import('../../ai/aiContractGenerator.js');
    const generator = new AIContractGenerator();
    const result = generator.generateFromDescription(description);
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(500).json({ success: false, error:e.message });
  }
});

router.post('/api/v1/ai/contract/recommend', async (req, res) => {
  const { description } = req.body;

  if (!description || typeof description !== 'string') {
    return res.status(400).json({ success: false, error:'description 是必填的字符串parameter' });
  }

  try {
    const AIContractGenerator = (await import('../../ai/aiContractGenerator.js')).default;
    const generator = new AIContractGenerator();
    const result = generator.recommendTemplate(description);
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(500).json({ success: false, error:e.message });
  }
});

router.post('/api/v1/ai/contract/optimize', async (req, res) => {
  const { bytecode } = req.body;

  if (!bytecode || !Array.isArray(bytecode)) {
    return res.status(400).json({ success: false, error:'bytecode must是非空数组' });
  }

  try {
    const AIContractGenerator = (await import('../../ai/aiContractGenerator.js')).default;
    const generator = new AIContractGenerator();
    const result = generator.optimizeBytecode(bytecode);
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(500).json({ success: false, error:e.message });
  }
});

router.post('/api/v1/ai/contract/analyze-complexity', async (req, res) => {
  const { bytecode } = req.body;

  if (!bytecode || !Array.isArray(bytecode)) {
    return res.status(400).json({ success: false, error:'bytecode must是非空数组' });
  }

  try {
    const AIContractGenerator = (await import('../../ai/aiContractGenerator.js')).default;
    const generator = new AIContractGenerator();
    const result = generator.analyzeComplexity(bytecode);
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(500).json({ success: false, error:e.message });
  }
});

router.post('/api/v1/ai/contract/extract-params', async (req, res) => {
  const { description } = req.body;

  if (!description || typeof description !== 'string') {
    return res.status(400).json({ success: false, error:'description 是必填的字符串parameter' });
  }

  try {
    const AIContractGenerator = (await import('../../ai/aiContractGenerator.js')).default;
    const generator = new AIContractGenerator();
    const params = generator.extractParameters(description);
    res.json({ success: true, data: { params, description } });
  } catch (e) {
    res.status(500).json({ success: false, error:e.message });
  }
});

export default router;