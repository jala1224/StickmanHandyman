import express, { Router } from 'express';
import { z } from 'zod';
import Stripe from 'stripe';
import { createContractAttachmentId, deleteAllContractAttachments, deleteContractAttachment, readContractAttachment, saveContractAttachment } from '../services/contractAttachmentStorage.js';
import { createSignatureRequest, withSignatureRequestLock } from '../services/contractSignature.js';
import { createContractCheckoutSession, getCheckoutOrigin, getCheckoutPresentation, getCheckoutResponse } from '../services/stripeCheckout.js';
import { requireAdmin, requireClient } from '../middleware/auth.js';
import { config } from '../config.js';
import { getContractBillingPrice, getContractPaymentSummary, getManualContractPaymentChanges } from '../services/contractPricing.js';
import { contractPdfFileName, generateContractPdfBuffer } from '../services/contractPdf.js';
import { calculateLaborContractSummary, getContractPeriodIndex, getMaintenanceContractTerms } from '../services/maintenanceContractBilling.js';
import { getMaintenanceContractSummary } from '../services/contractInvoiceBilling.js';
import { getContractorById } from '../services/contractorRepository.js';
import { createContract, deleteContract, getClientById, getClientUserByAccountId, getContractById, getContracts, getInvoices, recordAudit, updateClient, updateContract, verifyLookupSession } from '../services/store.js';

export const contractsRouter = Router();

const contractSchema = z.object({
  clientId: z.string().min(1),
  contractType: z.enum(['maintenance', 'labor']).default('maintenance'),
  title: z.string().trim().min(1).max(160).optional(),
  scope: z.string().trim().min(1).max(5000).optional(),
  serviceAddress: z.string().trim().min(1).max(500).optional(),
  status: z.string().optional(),
  billingCycle: z.string().optional(),
  startDate: z.string().optional(),
  packageType: z.enum(['single_home', 'portfolio', 'custom']).optional(),
  packageCoverageType: z.enum(['single_home', 'portfolio']).optional(),
  packageLevel: z.enum(['basic', 'pro', 'premium']).nullable().optional(),
  packageMonthlyCostCents: z.number().int().nonnegative().optional(),
  packageRetainerHours: z.number().nonnegative().multipleOf(0.25).optional(),
  packageRolloverHours: z.number().nonnegative().multipleOf(0.25).optional(),
  packageDiscountPercent: z.number().min(0).max(100).optional(),
  laborPricingModel: z.enum(['fixed', 'hourly_estimate']).optional(),
  laborFixedAmountCents: z.number().int().positive().optional(),
  laborEstimatedContractorHours: z.array(z.object({
    contractorId: z.string().min(1),
    hours: z.number().positive().multipleOf(0.25),
  })).optional(),
  laborEstimatedMaterialsCents: z.number().int().nonnegative().optional(),
  laborEstimatedMaterialsItems: z.array(z.object({
    amountCents: z.number().int().nonnegative(),
  })).max(1).optional(),
  laborEstimatedOtherItems: z.array(z.object({
    description: z.string().trim().min(1).max(160),
    amountCents: z.number().int().nonnegative(),
  })).optional(),
  packagePriorityScheduling: z.boolean().optional(),
  packageAnnualInspection: z.boolean().optional(),
  packageQuarterlyInspection: z.boolean().optional(),
  packageOnCallService: z.boolean().optional(),
  packageTenantCoordination: z.boolean().optional(),
});

