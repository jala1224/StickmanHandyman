import { getContractPaymentSummary } from './contractPricing.js';

const cycleMonths = Object.freeze({
  monthly: 1,
  quarterly: 3,
  annually: 12,
});

function parseDate(value) {
  if (typeof value !== 'string' || !value) return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const date = match
    ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addMonthsClamped(date, months) {
  const shifted = new Date(date);
  const day = shifted.getUTCDate();
  shifted.setUTCDate(1);
  shifted.setUTCMonth(shifted.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0)).getUTCDate();
  shifted.setUTCDate(Math.min(day, lastDay));
  return shifted;
}

function packageDefaults(contract) {
  const type = contract.packageType;
  const level = contract.packageLevel;
  const defaults = {
    single_home: {
      basic: { retainerHours: 2, rolloverHours: 0, discountPercent: 0 },
      pro: { retainerHours: 2, rolloverHours: 1, discountPercent: 5 },
      premium: { retainerHours: 4, rolloverHours: 2, discountPercent: 10 },
    },
    portfolio: {
      basic: { retainerHours: 4, rolloverHours: 0, discountPercent: 0 },
      pro: { retainerHours: 6, rolloverHours: 2, discountPercent: 5 },
      premium: { retainerHours: 10, rolloverHours: 4, discountPercent: 10 },
    },
  };
  return defaults[type]?.[level] || {};
}

export function getMaintenanceContractTerms(contract) {
  if (!contract || (contract.contractType || 'maintenance') !== 'maintenance') return null;
  const defaults = packageDefaults(contract);
  return {
    retainerHours: Math.max(0, Number(contract.packageRetainerHours ?? defaults.retainerHours ?? 0)),
    rolloverHours: Math.max(0, Number(contract.packageRolloverHours ?? defaults.rolloverHours ?? 0)),
    discountPercent: Math.max(0, Math.min(100, Number(contract.packageDiscountPercent ?? defaults.discountPercent ?? 0))),
  };
}

export function contractCoversServiceAddress(contract, serviceAddress, client = null) {
  const normalizedAddress = String(serviceAddress || '').trim().toLocaleLowerCase();
  if (!normalizedAddress) return false;
  if (String(contract.serviceAddress || '').trim().toLocaleLowerCase() === normalizedAddress) return true;
  const portfolio = contract.packageType === 'portfolio'
    || (contract.packageType === 'custom' && contract.packageCoverageType === 'portfolio');
  return (contract.contractType || 'maintenance') === 'maintenance' && portfolio;
}

export function findContractsForInvoiceAddress(contracts, accountId, serviceAddress, invoiceDate, client = null) {
  const normalizedAddress = String(serviceAddress || '').trim().toLocaleLowerCase();
  const date = parseDate(invoiceDate);
  if (!normalizedAddress || !date) return [];
  return contracts.filter(contract => {
    const startDate = parseDate(contract.startDate || contract.createdAt);
    return contract.accountId === accountId
      && contract.status === 'active'
      && (contract.contractType === 'labor' || (contract.contractType || 'maintenance') === 'maintenance')
      && contractCoversServiceAddress(contract, normalizedAddress, client)
      && startDate
      && startDate <= date;
  });
}

export function findMaintenanceContractForAddress(contracts, accountId, serviceAddress, client = null) {
  const matches = findContractsForInvoiceAddress(contracts, accountId, serviceAddress, new Date().toISOString(), client)
    .filter(contract => (contract.contractType || 'maintenance') === 'maintenance');
  return matches.length === 1 ? matches[0] : null;
}

export function getInvoiceElapsedJobHours(invoice) {
  const contractorHours = Array.isArray(invoice.contractorHours) ? invoice.contractorHours : [];
  const recordedHours = contractorHours.map(entry => Number(entry.hours) || 0);
  if (recordedHours.length) return Math.max(...recordedHours);
  const laborQuantities = (invoice.lineItems || [])
    .filter(item => item.type === 'labor')
    .map(item => Number(item.quantity) || 0);
  return laborQuantities.length ? Math.max(...laborQuantities) : 0;
}

