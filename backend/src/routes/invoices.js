import { Router } from 'express';
import { z } from 'zod';
import Stripe from 'stripe';
import { canReplaceCheckoutSession, createInvoiceCheckoutSession, getCheckoutOrigin, getCheckoutResponse } from '../services/stripeCheckout.js';
import { readBearerToken, requireAdmin } from '../middleware/auth.js';
import { config } from '../config.js';
import { authorizeInvoiceLookupAccess, authorizeInvoicePaymentAccess, createInvoice, deleteInvoice, getClientById, getInvoiceById, getInvoices, previewInvoiceContractPricing, recordAudit, updateInvoice, updateInvoiceStripeState, verifyAdminSession, verifyClientSession, verifyLookupSession } from '../services/store.js';
import { deleteInvoicePdf, getInvoicePdfBuffer, invoicePdfFileName, saveInvoicePdf } from '../services/invoicePdf.js';

export const invoicesRouter = Router();

const invoiceLineItemSchema = z.object({
  type: z.enum(['labor', 'material', 'package']).default('labor'),
  description: z.string().min(1),
  quantity: z.number().positive().multipleOf(0.25).default(1),
  unitPriceCents: z.number().int().nonnegative().default(0),
  taxable: z.boolean().optional().default(false),
});

const invoiceSchema = z.object({
  accountId: z.string().min(1).optional(),
  clientId: z.string().min(1).optional(),
  billingBusinessId: z.string().min(1).nullable().optional(),
  invoiceNumber: z.string().min(1).optional(),
  issueDate: z.string().optional(),
  amountCents: z.number().int().nonnegative().optional(),
  subtotalCents: z.number().int().nonnegative().optional(),
  discountCents: z.number().int().nonnegative().optional(),
  currency: z.string().min(3).default('usd'),
  status: z.string().optional(),
  serviceAddress: z.string().optional(),
  contractId: z.string().nullable().optional(),
  isOngoing: z.boolean().optional(),
  jobName: z.string().max(160).optional(),
  jobDescription: z.string().max(500).optional(),
  contractorHours: z.array(z.object({
    contractorId: z.string().min(1),
    hours: z.number().positive().multipleOf(0.25),
  })).optional(),
  stripePaymentIntentId: z.string().optional(),
  lineItems: z.array(invoiceLineItemSchema).optional(),
});

const invoiceUpdateSchema = invoiceSchema.partial().omit({ status: true }).extend({
  status: z.enum(['paid', 'sent']).optional(),
});

invoicesRouter.get('/', requireAdmin, (req, res) => {
  res.json({ invoices: getInvoices() });
});

invoicesRouter.post('/contract-pricing-preview', requireAdmin, (req, res) => {
  const parsed = invoiceSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid contract invoice preview.', details: parsed.error.flatten() });
  }
  if (!parsed.data.accountId && !parsed.data.clientId) {
    return res.status(400).json({ error: 'Select a client to preview contract pricing.' });
  }
  const pricing = previewInvoiceContractPricing(parsed.data);
  if (pricing.error) return res.status(400).json({ error: pricing.error });
  return res.json({ pricing });
});

invoicesRouter.post('/', requireAdmin, async (req, res) => {
  const parsed = invoiceSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid invoice payload.', details: parsed.error.flatten() });
  }

  if (!parsed.data.accountId && !parsed.data.clientId) {
    return res.status(400).json({ error: 'Either accountId or clientId is required.' });
  }
  if (parsed.data.isOngoing && !parsed.data.jobName?.trim()) {
    return res.status(400).json({ error: 'A job name is required for ongoing jobs.' });
  }

  let invoice;
  try {
    invoice = createInvoice(parsed.data);
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message || 'Unable to calculate contract invoice pricing.' });
  }
  recordAudit({
    actorType: 'admin',
    actorId: req.admin.id,
    action: 'invoice.create',
    entityType: 'invoice',
    entityId: invoice.id,
  });

  if (invoice.status !== 'ongoing') {
    try {
      const client = getClientById(invoice.accountId) || invoice.clientSnapshot;
      await saveInvoicePdf(invoice, client);
    } catch (error) {
      console.error('Failed to save invoice PDF:', error);
    }
  }

  return res.status(201).json({ invoice });
});

invoicesRouter.delete('/:invoiceId', requireAdmin, async (req, res) => {
  try {
    await expireInvoiceCheckout(getInvoiceById(req.params.invoiceId));
  } catch (error) {
    return res.status(error.statusCode || 502).json({ error: error.message });
  }
  const result = deleteInvoice(req.params.invoiceId);
  if (result.error === 'INVOICE_NOT_FOUND') {
    return res.status(404).json({ error: 'Invoice not found.' });
  }

  if (result.error === 'INVOICE_NOT_DELETABLE') {
    return res.status(409).json({ error: 'Only unpaid invoices can be deleted.' });
  }

  recordAudit({
    actorType: 'admin',
    actorId: req.admin.id,
    action: 'invoice.delete',
    entityType: 'invoice',
    entityId: result.invoice.id,
  });

  if (result.invoice.invoiceNumber) {
    try {
      await deleteInvoicePdf(result.invoice.invoiceNumber);
    } catch (error) {
      console.error('Failed to delete invoice PDF:', error);
    }
  }

  return res.json({ invoice: result.invoice });
});

