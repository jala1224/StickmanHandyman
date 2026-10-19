import { Router } from 'express';
import { z } from 'zod';
import { authenticateAdminLogin } from '../middleware/auth.js';

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post('/login', (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid login payload.', details: parsed.error.flatten() });
  }

  const session = authenticateAdminLogin(parsed.data.email, parsed.data.password);
  if (!session) {
    return res.status(401).json({ error: 'Invalid admin credentials.' });
  }

  return res.json({
    admin: { id: session.id, email: session.email },
    token: session.token,
  });
});