export function getContractPeriodIndex(contract, dateValue) {
  const months = cycleMonths[String(contract.billingCycle || 'monthly').toLowerCase()];
  const start = parseDate(contract.startDate || contract.createdAt);
  const date = parseDate(dateValue);
  if (!months || !start || !date || date < start) return null;

  const monthDifference = (date.getUTCFullYear() - start.getUTCFullYear()) * 12
    + date.getUTCMonth() - start.getUTCMonth();
  let index = Math.floor(monthDifference / months);
  while (index > 0 && addMonthsClamped(start, index * months) > date) index -= 1;
  while (addMonthsClamped(start, (index + 1) * months) <= date) index += 1;
  return index;
}

export function isMaintenanceContractBillingPeriodPaid(contract, dateValue) {
  const dateString = String(dateValue || '');
  if (contract && /^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    const paymentDate = contract.lastPaymentAt && new Date(contract.lastPaymentAt);
    const paymentDateParts = paymentDate && !Number.isNaN(paymentDate.getTime())
      ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(paymentDate)
      : [];
    const paymentParts = Object.fromEntries(paymentDateParts.map(part => [part.type, part.value]));
    const localPaymentDate = paymentParts.year ? `${paymentParts.year}-${paymentParts.month}-${paymentParts.day}` : null;
    return getContractPaymentSummary({
      ...contract,
      lastPaymentAt: localPaymentDate,
      nextPaymentDueAt: contract.nextPaymentDueAt?.slice(0, 10),
    }, new Date(`${dateString}T23:59:59.999Z`)).paymentStatus === 'Paid';
  }
  const date = dateValue instanceof Date
    ? dateValue
    : new Date(dateValue);
  if (!contract || Number.isNaN(date.getTime())) return false;
  return getContractPaymentSummary(contract, date).paymentStatus === 'Paid';
}

export function allocateMaintenanceContractHours(contract, invoices) {
  return calculateMaintenanceContractHours(contract, invoices).allocations;
}

export function calculateMaintenanceContractSummary(contract, invoices, dateValue = new Date().toISOString()) {
  return calculateMaintenanceContractHours(contract, invoices, dateValue).summary;
}

function calculateMaintenanceContractHours(contract, invoices, dateValue = null) {
  const terms = getMaintenanceContractTerms(contract);
  const allocations = new Map();
  let summary = terms ? { periodIndex: null, retainerHours: terms.retainerHours, rolloverHours: 0, availableHours: 0, usedHours: 0, remainingHours: 0 } : null;
  if (!terms) return { allocations, summary };
  const summaryPeriod = dateValue === null ? null : getContractPeriodIndex(contract, dateValue);
  if (dateValue !== null && (summaryPeriod === null || summaryPeriod > 1200)) return { allocations, summary };
  const summaryDate = parseDate(dateValue);

  const invoiceOrder = new Map(invoices.map((invoice, index) => [invoice.id, index]));
  const grouped = new Map();
  invoices.filter(invoice =>
    invoice.contractId === contract.id
    && invoice.contractPooledHoursEligible !== false
    && !['ongoing', 'void'].includes(invoice.status),
  ).forEach(invoice => {
    if (summaryDate && parseDate(invoice.issueDate || invoice.createdAt) > summaryDate) return;
    const periodIndex = getContractPeriodIndex(contract, invoice.issueDate || invoice.createdAt);
    if (periodIndex === null || periodIndex > 1200) return;
    const periodInvoices = grouped.get(periodIndex) || [];
    periodInvoices.push(invoice);
    grouped.set(periodIndex, periodInvoices);
  });

  const lastPeriod = summaryPeriod ?? (grouped.size ? Math.max(...grouped.keys()) : -1);
  let rollover = 0;
  for (let periodIndex = 0; periodIndex <= lastPeriod; periodIndex += 1) {
    let remaining = terms.retainerHours + rollover;
    const periodInvoices = (grouped.get(periodIndex) || []).slice().sort((first, second) => {
      const issueDateOrder = String(first.issueDate || first.createdAt || '').localeCompare(String(second.issueDate || second.createdAt || ''));
      if (issueDateOrder) return issueDateOrder;

      if (first.createdAt && second.createdAt) {
        const createdAtOrder = String(first.createdAt).localeCompare(String(second.createdAt));
        if (createdAtOrder) return createdAtOrder;
      }

      return (invoiceOrder.get(first.id) ?? 0) - (invoiceOrder.get(second.id) ?? 0);
    });

    periodInvoices.forEach(invoice => {
      const jobHours = Math.max(0, Number(invoice.contractJobHours ?? getInvoiceElapsedJobHours(invoice)));
      const appliedHours = typeof invoice.includedHoursApplied === 'number' && Number.isFinite(invoice.includedHoursApplied)
        ? Math.max(0, invoice.includedHoursApplied)
        : jobHours;
      const includedHours = Math.min(appliedHours, remaining);
      remaining -= includedHours;
      allocations.set(invoice.id, { periodIndex, jobHours, includedHours, remainingHours: remaining });
    });
    summary = {
      periodIndex,
      retainerHours: terms.retainerHours,
      rolloverHours: rollover,
      availableHours: terms.retainerHours + rollover,
      usedHours: terms.retainerHours + rollover - remaining,
      remainingHours: remaining,
    };
    rollover = Math.min(remaining, terms.rolloverHours);
  }
  return { allocations, summary };
}

