/**
 * NewsEvent model - stores news and economic calendar events
 */

import mongoose, { Schema, Document } from 'mongoose';

export type EventPriority = 'LOW' | 'MEDIUM' | 'HIGH';
export type EventCategory = 'ECONOMIC' | 'CRYPTO' | 'REGULATORY' | 'TECHNICAL' | 'GENERAL';

export interface INewsEvent extends Document {
  eventId: string;

  // Event details
  title: string;
  description?: string;
  fullContent?: string;

  // Categorization
  category: EventCategory;
  priority: EventPriority;
  impactScore?: number; // 0-100 estimated market impact

  // Timing
  eventTime: Date;
  publishedAt: Date;
  expiresAt?: Date;

  // Source
  source: string;
  sourceUrl?: string;

  // Market relevance
  assets: string[]; // ['BTC', 'ETH', etc.]
  regions: string[]; // ['US', 'EU', 'GLOBAL', etc.]

  // Economic calendar specifics (for economic events)
  economicData?: {
    indicator: string; // GDP, CPI, NFP, etc.
    actual?: number;
    forecast?: number;
    previous?: number;
    unit?: string;
  };

  // Analysis
  sentiment?: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  analyzed: boolean;
  analysisNotes?: string;

  // Status
  isActive: boolean;
  dismissed: boolean;

  createdAt: Date;
  updatedAt: Date;
}

const NewsEventSchema = new Schema<INewsEvent>({
  eventId: { type: String, required: true, unique: true, index: true },

  title: { type: String, required: true },
  description: { type: String },
  fullContent: { type: String },

  category: { type: String, enum: ['ECONOMIC', 'CRYPTO', 'REGULATORY', 'TECHNICAL', 'GENERAL'], required: true, index: true },
  priority: { type: String, enum: ['LOW', 'MEDIUM', 'HIGH'], required: true, index: true },
  impactScore: { type: Number, min: 0, max: 100 },

  eventTime: { type: Date, required: true, index: true },
  publishedAt: { type: Date, required: true },
  expiresAt: { type: Date, index: true },

  source: { type: String, required: true },
  sourceUrl: { type: String },

  assets: [{ type: String, index: true }],
  regions: [{ type: String, index: true }],

  economicData: {
    indicator: { type: String },
    actual: { type: Number },
    forecast: { type: Number },
    previous: { type: Number },
    unit: { type: String },
  },

  sentiment: { type: String, enum: ['BULLISH', 'BEARISH', 'NEUTRAL'] },
  analyzed: { type: Boolean, default: false, index: true },
  analysisNotes: { type: String },

  isActive: { type: Boolean, default: true, index: true },
  dismissed: { type: Boolean, default: false },
}, {
  timestamps: true,
});

// Compound indexes for common queries
NewsEventSchema.index({ category: 1, priority: 1, eventTime: -1 });
NewsEventSchema.index({ isActive: 1, eventTime: 1 });
NewsEventSchema.index({ assets: 1, eventTime: -1 });
NewsEventSchema.index({ eventTime: 1, priority: -1 });

export const NewsEvent = mongoose.model<INewsEvent>('NewsEvent', NewsEventSchema);
