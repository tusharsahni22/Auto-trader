/**
 * BotDecision model — persists every signal-bot decision for audit and review.
 */

import mongoose, { Schema, Document } from 'mongoose';

export interface IBotDecision extends Document {
  decisionId: string;
  asset: string;
  time: Date;
  signal: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  reasons: string[];
  indicators: {
    price: number;
    emaFast?: number | null;
    emaSlow?: number | null;
    rsi?: number | null;
    breakoutHigh?: number | null;
    breakoutLow?: number | null;
    trend: string;
  };
  executed: boolean;
  executionError?: string;
  tradeId?: string;
  deltaOrderId?: string;
}

const BotDecisionSchema = new Schema<IBotDecision>(
  {
    decisionId: { type: String, required: true, unique: true, index: true },
    asset: { type: String, required: true, index: true },
    time: { type: Date, required: true, index: true },
    signal: { type: String, required: true, enum: ['BUY', 'SELL', 'HOLD'], index: true },
    confidence: { type: Number, required: true },
    reasons: { type: [String], default: [] },
    indicators: {
      price: { type: Number, required: true },
      emaFast: Number,
      emaSlow: Number,
      rsi: Number,
      breakoutHigh: Number,
      breakoutLow: Number,
      trend: String,
    },
    executed: { type: Boolean, default: false },
    executionError: String,
    tradeId: String,
    deltaOrderId: String,
  },
  { timestamps: true }
);

BotDecisionSchema.index({ time: -1 });

export const BotDecision = mongoose.model<IBotDecision>('BotDecision', BotDecisionSchema);
