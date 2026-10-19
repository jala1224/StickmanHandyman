import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../middleware/auth.js';
import { getInvoices, recordAudit } from '../services/store.js';
import {
  createContractor,
  createContractorTimeEntry,
  deleteContractor,
  deleteContractorTimeEntry,
  buildContractorHourBreakdown,
  ensureContractorPaymentTransactions,
  getContractorById,
  getContractorInvoiceHours,
  getContractorPaymentTransactions,
  getContractorTimeEntries,
  getContractors,
  updateContractorPaymentStatus,
  updateContractor,
} from '../services/contractorRepository.js';

export const contractorsRouter = Router();

const contractorSchema = z.object({
  name: z.string().trim().min(1).max(120),
  hourlyRateCents: z.number().int().nonnegative().max(1_000_000),
  status: z.enum(['active', 'inactive']).optional(),
});

const timeEntrySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().trim().min(1).max(500),
  hours: z.number().positive().max(24).multipleOf(0.25),
});

contractorsRouter.get('/', requireAdmin, (req, res) => {
  const invoices = getInvoices();
  invoices.forEach((invoice) => ensureContractorPaymentTransactions(invoice));
  const entriesByAssignment = new Map(getContractorInvoiceHours().map((entry) => [`${entry.invoiceId}:${entry.contractorId}:${entry.tierIndex}`, entry]));
  invoices.forEach((invoice) => {
    for (const key of entriesByAssignment.keys()) {
      if (key.startsWith(`${invoice.id}:`)) {
        entriesByAssignment.delete(key);
      }
    }
    buildContractorHourBreakdown(invoice.contractorHours || []).forEach((entry) => {
      const entryId = `${invoice.id}:${entry.contractorId}:${entry.tierIndex}`;
      entriesByAssignment.set(entryId, {
        ...entry,
        id: entryId,
        date: invoice.issueDate || invoice.updatedAt?.slice(0, 10),
        description: invoice.jobName || invoice.jobDescription || `Invoice ${invoice.invoiceNumber || 'Ongoing'}`,
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        isOngoing: invoice.status === 'ongoing',
        invoiceStatus: invoice.status,
      });
    });
  });
  const invoiceHours = Array.from(entriesByAssignment.values());
  const allTimeEntries = [...getContractorTimeEntries(), ...invoiceHours];
  const totalsByContractor = new Map();
  allTimeEntries.forEach((entry) => {
    const contractor = getContractorById(entry.contractorId);
    if (!contractor) {
      return;
    }

    const totals = totalsByContractor.get(contractor.id) || { contractorId: contractor.id, hours: 0, payCents: 0 };
    totals.hours += Number(entry.hours || 0);
    totals.payCents += Math.round(Number(entry.hours || 0) * Number(entry.hourlyRateCents || 0));
    totalsByContractor.set(contractor.id, totals);
  });

  res.json({
    contractors: getContractors(),
    summaries: Array.from(totalsByContractor.values()),
    ownerHours: invoiceHours.filter((entry) => getContractorById(entry.contractorId)?.isOwner),
    payments: getContractorPaymentTransactions().slice().sort((first, second) =>
      String(second.date).localeCompare(String(first.date)) || String(first.contractorName).localeCompare(String(second.contractorName))),
  });
});

contractorsRouter.patch('/payments/:paymentId', requireAdmin, (req, res) => {
  const parsed = z.object({ paid: z.boolean() }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'A paid checkbox value is required.', details: parsed.error.flatten() });
  }

  const payment = updateContractorPaymentStatus(req.params.paymentId, parsed.data.paid);
  if (!payment) {
    return res.status(404).json({ error: 'Contractor payment not found.' });
  }

  recordAudit({
    actorType: 'admin',
    actorId: req.admin.id,
    action: parsed.data.paid ? 'contractor.payment.paid' : 'contractor.payment.unpaid',
    entityType: 'contractor_payment',
    entityId: payment.id,
  });

  return res.json({ payment });
});

