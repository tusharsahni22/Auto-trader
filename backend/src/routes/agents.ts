/**
 * Agent Management API routes
 */

import { Router } from 'express';
import {
  getAgentConfigs,
  getAgentConfig,
  updateAgentConfig,
  enableAgent,
  disableAgent,
  enableAllAgents,
  disableAllAgents,
  getProviderStates,
  checkProviderAvailability,
  getAgentSummary,
  resetAgentConfigs,
} from '../agents/config.js';

export const agentsRouter = Router();

/**
 * GET /api/agents
 * Get all agent configurations
 */
agentsRouter.get('/', (_req, res) => {
  try {
    const configs = getAgentConfigs();
    res.json({ agents: configs });
  } catch (error: any) {
    console.error('[api] /agents error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/agents/summary
 * Get agent system summary
 */
agentsRouter.get('/summary', (_req, res) => {
  try {
    const summary = getAgentSummary();
    res.json(summary);
  } catch (error: any) {
    console.error('[api] /agents/summary error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/agents/:name
 * Get specific agent configuration
 */
agentsRouter.get('/:name', (req, res) => {
  try {
    const config = getAgentConfig(req.params.name);
    if (!config) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    res.json({ agent: config });
  } catch (error: any) {
    console.error('[api] /agents/:name error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/agents/:name
 * Update agent configuration
 */
agentsRouter.put('/:name', (req, res) => {
  try {
    const updates = req.body;
    const config = updateAgentConfig(req.params.name, updates);
    res.json({ success: true, agent: config });
  } catch (error: any) {
    console.error('[api] /agents/:name PUT error:', error);
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /api/agents/:name/enable
 * Enable an agent
 */
agentsRouter.post('/:name/enable', (req, res) => {
  try {
    const config = enableAgent(req.params.name);
    res.json({ success: true, agent: config });
  } catch (error: any) {
    console.error('[api] /agents/:name/enable error:', error);
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /api/agents/:name/disable
 * Disable an agent
 */
agentsRouter.post('/:name/disable', (req, res) => {
  try {
    const config = disableAgent(req.params.name);
    res.json({ success: true, agent: config });
  } catch (error: any) {
    console.error('[api] /agents/:name/disable error:', error);
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /api/agents/enable-all
 * Enable all agents
 */
agentsRouter.post('/enable-all', (_req, res) => {
  try {
    const configs = enableAllAgents();
    res.json({ success: true, agents: configs });
  } catch (error: any) {
    console.error('[api] /agents/enable-all error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/agents/disable-all
 * Disable all agents
 */
agentsRouter.post('/disable-all', (_req, res) => {
  try {
    const configs = disableAllAgents();
    res.json({ success: true, agents: configs });
  } catch (error: any) {
    console.error('[api] /agents/disable-all error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/agents/reset
 * Reset agent configurations to defaults
 */
agentsRouter.post('/reset', (_req, res) => {
  try {
    const configs = resetAgentConfigs();
    res.json({ success: true, agents: configs });
  } catch (error: any) {
    console.error('[api] /agents/reset error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/agents/providers
 * Get provider status
 */
agentsRouter.get('/providers/status', (_req, res) => {
  try {
    const providers = getProviderStates();
    res.json({ providers });
  } catch (error: any) {
    console.error('[api] /agents/providers error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/agents/providers/:id/check
 * Check provider availability
 */
agentsRouter.post('/providers/:id/check', async (req, res) => {
  try {
    const providerId = req.params.id as 'openai' | 'anthropic';
    if (!['openai', 'anthropic'].includes(providerId)) {
      return res.status(400).json({ error: 'Invalid provider ID' });
    }

    const available = await checkProviderAvailability(providerId);
    const providers = getProviderStates();

    res.json({
      success: true,
      provider: providerId,
      available,
      state: providers[providerId],
    });
  } catch (error: any) {
    console.error('[api] /agents/providers/:id/check error:', error);
    res.status(500).json({ error: error.message });
  }
});
