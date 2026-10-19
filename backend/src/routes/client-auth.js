import { Router } from 'express';
import { z } from 'zod';
import { requireClient } from '../middleware/auth.js';
import { activateClientUser, authenticateClientUser, getClientById, getClientUserByAccountId, recordAudit, updateClient, updateClientCredentials, updateClientUser } from '../services/store.js';

export const clientAuthRouter = Router();

const activationSchema = z.object({
  accountKey: z.string().uuid(),
  name: z.string().min(1),
  address: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  notificationsEnabled: z.boolean().optional(),
  autopayEnabled: z.boolean().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const preferencesSchema = z.object({
  notificationsEnabled: z.boolean().optional(),
  autopayEnabled: z.boolean().optional(),
});

const profileSchema = z.object({
  name: z.string().trim().min(1),
  address: z.string().trim().min(1),
});

const credentialsSchema = z.object({
  email: z.string().trim().email(),
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).optional(),
});

clientAuthRouter.post('/activate', (req, res) => {
  const parsed = activationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid activation payload.', details: parsed.error.flatten() });
  }

  const result = activateClientUser(parsed.data);
  if (result.error === 'ACCOUNT_NOT_FOUND') {
    return res.status(404).json({ error: 'Account not found.' });
  }

  if (result.error === 'ACCOUNT_LOOKUP_MISMATCH') {
    return res.status(403).json({ error: 'The account information did not match the stored record.' });
  }

  if (result.error === 'ACCOUNT_ALREADY_HAS_CLIENT_USER') {
    return res.status(409).json({ error: 'This account already has a client login.' });
  }

  if (result.error === 'EMAIL_ALREADY_IN_USE') {
    return res.status(409).json({ error: 'That email address is already in use.' });
  }

  return res.status(201).json({
    account: {
      id: result.account.id,
      name: result.account.name,
      address: result.account.address,
      status: result.account.status,
    },
    clientUser: result.clientUser,
  });
});

clientAuthRouter.post('/login', (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid login payload.', details: parsed.error.flatten() });
  }

  const session = authenticateClientUser(parsed.data.email, parsed.data.password);
  if (!session) {
    return res.status(401).json({ error: 'Invalid client credentials.' });
  }

  return res.json({
    clientUser: session.clientUser,
    token: session.token,
    expiresAt: session.expiresAt,
  });
});

clientAuthRouter.get('/me', requireClient, (req, res) => {
  const account = getClientById(req.clientUser.accountId);
  const clientUser = getClientUserByAccountId(req.clientUser.accountId);

  if (!account || !clientUser) {
    return res.status(404).json({ error: 'Client account not found.' });
  }

  return res.json({
    account: {
      id: account.id,
      name: account.name,
      address: account.address,
      serviceAddresses: account.serviceAddresses || [],
      status: account.status,
      stripeCustomerId: account.stripeCustomerId,
    },
    clientUser,
  });
});

clientAuthRouter.patch('/me', requireClient, (req, res) => {
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid account information.', details: parsed.error.flatten() });
  }

  const account = updateClient(req.clientUser.accountId, parsed.data);
  if (!account) {
    return res.status(404).json({ error: 'Client account not found.' });
  }

  recordAudit({
    actorType: 'client',
    actorId: req.clientUser.id,
    action: 'client.profile.update',
    entityType: 'client',
    entityId: account.id,
  });

  return res.json({
    account: {
      id: account.id,
      name: account.name,
      address: account.address,
      serviceAddresses: account.serviceAddresses || [],
      status: account.status,
      stripeCustomerId: account.stripeCustomerId,
    },
  });
});

clientAuthRouter.patch('/preferences', requireClient, (req, res) => {
  const parsed = preferencesSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid preferences payload.', details: parsed.error.flatten() });
  }

  const clientUser = updateClientUser(req.clientUser.accountId, parsed.data);
  if (!clientUser) {
    return res.status(404).json({ error: 'Client account not found.' });
  }

  return res.json({ clientUser });
});

clientAuthRouter.patch('/credentials', requireClient, (req, res) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid sign-in details.', details: parsed.error.flatten() });
  }

  const result = updateClientCredentials(req.clientUser.accountId, parsed.data);
  if (result.error === 'CLIENT_USER_NOT_FOUND') {
    return res.status(404).json({ error: 'Client account not found.' });
  }
  if (result.error === 'INVALID_CURRENT_PASSWORD') {
    return res.status(403).json({ error: 'Current password is incorrect.' });
  }
  if (result.error === 'EMAIL_ALREADY_IN_USE') {
    return res.status(409).json({ error: 'That email address is already in use.' });
  }

  recordAudit({
    actorType: 'client',
    actorId: req.clientUser.id,
    action: 'client.credentials.update',
    entityType: 'client_user',
    entityId: req.clientUser.id,
  });

  return res.json({ clientUser: result.clientUser });
});