function validateContractTerms(contract, isCreate = false) {
  const contractType = contract.contractType || 'maintenance';
  if (contractType === 'labor') {
    if (!contract.title?.trim() || !contract.scope?.trim() || !contract.serviceAddress?.trim()) {
      return 'Labor contracts require a title, scope, and service address.';
    }
    if (contract.laborPricingModel === 'fixed' && !(Number(contract.laborFixedAmountCents) > 0)) {
      return 'Fixed-bid labor contracts require a fixed contract amount.';
    }
    if (contract.laborPricingModel === 'hourly_estimate') {
      const estimates = contract.laborEstimatedContractorHours || [];
      if (!estimates.length) return 'Add at least one contractor and estimated hours.';
      if (estimates.some((entry) => !getContractorById(entry.contractorId))) {
        return 'Choose a valid contractor for every estimated-hours row.';
      }
    }
    if (!['fixed', 'hourly_estimate'].includes(contract.laborPricingModel)) {
      return 'Choose a quoted price or hourly estimate for a labor contract.';
    }
    return null;
  }

  if (!isCreate && !contract.serviceAddress?.trim()) return null;
  if (!contract.serviceAddress?.trim()) return 'Maintenance contracts require a service address.';
  if (contract.packageType === 'custom') {
    if (contract.packageMonthlyCostCents === undefined || contract.packageRetainerHours === undefined) {
      return 'Custom packages require a monthly cost and retainer hours.';
    }
  } else if (!contract.packageLevel) {
    return 'Select a maintenance package level.';
  }
  return null;
}

contractsRouter.get('/', requireAdmin, (req, res) => {
  const invoices = getInvoices();
  res.json({ contracts: getContracts().map((contract) => {
    const price = getContractBillingPrice(contract);
    const { signedAttachments = [], ...publicContract } = contract;
    return {
      ...publicContract,
      signedAttachments: signedAttachments.filter(attachment => !attachment.generatedContract || attachment.signedCopy).map((attachment) => ({
        ...attachment,
        signatureRequests: (attachment.signatureRequests || []).map(({ tokenHash, ...request }) => request),
      })),
      ...getContractPaymentSummary(contract),
      ...(price ? { billingAmountCents: price.amountCents } : {}),
      ...((contract.contractType || 'maintenance') === 'maintenance' ? {
        maintenanceTerms: getMaintenanceContractTerms(contract),
        maintenanceSummary: getMaintenanceContractSummary(contract, invoices, getClientById(contract.accountId || contract.clientId)),
      } : {}),
      ...(contract.contractType === 'labor' ? { laborSummary: calculateLaborContractSummary(contract, invoices) } : {}),
    };
  }) });
});

contractsRouter.get('/:contractId/pdf', requireAdmin, async (req, res) => {
  const contract = getContractById(req.params.contractId);
  if (!contract) return res.status(404).json({ error: 'Contract not found.' });

  try {
    const client = getClientById(contract.accountId || contract.clientId);
    const buffer = await generateContractPdfBuffer(contract, client);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${contractPdfFileName(contract.contractNumber)}"`);
    return res.send(buffer);
  } catch (error) {
    console.error('Failed to generate contract PDF:', error);
    return res.status(500).json({ error: 'Unable to generate the contract PDF right now.' });
  }
});

