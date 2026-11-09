import {
  allocateMaintenanceContractHours,
  calculateMaintenanceContractCredits,
  contractCoversServiceAddress,
  findContractsForInvoiceAddress,
  getInvoiceElapsedJobHours,
  getMaintenanceContractTerms,
  calculateLaborContractSummary,
  calculateMaintenanceContractSummary,
  getContractPeriodIndex,
  isMaintenanceContractBillingPeriodPaid,
} from './maintenanceContractBilling.js';

const isBillableInvoice = (invoice) => !['ongoing', 'void'].includes(invoice.status);
const centsTotal = (lineItems) => lineItems.reduce((sum, item) => sum + Math.round(Math.max(0, Number(item.quantity || 1)) * Math.max(0, Number(item.unitPriceCents || 0))), 0);
const laborItems = (lineItems) => lineItems.filter(item => item.type === 'labor');

function findPriorMaintenanceInvoices(contract, invoices, client, currentInvoice) {
  const expectedAddress = String(contract.serviceAddress || '').trim().toLocaleLowerCase();
  return invoices.filter(invoice => {
    if (invoice.id === currentInvoice.id || invoice.contractPooledHoursEligible === false || !isBillableInvoice(invoice)) return false;
    if (invoice.contractId === contract.id) return true;
    const accountId = invoice.accountId || invoice.clientId;
    if (accountId !== contract.accountId) return false;
    const address = String(invoice.serviceAddress || client?.address || '').trim().toLocaleLowerCase();
    return address === expectedAddress || contractCoversServiceAddress(contract, address, client);
  }).map(invoice => ({ ...invoice, contractId: contract.id }));
}

export function findInvoiceContracts({ contracts, accountId, serviceAddress, invoiceDate, client }) {
  return findContractsForInvoiceAddress(contracts, accountId, serviceAddress, invoiceDate, client);
}

export function getMaintenanceContractSummary(contract, invoices, client, dateValue) {
  return calculateMaintenanceContractSummary(contract, findPriorMaintenanceInvoices(contract, invoices, client, {}), dateValue);
}

