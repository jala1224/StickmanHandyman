const standardMonthlyPrices = Object.freeze({
  single_home: Object.freeze({ basic: 16_000, pro: 20_000, premium: 35_000 }),
  portfolio: Object.freeze({ basic: 30_000, pro: 40_000, premium: 70_000 }),
});

const billingCycles = Object.freeze({
  monthly: Object.freeze({ interval: 'month', intervalCount: 1, periodCount: 1 }),
  quarterly: Object.freeze({ interval: 'month', intervalCount: 3, periodCount: 3 }),
  annually: Object.freeze({ interval: 'year', intervalCount: 1, periodCount: 12 }),
});

export function getContractBillingPrice(contract) {
  const monthlyAmountCents = contract.packageType === 'custom'
    ? Number(contract.packageMonthlyCostCents)
    : Number(standardMonthlyPrices[contract.packageType]?.[contract.packageLevel]);
  const billingCycle = billingCycles[contract.billingCycle];

  if (!Number.isSafeInteger(monthlyAmountCents) || monthlyAmountCents <= 0 || !billingCycle) {
    return null;
  }

  return {
    monthlyAmountCents,
    amountCents: monthlyAmountCents * billingCycle.periodCount,
    interval: billingCycle.interval,
    intervalCount: billingCycle.intervalCount,
  };
}

function parseContractDate(value) {
  if (typeof value !== 'string' || !value) {
    return null;
  }
  const dateOnlyMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const parsed = dateOnlyMatch
    ? new Date(Date.UTC(Number(dateOnlyMatch[1]), Number(dateOnlyMatch[2]) - 1, Number(dateOnlyMatch[3])))
    : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function addBillingMonths(date, months) {
  const shifted = new Date(date);
  const dayOfMonth = shifted.getUTCDate();
  shifted.setUTCDate(1);
  shifted.setUTCMonth(shifted.getUTCMonth() + months);
  const lastDayOfMonth = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0)).getUTCDate();
  shifted.setUTCDate(Math.min(dayOfMonth, lastDayOfMonth));
  return shifted;
}

export function getNextContractPaymentDueAt(contract, paymentDate) {
  const price = getContractBillingPrice(contract);
  const paidAt = parseContractDate(paymentDate);
  if (!price || !paidAt) {
    return null;
  }
  const months = price.interval === 'year' ? 12 * price.intervalCount : price.intervalCount;
  return addBillingMonths(paidAt, months).toISOString();
}

export function getContractPaymentSummary(contract, nowValue = new Date()) {
  const price = getContractBillingPrice(contract);
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
  const lastPaymentAt = parseContractDate(contract.lastPaymentAt);
  const startDate = parseContractDate(contract.startDate);
  const months = price ? (price.interval === 'year' ? 12 * price.intervalCount : price.intervalCount) : 1;
  let nextPaymentDueAt = parseContractDate(contract.nextPaymentDueAt);

  if (!nextPaymentDueAt && lastPaymentAt) {
    nextPaymentDueAt = addBillingMonths(lastPaymentAt, months);
  } else if (!nextPaymentDueAt && startDate) {
    nextPaymentDueAt = addBillingMonths(startDate, months);
  }

  const periodStart = nextPaymentDueAt ? addBillingMonths(nextPaymentDueAt, -months) : null;
  const subscriptionStatus = String(contract.stripeSubscriptionStatus || '').toLowerCase();
  const paymentStatus = !['past_due', 'unpaid', 'incomplete', 'incomplete_expired'].includes(subscriptionStatus)
    && Boolean(lastPaymentAt && periodStart && lastPaymentAt >= periodStart && lastPaymentAt <= now && now < nextPaymentDueAt)
    ? 'Paid'
    : 'Unpaid';

  return {
    paymentStatus,
    nextPaymentDueAt: nextPaymentDueAt ? nextPaymentDueAt.toISOString().slice(0, 10) : null,
  };
}