contractsRouter.post('/:contractId/signature-request', requireAdmin, async (req, res) => {
  const parsed = z.object({
    signerName: z.string().trim().min(2).max(120).optional(),
    signerEmail: z.string().trim().email().max(254).optional(),
  }).safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Signer details are invalid.' });

  try {
    const result = await withSignatureRequestLock(`generated-contract:${req.params.contractId}`, async () => {
      const contract = getContractById(req.params.contractId);
      if (!contract) return { status: 404, payload: { error: 'Contract not found.' } };

      const client = getClientById(contract.accountId || contract.clientId);
      const signerName = client?.name || parsed.data.signerName;
      if (!signerName) return { status: 400, payload: { error: 'This contract has no client name to use for signing.' } };
      const buffer = await generateContractPdfBuffer(contract, client);
      const now = new Date();
      const attachment = {
        id: createContractAttachmentId(),
        fileName: contractPdfFileName(contract.contractNumber),
        uploadedAt: now.toISOString(),
        sizeBytes: buffer.length,
        generatedContract: true,
      };

      const previousAttachments = (contract.signedAttachments || []).map(item => item.generatedContract
        ? {
            ...item,
            signatureRequests: (item.signatureRequests || []).map(request => request.status === 'pending'
              ? { ...request, status: 'superseded', supersededAt: now.toISOString() }
              : request),
          }
        : item);

      try {
        await saveContractAttachment(contract.id, attachment.id, buffer);
        const { token, request } = await createSignatureRequest(contract.id, attachment, signerName, parsed.data.signerEmail, now);
        const updatedAttachment = { ...attachment, signatureRequests: [request] };
        updateContract(contract.id, { signedAttachments: [...previousAttachments, updatedAttachment] });
        const origin = getCheckoutOrigin(req.headers.origin, config.corsOrigins);
        const signingUrl = `${origin}/sign-contract.html#token=${encodeURIComponent(token)}`;
        recordAudit({ actorType: 'admin', actorId: req.admin.id, action: 'contract.signature.requested', entityType: 'contract', entityId: contract.id, metadata: { attachmentId: attachment.id, signatureRequestId: request.id, signerEmail: request.signerEmail, expiresAt: request.expiresAt, generatedContract: true } });
        return {
          status: 201,
          payload: {
            signingUrl,
            attachment: { id: attachment.id, fileName: attachment.fileName, uploadedAt: attachment.uploadedAt, generatedContract: true },
            request: { id: request.id, signerName: request.signerName, signerEmail: request.signerEmail, status: request.status, expiresAt: request.expiresAt },
          },
        };
      } catch (error) {
        await deleteContractAttachment(contract.id, attachment.id).catch(() => {});
        throw error;
      }
    });
    return res.status(result.status).json(result.payload);
  } catch (error) {
    console.error('Failed to create a generated contract signing link:', error);
    return res.status(500).json({ error: 'Unable to generate the contract and create a signing link.' });
  }
});

contractsRouter.post('/:contractId/attachments', requireAdmin, express.raw({ type: 'application/pdf', limit: '10mb' }), async (req, res) => {
  const contract = getContractById(req.params.contractId);
  if (!contract) return res.status(404).json({ error: 'Contract not found.' });
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'Select a PDF file to upload.' });
  if (req.body.length < 5 || req.body.subarray(0, 5).toString('ascii') !== '%PDF-') {
    return res.status(415).json({ error: 'The uploaded file is not a valid PDF.' });
  }

  const parsed = z.object({ filename: z.string().trim().min(1).max(200) }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'A PDF filename is required.' });
  const fileName = parsed.data.filename.replace(/\\/g, '/').split('/').pop()
    .replace(/[\u0000-\u001f\u007f"<>:*?|]/g, '_').trim();
  if (!fileName || !/\.pdf$/i.test(fileName)) return res.status(415).json({ error: 'Only PDF attachments are supported.' });

  const attachment = {
    id: createContractAttachmentId(),
    fileName: fileName.length <= 160 ? fileName : `${fileName.slice(0, 156)}.pdf`,
    uploadedAt: new Date().toISOString(),
    sizeBytes: req.body.length,
  };
  try {
    await saveContractAttachment(contract.id, attachment.id, req.body);
    const updatedContract = updateContract(contract.id, { signedAttachments: [...(contract.signedAttachments || []), attachment] });
    recordAudit({ actorType: 'admin', actorId: req.admin.id, action: 'contract.attachment.uploaded', entityType: 'contract', entityId: contract.id, metadata: { attachmentId: attachment.id, fileName: attachment.fileName, sizeBytes: attachment.sizeBytes } });
    return res.status(201).json({ attachment, contract: updatedContract });
  } catch (error) {
    await deleteContractAttachment(contract.id, attachment.id).catch(() => {});
    console.error('Failed to store signed contract PDF:', error);
    return res.status(500).json({ error: 'Unable to save the contract attachment.' });
  }
});