contractorsRouter.post('/', requireAdmin, (req, res) => {
  const parsed = contractorSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid contractor payload.', details: parsed.error.flatten() });
  }

  const contractor = createContractor(parsed.data);
  recordAudit({
    actorType: 'admin',
    actorId: req.admin.id,
    action: 'contractor.create',
    entityType: 'contractor',
    entityId: contractor.id,
  });

  return res.status(201).json({ contractor });
});

contractorsRouter.patch('/:contractorId', requireAdmin, (req, res) => {
  const parsed = contractorSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid contractor payload.', details: parsed.error.flatten() });
  }

  const contractor = updateContractor(req.params.contractorId, parsed.data);
  if (!contractor) {
    return res.status(404).json({ error: 'Contractor not found.' });
  }

  recordAudit({
    actorType: 'admin',
    actorId: req.admin.id,
    action: 'contractor.update',
    entityType: 'contractor',
    entityId: contractor.id,
  });

  return res.json({ contractor });
});

contractorsRouter.delete('/:contractorId', requireAdmin, (req, res) => {
  const invoices = getInvoices();
  invoices.forEach((invoice) => ensureContractorPaymentTransactions(invoice));
  const contractorId = req.params.contractorId;
  if (!getContractorById(contractorId)) {
    return res.status(404).json({ error: 'Contractor not found.' });
  }

  const assignedToInvoice = invoices.some((invoice) =>
    (invoice.contractorHours || []).some((entry) => entry.contractorId === contractorId));
  if (assignedToInvoice) {
    return res.status(409).json({ error: 'This contractor has invoice or job hours and cannot be removed. Set the contractor to inactive instead.' });
  }

  const result = deleteContractor(contractorId);
  if (result.error === 'CONTRACTOR_NOT_FOUND') {
    return res.status(404).json({ error: 'Contractor not found.' });
  }
  if (result.error === 'OWNER_CONTRACTOR_PROTECTED') {
    return res.status(409).json({ error: 'The owner record cannot be removed.' });
  }
  if (result.error === 'CONTRACTOR_HAS_RECORDS') {
    return res.status(409).json({ error: 'This contractor has recorded hours or payments and cannot be removed. Set the contractor to inactive instead.' });
  }

  recordAudit({
    actorType: 'admin',
    actorId: req.admin.id,
    action: 'contractor.delete',
    entityType: 'contractor',
    entityId: result.contractor.id,
  });

  return res.json({ contractor: result.contractor });
});

contractorsRouter.post('/:contractorId/time-entries', requireAdmin, (req, res) => {
  const parsed = timeEntrySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid contractor time entry.', details: parsed.error.flatten() });
  }

  const timeEntry = createContractorTimeEntry(req.params.contractorId, parsed.data);
  if (!timeEntry) {
    return res.status(404).json({ error: 'Active contractor not found.' });
  }

  recordAudit({
    actorType: 'admin',
    actorId: req.admin.id,
    action: 'contractor.time_entry.create',
    entityType: 'contractor_time_entry',
    entityId: timeEntry.id,
  });

  return res.status(201).json({ timeEntry });
});

contractorsRouter.delete('/time-entries/:timeEntryId', requireAdmin, (req, res) => {
  const timeEntry = deleteContractorTimeEntry(req.params.timeEntryId);
  if (!timeEntry) {
    return res.status(404).json({ error: 'Time entry not found.' });
  }

  recordAudit({
    actorType: 'admin',
    actorId: req.admin.id,
    action: 'contractor.time_entry.delete',
    entityType: 'contractor_time_entry',
    entityId: timeEntry.id,
  });

  return res.json({ timeEntry });
});

contractorsRouter.get('/:contractorId', requireAdmin, (req, res) => {
  const contractor = getContractorById(req.params.contractorId);
  if (!contractor) {
    return res.status(404).json({ error: 'Contractor not found.' });
  }

  return res.json({ contractor });
});