import { Router } from 'express';
import { z } from 'zod';
import Stripe from 'stripe';
import { requireAdmin, requireClient } from '../middleware/auth.js';
import { config } from '../config.js';
import { getContractBillingPrice, getContractPaymentSummary } from '../services/contractPricing.js';
import { createContract, deleteContract, getClientById, getClientUserByAccountId, getContractById, getContracts, recordAudit, updateClient, updateContract, verifyLookupSession } from '../services/store.js';

export const contractsRouter = Router();

const contractSchema = z.object({
  clientId: z.string().min(1),
  status: z.string().optional(),
  billingCycle: z.string().optional(),
  startDate: z.string().optional(),
  packageType: z.enum(['single_home', 'portfolio', 'custom']),
  packageLevel: z.enum(['basic', 'pro', 'premium']).nullable().optional(),
  packageMonthlyCostCents: z.number().int().nonnegative().optional(),
  packageRetainerHours: z.number().nonnegative().multipleOf(0.25).optional(),
  packageRolloverHours: z.number().nonnegative().multipleOf(0.25).optional(),
  packageDiscountPercent: z.number().min(0).max(100).optional(),
  packagePriorityScheduling: z.boolean().optional(),
  packageAnnualInspection: z.boolean().optional(),
  packageQuarterlyInspection: z.boolean().optional(),
  packageOnCallService: z.boolean().optional(),
  packageTenantCoordination: z.boolean().optional(),
});

contractsRouter.get('/', requireAdmin, (req, res) => {
  res.json({ contracts: getContracts().map((contract) => ({
    ...contract,
    ...getContractPaymentSummary(contract),
  })) });
});

contractsRouter.post('/:contractId/checkout-session', requireClient, async (req, res) => {
  const parsed = z.object({ autopay: z.boolean().optional().default(false) }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid contract checkout request.', details: parsed.error.flatten() });
  }
  if (!config.stripeSecretKey) {
    return res.status(503).json({ error: 'Stripe is not configured yet.' });
  }

  const contract = getContractById(req.params.contractId);
  if (!contract) {
    return res.status(404).json({ error: 'Contract not found.' });
  }
  if (contract.accountId !== req.clientUser.accountId) {
    return res.status(403).json({ error: 'This contract does not belong to your account.' });
  }
  if (contract.status !== 'active') {
    return res.status(409).json({ error: 'Only active contracts can be paid.' });
  }
  if (parsed.data.autopay && contract.autopayEnabled) {
    return res.status(409).json({ error: 'Autopay is already enabled for this contract.' });
  }

  const price = getContractBillingPrice(contract);
  if (!price) {
    return res.status(400).json({ error: 'This contract does not have a valid package price.' });
  }

  const account = getClientById(contract.accountId);
  if (!account) {
    return res.status(404).json({ error: 'Client account not found.' });
  }

  const stripe = new Stripe(config.stripeSecretKey);
  try {
    let customerId = account.stripeCustomerId;
    if (!customerId) {
      const clientUser = getClientUserByAccountId(account.id);
      const customer = await stripe.customers.create({
        name: account.name,
        ...(clientUser?.email ? { email: clientUser.email } : {}),
        metadata: { accountId: account.id },
      });
      customerId = customer.id;
      updateClient(account.id, { stripeCustomerId: customerId });
    }

    const origin = req.headers.origin || `${req.protocol}://${req.get('host')}`;
    const mode = parsed.data.autopay ? 'subscription' : 'payment';
    const cycleLabel = contract.billingCycle || 'monthly';
    const productData = {
      name: `Contract ${contract.contractNumber}`,
      description: `${cycleLabel} maintenance contract`,
    };
    const lineItem = {
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: price.amountCents,
        product_data: productData,
        ...(parsed.data.autopay ? {
          recurring: { interval: price.interval, interval_count: price.intervalCount },
        } : {}),
      },
    };
    const session = await stripe.checkout.sessions.create({
      mode,
      customer: customerId,
      client_reference_id: contract.id,
      metadata: {
        contractId: contract.id,
        accountId: account.id,
        autopay: String(parsed.data.autopay),
      },
      line_items: [lineItem],
      ...(parsed.data.autopay ? {
        subscription_data: { metadata: { contractId: contract.id, accountId: account.id } },
      } : {
        payment_intent_data: { metadata: { contractId: contract.id, accountId: account.id } },
      }),
      success_url: `${origin}/portal-client.html?contractCheckout=success&contractId=${encodeURIComponent(contract.id)}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/portal-client.html?contractCheckout=cancelled&contractId=${encodeURIComponent(contract.id)}`,
    });

    return res.json({ checkoutUrl: session.url });
  } catch (error) {
    console.error('Failed to create Stripe contract checkout session:', error);
    return res.status(502).json({ error: 'Unable to start contract checkout right now.' });
  }
});