contractsRouter.get('/:contractId/attachments/:attachmentId', requireAdmin, async (req, res) => {
  const contract = getContractById(req.params.contractId);
  if (!contract) return res.status(404).json({ error: 'Contract not found.' });
  const attachment = (contract.signedAttachments || []).find(item => item.id === req.params.attachmentId);
  if (!attachment) return res.status(404).json({ error: 'Contract attachment not found.' });
  try {
    const buffer = await readContractAttachment(contract.id, attachment.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${attachment.fileName}"`);
    res.setHeader('Content-Length', buffer.length);
    return res.send(buffer);
  } catch (error) {
    if (error.code === 'ENOENT') return res.status(404).json({ error: 'Contract attachment file was not found.' });
    console.error('Failed to read signed contract PDF:', error);
    return res.status(500).json({ error: 'Unable to read the contract attachment.' });
  }
});

contractsRouter.delete('/:contractId/attachments/:attachmentId', requireAdmin, async (req, res) => {
  const contract = getContractById(req.params.contractId);
  if (!contract) return res.status(404).json({ error: 'Contract not found.' });
  const attachment = (contract.signedAttachments || []).find(item => item.id === req.params.attachmentId);
  if (!attachment) return res.status(404).json({ error: 'Contract attachment not found.' });
  try {
    await deleteContractAttachment(contract.id, attachment.id);
    const updatedContract = updateContract(contract.id, { signedAttachments: contract.signedAttachments.filter(item => item.id !== attachment.id) });
    recordAudit({ actorType: 'admin', actorId: req.admin.id, action: 'contract.attachment.deleted', entityType: 'contract', entityId: contract.id, metadata: { attachmentId: attachment.id } });
    return res.json({ contract: updatedContract });
  } catch (error) {
    console.error('Failed to delete signed contract PDF:', error);
    return res.status(500).json({ error: 'Unable to remove the contract attachment.' });
  }
});

contractsRouter.post('/:contractId/attachments/:attachmentId/signature-request', requireAdmin, async (req, res) => {
  const parsed = z.object({
    signerName: z.string().trim().min(2).max(120).optional(),
    signerEmail: z.string().trim().email().max(254).optional(),
    replaceExisting: z.boolean().default(false),
  }).safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Signer details are invalid.' });
  const contract = getContractById(req.params.contractId);
  if (!contract) return res.status(404).json({ error: 'Contract not found.' });
  const attachments = contract.signedAttachments || [];
  const attachment = attachments.find(item => item.id === req.params.attachmentId);
  if (!attachment) return res.status(404).json({ error: 'Contract attachment not found.' });
  if (attachment.signedCopy) return res.status(409).json({ error: 'A completed signed copy cannot be sent for signature.' });
  const client = getClientById(contract.accountId || contract.clientId);
  const signerName = parsed.data.signerName || client?.name;
  if (!signerName) return res.status(400).json({ error: 'This contract has no client name to use for signing.' });

  const now = new Date();
  const previousRequests = (attachment.signatureRequests || []).map(request => {
    if (request.status !== 'pending') return request;
    if (new Date(request.expiresAt).getTime() <= now.getTime()) return { ...request, status: 'expired' };
    return parsed.data.replaceExisting ? { ...request, status: 'superseded', supersededAt: now.toISOString() } : request;
  });
  if (!parsed.data.replaceExisting && previousRequests.some(request => request.status === 'pending')) {
    return res.status(409).json({ error: 'A signing link is already active for this PDF. Wait for it to be signed or expire.' });
  }

  try {
    const { token, request } = await createSignatureRequest(contract.id, attachment, signerName, parsed.data.signerEmail, now);
    const updatedAttachment = { ...attachment, signatureRequests: [...previousRequests, request] };
    updateContract(contract.id, { signedAttachments: attachments.map(item => item.id === attachment.id ? updatedAttachment : item) });
    const origin = getCheckoutOrigin(req.headers.origin, config.corsOrigins);
    const signingUrl = `${origin}/sign-contract.html#token=${encodeURIComponent(token)}`;
    recordAudit({ actorType: 'admin', actorId: req.admin.id, action: 'contract.signature.requested', entityType: 'contract', entityId: contract.id, metadata: { attachmentId: attachment.id, signatureRequestId: request.id, signerEmail: request.signerEmail, expiresAt: request.expiresAt } });
    return res.status(201).json({ signingUrl, request: { id: request.id, signerName: request.signerName, signerEmail: request.signerEmail, status: request.status, expiresAt: request.expiresAt } });
  } catch (error) {
    console.error('Failed to create a contract signing link:', error);
    return res.status(500).json({ error: 'Unable to create the contract signing link.' });
  }
});

contractsRouter.post('/:contractId/checkout-session', requireClient, async (req, res) => {
  const parsed = z.object({
    autopay: z.boolean().optional().default(false),
    uiMode: z.enum(['hosted', 'embedded']).default('hosted'),
  }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid contract checkout request.', details: parsed.error.flatten() });
  }
  if (!config.stripeSecretKey || (parsed.data.uiMode === 'embedded' && !config.stripePublishableKey)) {
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
      }, { idempotencyKey: `customer:${account.id}` });
      customerId = customer.id;
      updateClient(account.id, { stripeCustomerId: customerId });
    }

    const origin = getCheckoutOrigin(req.headers.origin, config.corsOrigins);
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
    const session = await createContractCheckoutSession(stripe, contract, {
      mode,
      customer: customerId,
      client_reference_id: contract.id,
      metadata: {
        contractId: contract.id,
        accountId: account.id,
        autopay: String(parsed.data.autopay),
        billingPeriod: String(getContractPeriodIndex(contract, new Date().toISOString())),
      },
      line_items: [lineItem],
      ...(parsed.data.autopay ? {
        subscription_data: { metadata: { contractId: contract.id, accountId: account.id } },
      } : {
        payment_intent_data: { metadata: { contractId: contract.id, accountId: account.id } },
      }),
      ...getCheckoutPresentation({
        uiMode: parsed.data.uiMode, origin, returnPath: 'portal-client.html',
        successQuery: `contractCheckout=success&contractId=${encodeURIComponent(contract.id)}&session_id={CHECKOUT_SESSION_ID}`,
        cancelQuery: `contractCheckout=cancelled&contractId=${encodeURIComponent(contract.id)}`,
      }),
    }, updateContract);

    return res.json(getCheckoutResponse(session, config.stripePublishableKey));
  } catch (error) {
    console.error('Failed to create Stripe contract checkout session:', error);
    return res.status(error.statusCode || 502).json({ error: error.statusCode ? error.message : 'Unable to start contract checkout right now.' });
  }
});

