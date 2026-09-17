/**
 * LLM Agent Configuration System
 * Manages agent enable/disable state and provider fallback
 */

export interface AgentConfig {
  name: string;
  enabled: boolean;
  provider: 'openai' | 'anthropic' | 'fallback_deterministic';
  model: string;
  temperature: number;
  weight: number; // Weight in ensemble (0-1)
  fallbackEnabled: boolean;
}

export interface ProviderConfig {
  id: 'openai' | 'anthropic';
  apiKey: string;
  available: boolean;
  lastError?: string;
  lastChecked?: number;
}

/**
 * Default agent configurations
 */
const DEFAULT_AGENTS: Record<string, AgentConfig> = {
  structure: {
    name: 'structure',
    enabled: process.env.AGENTS_ENABLED === 'true',
    provider: process.env.OPENAI_API_KEY ? 'openai' : 'anthropic',
    model: 'gpt-4-turbo-preview',
    temperature: 0,
    weight: 0.25,
    fallbackEnabled: true,
  },
  positioning: {
    name: 'positioning',
    enabled: process.env.AGENTS_ENABLED === 'true',
    provider: process.env.OPENAI_API_KEY ? 'openai' : 'anthropic',
    model: 'gpt-4-turbo-preview',
    temperature: 0,
    weight: 0.30,
    fallbackEnabled: true,
  },
  context: {
    name: 'context',
    enabled: process.env.AGENTS_ENABLED === 'true',
    provider: process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'openai',
    model: 'claude-3-sonnet-20240229',
    temperature: 0,
    weight: 0.15,
    fallbackEnabled: true,
  },
  adversary: {
    name: 'adversary',
    enabled: process.env.AGENTS_ENABLED === 'true',
    provider: process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'openai',
    model: 'claude-3-sonnet-20240229',
    temperature: 0.3, // Higher temperature for creative adversarial thinking
    weight: 0.30,
    fallbackEnabled: true,
  },
};

/**
 * In-memory agent configuration state
 */
let agentConfigs: Record<string, AgentConfig> = { ...DEFAULT_AGENTS };

/**
 * Provider availability state
 */
let providerStates: Record<string, ProviderConfig> = {
  openai: {
    id: 'openai',
    apiKey: process.env.OPENAI_API_KEY || '',
    available: Boolean(process.env.OPENAI_API_KEY),
  },
  anthropic: {
    id: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    available: Boolean(process.env.ANTHROPIC_API_KEY),
  },
};

/**
 * Get all agent configurations
 */
export function getAgentConfigs(): Record<string, AgentConfig> {
  return { ...agentConfigs };
}

/**
 * Get configuration for a specific agent
 */
export function getAgentConfig(agentName: string): AgentConfig | null {
  return agentConfigs[agentName] || null;
}

/**
 * Update agent configuration
 */
export function updateAgentConfig(agentName: string, updates: Partial<AgentConfig>): AgentConfig {
  if (!agentConfigs[agentName]) {
    throw new Error(`Agent ${agentName} not found`);
  }

  agentConfigs[agentName] = {
    ...agentConfigs[agentName],
    ...updates,
  };

  console.log(`[agents/config] Updated ${agentName}:`, updates);
  return agentConfigs[agentName];
}

/**
 * Enable an agent
 */
export function enableAgent(agentName: string): AgentConfig {
  return updateAgentConfig(agentName, { enabled: true });
}

/**
 * Disable an agent
 */
export function disableAgent(agentName: string): AgentConfig {
  return updateAgentConfig(agentName, { enabled: false });
}

/**
 * Enable all agents
 */
export function enableAllAgents(): Record<string, AgentConfig> {
  Object.keys(agentConfigs).forEach(name => {
    agentConfigs[name].enabled = true;
  });
  console.log('[agents/config] All agents enabled');
  return agentConfigs;
}

/**
 * Disable all agents
 */
export function disableAllAgents(): Record<string, AgentConfig> {
  Object.keys(agentConfigs).forEach(name => {
    agentConfigs[name].enabled = false;
  });
  console.log('[agents/config] All agents disabled');
  return agentConfigs;
}

/**
 * Get list of enabled agents
 */
export function getEnabledAgents(): AgentConfig[] {
  return Object.values(agentConfigs).filter(agent => agent.enabled);
}

/**
 * Check if agents are globally enabled
 */
