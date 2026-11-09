import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../middleware/auth.js';
import { getClientActivity } from '../services/clientActivity.js';
import { createClient, deleteClient, findClientByNameAndAddress, getClientUserByAccountId, getClients, issueLookupSession, mergeClientAsBusiness, recordAudit, setClientLoginCredentials, updateClient } from '../services/store.js';

export const clientsRouter = Router();

const clientSchema = z.object({
  name: z.string().min(1),
  address: z.string().min(1),
  serviceAddresses: z.array(z.string().min(1)).optional(),
  businesses: z.array(z.object({
    id: z.string().min(1).optional(),
    name: z.string().trim().min(1).max(160),
    address: z.string().trim().min(1).max(500),
  })).max(25).optional(),
  status: z.string().optional(),
});

const clientLoginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(8).optional(),
});

clientsRouter.get('/', requireAdmin, (req, res) => {
  const clients = getClients().map((client) => {
    const clientUser = getClientUserByAccountId(client.id);
    return {
      ...client,
      clientLoginEnabled: Boolean(clientUser),
      clientLoginEmail: clientUser?.email || null,
    };
  });
  res.json({ clients });
});

clientsRouter.post('/', requireAdmin, (req, res) => {
  const parsed = clientSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid client payload.', details: parsed.error.flatten() });
  }

  const client = createClient(parsed.data);
  recordAudit({
    actorType: 'admin',
    actorId: req.admin.id,
    action: 'client.create',
    entityType: 'client',
    entityId: client.id,
  });

  return res.status(201).json({ client });
});

clientsRouter.put('/:clientId', requireAdmin, (req, res) => {
  const parsed = clientSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid client payload.', details: parsed.error.flatten() });
  }

  const client = updateClient(req.params.clientId, parsed.data);
  if (!client) {
    return res.status(404).json({ error: 'Client not found.' });
  }

  recordAudit({
    actorType: 'admin',
    actorId: req.admin.id,
    action: 'client.update',
    entityType: 'client',
    entityId: client.id,
  });

  return res.json({ client });
});

clientsRouter.post('/:clientId/merge-business', requireAdmin, (req, res) => {
  const parsed = z.object({ sourceClientId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Select the client account to merge.' });

  const result = mergeClientAsBusiness(req.params.clientId, parsed.data.sourceClientId);
  if (result.error === 'CLIENT_NOT_FOUND') return res.status(404).json({ error: 'One of the client accounts was not found.' });
  if (result.error === 'CLIENT_MERGE_SELF') return res.status(400).json({ error: 'Choose a different client account to merge.' });
  if (result.error === 'CLIENT_MERGE_ACTIVE_SUBSCRIPTION') {
    return res.status(409).json({ error: 'Cancel the source client’s active autopay subscription before merging these accounts.' });
  }
  if (result.error === 'CLIENT_MERGE_LOGIN_CONFLICT') {
    return res.status(409).json({ error: 'Both accounts have client logins. Remove one login first so the merge can preserve access.' });
  }

  recordAudit({
    actorType: 'admin',
    actorId: req.admin.id,
    action: 'client.merge_business',
    entityType: 'client',
    entityId: result.client.id,
    metadata: {
      sourceClientId: parsed.data.sourceClientId,
      mergedBusinessId: result.mergedBusiness.id,
      invoiceCount: result.invoiceCount,
      contractCount: result.contractCount,
      loginTransferred: result.loginTransferred,
    },
  });
  return res.json({
    client: result.client,
    mergedBusiness: result.mergedBusiness,
    invoiceCount: result.invoiceCount,
    contractCount: result.contractCount,
    loginTransferred: result.loginTransferred,
  });
});

clientsRouter.put('/:clientId/login', requireAdmin, (req, res) => {
  const parsed = clientLoginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Enter a valid login email and, when resetting, a password of at least 8 characters.', details: parsed.error.flatten() });
  }

  const result = setClientLoginCredentials(req.params.clientId, parsed.data);
  if (result.error === 'CLIENT_NOT_FOUND') {
    return res.status(404).json({ error: 'Client not found.' });
  }
  if (result.error === 'EMAIL_ALREADY_IN_USE') {
    return res.status(409).json({ error: 'That email address is already in use.' });
  }
  if (result.error === 'PASSWORD_REQUIRED') {
    return res.status(400).json({ error: 'A password of at least 8 characters is required to create login access.' });
  }

  recordAudit({
    actorType: 'admin',
    actorId: req.admin.id,
    action: 'client.login.update',
    entityType: 'client_user',
    entityId: result.clientUser.id,
  });

  return res.json({ clientUser: result.clientUser });
});

clientsRouter.delete('/:clientId', requireAdmin, (req, res) => {
  const result = deleteClient(req.params.clientId);
  if (result.error === 'CLIENT_NOT_FOUND') {
    return res.status(404).json({ error: 'Client not found.' });
  }

  if (result.error === 'CLIENT_HAS_RECORDS') {
    return res.status(409).json({ error: 'This client has invoices or contracts and cannot be deleted.' });
  }

  recordAudit({
    actorType: 'admin',
    actorId: req.admin.id,
    action: 'client.delete',
    entityType: 'client',
    entityId: result.client.id,
  });

  return res.json({ client: result.client });
});

clientsRouter.post('/lookup', (req, res) => {
  const parsed = z.object({
    name: z.string().min(1),
    address: z.string().min(1),
  }).safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: 'Name and address are required.', details: parsed.error.flatten() });
  }

  const client = findClientByNameAndAddress(parsed.data.name, parsed.data.address);
  if (!client) {
    return res.status(404).json({ found: false, message: 'No matching client records were found.' });
  }

  const activity = getClientActivity(client);
  const lookupSession = issueLookupSession(client.id);

  return res.json({
    found: true,
    account: {
      id: client.id,
      accountKey: client.accountKey,
      name: client.name,
      address: client.address,
      status: client.status,
      clientLoginEnabled: Boolean(getClientUserByAccountId(client.id)),
    },
    lookupAccessToken: lookupSession.token,
    lookupAccessExpiresAt: new Date(lookupSession.expiresAt).toISOString(),
    ...activity,
  });
});