invoicesRouter.patch('/:invoiceId', requireAdmin, async (req, res) => {
  const parsed = invoiceUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid invoice payload.', details: parsed.error.flatten() });
  }

  let invoice;
  try {
    await expireInvoiceCheckout(getInvoiceById(req.params.invoiceId));
    invoice = updateInvoice(req.params.invoiceId, parsed.data);
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message || 'Unable to calculate contract invoice pricing.' });
  }
  if (!invoice) {
    return res.status(404).json({ error: 'Invoice not found.' });
  }

  recordAudit({
    actorType: 'admin',
    actorId: req.admin.id,
    action: 'invoice.update',
    entityType: 'invoice',
    entityId: invoice.id,
  });

  if (invoice.status !== 'ongoing') {
    try {
      const client = getClientById(invoice.accountId) || invoice.clientSnapshot;
      await saveInvoicePdf(invoice, client);
    } catch (error) {
      console.error('Failed to save invoice PDF:', error);
    }
  }

  return res.json({ invoice });
});

invoicesRouter.post('/:invoiceId/lookup-access', (req, res) => {
  const parsed = z.object({
    lookupAccessToken: z.string().uuid(),
  }).safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: 'A valid lookup access token is required.', details: parsed.error.flatten() });
  }

  const authorized = authorizeInvoiceLookupAccess({
    invoiceId: req.params.invoiceId,
    lookupToken: parsed.data.lookupAccessToken,
  });

  if (authorized.error === 'LOOKUP_SESSION_INVALID') {
    return res.status(401).json({ error: 'Lookup access has expired. Please search for your account again.' });
  }

  if (authorized.error === 'INVOICE_NOT_FOUND') {
    return res.status(404).json({ error: 'Invoice not found.' });
  }

  if (authorized.error === 'INVOICE_ACCESS_DENIED') {
    return res.status(403).json({ error: 'This invoice does not belong to the verified account.' });
  }

  if (authorized.error === 'INVOICE_NOT_PAYABLE') {
    return res.status(409).json({ error: 'This invoice is not currently payable.' });
  }

  return res.json({
    authorized: true,
    invoice: authorized.invoice,
    account: {
      id: authorized.account?.id ?? null,
      name: authorized.account?.name ?? null,
      address: authorized.account?.address ?? null,
    },
  });
});

