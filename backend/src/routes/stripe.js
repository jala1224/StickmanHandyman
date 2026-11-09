import { Router } from 'express';
import Stripe from 'stripe';
import { config } from '../config.js';
import { getContractById, getContractByStripeSubscriptionId, getInvoiceById, markInvoicePaid, recordAudit, updateContract, updateInvoiceStripeState } from '../services/store.js';
import { getInvoicePaymentEvent, matchesInvoicePayment } from '../services/stripeCheckout.js';
import { getNextContractPaymentDueAt } from '../services/contractPricing.js';

export const stripeRouter = Router();

stripeRouter.post('/webhook', (req, res) => {
  if (!config.stripeSecretKey || !config.stripeWebhookSecret) {
    return res.status(503).json({ error: 'Stripe webhook is not configured.' });
  }

  const signature = req.headers['stripe-signature'];
  if (!signature) {
    return res.status(400).json({ error: 'Stripe signature is required.' });
  }

  let event;
  try {
    const stripe = new Stripe(config.stripeSecretKey);
    event = stripe.webhooks.constructEvent(req.body, signature, config.stripeWebhookSecret);
  } catch {
    return res.status(400).json({ error: 'Invalid Stripe webhook signature.' });
  }

  const contractUpdate = getContractStripeUpdate(event);
  if (contractUpdate) {
    const contract = contractUpdate.contractId
      ? getContractById(contractUpdate.contractId)
      : getContractByStripeSubscriptionId(contractUpdate.subscriptionId);
    if (!contract) {
      return res.status(404).json({ error: 'Contract referenced by Stripe was not found.' });
    }

    updateContract(contract.id, contractUpdate.changes);
    recordAudit({
      actorType: 'stripe',
      actorId: event.id,
      action: contractUpdate.action,
      entityType: 'contract',
      entityId: contract.id,
    });
    return res.json({ received: true });
  }

  const payment = getInvoicePaymentEvent(event);
  if (!payment) {
    return res.json({ received: true });
  }

  const invoice = getInvoiceById(payment.invoiceId);
  if (!invoice) {
    return res.status(404).json({ error: 'Invoice referenced by Stripe was not found.' });
  }

  if (!matchesInvoicePayment(invoice, payment)) return res.status(409).json({ error: 'Stripe payment amount or currency does not match the invoice.' });
  if (payment.checkoutSessionId && invoice.stripeCheckoutSessionId && payment.checkoutSessionId !== invoice.stripeCheckoutSessionId && payment.status !== 'succeeded') return res.json({ received: true });
  if (payment.status === 'succeeded') {
    markInvoicePaid(invoice.id, payment.paymentIntentId);
    updateInvoiceStripeState(invoice.id, { stripePaymentStatus: 'succeeded', stripeLivemode: payment.livemode });
  }
  else updateInvoiceStripeState(invoice.id, {
    stripePaymentStatus: payment.status, stripePaymentError: payment.error,
    ...(payment.paymentIntentId ? { stripePaymentIntentId: payment.paymentIntentId } : {}),
  });

  recordAudit({
    actorType: 'stripe',
    actorId: payment.paymentIntentId || event.id,
    action: `invoice.payment.${payment.status}`,
    entityType: 'invoice',
    entityId: invoice.id,
  });

  return res.json({ received: true });
});

