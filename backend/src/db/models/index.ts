/**
 * MongoDB models index
 * Central export point for all database models
 */

export { Trade } from './Trade.js';
export type { ITrade } from './Trade.js';

export { Opportunity } from './Opportunity.js';
export type { IOpportunity } from './Opportunity.js';

export { AgentOutput } from './AgentOutput.js';
export type { IAgentOutput } from './AgentOutput.js';

export { NewsEvent } from './NewsEvent.js';
export type { INewsEvent, EventPriority, EventCategory } from './NewsEvent.js';

export { BotDecision } from './BotDecision.js';
export type { IBotDecision } from './BotDecision.js';
