import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { getDashboardSummary } from '../services/store.js';

export const dashboardRouter = Router();

dashboardRouter.get('/summary', requireAdmin, (req, res) => {
  res.json({ summary: getDashboardSummary() });
});
