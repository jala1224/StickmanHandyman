import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContractorHourTiers, getContractorById, getContractorInvoiceHours } from './contractorRepository.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(currentDir, '..', '..', 'data');
const dataPath = path.join(dataDir, 'business.json');
let storedContracts = [];

function recoverInvoicesFromContractorHours(defaultInvoices, defaultClients) {
  const knownInvoiceIds = new Set(defaultInvoices.map((invoice) => invoice.id));
  const groups = new Map();

  getContractorInvoiceHours().forEach((entry) => {
    if (!entry.invoiceId || knownInvoiceIds.has(entry.invoiceId)) {
      return;
    }

    const group = groups.get(entry.invoiceId) || { entries: [], invoiceNumber: entry.invoiceNumber, jobName: entry.jobName, date: entry.date };
    group.entries.push(entry);
    groups.set(entry.invoiceId, group);
  });

  return Array.from(groups, ([invoiceId, group]) => {
    const contractorHoursById = new Map();
    group.entries.forEach((entry) => {
      const contractor = getContractorById(entry.contractorId);
      if (!contractor) {
        return;
      }

      const current = contractorHoursById.get(contractor.id) || {
        contractorId: contractor.id,
        contractorName: contractor.name,
        hourlyRateCents: contractor.hourlyRateCents,
        hours: 0,
      };
      current.hours += Number(entry.hours || 0);
      contractorHoursById.set(contractor.id, current);
    });

    const contractorHours = Array.from(contractorHoursById.values());
    const lineItems = buildContractorHourTiers(contractorHours).map((tier) => ({
      type: 'labor',
      description: 'Labor',
      quantity: tier.hours,
      unitPriceCents: tier.hourlyRateCents,
      taxable: false,
    }));
    const amountCents = lineItems.reduce((sum, item) => sum + Math.round(item.quantity * item.unitPriceCents), 0);
    const issueDate = group.date || new Date().toISOString().slice(0, 10);
    const account = defaultClients[0] || null;

    return {
      id: invoiceId,
      accountId: account?.id || 'client_1',
      clientSnapshot: account ? { id: account.id, name: account.name, address: account.address } : null,
      invoiceNumber: group.invoiceNumber || null,
      issueDate,
      jobName: group.jobName || '',
      jobDescription: '',
      isOngoing: false,
      dueDate: null,
      amountCents,
      subtotalCents: amountCents,
      taxCents: 0,
      discountCents: 0,
      currency: 'usd',
      status: 'sent',
      serviceAddress: null,
      contractorHours,
      lineItems,
      stripePaymentIntentId: null,
      createdAt: new Date(`${issueDate}T12:00:00.000Z`).toISOString(),
      updatedAt: new Date(`${issueDate}T12:00:00.000Z`).toISOString(),
    };
  });
}

export function loadBusinessData(defaults) {
  if (existsSync(dataPath)) {
    const savedData = JSON.parse(readFileSync(dataPath, 'utf8'));
    const businessData = {
      clients: Array.isArray(savedData.clients) ? savedData.clients : defaults.clients,
      invoices: Array.isArray(savedData.invoices) ? savedData.invoices : defaults.invoices,
      contracts: Array.isArray(savedData.contracts) ? savedData.contracts : defaults.contracts,
    };
    storedContracts = businessData.contracts;
    if (!Array.isArray(savedData.contracts)) {
      saveBusinessData(businessData);
    }
    return businessData;
  }

  const businessData = {
    clients: defaults.clients,
    invoices: [...defaults.invoices, ...recoverInvoicesFromContractorHours(defaults.invoices, defaults.clients)],
    contracts: defaults.contracts,
  };
  saveBusinessData(businessData);
  return businessData;
}

export function saveBusinessData({ clients, invoices, contracts }) {
  if (Array.isArray(contracts)) {
    storedContracts = contracts;
  }
  mkdirSync(dataDir, { recursive: true });
  const temporaryPath = `${dataPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify({ clients, invoices, contracts: storedContracts }, null, 2));
  renameSync(temporaryPath, dataPath);
}