function getContractStripeUpdate(event) {
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const session = event.data.object;
    const contractId = session.metadata?.contractId;
    if (!contractId) {
      return null;
    }

    if (session.mode === 'payment' && session.payment_status === 'paid') {
      const contract = getContractById(contractId);
      const lastPaymentAt = new Date(event.created * 1000).toISOString();
      return {
        contractId,
        action: 'contract.payment.completed',
        changes: {
          lastPaymentAt,
          lastPaymentAmountCents: Number(session.amount_total || 0),
          lastPaymentSource: 'stripe',
          manualPaymentPreviousLastPaymentAt: null,
          manualPaymentPreviousLastPaymentAmountCents: null,
          manualPaymentPreviousLastPaymentSource: null,
          manualPaymentPreviousNextPaymentDueAt: null,
          nextPaymentDueAt: contract ? getNextContractPaymentDueAt(contract, lastPaymentAt) : null,
        },
      };
    }

    if (session.mode === 'subscription' && session.subscription) {
      const subscriptionId = typeof session.subscription === 'string'
        ? session.subscription
        : session.subscription.id;
      return {
        contractId,
        action: 'contract.autopay.enabled',
        changes: {
          stripeSubscriptionId: subscriptionId,
          stripeSubscriptionStatus: session.payment_status === 'paid' ? 'active' : 'incomplete',
          autopayEnabled: session.payment_status === 'paid',
          ...(typeof session.subscription === 'object' && session.subscription.current_period_end ? {
            nextPaymentDueAt: new Date(session.subscription.current_period_end * 1000).toISOString(),
          } : {}),
          ...(session.payment_status === 'paid' && Number(session.amount_total || 0) > 0 ? {
            lastPaymentAt: new Date(event.created * 1000).toISOString(),
            lastPaymentAmountCents: Number(session.amount_total),
            lastPaymentSource: 'stripe',
            manualPaymentPreviousLastPaymentAt: null,
            manualPaymentPreviousLastPaymentAmountCents: null,
            manualPaymentPreviousLastPaymentSource: null,
            manualPaymentPreviousNextPaymentDueAt: null,
          } : {}),
        },
      };
    }
    return null;
  }

  if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
    const invoice = event.data.object;
    const subscriptionReference = invoice.subscription || invoice.parent?.subscription_details?.subscription;
    const subscriptionId = typeof subscriptionReference === 'string' ? subscriptionReference : subscriptionReference?.id;
    if (!subscriptionId) {
      return null;
    }

    const isPaid = event.type === 'invoice.paid';
    const periodEnd = invoice.lines?.data?.find((line) => line.period?.end)?.period.end;
    return {
      subscriptionId,
      action: isPaid ? 'contract.autopay.payment_succeeded' : 'contract.autopay.payment_failed',
      changes: isPaid ? {
        stripeSubscriptionStatus: 'active',
        lastPaymentAt: new Date(event.created * 1000).toISOString(),
        lastPaymentAmountCents: Number(invoice.amount_paid || 0),
        lastPaymentSource: 'stripe',
        manualPaymentPreviousLastPaymentAt: null,
        manualPaymentPreviousLastPaymentAmountCents: null,
        manualPaymentPreviousLastPaymentSource: null,
        manualPaymentPreviousNextPaymentDueAt: null,
        ...(periodEnd ? { nextPaymentDueAt: new Date(periodEnd * 1000).toISOString() } : {}),
      } : {
        stripeSubscriptionStatus: 'past_due',
        ...(periodEnd ? { nextPaymentDueAt: new Date(periodEnd * 1000).toISOString() } : {}),
      },
    };
  }

  if (event.type === 'customer.subscription.created'
    || event.type === 'customer.subscription.updated'
    || event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const isDeleted = event.type === 'customer.subscription.deleted';
    const isEnabled = !isDeleted && ['active', 'trialing', 'past_due'].includes(subscription.status);
    return {
      ...(subscription.metadata?.contractId ? { contractId: subscription.metadata.contractId } : {}),
      subscriptionId: subscription.id,
      action: isDeleted
        ? 'contract.autopay.cancelled'
        : event.type === 'customer.subscription.created'
          ? 'contract.autopay.created'
          : 'contract.autopay.status_updated',
      changes: {
        stripeSubscriptionId: subscription.id,
        stripeSubscriptionStatus: subscription.status,
        autopayEnabled: isEnabled,
        nextPaymentDueAt: !isDeleted && (subscription.current_period_end || subscription.items?.data?.[0]?.current_period_end)
          ? new Date((subscription.current_period_end || subscription.items.data[0].current_period_end) * 1000).toISOString()
          : null,
      },
    };
  }

  return null;
}
