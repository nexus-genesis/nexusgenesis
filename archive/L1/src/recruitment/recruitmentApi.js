/**
 * NexusGenesis - Recruitment API Routes
 *
 * 招募引擎的 HTTP API 端点
 *
 * Endpoints:
 *   GET  /api/recruitment/status    - 招募状态
 *   GET  /api/recruitment/history   - 历史记录
 *   POST /api/recruitment/trigger   - 手动触发招募
 *   POST /api/recruitment/schedule  - 开启/关闭定时招募
 *   GET  /api/recruitment/channels  - 渠道状态
 */

import recruitmentEngine from '../recruitment/recruitmentEngine.js';

let schedulerInterval = null;
let schedulerActive = false;

export function setupRecruitmentRoutes(app) {
  app.get('/api/recruitment/status', (req, res) => {
    try {
      const status = recruitmentEngine.getStatus();
      res.json(status);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/recruitment/history', (req, res) => {
    try {
      const days = parseInt(req.query.days) || 30;
      const history = recruitmentEngine.getHistory(days);
      res.json(history);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/recruitment/trigger', async (req, res) => {
    try {
      const count = parseInt(req.body.count) || 0;
      let result;

      if (count > 0) {
        const engine = recruitmentEngine;
        await engine._recruitViaLocalChannel(count);
        engine._saveState();
        result = recruitmentEngine.getStatus();
      } else {
        result = await recruitmentEngine.recruitDaily();
      }

      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/recruitment/schedule', (req, res) => {
    try {
      const action = req.body.action || 'status';

      if (action === 'start') {
        if (schedulerActive) {
          return res.json({ scheduled: true, message: 'Scheduler already running' });
        }

        schedulerActive = true;
        const SIX_HOURS = 6 * 60 * 60 * 1000;

        schedulerInterval = setInterval(async () => {
          try {
            await recruitmentEngine.recruitDaily();
          } catch (e) {
            console.error('[RecruitmentScheduler] Error:', e.message);
          }
        }, SIX_HOURS);

        console.log('[RecruitmentAPI] Scheduler started (every 6 hours)');
        res.json({ scheduled: true, interval: '6 hours' });

      } else if (action === 'stop') {
        if (schedulerInterval) {
          clearInterval(schedulerInterval);
          schedulerInterval = null;
        }
        schedulerActive = false;
        console.log('[RecruitmentAPI] Scheduler stopped');
        res.json({ scheduled: false, message: 'Scheduler stopped' });

      } else {
        res.json({
          scheduled: schedulerActive,
          interval: schedulerActive ? '6 hours' : null,
          nextRun: schedulerActive ? 'Pending' : null
        });
      }
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/recruitment/channels', (req, res) => {
    try {
      const channels = ['local', 'internal', 'forum', 'moltbook', 'p2p'];
      const status = recruitmentEngine.getStatus();
      const channelInfo = {};

      for (const ch of channels) {
        channelInfo[ch] = {
          available: typeof recruitmentEngine._channelAvailable === 'function'
            ? recruitmentEngine._channelAvailable(ch)
            : true,
          stats: status.channels[ch] || { attempts: 0, successes: 0, failures: 0 }
        };
      }

      res.json(channelInfo);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  console.log('[RecruitmentAPI] Routes registered: /api/recruitment/*');
}