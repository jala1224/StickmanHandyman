import { Router } from 'express';
import Stripe from 'stripe';
import { config } from '../config.js';
import { getContractById, getContractByStripeSubscriptionId, markInvoicePaid, recordAudit, updateContract } from '../services/store.js';
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

  const payment = getCompletedInvoicePayment(event);
  if (!payment) {
    return res.json({ received: true });
  }

  const invoice = markInvoicePaid(payment.invoiceId, payment.paymentIntentId);
  if (!invoice) {
    return res.status(404).json({ error: 'Invoice referenced by Stripe was not found.' });
  }

  recordAudit({
    actorType: 'stripe',
    actorId: payment.paymentIntentId || event.id,
    action: 'invoice.payment.completed',
    entityType: 'invoice',
    entityId: invoice.id,
  });

  return res.json({ received: true });
});

function getContractStripeUpdate(event) {
  if (event.type === 'checkout.session.completed') {
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
          stripeSubscriptionStatus: 'active',
          autopayEnabled: true,
          ...(typeof session.subscription === 'object' && session.subscription.current_period_end ? {
            nextPaymentDueAt: new Date(session.subscription.current_period_end * 1000).toISOString(),
          } : {}),
          ...(session.payment_status === 'paid' && Number(session.amount_total || 0) > 0 ? {
            lastPaymentAt: new Date(event.created * 1000).toISOString(),
            lastPaymentAmountCents: Number(session.amount_total),
          } : {}),
        },
      };
    }
    return null;
  }

  if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
    const invoice = event.data.object;
    const subscriptionId = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;
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
        nextPaymentDueAt: !isDeleted && subscription.current_period_end
          ? new Date(subscription.current_period_end * 1000).toISOString()
          : null,
      },
    };
  }

  return null;
}

function getCompletedInvoicePayment(event) {
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    if (session.payment_status !== 'paid') {
      return null;
    }

    return {
      invoiceId: session.metadata?.invoiceId || session.client_reference_id,
      paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null,
    };
  }

  if (event.type === 'payment_intent.succeeded') {
    const paymentIntent = event.data.object;
    return {
      invoiceId: paymentIntent.metadata?.invoiceId,
      paymentIntentId: paymentIntent.id,
    };
  }

  return null;
}