contractsRouter.post('/:contractId/checkout-session/lookup', async (req, res) => {
  const parsed = z.object({ lookupAccessToken: z.string().uuid() }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'A valid account lookup token is required.' });
  }
  if (!config.stripeSecretKey) {
    return res.status(503).json({ error: 'Stripe is not configured yet.' });
  }

  const lookupSession = verifyLookupSession(parsed.data.lookupAccessToken);
  if (!lookupSession) {
    return res.status(401).json({ error: 'Account lookup has expired. Search for your account again.' });
  }

  const contract = getContractById(req.params.contractId);
  if (!contract) {
    return res.status(404).json({ error: 'Contract not found.' });
  }
  if (contract.accountId !== lookupSession.accountId) {
    return res.status(403).json({ error: 'This contract does not belong to the verified account.' });
  }
  if (contract.status !== 'active') {
    return res.status(409).json({ error: 'Only active contracts can be paid.' });
  }

  const price = getContractBillingPrice(contract);
  if (!price) {
    return res.status(400).json({ error: 'This contract does not have a valid package price.' });
  }

  const account = getClientById(contract.accountId);
  if (!account) {
    return res.status(404).json({ error: 'Client account not found.' });
  }

  try {
    const stripe = new Stripe(config.stripeSecretKey);
    let customerId = account.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        name: account.name,
        metadata: { accountId: account.id },
      });
      customerId = customer.id;
      updateClient(account.id, { stripeCustomerId: customerId });
    }

    const requestedOrigin = String(req.headers.origin || '');
    const origin = config.corsOrigins.includes(requestedOrigin)
      ? requestedOrigin
      : 'https://www.stickman-handyman.com';
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer: customerId,
      client_reference_id: contract.id,
      metadata: { contractId: contract.id, accountId: account.id, autopay: 'false' },
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: price.amountCents,
          product_data: {
            name: `Contract ${contract.contractNumber}`,
            description: `${contract.billingCycle || 'monthly'} maintenance contract`,
          },
        },
      }],
      payment_intent_data: { metadata: { contractId: contract.id, accountId: account.id } },
      success_url: `${origin}/portal-found.html?contractCheckout=success&contractId=${encodeURIComponent(contract.id)}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/portal-found.html?contractCheckout=cancelled&contractId=${encodeURIComponent(contract.id)}`,
    });

    return res.json({ checkoutUrl: session.url });
  } catch (error) {
    console.error('Failed to create lookup contract checkout session:', error);
    return res.status(502).json({ error: 'Unable to start contract checkout right now.' });
  }
});

contractsRouter.post('/:contractId/checkout-session/confirm', requireClient, async (req, res) => {
  const parsed = z.object({ sessionId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'A Checkout session ID is required.' });
  }
  if (!config.stripeSecretKey) {
    return res.status(503).json({ error: 'Stripe is not configured yet.' });
  }

  const contract = getContractById(req.params.contractId);
  if (!contract || contract.accountId !== req.clientUser.accountId) {
    return res.status(contract ? 403 : 404).json({ error: contract ? 'This contract does not belong to your account.' : 'Contract not found.' });
  }

  try {
    const stripe = new Stripe(config.stripeSecretKey);
    const session = await stripe.checkout.sessions.retrieve(parsed.data.sessionId, { expand: ['subscription'] });
    if (session.status !== 'complete'
      || session.metadata?.contractId !== contract.id
      || session.metadata?.accountId !== req.clientUser.accountId) {
      return res.status(403).json({ error: 'This Checkout session is not valid for this contract.' });
    }

    const changes = {};
    if (session.mode === 'payment') {
      if (session.payment_status !== 'paid') {
        return res.status(409).json({ error: 'The contract payment has not completed.' });
      }
      changes.lastPaymentAt = new Date().toISOString();
      changes.lastPaymentAmountCents = Number(session.amount_total || 0);
    } else if (session.mode === 'subscription') {
      const subscription = typeof session.subscription === 'object'
        ? session.subscription
        : await stripe.subscriptions.retrieve(session.subscription);
      changes.stripeSubscriptionId = subscription.id;
      changes.stripeSubscriptionStatus = subscription.status;
      changes.autopayEnabled = ['active', 'trialing', 'past_due'].includes(subscription.status);
        changes.nextPaymentDueAt = subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null;
      if (session.payment_status === 'paid' && Number(session.amount_total || 0) > 0) {
        changes.lastPaymentAt = new Date().toISOString();
        changes.lastPaymentAmountCents = Number(session.amount_total);
      }
    } else {
      return res.status(400).json({ error: 'Unsupported Checkout session type.' });
    }

    const updatedContract = updateContract(contract.id, changes);
    const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
    const account = getClientById(contract.accountId);
    if (account && customerId && !account.stripeCustomerId) {
      updateClient(account.id, { stripeCustomerId: customerId });
    }

    recordAudit({
      actorType: 'client',
      actorId: req.clientUser.id,
      action: session.mode === 'subscription' ? 'contract.autopay.enabled' : 'contract.payment.completed',
      entityType: 'contract',
      entityId: contract.id,
    });

    return res.json({ contract: updatedContract });
  } catch (error) {
    console.error('Failed to confirm Stripe contract checkout:', error);
    return res.status(502).json({ error: 'Unable to verify contract checkout right now.' });
  }
});

