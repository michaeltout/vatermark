import express from 'express';
import { HttpError } from './errors.js';
import type { GiftService } from './gifts.js';

/** Mount after the common session/CSRF middleware. No route lists the inventory. */
export function mountGiftRoutes(app: express.Express, options: {
  service: GiftService;
}) {
  const { service } = options;
  app.get('/api/gifts/current', async (req, res) => {
    res.set({ 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' });
    res.json({ card: await service.current(String(res.locals.owner || '')) ?? null });
  });
  app.post('/api/gifts/claim', express.json({ limit: '3kb' }), async (req, res) => {
    res.set({ 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' });
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length !== 0) {
      throw new HttpError(400, 'INVALID_GIFT_CLAIM', 'Send an empty JSON object to request a gift card.');
    }
    res.json({ card: await service.claim(String(res.locals.owner || '')) });
  });
}
