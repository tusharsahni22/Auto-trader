/**
 * Manual Trade Entry API
 */

import { Router } from 'express';
import { openManualTrade } from '../engine/index.js';
import type { Asset, Direction } from '../types.js';

export const manualTradeRouter = Router();

const VALID_ASSETS: Asset[] = ['BTCUSDT', 'ETHUSDT'];

/**
 * POST /api/manual-trade/entry
 * Open a trade from user-supplied levels.
 */
manualTradeRouter.post('/entry', (req, res) => {
  const { asset, direction, entryPrice, stopLoss, takeProfit, quantity, setupType, notes } = req.body ?? {};

  if (!VALID_ASSETS.includes(asset)) {
    res.status(400).json({ error: `asset must be one of ${VALID_ASSETS.join(', ')}` });
    return;
  }
  if (direction !== 'LONG' && direction !== 'SHORT') {
    res.status(400).json({ error: 'direction must be LONG or SHORT' });
    return;
  }

  const entry = Number(entryPrice);
  const stop = Number(stopLoss);
  const size = Number(quantity);

  if (!Number.isFinite(entry) || entry <= 0) {
    res.status(400).json({ error: 'entryPrice must be a positive number' });
    return;
  }
  if (!Number.isFinite(stop) || stop <= 0) {
    res.status(400).json({ error: 'stopLoss is required and must be a positive number' });
    return;
  }
  if (!Number.isFinite(size) || size <= 0) {
    res.status(400).json({ error: 'quantity must be a positive number' });
    return;
  }

  const targets = (Array.isArray(takeProfit) ? takeProfit : [takeProfit])
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);

  const result = openManualTrade({
    asset: asset as Asset,
    direction: direction as Direction,
    entryPrice: entry,
    stopPrice: stop,
    targets,
    quantity: size,
    setupType,
    notes,
  });

  if (!result.ok) {
    res.status(409).json(result);
    return;
  }

  res.json({ success: true, trade: result.trade });
});

/**
 * GET /api/manual-trade/setups
 * Reference templates describing which levels each popular setup needs.
 */
manualTradeRouter.get('/setups', (_req, res) => {
  res.json({
    setups: [
      {
        id: 'support_bounce',
        name: 'Support Bounce',
        description: 'Buy at a support level with the stop below it',
        type: 'LONG',
        lines: ['support (entry)', 'stop below support', 'target at prior resistance'],
      },
      {
        id: 'resistance_rejection',
        name: 'Resistance Rejection',
        description: 'Sell at a resistance level with the stop above it',
        type: 'SHORT',
        lines: ['resistance (entry)', 'stop above resistance', 'target at prior support'],
      },
      {
        id: 'breakout_long',
        name: 'Breakout (Long)',
        description: 'Buy the break of resistance; old resistance becomes the stop',
        type: 'LONG',
        lines: ['resistance (breakout level)', 'stop below broken level', 'measured-move target'],
      },
      {
        id: 'breakdown_short',
        name: 'Breakdown (Short)',
        description: 'Sell the break of support; old support becomes the stop',
        type: 'SHORT',
        lines: ['support (breakdown level)', 'stop above broken level', 'measured-move target'],
      },
      {
        id: 'range_trade',
        name: 'Range Trading',
        description: 'Fade both edges of an established range',
        type: 'BOTH',
        lines: ['resistance (sell zone)', 'support (buy zone)', 'stops outside the range'],
      },
    ],
  });
});