contractsRouter.post('/:contractId/autopay/cancel', requireClient, async (req, res) => {
  if (!config.stripeSecretKey) {
    return res.status(503).json({ error: 'Stripe is not configured yet.' });
  }

  const contract = getContractById(req.params.contractId);
  if (!contract || contract.accountId !== req.clientUser.accountId) {
    return res.status(contract ? 403 : 404).json({ error: contract ? 'This contract does not belong to your account.' : 'Contract not found.' });
  }
  if (!contract.stripeSubscriptionId || !contract.autopayEnabled) {
    return res.status(409).json({ error: 'Autopay is not enabled for this contract.' });
  }

  try {
    const stripe = new Stripe(config.stripeSecretKey);
    const subscription = await stripe.subscriptions.cancel(contract.stripeSubscriptionId);
    const updatedContract = updateContract(contract.id, {
      autopayEnabled: false,
      stripeSubscriptionStatus: subscription.status,
      nextPaymentDueAt: null,
    });
    recordAudit({
      actorType: 'client',
      actorId: req.clientUser.id,
      action: 'contract.autopay.cancelled',
      entityType: 'contract',
      entityId: contract.id,
    });
    return res.json({ contract: updatedContract });
  } catch (error) {
    console.error('Failed to cancel Stripe contract autopay:', error);
    return res.status(502).json({ error: 'Unable to cancel autopay right now.' });
  }
});

contractsRouter.post('/', requireAdmin, (req, res) => {
  const parsed = contractSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid contract payload.', details: parsed.error.flatten() });
  }
  if (parsed.data.packageType === 'custom') {
    if (parsed.data.packageMonthlyCostCents === undefined || parsed.data.packageRetainerHours === undefined) {
      return res.status(400).json({ error: 'Custom packages require a monthly cost and retainer hours.' });
    }
  } else if (!parsed.data.packageLevel) {
    return res.status(400).json({ error: 'Select a package level.' });
  }

  const contract = createContract(parsed.data);
  recordAudit({
    actorType: 'admin',
    actorId: req.admin.id,
    action: 'contract.create',
    entityType: 'contract',
    entityId: contract.id,
  });

  return res.status(201).json({ contract });
});

contractsRouter.patch('/:contractId', requireAdmin, (req, res) => {
  const parsed = contractSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid contract payload.', details: parsed.error.flatten() });
  }

  const contract = updateContract(req.params.contractId, parsed.data);
  if (!contract) {
    return res.status(404).json({ error: 'Contract not found.' });
  }

  recordAudit({
    actorType: 'admin',
    actorId: req.admin.id,
    action: 'contract.update',
    entityType: 'contract',
    entityId: contract.id,
  });

  return res.json({ contract });
});

contractsRouter.delete('/:contractId', requireAdmin, (req, res) => {
  const result = deleteContract(req.params.contractId);
  if (result.error === 'CONTRACT_NOT_FOUND') {
    return res.status(404).json({ error: 'Contract not found.' });
  }
  if (result.error === 'CONTRACT_AUTOPAY_ACTIVE') {
    return res.status(409).json({ error: 'Cancel autopay and wait for the Stripe subscription to finish before removing this contract.' });
  }

  recordAudit({
    actorType: 'admin',
    actorId: req.admin.id,
    action: 'contract.delete',
    entityType: 'contract',
    entityId: result.contract.id,
  });

  return res.json({ contract: result.contract });
});
