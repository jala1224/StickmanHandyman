import { Router } from 'express';
import Stripe from 'stripe';
import { config } from '../config.js';
import { requireAdmin } from '../middleware/auth.js';
import { getInvoiceById, markInvoicePaid, recordAudit, updateInvoiceStripeState } from '../services/store.js';
import { cancelTerminalInvoicePayment, createTerminalInvoicePayment, matchesInvoicePayment, withInvoicePaymentLock } from '../services/stripeCheckout.js';

export const terminalRouter = Router();
terminalRouter.use(requireAdmin);

function terminalConfigured() {
  return config.stripeTerminalEnabled && Boolean(config.stripeSecretKey && config.stripeTerminalLocationId)
    && (!config.stripeTerminalSimulated || /^sk_test_/.test(config.stripeSecretKey));
}

terminalRouter.get('/config', (req, res) => {
  res.json({
    enabled: terminalConfigured(),
    locationId: terminalConfigured() ? config.stripeTerminalLocationId : null,
    simulated: config.stripeTerminalSimulated,
  });
});

terminalRouter.post('/connection-token', async (req, res) => {
  if (!terminalConfigured()) return res.status(503).json({ error: 'Stripe Terminal is not configured for this environment.' });
  try {
    const stripe = new Stripe(config.stripeSecretKey);
    const token = await stripe.terminal.connectionTokens.create({ location: config.stripeTerminalLocationId });
    return res.json({ secret: token.secret });
  } catch (error) {
    console.error('Failed to create a Terminal connection token:', error);
    return res.status(502).json({ error: 'Unable to connect to Stripe Terminal.' });
  }
});

terminalRouter.post('/invoices/:invoiceId/payment-intent', async (req, res) => {
  if (!terminalConfigured()) return res.status(503).json({ error: 'Stripe Terminal is not configured for this environment.' });
  const invoice = getInvoiceById(req.params.invoiceId);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });
  try {
    const stripe = new Stripe(config.stripeSecretKey);
    const intent = await createTerminalInvoicePayment(stripe, invoice, updateInvoiceStripeState);
    if (!intent.client_secret) throw new Error('Stripe returned no Terminal payment client secret.');
    recordAudit({ actorType: 'admin', actorId: req.admin.id, action: 'invoice.terminal.created', entityType: 'invoice', entityId: invoice.id, metadata: { paymentIntentId: intent.id } });
    return res.json({ clientSecret: intent.client_secret });
  } catch (error) {
    console.error('Failed to create a Terminal invoice payment:', error);
    return res.status(error.statusCode === 409 ? 409 : 502).json({ error: error.statusCode === 409 ? error.message : 'Unable to start Tap to Pay.' });
  }
});

terminalRouter.post('/invoices/:invoiceId/reconcile', async (req, res) => {
  if (!config.stripeSecretKey) return res.status(503).json({ error: 'Stripe is not configured.' });
  const invoice = getInvoiceById(req.params.invoiceId);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });
  try {
    return await withInvoicePaymentLock(invoice.id, async () => {
      if (!invoice.stripeTerminalPaymentIntentId) return res.status(409).json({ error: 'This invoice has no Tap to Pay payment to check.' });
      const stripe = new Stripe(config.stripeSecretKey);
      const intent = await stripe.paymentIntents.retrieve(invoice.stripeTerminalPaymentIntentId);
      if (intent.metadata?.invoiceId !== invoice.id || intent.metadata?.source !== 'terminal'
        || !matchesInvoicePayment(invoice, { amountCents: intent.status === 'succeeded' ? intent.amount_received : intent.amount, currency: intent.currency })) {
        return res.status(409).json({ error: 'The Stripe payment does not match this invoice.' });
      }
      if (intent.status === 'succeeded') {
        markInvoicePaid(invoice.id, intent.id);
        updateInvoiceStripeState(invoice.id, { stripePaymentStatus: 'succeeded', stripeLivemode: intent.livemode });
        recordAudit({ actorType: 'admin', actorId: req.admin.id, action: 'invoice.terminal.reconciled', entityType: 'invoice', entityId: invoice.id, metadata: { paymentIntentId: intent.id } });
      }
      return res.json({ status: intent.status, invoice });
    });
  } catch (error) {
    console.error('Failed to reconcile a Terminal payment:', error);
    return res.status(502).json({ error: 'Unable to verify payment. Do not collect another payment until its status is confirmed.' });
  }
});

terminalRouter.post('/invoices/:invoiceId/cancel', async (req, res) => {
  if (!config.stripeSecretKey) return res.status(503).json({ error: 'Stripe is not configured.' });
  const invoice = getInvoiceById(req.params.invoiceId);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });
  try {
    await withInvoicePaymentLock(invoice.id, () => cancelTerminalInvoicePayment(new Stripe(config.stripeSecretKey), invoice, updateInvoiceStripeState));
    return res.status(204).end();
  } catch (error) {
    console.error('Failed to cancel a Terminal payment:', error);
    return res.status(error.statusCode === 409 ? 409 : 502).json({ error: error.statusCode === 409 ? error.message : 'Unable to cancel Tap to Pay. Check payment status before retrying.' });
  }
});