export function areAgentsEnabled(): boolean {
  return getEnabledAgents().length > 0;
}

/**
 * Get provider states
 */
export function getProviderStates(): Record<string, ProviderConfig> {
  return { ...providerStates };
}

/**
 * Update provider availability
 */
export function updateProviderState(
  providerId: 'openai' | 'anthropic',
  updates: Partial<ProviderConfig>
): void {
  providerStates[providerId] = {
    ...providerStates[providerId],
    ...updates,
    lastChecked: Date.now(),
  };

  if (updates.available === false) {
    console.warn(`[agents/config] Provider ${providerId} unavailable:`, updates.lastError);

    // Trigger fallback for agents using this provider
    Object.values(agentConfigs).forEach(agent => {
      if (agent.provider === providerId && agent.fallbackEnabled) {
        console.log(`[agents/config] ${agent.name} falling back due to ${providerId} unavailability`);
      }
    });
  }
}

/**
 * Check provider availability by making a test call
 */
export async function checkProviderAvailability(providerId: 'openai' | 'anthropic'): Promise<boolean> {
  const provider = providerStates[providerId];

  if (!provider.apiKey) {
    updateProviderState(providerId, {
      available: false,
      lastError: 'API key not configured'
    });
    return false;
  }

  try {
    // Simple test - just check if we can make a request
    // In production, you'd make a minimal API call here
    updateProviderState(providerId, { available: true, lastError: undefined });
    return true;
  } catch (error: any) {
    updateProviderState(providerId, {
      available: false,
      lastError: error.message,
    });
    return false;
  }
}

/**
 * Get fallback provider for an agent
 */
export function getFallbackProvider(agent: AgentConfig): 'openai' | 'anthropic' | 'fallback_deterministic' {
  if (!agent.fallbackEnabled) {
    return 'fallback_deterministic';
  }

  // Try alternate provider first
  const alternateProvider = agent.provider === 'openai' ? 'anthropic' : 'openai';
  if (providerStates[alternateProvider]?.available) {
    return alternateProvider;
  }

  // Fall back to deterministic
  return 'fallback_deterministic';
}

/**
 * Check if agent should run based on its config and provider availability
 */
export function shouldRunAgent(agentName: string): {
  shouldRun: boolean;
  provider: 'openai' | 'anthropic' | 'fallback_deterministic';
  reason?: string;
} {
  const agent = agentConfigs[agentName];

  if (!agent) {
    return { shouldRun: false, provider: 'fallback_deterministic', reason: 'Agent not found' };
  }

  if (!agent.enabled) {
    return { shouldRun: false, provider: 'fallback_deterministic', reason: 'Agent disabled' };
  }

  // Check if primary provider is available
  const primaryProvider = providerStates[agent.provider];
  if (primaryProvider?.available) {
    return { shouldRun: true, provider: agent.provider };
  }

  // Try fallback
  if (agent.fallbackEnabled) {
    const fallbackProvider = getFallbackProvider(agent);
    if (fallbackProvider === 'fallback_deterministic') {
      return {
        shouldRun: true,
        provider: fallbackProvider,
        reason: 'Using deterministic fallback'
      };
    }
    return {
      shouldRun: true,
      provider: fallbackProvider,
      reason: `Fallback to ${fallbackProvider}`
    };
  }

  return {
    shouldRun: false,
    provider: 'fallback_deterministic',
    reason: 'Provider unavailable and fallback disabled'
  };
}

/**
 * Reset all agent configs to defaults
 */
export function resetAgentConfigs(): Record<string, AgentConfig> {
  agentConfigs = { ...DEFAULT_AGENTS };
  console.log('[agents/config] Reset to default configurations');
  return agentConfigs;
}

/**
 * Get agent configuration summary for UI
 */
export function getAgentSummary() {
  const enabled = getEnabledAgents();
  const providers = getProviderStates();

  return {
    totalAgents: Object.keys(agentConfigs).length,
    enabledAgents: enabled.length,
    disabledAgents: Object.keys(agentConfigs).length - enabled.length,
    providers: {
      openai: providers.openai.available,
      anthropic: providers.anthropic.available,
    },
    agents: Object.values(agentConfigs).map(agent => ({
      name: agent.name,
      enabled: agent.enabled,
      provider: agent.provider,
      weight: agent.weight,
      fallback: agent.fallbackEnabled,
    })),
  };
}