contractsRouter.post('/:contractId/checkout-session/lookup', async (req, res) => {
  const parsed = z.object({
    lookupAccessToken: z.string().uuid(),
    autopay: z.boolean().default(false),
    uiMode: z.enum(['hosted', 'embedded']).default('hosted'),
  }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'A valid account lookup token is required.' });
  }
  if (!config.stripeSecretKey || (parsed.data.uiMode === 'embedded' && !config.stripePublishableKey)) {
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

  try {
    const stripe = new Stripe(config.stripeSecretKey);
    let customerId = account.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        name: account.name,
        metadata: { accountId: account.id },
      }, { idempotencyKey: `customer:${account.id}` });
      customerId = customer.id;
      updateClient(account.id, { stripeCustomerId: customerId });
    }

    const origin = getCheckoutOrigin(req.headers.origin, config.corsOrigins);
    const session = await createContractCheckoutSession(stripe, contract, {
      mode: parsed.data.autopay ? 'subscription' : 'payment',
      customer: customerId,
      client_reference_id: contract.id,
      metadata: { contractId: contract.id, accountId: account.id, autopay: String(parsed.data.autopay), billingPeriod: String(getContractPeriodIndex(contract, new Date().toISOString())) },
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: price.amountCents,
          product_data: {
            name: `Contract ${contract.contractNumber}`,
            description: `${contract.billingCycle || 'monthly'} maintenance contract`,
          },
          ...(parsed.data.autopay ? {
            recurring: { interval: price.interval, interval_count: price.intervalCount },
          } : {}),
        },
      }],
      ...(parsed.data.autopay ? {
        subscription_data: { metadata: { contractId: contract.id, accountId: account.id } },
      } : {
        payment_intent_data: { metadata: { contractId: contract.id, accountId: account.id } },
      }),
      ...getCheckoutPresentation({
        uiMode: parsed.data.uiMode, origin, returnPath: 'portal-found.html',
        successQuery: `contractCheckout=success&contractId=${encodeURIComponent(contract.id)}&session_id={CHECKOUT_SESSION_ID}`,
        cancelQuery: `contractCheckout=cancelled&contractId=${encodeURIComponent(contract.id)}`,
      }),
    }, updateContract);

    return res.json(getCheckoutResponse(session, config.stripePublishableKey));
  } catch (error) {
    console.error('Failed to create lookup contract checkout session:', error);
    return res.status(error.statusCode || 502).json({ error: error.statusCode ? error.message : 'Unable to start contract checkout right now.' });
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
      changes.lastPaymentSource = 'stripe';
      changes.manualPaymentPreviousLastPaymentAt = null;
      changes.manualPaymentPreviousLastPaymentAmountCents = null;
      changes.manualPaymentPreviousLastPaymentSource = null;
      changes.manualPaymentPreviousNextPaymentDueAt = null;
    } else if (session.mode === 'subscription') {
      const subscription = typeof session.subscription === 'object'
        ? session.subscription
        : await stripe.subscriptions.retrieve(session.subscription);
      changes.stripeSubscriptionId = subscription.id;
      changes.stripeSubscriptionStatus = subscription.status;
      changes.autopayEnabled = ['active', 'trialing', 'past_due'].includes(subscription.status);
      const periodEnd = subscription.current_period_end || subscription.items?.data?.[0]?.current_period_end;
      changes.nextPaymentDueAt = periodEnd ? new Date(periodEnd * 1000).toISOString() : null;
      if (session.payment_status === 'paid' && Number(session.amount_total || 0) > 0) {
        changes.lastPaymentAt = new Date().toISOString();
        changes.lastPaymentAmountCents = Number(session.amount_total);
        changes.lastPaymentSource = 'stripe';
        changes.manualPaymentPreviousLastPaymentAt = null;
        changes.manualPaymentPreviousLastPaymentAmountCents = null;
        changes.manualPaymentPreviousLastPaymentSource = null;
        changes.manualPaymentPreviousNextPaymentDueAt = null;
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

contractsRouter.post('/:contractId/record-payment', requireAdmin, (req, res) => {
  const contract = getContractById(req.params.contractId);
  if (!contract) return res.status(404).json({ error: 'Contract not found.' });
  if (contract.status !== 'active') return res.status(409).json({ error: 'Only active contracts can be marked paid.' });
  if (contract.autopayEnabled || (contract.stripeSubscriptionId && !['canceled', 'incomplete_expired'].includes(String(contract.stripeSubscriptionStatus || '').toLowerCase()))) {
    return res.status(409).json({ error: 'Disable or cancel autopay before recording a separate manual payment.' });
  }

  const payment = getManualContractPaymentChanges(contract);
  if (payment.error) return res.status(409).json({ error: payment.error });
  const updatedContract = updateContract(contract.id, {
    ...payment.changes,
    lastPaymentSource: 'manual',
    manualPaymentPreviousLastPaymentAt: contract.lastPaymentAt ?? null,
    manualPaymentPreviousLastPaymentAmountCents: contract.lastPaymentAmountCents ?? null,
    manualPaymentPreviousLastPaymentSource: contract.lastPaymentSource ?? null,
    manualPaymentPreviousNextPaymentDueAt: contract.nextPaymentDueAt ?? null,
  });
  const paymentSummary = getContractPaymentSummary(updatedContract);
  recordAudit({
    actorType: 'admin',
    actorId: req.admin.id,
    action: 'contract.payment.recorded_manually',
    entityType: 'contract',
    entityId: contract.id,
    metadata: { amountCents: payment.changes.lastPaymentAmountCents, currency: 'usd', nextPaymentDueAt: payment.changes.nextPaymentDueAt },
  });
  return res.json({ contract: { ...updatedContract, ...paymentSummary } });
});

contractsRouter.post('/:contractId/undo-manual-payment', requireAdmin, (req, res) => {
  const contract = getContractById(req.params.contractId);
  if (!contract) return res.status(404).json({ error: 'Contract not found.' });
  if (contract.status !== 'active') return res.status(409).json({ error: 'Only active contracts can be updated.' });
  if (contract.autopayEnabled || (contract.stripeSubscriptionId && !['canceled', 'incomplete_expired'].includes(String(contract.stripeSubscriptionStatus || '').toLowerCase()))) {
    return res.status(409).json({ error: 'Disable or cancel autopay before changing a separate manual payment.' });
  }
  if (contract.lastPaymentSource !== 'manual' || getContractPaymentSummary(contract).paymentStatus !== 'Paid') {
    return res.status(409).json({ error: 'There is no current-cycle manual payment to mark unpaid.' });
  }

  const updatedContract = updateContract(contract.id, {
    lastPaymentAt: contract.manualPaymentPreviousLastPaymentAt ?? null,
    lastPaymentAmountCents: contract.manualPaymentPreviousLastPaymentAmountCents ?? null,
    lastPaymentSource: contract.manualPaymentPreviousLastPaymentSource ?? null,
    nextPaymentDueAt: contract.manualPaymentPreviousNextPaymentDueAt ?? null,
    manualPaymentPreviousLastPaymentAt: null,
    manualPaymentPreviousLastPaymentAmountCents: null,
    manualPaymentPreviousLastPaymentSource: null,
    manualPaymentPreviousNextPaymentDueAt: null,
  });
  const paymentSummary = getContractPaymentSummary(updatedContract);
  recordAudit({
    actorType: 'admin',
    actorId: req.admin.id,
    action: 'contract.payment.manual_marked_unpaid',
    entityType: 'contract',
    entityId: contract.id,
  });
  return res.json({ contract: { ...updatedContract, ...paymentSummary } });
});

contractsRouter.post('/', requireAdmin, (req, res) => {
  const parsed = contractSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid contract payload.', details: parsed.error.flatten() });
  }
  const validationError = validateContractTerms(parsed.data, true);
  if (validationError) return res.status(400).json({ error: validationError });

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

  const existing = getContractById(req.params.contractId);
  if (!existing) return res.status(404).json({ error: 'Contract not found.' });
  const validationError = validateContractTerms({ ...existing, ...parsed.data });
  if (validationError) return res.status(400).json({ error: validationError });
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

contractsRouter.delete('/:contractId', requireAdmin, async (req, res) => {
  const result = deleteContract(req.params.contractId);
  if (result.error === 'CONTRACT_NOT_FOUND') {
    return res.status(404).json({ error: 'Contract not found.' });
  }
  if (result.error === 'CONTRACT_AUTOPAY_ACTIVE') {
    return res.status(409).json({ error: 'Cancel autopay and wait for the Stripe subscription to finish before removing this contract.' });
  }
  try {
    await deleteAllContractAttachments(result.contract.id);
  } catch (error) {
    console.error('Failed to clean up deleted contract attachments:', error);
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