export function calculateMaintenanceContractDiscountCents(laborItems, includedHours, discountPercent) {
  return calculateMaintenanceContractCredits(laborItems, includedHours, discountPercent).totalCreditCents;
}

export function calculateMaintenanceContractCredits(laborItems, includedHours, discountPercent) {
  let includedRemaining = Math.max(0, Number(includedHours) || 0);
  let includedHoursApplied = 0;
  let retainerCreditCents = 0;
  let remainingLaborCents = 0;

  laborItems.forEach(item => {
    const quantity = Math.max(0, Number(item.quantity) || 0);
    const unitPriceCents = Math.max(0, Number(item.unitPriceCents) || 0);
    const coveredHours = Math.min(quantity, includedRemaining);
    includedHoursApplied += coveredHours;
    retainerCreditCents += Math.round(coveredHours * unitPriceCents);
    includedRemaining -= coveredHours;
    remainingLaborCents += Math.round((quantity - coveredHours) * unitPriceCents);
  });

  const percent = Math.max(0, Math.min(100, Number(discountPercent) || 0));
  const serviceDiscountCents = Math.round(remainingLaborCents * percent / 100);
  return {
    includedHoursApplied,
    retainerCreditCents,
    serviceDiscountCents,
    totalCreditCents: Math.min(retainerCreditCents + serviceDiscountCents, retainerCreditCents + remainingLaborCents),
  };
}

export function calculateLaborContractSummary(contract, invoices) {
  if (!contract || contract.contractType !== 'labor') return null;
  const linkedInvoices = invoices.filter(invoice =>
    invoice.contractId === contract.id && !['void', 'ongoing'].includes(invoice.status),
  );
  const invoicedAmountCents = linkedInvoices.reduce((sum, invoice) => sum + Math.max(0, Number(invoice.amountCents || 0)), 0);
  const actualHours = linkedInvoices.reduce((sum, invoice) => {
    if (Array.isArray(invoice.contractorHours) && invoice.contractorHours.length) {
      return sum + invoice.contractorHours.reduce((hours, entry) => hours + Math.max(0, Number(entry.hours || 0)), 0);
    }
    return sum + (invoice.lineItems || []).filter(item => item.type === 'labor')
      .reduce((hours, item) => hours + Math.max(0, Number(item.quantity || 0)), 0);
  }, 0);

  if (contract.laborPricingModel === 'fixed') {
    const contractAmountCents = Math.max(0, Number(contract.laborFixedAmountCents || 0));
    return {
      invoicedAmountCents,
      contractAmountCents,
      remainingAmountCents: Math.max(0, contractAmountCents - invoicedAmountCents),
    };
  }

  const estimatedHours = Math.max(0, Number(contract.laborEstimatedHours || 0));
  return {
    invoicedAmountCents,
    estimatedHours,
    estimatedAmountCents: Math.max(0, Number(contract.laborEstimatedAmountCents || 0)),
    estimatedMaterialsAmountCents: Math.max(0, Number(contract.laborEstimatedMaterialsCents || 0)),
    estimatedOtherAmountCents: Math.max(0, Number(contract.laborEstimatedOtherAmountCents || 0)),
    estimatedTotalAmountCents: Math.max(0, Number(contract.laborEstimatedAmountCents || 0))
      + Math.max(0, Number(contract.laborEstimatedMaterialsCents || 0))
      + Math.max(0, Number(contract.laborEstimatedOtherAmountCents || 0)),
    actualHours,
    remainingHours: Math.max(0, estimatedHours - actualHours),
  };
}
