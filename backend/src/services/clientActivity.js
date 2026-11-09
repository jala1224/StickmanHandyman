import { getContractBillingPrice, getContractPaymentSummary } from './contractPricing.js';
import { calculateLaborContractSummary, getMaintenanceContractTerms } from './maintenanceContractBilling.js';
import { getMaintenanceContractSummary } from './contractInvoiceBilling.js';
import { getContracts, getInvoices } from './store.js';

export function getClientActivity(account) {
  const allInvoices = getInvoices();
  const invoices = allInvoices.filter(invoice => invoice.status !== 'ongoing'
    && (invoice.accountId === account.id || invoice.clientId === account.id));
  const contracts = getContracts()
    .filter(contract => contract.accountId === account.id || contract.clientId === account.id)
    .map(contract => {
      const price = getContractBillingPrice(contract);
      const { stripeSubscriptionId, signedAttachments, ...publicContract } = contract;
      return {
        ...publicContract,
        ...((contract.contractType || 'maintenance') === 'maintenance' ? {
          maintenanceTerms: getMaintenanceContractTerms(contract),
          maintenanceSummary: getMaintenanceContractSummary(contract, allInvoices, account),
        } : {}),
        ...(contract.contractType === 'labor' ? { laborSummary: calculateLaborContractSummary(contract, allInvoices) } : {}),
        monthlyAmountCents: price?.monthlyAmountCents ?? null,
        billingAmountCents: price?.amountCents ?? null,
        autopayEnabled: Boolean(contract.autopayEnabled),
        stripeSubscriptionStatus: contract.stripeSubscriptionStatus || null,
        lastPaymentAt: contract.lastPaymentAt || null,
        lastPaymentAmountCents: contract.lastPaymentAmountCents ?? null,
        ...getContractPaymentSummary(contract),
      };
    });
  return { invoices, contracts };
}