export function calculateContractInvoicePricing({
  contract,
  invoice,
  invoices,
  client,
  lineItems,
  requestedAmountCents,
}) {
  const subtotalCents = centsTotal(lineItems);
  if (!contract) {
    const amountCents = requestedAmountCents == null
      ? Math.max(subtotalCents - Number(invoice.discountCents || 0), 0)
      : Math.max(0, Math.min(subtotalCents, Math.round(Number(requestedAmountCents))));
    return {
      contractId: null,
      subtotalCents,
      amountCents,
      discountCents: subtotalCents - amountCents,
      retainerCreditCents: 0,
      serviceDiscountCents: 0,
      includedHoursApplied: 0,
      contractBalanceCents: null,
    };
  }

  if (contract.accountId !== (invoice.accountId || invoice.clientId) || contract.status !== 'active') {
    return { error: 'The selected contract is not active for this account.' };
  }
  if (!contractCoversServiceAddress(contract, invoice.serviceAddress || client?.address, client)) {
    return { error: 'The selected contract does not match the invoice service address.' };
  }

  const invoiceDate = invoice.issueDate || invoice.createdAt;
  const contractInvoice = { ...invoice, contractId: contract.id, status: invoice.status || 'sent' };

  if ((contract.contractType || 'maintenance') === 'maintenance') {
    const terms = getMaintenanceContractTerms(contract);
    const paidWhenCreated = invoice.contractPooledHoursEligible === false
      && new Date(contract.lastPaymentAt).getTime() <= new Date(invoice.createdAt).getTime()
      && isMaintenanceContractBillingPeriodPaid(contract, invoiceDate);
    const pooledHoursEligible = typeof invoice.contractPooledHoursEligible === 'boolean'
      ? invoice.contractPooledHoursEligible || paidWhenCreated
      : isMaintenanceContractBillingPeriodPaid(contract, invoiceDate);
    contractInvoice.contractPooledHoursEligible = pooledHoursEligible;
    const usageInvoices = [
      ...findPriorMaintenanceInvoices(contract, invoices, client, contractInvoice),
      ...(pooledHoursEligible ? [contractInvoice] : []),
    ];
    const allocation = pooledHoursEligible ? allocateMaintenanceContractHours(contract, usageInvoices).get(contractInvoice.id) : null;
    const credits = calculateMaintenanceContractCredits(laborItems(lineItems), allocation?.includedHours || 0, terms.discountPercent);
    const automaticCreditCents = Math.min(credits.totalCreditCents, subtotalCents);
    const automaticTotalCents = subtotalCents - automaticCreditCents;
    const amountCents = requestedAmountCents == null
      ? automaticTotalCents
      : Math.max(0, Math.min(automaticTotalCents, Math.round(Number(requestedAmountCents))));
    return {
      contractId: contract.id,
      contractType: 'maintenance',
      contractJobHours: allocation?.jobHours || 0,
      contractPooledHoursEligible: pooledHoursEligible,
      includedHoursApplied: credits.includedHoursApplied,
      retainerCreditCents: credits.retainerCreditCents,
      serviceDiscountCents: credits.serviceDiscountCents,
      automaticCreditCents,
      subtotalCents,
      amountCents,
      discountCents: subtotalCents - amountCents,
      contractBalanceCents: null,
      billingPeriodIndex: allocation?.periodIndex ?? getContractPeriodIndex(contract, invoiceDate),
    };
  }

  if (contract.contractType === 'labor') {
    const previousInvoices = invoices.filter(existingInvoice => existingInvoice.id !== invoice.id);
    const summary = calculateLaborContractSummary(contract, previousInvoices);
    const isFixedQuote = contract.laborPricingModel === 'fixed';
    const capCents = isFixedQuote ? summary?.remainingAmountCents || 0 : null;
    const proposedCents = requestedAmountCents == null
      ? isFixedQuote ? Math.min(subtotalCents, capCents) : subtotalCents
      : Math.max(0, Math.round(Number(requestedAmountCents)));
    if (proposedCents <= 0) return { error: 'Enter a positive invoice amount for this labor contract.' };
    if (isFixedQuote && proposedCents > capCents) {
      return { error: `This invoice exceeds the labor contract balance of $${(capCents / 100).toFixed(2)}.` };
    }
    const currentInvoiceHours = Array.isArray(invoice.contractorHours) && invoice.contractorHours.length
      ? invoice.contractorHours.reduce((sum, entry) => sum + Math.max(0, Number(entry.hours || 0)), 0)
      : laborItems(lineItems).reduce((sum, item) => sum + Math.max(0, Number(item.quantity || 0)), 0);
    const actualHours = (summary?.actualHours || 0) + currentInvoiceHours;
    return {
      contractId: contract.id,
      contractType: 'labor',
      subtotalCents,
      amountCents: proposedCents,
      discountCents: Math.max(0, subtotalCents - proposedCents),
      retainerCreditCents: 0,
      serviceDiscountCents: 0,
      includedHoursApplied: 0,
      contractBalanceCents: isFixedQuote ? Math.max(0, capCents - proposedCents) : null,
      contractEstimatedHours: isFixedQuote ? null : summary?.estimatedHours,
      contractActualHours: isFixedQuote ? null : actualHours,
      contractRemainingHours: isFixedQuote ? null : Math.max(0, (summary?.estimatedHours || 0) - actualHours),
    };
  }

  return { error: 'The selected contract type is not supported for invoice billing.' };
}

export function getInvoiceContractPricingInput({ contracts, invoices, accountId, clientId, serviceAddress, issueDate, contractId, invoiceId, jobName, status = 'sent', contractorHours, lineItems, discountCents, requestedAmountCents, client, contractPooledHoursEligible }) {
  const resolvedAccountId = accountId || clientId;
  const invoiceDate = issueDate || new Date().toISOString().slice(0, 10);
  const existingInvoice = invoiceId ? invoices.find(existing => existing.id === invoiceId) : null;
  const matches = findInvoiceContracts({ contracts, accountId: resolvedAccountId, serviceAddress: serviceAddress || client?.address, invoiceDate, client });
  const selectedContract = contractId
    ? contracts.find(contract => contract.id === contractId)
    : matches.length === 1 ? matches[0] : null;

  if (contractId && !selectedContract) return { error: 'The selected contract could not be found.' };
  if (contractId && !matches.some(contract => contract.id === contractId)) {
    return { error: 'The selected contract is not active for this address and invoice date.' };
  }
  if (matches.length > 1 && !contractId) {
    return { error: 'More than one active contract covers this address. Select which contract to use.' };
  }

  const invoice = {
    id: invoiceId || '__contract_invoice_preview__',
    accountId: resolvedAccountId,
    issueDate: invoiceDate,
    ...(existingInvoice?.createdAt ? { createdAt: existingInvoice.createdAt } : {}),
    serviceAddress: serviceAddress || client?.address || '',
    jobName,
    status,
    contractorHours,
    lineItems,
    discountCents,
    contractId: selectedContract?.id,
    contractPooledHoursEligible,
  };
  const pricing = calculateContractInvoicePricing({ contract: selectedContract, invoice, invoices, client, lineItems, requestedAmountCents });
  return { ...pricing, invoiceDate };
}
