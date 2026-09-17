/**
 * News and Economic Calendar API routes
 */

import { Router } from 'express';
import {
  updateNewsCalendar,
  getUpcomingEvents,
  getRecentNews,
  getEventById,
  dismissEvent,
  getCalendarStats,
  getNewsBlackout,
  newsConfig,
} from '../services/newsCalendar.js';

export const newsCalendarRouter = Router();

function listParam(value: unknown): string[] | undefined {
  return value ? String(value).split(',').filter(Boolean) : undefined;
}

function intParam(value: unknown, fallback: number): number {
  const parsed = parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * GET /api/news-calendar/upcoming
 * Calendar window: recent news plus scheduled events.
 */
newsCalendarRouter.get('/upcoming', async (req, res) => {
  try {
    const events = await getUpcomingEvents({
      priority: listParam(req.query.priority) as any,
      category: listParam(req.query.category) as any,
      assets: listParam(req.query.assets),
      hoursAhead: intParam(req.query.hoursAhead, 72),
      hoursBack: intParam(req.query.hoursBack, 12),
      limit: intParam(req.query.limit, 50),
    });

    res.json({ events, count: events.length });
  } catch (error: any) {
    console.error('[api] /upcoming error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/news-calendar/recent
 */
newsCalendarRouter.get('/recent', async (req, res) => {
  try {
    const events = await getRecentNews({
      priority: listParam(req.query.priority) as any,
      category: listParam(req.query.category) as any,
      assets: listParam(req.query.assets),
      hoursBack: intParam(req.query.hoursBack, 24),
      limit: intParam(req.query.limit, 50),
    });

    res.json({ events, count: events.length });
  } catch (error: any) {
    console.error('[api] /recent error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/news-calendar/update
 */
newsCalendarRouter.post('/update', async (_req, res) => {
  try {
    const result = await updateNewsCalendar();
    res.json({
      success: true,
      stored: result,
      message: `Updated ${result.economic} economic events and ${result.crypto} crypto news`,
    });
  } catch (error: any) {
    console.error('[api] /update error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/news-calendar/event/:id
 */
newsCalendarRouter.get('/event/:id', (req, res) => {
  const event = getEventById(req.params.id);
  if (!event) {
    res.status(404).json({ error: 'Event not found' });
    return;
  }
  res.json({ event });
});

/**
 * PUT /api/news-calendar/event/:id/dismiss
 */
newsCalendarRouter.put('/event/:id/dismiss', (req, res) => {
  const event = dismissEvent(req.params.id);
  if (!event) {
    res.status(404).json({ error: 'Event not found' });
    return;
  }
  res.json({ success: true, event });
});

/**
 * GET /api/news-calendar/stats
 */
newsCalendarRouter.get('/stats', (_req, res) => {
  res.json({ ...getCalendarStats(), config: newsConfig });
});

/**
 * GET /api/news-calendar/blackout
 * Whether a High-impact release is close enough to block new entries.
 */
newsCalendarRouter.get('/blackout', (_req, res) => {
  res.json(getNewsBlackout());
});