invoicesRouter.get('/:invoiceId/pdf', async (req, res) => {
  const invoice = getInvoiceById(req.params.invoiceId);
  if (!invoice) {
    return res.status(404).json({ error: 'Invoice not found.' });
  }

  const adminToken = readBearerToken(req);
  const isAdmin = adminToken && verifyAdminSession(adminToken);

  if (!isAdmin) {
    const session = req.headers.authorization
      ? verifyClientSession(adminToken)
      : verifyLookupSession(String(req.query.lookupAccessToken || ''));
    if (!session || session.accountId !== (invoice.accountId || invoice.clientId)) {
      return res.status(403).json({ error: 'You do not have access to this invoice.' });
    }
  }
  if (invoice.status === 'ongoing') {
    return res.status(409).json({ error: 'Ongoing jobs do not have an invoice PDF yet.' });
  }

  try {
    const client = getClientById(invoice.accountId) || invoice.clientSnapshot;
    const buffer = await getInvoicePdfBuffer(invoice, client);
    const disposition = req.query.disposition === 'inline' ? 'inline' : 'attachment';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${disposition}; filename="${invoicePdfFileName(invoice.invoiceNumber)}"`);
    return res.send(buffer);
  } catch (error) {
    console.error('Failed to generate invoice PDF:', error);
    return res.status(500).json({ error: 'Unable to generate the invoice PDF right now.' });
  }
});

invoicesRouter.post('/:invoiceId/checkout-session', async (req, res) => {
  const parsed = z.object({
    lookupAccessToken: z.string().uuid().optional(),
    returnPath: z.string().min(1).optional(),
    uiMode: z.enum(['hosted', 'embedded']).default('hosted'),
  }).safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid checkout request.', details: parsed.error.flatten() });
  }

  if (!config.stripeSecretKey || !config.stripePublishableKey) {
    return res.status(503).json({ error: 'Stripe is not configured yet.' });
  }

  const authorized = authorizeInvoicePaymentAccess({
    invoiceId: req.params.invoiceId,
    lookupToken: parsed.data.lookupAccessToken,
    clientToken: req.headers.authorization === undefined ? undefined : readBearerToken(req),
  });

  if (authorized.error === 'LOOKUP_SESSION_INVALID' || authorized.error === 'CLIENT_SESSION_INVALID') {
    return res.status(401).json({ error: 'Your session has expired. Sign in or search for your account again.' });
  }

  if (authorized.error === 'INVOICE_NOT_FOUND') {
    return res.status(404).json({ error: 'Invoice not found.' });
  }

  if (authorized.error === 'INVOICE_ACCESS_DENIED') {
    return res.status(403).json({ error: 'This invoice does not belong to the verified account.' });
  }

  if (authorized.error === 'INVOICE_NOT_PAYABLE') {
    return res.status(409).json({ error: 'This invoice is not currently payable.' });
  }

  const invoice = authorized.invoice;
  const origin = getCheckoutOrigin(req.headers.origin, config.corsOrigins);
  const allowedReturnPaths = new Set(['portal-client.html', 'portal-found.html']);
  const returnPath = allowedReturnPaths.has(parsed.data.returnPath) ? parsed.data.returnPath : 'portal-client.html';

  try {
    const stripe = new Stripe(config.stripeSecretKey);
    const session = await createInvoiceCheckoutSession(stripe, invoice, { uiMode: parsed.data.uiMode, origin, returnPath }, updateInvoiceStripeState);

    return res.json(getCheckoutResponse(session, config.stripePublishableKey));
  } catch (error) {
    console.error('Failed to create Stripe checkout session:', error);
    return res.status(error.statusCode || 502).json({ error: error.statusCode ? error.message : 'Unable to start checkout right now.' });
  }
});

async function expireInvoiceCheckout(invoice) {
  if (!invoice?.stripeCheckoutSessionId) return;
  if (!config.stripeSecretKey) {
    const expiresAt = Date.parse(invoice.stripeCheckoutExpiresAt || '');
    const expiredSandboxTestSession = config.localSandbox
      && invoice.stripeLivemode === false
      && invoice.stripeCheckoutSessionId.startsWith('cs_test_')
      && invoice.stripePaymentStatus === 'pending'
      && !invoice.stripePaymentIntentId
      && Number.isFinite(expiresAt)
      && expiresAt <= Date.now();
    if (!expiredSandboxTestSession) {
      throw Object.assign(new Error('Stripe must be configured to invalidate the existing checkout session before changing this invoice.'), { statusCode: 503 });
    }
    updateInvoiceStripeState(invoice.id, { stripeCheckoutSessionId: null, stripeCheckoutUrl: null, stripeCheckoutExpiresAt: null, stripePaymentStatus: 'expired' });
    return;
  }
  const stripe = new Stripe(config.stripeSecretKey);
  const session = await stripe.checkout.sessions.retrieve(invoice.stripeCheckoutSessionId);
  if (!await canReplaceCheckoutSession(stripe, session)) throw Object.assign(new Error('A Stripe payment is already submitted. Refresh its status before changing this invoice.'), { statusCode: 409 });
  if (session.status === 'open') await stripe.checkout.sessions.expire(session.id);
  updateInvoiceStripeState(invoice.id, { stripeCheckoutSessionId: null, stripeCheckoutUrl: null, stripeCheckoutExpiresAt: null, stripePaymentStatus: 'expired' });
}

invoicesRouter.post('/:invoiceId/payment-intent', async (req, res) => {
  const parsed = z.object({
    lookupAccessToken: z.string().uuid().optional(),
  }).safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: 'A valid lookup access token is required.', details: parsed.error.flatten() });
  }

  if (!config.stripeSecretKey || !config.stripePublishableKey) {
    return res.status(503).json({ error: 'Stripe is not configured yet.' });
  }

  const authorized = authorizeInvoicePaymentAccess({
    invoiceId: req.params.invoiceId,
    lookupToken: parsed.data.lookupAccessToken,
    clientToken: req.headers.authorization === undefined ? undefined : readBearerToken(req),
  });

  if (authorized.error === 'LOOKUP_SESSION_INVALID' || authorized.error === 'CLIENT_SESSION_INVALID') {
    return res.status(401).json({ error: 'Your session has expired. Sign in or search for your account again.' });
  }

  if (authorized.error === 'INVOICE_NOT_FOUND') {
    return res.status(404).json({ error: 'Invoice not found.' });
  }

  if (authorized.error === 'INVOICE_ACCESS_DENIED') {
    return res.status(403).json({ error: 'This invoice does not belong to the verified account.' });
  }

  if (authorized.error === 'INVOICE_NOT_PAYABLE') {
    return res.status(409).json({ error: 'This invoice is not currently payable.' });
  }

  const invoice = authorized.invoice;

  try {
    const stripe = new Stripe(config.stripeSecretKey);
    const paymentIntent = await stripe.paymentIntents.create({
      amount: invoice.amountCents,
      currency: invoice.currency || 'usd',
      metadata: { invoiceId: invoice.id },
      automatic_payment_methods: { enabled: true },
    });

    return res.json({
      clientSecret: paymentIntent.client_secret,
      publishableKey: config.stripePublishableKey,
      invoice: {
        invoiceNumber: invoice.invoiceNumber,
        amountCents: invoice.amountCents,
        currency: invoice.currency || 'usd',
      },
    });
  } catch (error) {
    console.error('Failed to create Stripe payment intent:', error);
    return res.status(502).json({ error: 'Unable to start checkout right now.' });
  }
});
