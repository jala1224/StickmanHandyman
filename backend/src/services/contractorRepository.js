import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(currentDir, '..', '..', 'data');
const dataPath = path.join(dataDir, 'contractors.json');

function createOwnerContractor() {
  const timestamp = new Date().toISOString();
  return {
    id: 'contractor_owner',
    name: 'Owner (You)',
    hourlyRateCents: 0,
    status: 'active',
    isOwner: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function loadData() {
  if (!existsSync(dataPath)) {
    return { contractors: [createOwnerContractor()], timeEntries: [], ongoingJobs: [], invoiceHours: [] };
  }

  const data = JSON.parse(readFileSync(dataPath, 'utf8'));
  const contractorList = Array.isArray(data.contractors) ? data.contractors : [];
  const timeEntries = Array.isArray(data.timeEntries) ? data.timeEntries : [];
  const ongoingJobs = Array.isArray(data.ongoingJobs) ? data.ongoingJobs : [];
  const invoiceHours = Array.isArray(data.invoiceHours) ? data.invoiceHours : [];
  const paymentTransactions = Array.isArray(data.paymentTransactions) ? data.paymentTransactions : [];
  let owner = contractorList.find((contractor) => contractor.isOwner);

  if (!owner) {
    owner = createOwnerContractor();
    contractorList.unshift(owner);
  }

  const mergedInvoiceHours = new Map();
  invoiceHours.forEach((entry) => {
    const contractor = contractorList.find((candidate) => candidate.id === entry.contractorId);
    if (contractor && !contractor.isOwner) {
      const key = `${entry.invoiceId}:${entry.contractorId}`;
      const existing = mergedInvoiceHours.get(key);
      mergedInvoiceHours.set(key, {
        ...entry,
        id: key,
        tierIndex: -1,
        hours: Number(existing?.hours || 0) + Number(entry.hours || 0),
      });
    } else {
      mergedInvoiceHours.set(entry.id || `${entry.invoiceId}:${entry.contractorId}:${entry.tierIndex}`, entry);
    }
  });

  return {
    contractors: contractorList,
    timeEntries,
    ongoingJobs,
    invoiceHours: Array.from(mergedInvoiceHours.values()),
    paymentTransactions,
  };
}

const data = loadData();
let contractors = data.contractors;
let timeEntries = data.timeEntries;
let ongoingJobs = data.ongoingJobs;
let invoiceHours = data.invoiceHours;
let paymentTransactions = data.paymentTransactions;

function persistData() {
  mkdirSync(dataDir, { recursive: true });
  const temporaryPath = `${dataPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify({ contractors, timeEntries, ongoingJobs, invoiceHours, paymentTransactions }, null, 2));
  renameSync(temporaryPath, dataPath);
}

if (!existsSync(dataPath)) {
  persistData();
}

export function getContractors() {
  return contractors;
}

export function getContractorTimeEntries() {
  return timeEntries;
}

export function getContractorById(contractorId) {
  return contractors.find((contractor) => contractor.id === contractorId) ?? null;
}

export function buildContractorHourTiers(contractorHours = []) {
  const hourLevels = [...new Set(contractorHours.map((entry) => Number(entry.hours)).filter((hours) => hours > 0))]
    .sort((first, second) => first - second);
  const tiers = [];
  let previousHours = 0;

  hourLevels.forEach((hourLevel, tierIndex) => {
    const hoursInTier = hourLevel - previousHours;
    const activeEntries = contractorHours.filter((entry) => Number(entry.hours) >= hourLevel);

    const contractorsInTier = activeEntries.map((entry) => {
      const contractor = getContractorById(entry.contractorId);
      if (!contractor || hoursInTier <= 0) {
        return null;
      }

      const payRateCents = Number(entry.hourlyRateCents || 0);
      return {
        contractorId: contractor.id,
        contractorName: entry.contractorName || contractor.name,
        hourlyRateCents: payRateCents + (contractor.isOwner ? 0 : 1_000),
        payRateCents,
      };
    }).filter(Boolean);
    tiers.push({
      tierIndex,
      hours: hoursInTier,
      hourlyRateCents: contractorsInTier.reduce((sum, entry) => sum + entry.hourlyRateCents, 0),
      contractors: contractorsInTier,
    });
    previousHours = hourLevel;
  });

  return tiers;
}

export function buildContractorHourBreakdown(contractorHours = []) {
  const ownerEntries = [];
  const otherEntries = new Map();

  buildContractorHourTiers(contractorHours).forEach((tier) => {
    tier.contractors.forEach((entry) => {
      const contractor = getContractorById(entry.contractorId);
      if (contractor?.isOwner) {
        ownerEntries.push({ ...entry, hourlyRateCents: entry.payRateCents, hours: tier.hours, tierIndex: tier.tierIndex });
        return;
      }

      const existing = otherEntries.get(entry.contractorId);
      otherEntries.set(entry.contractorId, {
        ...entry,
        hourlyRateCents: entry.payRateCents,
        hours: Number(existing?.hours || 0) + tier.hours,
        tierIndex: -1,
      });
    });
  });

  return [...ownerEntries, ...otherEntries.values()];
}

export function createContractor(input) {
  const timestamp = new Date().toISOString();
  const contractor = {
    id: `contractor_${randomUUID()}`,
    name: input.name.trim(),
    hourlyRateCents: input.hourlyRateCents,
    status: 'active',
    isOwner: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  contractors.push(contractor);
  persistData();
  return contractor;
}

export function updateContractor(contractorId, changes) {
  const contractor = getContractorById(contractorId);
  if (!contractor) {
    return null;
  }

  if (typeof changes.name === 'string') {
    contractor.name = changes.name.trim();
  }
  if (Number.isInteger(changes.hourlyRateCents)) {
    contractor.hourlyRateCents = changes.hourlyRateCents;
  }
  if (!contractor.isOwner && typeof changes.status === 'string') {
    contractor.status = changes.status;
  }

  contractor.updatedAt = new Date().toISOString();
  persistData();
  return contractor;
}

export function deleteContractor(contractorId) {
  const index = contractors.findIndex((contractor) => contractor.id === contractorId);
  if (index < 0) {
    return { error: 'CONTRACTOR_NOT_FOUND' };
  }

  const contractor = contractors[index];
  if (contractor.isOwner) {
    return { error: 'OWNER_CONTRACTOR_PROTECTED' };
  }

  const hasTimeEntries = timeEntries.some((entry) => entry.contractorId === contractorId);
  const hasOngoingHours = ongoingJobs.some((job) => (job.contractorHours || []).some((entry) => entry.contractorId === contractorId));
  const hasInvoiceHours = invoiceHours.some((entry) => entry.contractorId === contractorId);
  const hasPaymentHistory = paymentTransactions.some((entry) => entry.contractorId === contractorId);
  if (hasTimeEntries || hasOngoingHours || hasInvoiceHours || hasPaymentHistory) {
    return { error: 'CONTRACTOR_HAS_RECORDS' };
  }

  const [removedContractor] = contractors.splice(index, 1);
  persistData();
  return { contractor: removedContractor };
}

export function createContractorTimeEntry(contractorId, input) {
  const contractor = getContractorById(contractorId);
  if (!contractor || contractor.status !== 'active') {
    return null;
  }

  const timeEntry = {
    id: `contractor_time_${randomUUID()}`,
    contractorId,
    date: input.date,
    description: input.description.trim(),
    hours: input.hours,
    hourlyRateCents: contractor.hourlyRateCents,
    createdAt: new Date().toISOString(),
  };

  timeEntries.push(timeEntry);
  persistData();
  return timeEntry;
}

export function deleteContractorTimeEntry(timeEntryId) {
  const index = timeEntries.findIndex((entry) => entry.id === timeEntryId);
  if (index < 0) {
    return null;
  }

  const [removedEntry] = timeEntries.splice(index, 1);
  persistData();
  return removedEntry;
}

export function getOngoingJobs() {
  return ongoingJobs;
}

export function getOngoingJobById(jobId) {
  return ongoingJobs.find((job) => job.id === jobId) ?? null;
}

export function createOngoingJob(job) {
  ongoingJobs.push(job);
  persistData();
  return job;
}

export function updateOngoingJob(jobId, changes) {
  const job = getOngoingJobById(jobId);
  if (!job) {
    return null;
  }

  Object.assign(job, changes, { updatedAt: new Date().toISOString() });
  persistData();
  return job;
}

export function deleteOngoingJob(jobId) {
  const index = ongoingJobs.findIndex((job) => job.id === jobId);
  if (index < 0) {
    return null;
  }

  const [job] = ongoingJobs.splice(index, 1);
  persistData();
  return job;
}

export function getContractorHourSummaries() {
  return ongoingJobs.flatMap((job) => buildContractorHourBreakdown(job.contractorHours).map((entry) => ({
    ...entry,
    id: `${job.id}:${entry.contractorId}:${entry.tierIndex}`,
    date: job.updatedAt?.slice(0, 10) || job.issueDate,
    description: job.jobDescription || job.jobName || 'Ongoing job',
    invoiceId: job.id,
    invoiceNumber: null,
    isOngoing: true,
  })));
}

export function getContractorInvoiceHours() {
  return invoiceHours;
}

export function getContractorPaymentTransactions() {
  return paymentTransactions;
}

export function ensureContractorPaymentTransactions(invoice) {
  if (invoice.status !== 'ongoing' && !invoice.invoiceNumber) {
    return [];
  }

  const paymentEntries = buildContractorHourBreakdown(Array.isArray(invoice.contractorHours) ? invoice.contractorHours : [])
    .filter((entry) => !getContractorById(entry.contractorId)?.isOwner);
  const updated = [];

  paymentEntries.forEach((entry) => {
    const paymentId = `contractor_payment_${invoice.id}_${entry.contractorId}`;
    const existing = paymentTransactions.find((transaction) => transaction.id === paymentId);
    const transaction = {
      id: paymentId,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      isOngoing: invoice.status === 'ongoing',
      contractorId: entry.contractorId,
      contractorName: entry.contractorName,
      jobName: invoice.jobName || '',
      date: invoice.issueDate || invoice.updatedAt?.slice(0, 10) || '',
      hours: Number(entry.hours || 0),
      payRateCents: Number(entry.hourlyRateCents || 0),
      amountCents: Math.round(Number(entry.hours || 0) * Number(entry.hourlyRateCents || 0)),
      status: existing?.status || 'unpaid',
      paidAt: existing?.paidAt || null,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    if (existing) {
      Object.assign(existing, transaction);
      updated.push(existing);
    } else {
      paymentTransactions.push(transaction);
      updated.push(transaction);
    }
  });

  const invoicePaymentIds = new Set(paymentEntries.map((entry) => `contractor_payment_${invoice.id}_${entry.contractorId}`));
  paymentTransactions = paymentTransactions.filter((transaction) => transaction.invoiceId !== invoice.id || invoicePaymentIds.has(transaction.id));
  persistData();
  return updated;
}

export function updateContractorPaymentStatus(paymentId, isPaid) {
  const transaction = paymentTransactions.find((entry) => entry.id === paymentId);
  if (!transaction) {
    return null;
  }

  transaction.status = isPaid ? 'paid' : 'unpaid';
  transaction.paidAt = isPaid ? new Date().toISOString() : null;
  transaction.updatedAt = new Date().toISOString();
  persistData();
  return transaction;
}

export function saveContractorInvoiceHours(invoice) {
  if (!Array.isArray(invoice.contractorHours) || invoice.contractorHours.length === 0) {
    if (invoice.status !== 'ongoing') {
      ensureContractorPaymentTransactions(invoice);
    }
    return;
  }

  invoiceHours = invoiceHours.filter((entry) => entry.invoiceId !== invoice.id);
  invoiceHours.push(...buildContractorHourBreakdown(invoice.contractorHours).map((entry) => ({
    ...entry,
    id: `${invoice.id}:${entry.contractorId}:${entry.tierIndex}`,
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    jobName: invoice.jobName || '',
    date: invoice.issueDate,
    isOngoing: false,
  })));
  ensureContractorPaymentTransactions(invoice);
  persistData();
}

export function removeContractorInvoiceHours(invoiceId) {
  const previousLength = invoiceHours.length;
  invoiceHours = invoiceHours.filter((entry) => entry.invoiceId !== invoiceId);
  const previousPaymentLength = paymentTransactions.length;
  paymentTransactions = paymentTransactions.filter((entry) => entry.invoiceId !== invoiceId);
  if (invoiceHours.length !== previousLength || paymentTransactions.length !== previousPaymentLength) {
    persistData();
  }
}