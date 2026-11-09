import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { getHighestSavedInvoiceNumber } from './invoicePdf.js';
import { buildContractorHourTiers, calculateContractorLaborEstimate, createOngoingJob, deleteOngoingJob, getContractorById, getOngoingJobById, getOngoingJobs, removeContractorInvoiceHours, saveContractorInvoiceHours, updateOngoingJob } from './contractorRepository.js';
import { loadBusinessData, saveBusinessData } from './businessRepository.js';
import { loadClientUsers, saveClientUsers } from './clientUserRepository.js';
import { getInvoiceContractPricingInput } from './contractInvoiceBilling.js';

const nowIso = () => new Date().toISOString();
const todayLocalDate = () => {
  const date = new Date();
  const offsetDate = new Date(date.getTime() - (date.getTimezoneOffset() * 60_000));
  return offsetDate.toISOString().slice(0, 10);
};

const defaultAccounts = [
  {
    id: 'client_1',
    accountKey: 'a7d54fc8-3bc0-4f46-9bc3-0c2ca8e9c001',
    name: 'Sample Client',
    address: '123 Main St, Boulder, CO',
    businesses: [],
    nameNormalized: normalize('Sample Client'),
    addressNormalized: normalize('123 Main St, Boulder, CO'),
    lookupHash: buildLookupHash('Sample Client', '123 Main St, Boulder, CO'),
    status: 'active',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  },
];

const defaultInvoices = [
  {
    id: 'invoice_1',
    accountId: 'client_1',
    invoiceNumber: 'INV-1000',
    amountCents: 45000,
    currency: 'usd',
    status: 'sent',
    dueDate: '2026-08-31',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  },
];

const defaultContracts = [
  {
    id: 'contract_1',
    accountId: 'client_1',
    contractNumber: 'CON-2000',
    contractType: 'maintenance',
    status: 'active',
    billingCycle: 'monthly',
    startDate: '2026-08-01',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  },
];

const businessData = loadBusinessData({
  clients: defaultAccounts,
  invoices: defaultInvoices,
  contracts: defaultContracts,
});
const accounts = businessData.clients;
const invoices = businessData.invoices;
const contracts = businessData.contracts;

const adminUsers = [
  {
    id: 'admin_1',
    email: config.adminBootstrapEmail,
    password: config.adminBootstrapPassword,
    role: 'admin',
  },
];

const adminSessions = new Map();
const clientUsers = loadClientUsers();
const clientSessions = new Map();
const lookupSessions = new Map();
const audits = [];

export function getClients() {
  return accounts;
}

export function getClientById(clientId) {
  return accounts.find((account) => account.id === clientId) ?? null;
}

function resolveInvoiceBillingIdentity(accountId, businessId = null) {
  const account = getClientById(accountId);
  const business = businessId ? account?.businesses?.find((entry) => entry.id === businessId) : null;
  if (businessId && !business) throw new Error('The selected business is not associated with this client.');
  return {
    billingBusinessId: business?.id || null,
    billingEntityName: business?.name || account?.name || null,
    billingEntityAddress: business?.address || account?.address || null,
  };
}

export function getAccountByKey(accountKey) {
  return accounts.find((account) => account.accountKey === accountKey) ?? null;
}

export function findClientByNameAndAddress(name, address) {
  const lookupHash = buildLookupHash(name, address);
  const exactMatch = accounts.find((account) => {
    return account.lookupHash === lookupHash
      || (Array.isArray(account.serviceAddresses)
        && account.serviceAddresses.some((serviceAddress) => buildLookupHash(account.name, serviceAddress) === lookupHash));
  });
  if (exactMatch) {
    return exactMatch;
  }

  const normalizedName = normalize(name);
  const normalizedAddress = normalizeLookupAddress(address);
  return accounts.find((account) => {
    if (normalize(account.name) !== normalizedName) {
      return false;
    }

    const savedAddresses = [account.address, ...(Array.isArray(account.serviceAddresses) ? account.serviceAddresses : [])];
    return savedAddresses.some((savedAddress) => normalizeLookupAddress(savedAddress) === normalizedAddress);
  }) ?? null;
}

export function issueLookupSession(accountId) {
  const token = randomUUID();
  const expiresAt = Date.now() + config.lookupSessionTtlMinutes * 60 * 1000;

  lookupSessions.set(token, {
    accountId,
    expiresAt,
  });

  return { token, expiresAt };
}

export function verifyLookupSession(token) {
  const session = lookupSessions.get(token);
  if (!session) {
    return null;
  }

  if (session.expiresAt <= Date.now()) {
    lookupSessions.delete(token);
    return null;
  }

  return session;
}

function normalizeServiceAddresses(input) {
  const values = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(/\r?\n|[,;]/)
      : [];

  const uniqueValues = [];
  for (const value of values) {
    const normalized = String(value ?? '').trim();
    if (!normalized || uniqueValues.includes(normalized)) {
      continue;
    }
    uniqueValues.push(normalized);
  }

  return uniqueValues;
}

function normalizeClientBusinesses(input = []) {
  if (!Array.isArray(input)) return [];
  return input.map((business) => ({
    id: String(business.id || `business_${randomUUID()}`),
    name: String(business.name || '').trim(),
    address: String(business.address || '').trim(),
  })).filter((business) => business.name && business.address);
}

export function createClient(input) {
  const serviceAddresses = normalizeServiceAddresses(input.serviceAddresses ?? []);
  const businesses = normalizeClientBusinesses(input.businesses ?? []);
  const resolvedBillingAddress = String(input.address || '').trim();

  const account = {
    id: `client_${randomUUID()}`,
    accountKey: randomUUID(),
    name: input.name,
    address: resolvedBillingAddress,
    serviceAddresses,
    businesses,
    nameNormalized: normalize(input.name),
    addressNormalized: normalize(resolvedBillingAddress),
    lookupHash: buildLookupHash(input.name, resolvedBillingAddress),
    status: input.status ?? 'active',
    stripeCustomerId: input.stripeCustomerId ?? null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  accounts.push(account);
  saveBusinessData({ clients: accounts, invoices });
  return account;
}

export function updateClient(clientId, changes) {
  const account = getClientById(clientId);
  if (!account) {
    return null;
  }

  if (typeof changes.name === 'string') {
    account.name = changes.name;
    account.nameNormalized = normalize(changes.name);
  }

  if (typeof changes.address === 'string') {
    account.address = changes.address;
    account.addressNormalized = normalize(changes.address);
  }

  if (Array.isArray(changes.serviceAddresses)) {
    account.serviceAddresses = normalizeServiceAddresses(changes.serviceAddresses);
  } else if (typeof changes.serviceAddresses === 'string') {
    account.serviceAddresses = normalizeServiceAddresses(changes.serviceAddresses);
  }

  if (Array.isArray(changes.businesses)) {
    account.businesses = normalizeClientBusinesses(changes.businesses);
  }

  if (typeof changes.status === 'string') {
    account.status = changes.status;
  }

  if (typeof changes.stripeCustomerId === 'string') {
    account.stripeCustomerId = changes.stripeCustomerId;
  }

  account.lookupHash = buildLookupHash(account.name, account.address);
  account.updatedAt = nowIso();
  saveBusinessData({ clients: accounts, invoices });
  return account;
}

export function mergeClientAsBusiness(targetClientId, sourceClientId) {
  if (targetClientId === sourceClientId) return { error: 'CLIENT_MERGE_SELF' };
  const target = getClientById(targetClientId);
  const source = getClientById(sourceClientId);
  if (!target || !source) return { error: 'CLIENT_NOT_FOUND' };

  const sourceContracts = contracts.filter((contract) => (contract.accountId || contract.clientId) === source.id);
  const hasActiveSubscription = sourceContracts.some((contract) => contract.autopayEnabled
    || (contract.stripeSubscriptionId && !['canceled', 'incomplete_expired'].includes(String(contract.stripeSubscriptionStatus || '').toLowerCase())));
  if (hasActiveSubscription) return { error: 'CLIENT_MERGE_ACTIVE_SUBSCRIPTION' };

  const sourceUser = getClientUserByAccountId(source.id);
  const targetUser = getClientUserByAccountId(target.id);
  if (sourceUser && targetUser) return { error: 'CLIENT_MERGE_LOGIN_CONFLICT' };

  const targetBusinesses = normalizeClientBusinesses(target.businesses || []);
  const findOrAddBusiness = (name, address) => {
    const normalizedName = String(name || '').trim().toLocaleLowerCase();
    const normalizedAddress = String(address || '').trim().toLocaleLowerCase();
    const existing = targetBusinesses.find((business) => business.name.toLocaleLowerCase() === normalizedName
      && business.address.toLocaleLowerCase() === normalizedAddress);
    if (existing) return existing;
    let id = `business_${source.id}`;
    if (targetBusinesses.some((business) => business.id === id)) id = `${id}_${randomUUID()}`;
    const business = { id, name: String(name || '').trim(), address: String(address || '').trim() };
    targetBusinesses.push(business);
    return business;
  };

  const sourceBusiness = findOrAddBusiness(source.name, source.address);
  const businessIdMap = new Map([[null, sourceBusiness.id]]);
  for (const business of source.businesses || []) {
    businessIdMap.set(business.id, findOrAddBusiness(business.name, business.address).id);
  }
  target.businesses = targetBusinesses;
  target.serviceAddresses = normalizeServiceAddresses([
    ...(target.serviceAddresses || []),
    source.address,
    ...(source.serviceAddresses || []),
    ...(source.businesses || []).flatMap((business) => [business.address, ...(business.serviceAddresses || [])]),
  ]);
  if (source.stripeCustomerId && !target.stripeCustomerId) target.stripeCustomerId = source.stripeCustomerId;
  else if (source.stripeCustomerId && source.stripeCustomerId !== target.stripeCustomerId) {
    target.legacyStripeCustomerIds = [...new Set([...(target.legacyStripeCustomerIds || []), source.stripeCustomerId])];
  }

  const reassignInvoice = (invoice) => {
    if ((invoice.accountId || invoice.clientId) !== source.id) return invoice;
    const originalBusiness = (source.businesses || []).find((business) => business.id === invoice.billingBusinessId);
    invoice.accountId = target.id;
    if (invoice.clientId === source.id) invoice.clientId = target.id;
    invoice.billingBusinessId = businessIdMap.get(invoice.billingBusinessId || null) || sourceBusiness.id;
    invoice.billingEntityName ||= originalBusiness?.name || source.name;
    invoice.billingEntityAddress ||= originalBusiness?.address || source.address;
    invoice.clientSnapshot = { id: target.id, name: target.name, address: target.address };
    return invoice;
  };
  let invoiceCount = 0;
  invoices.forEach((invoice) => {
    if ((invoice.accountId || invoice.clientId) !== source.id) return;
    reassignInvoice(invoice);
    invoiceCount += 1;
  });
  const ongoingJobs = getOngoingJobs().filter((job) => (job.accountId || job.clientId) === source.id);
  ongoingJobs.forEach((job) => {
    reassignInvoice(job);
    updateOngoingJob(job.id, job);
  });

  sourceContracts.forEach((contract) => {
    contract.accountId = target.id;
    if (contract.clientId === source.id) contract.clientId = target.id;
  });
  accounts.splice(accounts.findIndex((account) => account.id === source.id), 1);
  target.updatedAt = nowIso();

  if (sourceUser && !targetUser) {
    sourceUser.accountId = target.id;
    sourceUser.updatedAt = nowIso();
    clientSessions.forEach((session) => {
      if (session.clientUserId === sourceUser.id) session.accountId = target.id;
    });
    saveClientUsers(clientUsers);
  }
  lookupSessions.forEach((session) => {
    if (session.accountId === source.id) session.accountId = target.id;
  });

  saveBusinessData({ clients: accounts, invoices, contracts });
  return {
    client: target,
    mergedBusiness: sourceBusiness,
    invoiceCount: invoiceCount + ongoingJobs.length,
    contractCount: sourceContracts.length,
    loginTransferred: Boolean(sourceUser),
  };
}

export function deleteClient(clientId) {
  const clientIndex = accounts.findIndex((account) => account.id === clientId);
  if (clientIndex < 0) {
    return { error: 'CLIENT_NOT_FOUND' };
  }

  const hasInvoices = getInvoices().some((invoice) => invoice.accountId === clientId);
  const hasContracts = contracts.some((contract) => contract.accountId === clientId);
  if (hasInvoices || hasContracts) {
    return { error: 'CLIENT_HAS_RECORDS' };
  }

  const [removedAccount] = accounts.splice(clientIndex, 1);
  saveBusinessData({ clients: accounts, invoices });

  const clientUserIndex = clientUsers.findIndex((clientUser) => clientUser.accountId === clientId);
  if (clientUserIndex >= 0) {
    clientUsers.splice(clientUserIndex, 1);
    saveClientUsers(clientUsers);
  }

  return { client: removedAccount };
}

export function getClientUserByEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  return clientUsers.find((clientUser) => normalizeEmail(clientUser.email) === normalizedEmail) ?? null;
}

export function getClientUserByAccountId(accountId) {
  return clientUsers.find((clientUser) => clientUser.accountId === accountId) ?? null;
}

export function createClientUser({ accountId, email, password, notificationsEnabled = true, autopayEnabled = false }) {
  const existingAccountUser = getClientUserByAccountId(accountId);
  if (existingAccountUser) {
    throw new Error('ACCOUNT_ALREADY_HAS_CLIENT_USER');
  }

  const existingEmailUser = getClientUserByEmail(email);
  if (existingEmailUser) {
    throw new Error('EMAIL_ALREADY_IN_USE');
  }

  const clientUser = {
    id: `client_user_${randomUUID()}`,
    accountId,
    email,
    passwordHash: hashPassword(password),
    notificationsEnabled,
    autopayEnabled,
    emailVerifiedAt: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  clientUsers.push(clientUser);
  saveClientUsers(clientUsers);
  return sanitizeClientUser(clientUser);
}

export function activateClientUser({ accountKey, name, address, email, password, notificationsEnabled = true, autopayEnabled = false }) {
  const account = getAccountByKey(accountKey);
  if (!account) {
    return { error: 'ACCOUNT_NOT_FOUND' };
  }

  if (account.lookupHash !== buildLookupHash(name, address)) {
    return { error: 'ACCOUNT_LOOKUP_MISMATCH' };
  }

  try {
    const clientUser = createClientUser({
      accountId: account.id,
      email,
      password,
      notificationsEnabled,
      autopayEnabled,
    });

    return { account, clientUser };
  } catch (error) {
    return { error: error.message };
  }
}

export function authenticateClientUser(email, password) {
  const clientUser = getClientUserByEmail(email);
  if (!clientUser) {
    return null;
  }

  if (!verifyPassword(password, clientUser.passwordHash)) {
    return null;
  }

  const session = issueClientSession(clientUser);
  return {
    clientUser: sanitizeClientUser(clientUser),
    token: session.token,
    expiresAt: session.expiresAt,
  };
}

export function issueClientSession(clientUser) {
  const token = randomUUID();
  const expiresAt = Date.now() + config.clientSessionTtlHours * 60 * 60 * 1000;

  clientSessions.set(token, {
    clientUserId: clientUser.id,
    accountId: clientUser.accountId,
    email: clientUser.email,
    expiresAt,
  });

  return { token, expiresAt };
}

export function verifyClientSession(token) {
  const session = clientSessions.get(token);
  if (!session) {
    return null;
  }

  if (session.expiresAt <= Date.now()) {
    clientSessions.delete(token);
    return null;
  }

  return session;
}

export function revokeClientSession(token) {
  return clientSessions.delete(token);
}

export function updateClientUser(accountId, changes) {
  const clientUser = getClientUserByAccountId(accountId);
  if (!clientUser) {
    return null;
  }

  if (typeof changes.notificationsEnabled === 'boolean') {
    clientUser.notificationsEnabled = changes.notificationsEnabled;
  }

  if (typeof changes.autopayEnabled === 'boolean') {
    clientUser.autopayEnabled = changes.autopayEnabled;
  }

  if (typeof changes.emailVerifiedAt === 'string' || changes.emailVerifiedAt === null) {
    clientUser.emailVerifiedAt = changes.emailVerifiedAt;
  }

  clientUser.updatedAt = nowIso();
  saveClientUsers(clientUsers);
  return sanitizeClientUser(clientUser);
}

export function updateClientCredentials(accountId, { email, currentPassword, newPassword }) {
  const clientUser = getClientUserByAccountId(accountId);
  if (!clientUser) {
    return { error: 'CLIENT_USER_NOT_FOUND' };
  }

  if (!currentPassword || !verifyPassword(currentPassword, clientUser.passwordHash)) {
    return { error: 'INVALID_CURRENT_PASSWORD' };
  }

  const normalizedEmail = normalizeEmail(email);
  const existingEmailUser = getClientUserByEmail(normalizedEmail);
  if (existingEmailUser && existingEmailUser.id !== clientUser.id) {
    return { error: 'EMAIL_ALREADY_IN_USE' };
  }

  if (clientUser.email !== normalizedEmail) {
    clientUser.emailVerifiedAt = null;
  }
  clientUser.email = normalizedEmail;
  if (newPassword) {
    clientUser.passwordHash = hashPassword(newPassword);
  }
  clientUser.updatedAt = nowIso();

  clientSessions.forEach((session) => {
    if (session.clientUserId === clientUser.id) {
      session.email = clientUser.email;
    }
  });

  saveClientUsers(clientUsers);
  return { clientUser: sanitizeClientUser(clientUser) };
}

export function setClientLoginCredentials(accountId, { email, password }) {
  if (!getClientById(accountId)) {
    return { error: 'CLIENT_NOT_FOUND' };
  }

  const normalizedEmail = normalizeEmail(email);
  const existingEmailUser = getClientUserByEmail(normalizedEmail);
  if (existingEmailUser && existingEmailUser.accountId !== accountId) {
    return { error: 'EMAIL_ALREADY_IN_USE' };
  }

  let clientUser = getClientUserByAccountId(accountId);
  if (!clientUser) {
    if (!password) {
      return { error: 'PASSWORD_REQUIRED' };
    }
    try {
      clientUser = createClientUser({ accountId, email: normalizedEmail, password });
      return { clientUser };
    } catch (error) {
      return { error: error.message };
    }
  }

  if (clientUser.email !== normalizedEmail) {
    clientUser.email = normalizedEmail;
    clientUser.emailVerifiedAt = null;
  }
  if (password) {
    clientUser.passwordHash = hashPassword(password);
  }
  clientUser.updatedAt = nowIso();

  for (const [token, session] of clientSessions) {
    if (session.clientUserId === clientUser.id) {
      clientSessions.delete(token);
    }
  }

  saveClientUsers(clientUsers);
  return { clientUser: sanitizeClientUser(clientUser) };
}

export function getInvoices() {
  return [...invoices, ...getOngoingJobs()];
}

export function getInvoiceById(invoiceId) {
  return invoices.find((invoice) => invoice.id === invoiceId) ?? getOngoingJobById(invoiceId);
}

export function deleteInvoice(invoiceId) {
  const ongoingJob = getOngoingJobById(invoiceId);
  if (ongoingJob) {
    if (!deleteOngoingJob(invoiceId)) {
      return { error: 'INVOICE_NOT_FOUND' };
    }
    removeContractorInvoiceHours(invoiceId);
    return { invoice: ongoingJob };
  }

  const invoiceIndex = invoices.findIndex((invoice) => invoice.id === invoiceId);
  if (invoiceIndex < 0) {
    return { error: 'INVOICE_NOT_FOUND' };
  }

  const invoice = invoices[invoiceIndex];
  if (invoice.status === 'paid' || invoice.status === 'void') {
    return { error: 'INVOICE_NOT_DELETABLE' };
  }

  invoices.splice(invoiceIndex, 1);
  saveBusinessData({ clients: accounts, invoices });
  removeContractorInvoiceHours(invoiceId);
  return { invoice };
}

export function authorizeInvoiceLookupAccess({ invoiceId, lookupToken }) {
  return authorizeInvoicePaymentAccess({ invoiceId, lookupToken });
}

export function authorizeInvoicePaymentAccess({ invoiceId, lookupToken, clientToken }) {
  const session = clientToken === undefined ? verifyLookupSession(lookupToken) : verifyClientSession(clientToken);
  if (!session) {
    return { error: clientToken === undefined ? 'LOOKUP_SESSION_INVALID' : 'CLIENT_SESSION_INVALID' };
  }

  const invoice = getInvoiceById(invoiceId);
  if (!invoice) {
    return { error: 'INVOICE_NOT_FOUND' };
  }

  if ((invoice.accountId || invoice.clientId) !== session.accountId) {
    return { error: 'INVOICE_ACCESS_DENIED' };
  }

  if (invoice.status === 'paid' || invoice.status === 'void' || invoice.status === 'ongoing' || !(invoice.amountCents > 0)) {
    return { error: 'INVOICE_NOT_PAYABLE' };
  }

  return {
    invoice,
    account: getClientById(session.accountId),
    lookupSession: session,
  };
}

export function getNextInvoiceNumber() {
  const startingNumber = Number.isFinite(config.invoiceNumberStart) ? config.invoiceNumberStart : 1001;
  const existingNumbers = invoices
    .map((invoice) => Number(String(invoice.invoiceNumber || '').replace(/\D+/g, '')))
    .filter((value) => Number.isFinite(value) && value > 0);

  const highestInMemory = existingNumbers.length ? Math.max(...existingNumbers) : 0;
  const highestSaved = getHighestSavedInvoiceNumber();
  const highestKnown = Math.max(highestInMemory, highestSaved);

  const nextValue = highestKnown > 0 ? Math.max(highestKnown + 1, startingNumber) : startingNumber;
  return `INV-${nextValue}`;
}

function resolveInvoiceContractPricing(invoice, requestedAmountCents = null) {
  const client = getClientById(invoice.accountId) || invoice.clientSnapshot;
  const pricing = getInvoiceContractPricingInput({
    contracts,
    invoices,
    accountId: invoice.accountId,
    serviceAddress: invoice.serviceAddress || client?.address,
    billingBusinessId: invoice.billingBusinessId,
    issueDate: invoice.issueDate,
    contractId: invoice.contractId,
    invoiceId: invoice.id,
    jobName: invoice.jobName,
    status: invoice.status,
    contractorHours: invoice.contractorHours,
    lineItems: invoice.lineItems,
    discountCents: invoice.discountCents,
    requestedAmountCents,
    client,
    contractPooledHoursEligible: invoice.contractPooledHoursEligible,
  });
  if (pricing.error) {
    const error = new Error(pricing.error);
    error.statusCode = 400;
    throw error;
  }
  if (!pricing.contractId) return invoice;

  Object.assign(invoice, {
    contractId: pricing.contractId,
    contractType: pricing.contractType,
    contractJobHours: pricing.contractJobHours,
    contractPooledHoursEligible: pricing.contractPooledHoursEligible,
    includedHoursApplied: pricing.includedHoursApplied,
    retainerCreditCents: pricing.retainerCreditCents,
    serviceDiscountCents: pricing.serviceDiscountCents,
    contractBillingPeriodIndex: pricing.billingPeriodIndex,
    contractBalanceCents: pricing.contractBalanceCents,
    subtotalCents: pricing.subtotalCents,
    discountCents: pricing.discountCents,
    amountCents: pricing.amountCents,
  });
  return invoice;
}

export function previewInvoiceContractPricing(input) {
  const accountId = input.accountId ?? input.clientId;
  const client = getClientById(accountId);
  const contractorHours = normalizeContractorHours(input.contractorHours ?? []);
  return getInvoiceContractPricingInput({
    contracts,
    invoices,
    accountId,
    serviceAddress: input.serviceAddress || client?.address,
    billingBusinessId: input.billingBusinessId,
    issueDate: input.issueDate || todayLocalDate(),
    contractId: input.contractId,
    contractorHours,
    lineItems: buildInvoiceLineItems(input.lineItems ?? [], contractorHours, Array.isArray(input.contractorHours)),
    requestedAmountCents: input.amountCents,
    client,
    contractPooledHoursEligible: input.contractPooledHoursEligible,
  });
}

export function createInvoice(input) {
  const contractorHours = normalizeContractorHours(input.contractorHours ?? []);
  const lineItems = buildInvoiceLineItems(input.lineItems ?? [], contractorHours, Array.isArray(input.contractorHours));
  const subtotalCents = input.subtotalCents ?? calculateLineItemsTotal(lineItems);
  const discountCents = Math.max(0, Number(input.discountCents ?? 0));
  const amountCents = input.amountCents ?? Math.max(subtotalCents - discountCents, 0);

  const isOngoing = Boolean(input.isOngoing);
  const accountId = input.accountId ?? input.clientId;
  const client = isOngoing ? getClientById(accountId) : null;
  const billingIdentity = resolveInvoiceBillingIdentity(accountId, input.billingBusinessId || null);
  const invoice = {
    id: `invoice_${randomUUID()}`,
    accountId,
    ...billingIdentity,
    clientSnapshot: client ? { id: client.id, name: client.name, address: client.address } : null,
    invoiceNumber: isOngoing ? null : (input.invoiceNumber || getNextInvoiceNumber()),
    issueDate: input.issueDate || todayLocalDate(),
    jobName: String(input.jobName ?? '').trim(),
    jobDescription: String(input.jobDescription ?? '').trim(),
    isOngoing,
    dueDate: null,
    amountCents,
    subtotalCents,
    taxCents: 0,
    discountCents,
    currency: input.currency ?? 'usd',
    status: isOngoing ? 'ongoing' : 'sent',
    serviceAddress: input.serviceAddress || null,
    contractId: input.contractId || null,
    contractorHours,
    lineItems,
    stripePaymentIntentId: input.stripePaymentIntentId ?? null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  if (isOngoing) {
    return createOngoingJob(invoice);
  }

  resolveInvoiceContractPricing(invoice, input.amountCents);

  invoices.push(invoice);
  saveBusinessData({ clients: accounts, invoices });
  saveContractorInvoiceHours(invoice);
  return invoice;
}

export function updateInvoice(invoiceId, changes) {
  const invoice = getInvoiceById(invoiceId);
  if (!invoice) {
    return null;
  }

  const finalizeOngoingJob = invoice.status === 'ongoing' && changes.isOngoing === false;
  const previousAccountId = invoice.accountId || invoice.clientId;
  if (typeof changes.accountId === 'string') {
    invoice.accountId = changes.accountId;
  }
  const accountChanged = (invoice.accountId || invoice.clientId) !== previousAccountId;
  if (accountChanged || Object.hasOwn(changes, 'billingBusinessId') || !invoice.billingEntityName) {
    const billingBusinessId = Object.hasOwn(changes, 'billingBusinessId')
      ? changes.billingBusinessId || null
      : accountChanged ? null : invoice.billingBusinessId || null;
    Object.assign(invoice, resolveInvoiceBillingIdentity(invoice.accountId || invoice.clientId, billingBusinessId));
  }
  if (invoice.status === 'ongoing' && invoice.accountId) {
    const client = getClientById(invoice.accountId);
    if (client) {
      invoice.clientSnapshot = { id: client.id, name: client.name, address: client.address };
    }
  }
  if (invoice.status !== 'ongoing' && typeof changes.status === 'string') {
    invoice.status = changes.status;
  }

  if (typeof changes.serviceAddress === 'string') {
    invoice.serviceAddress = changes.serviceAddress.trim() || null;
  }
  if (typeof changes.contractId === 'string' || changes.contractId === null) {
    invoice.contractId = changes.contractId;
  }

  if (typeof changes.issueDate === 'string') {
    invoice.issueDate = changes.issueDate;
  } else if (!invoice.issueDate) {
    invoice.issueDate = todayLocalDate();
  }

  invoice.dueDate = null;

  if (typeof changes.jobName === 'string') {
    invoice.jobName = changes.jobName.trim();
  }
  if (typeof changes.jobDescription === 'string') {
    invoice.jobDescription = changes.jobDescription.trim();
  }

  if (Array.isArray(changes.contractorHours)) {
    invoice.contractorHours = normalizeContractorHours(changes.contractorHours, invoice.contractorHours || []);
  }

  if (Array.isArray(changes.lineItems)) {
    invoice.lineItems = buildInvoiceLineItems(changes.lineItems, invoice.contractorHours || [], Array.isArray(changes.contractorHours));
    invoice.subtotalCents = changes.subtotalCents ?? calculateLineItemsTotal(invoice.lineItems);
    invoice.taxCents = 0;
    invoice.discountCents = 0;
    invoice.amountCents = changes.amountCents ?? Math.max(invoice.subtotalCents, 0);
  }

  if (typeof changes.amountCents === 'number') {
    invoice.amountCents = changes.amountCents;
  }

  if (typeof changes.subtotalCents === 'number') {
    invoice.subtotalCents = changes.subtotalCents;
  }

  if (typeof changes.taxCents === 'number') {
    invoice.taxCents = changes.taxCents;
  }

  if (typeof changes.discountCents === 'number') {
    invoice.discountCents = changes.discountCents;
  }

  if (typeof changes.currency === 'string') {
    invoice.currency = changes.currency;
  }

  invoice.updatedAt = nowIso();
  if (invoice.status === 'ongoing' && !finalizeOngoingJob) {
    return updateOngoingJob(invoiceId, invoice) || invoice;
  }
  if (finalizeOngoingJob) {
    invoice.invoiceNumber = getNextInvoiceNumber();
    invoice.isOngoing = false;
    invoice.status = 'sent';
    deleteOngoingJob(invoiceId);
    resolveInvoiceContractPricing(invoice, changes.amountCents);
    invoices.push(invoice);
    saveContractorInvoiceHours(invoice);
  } else if (invoice.status !== 'ongoing' && Array.isArray(changes.contractorHours)) {
    resolveInvoiceContractPricing(invoice, changes.amountCents);
    saveContractorInvoiceHours(invoice);
  } else if (invoice.status !== 'ongoing' && (typeof changes.serviceAddress === 'string' || typeof changes.contractId === 'string' || changes.contractId === null || Array.isArray(changes.lineItems))) {
    resolveInvoiceContractPricing(invoice, changes.amountCents);
  }
  if (invoice.status !== 'ongoing') {
    saveBusinessData({ clients: accounts, invoices });
  }
  return invoice;
}

export function markInvoicePaid(invoiceId, paymentIntentId) {
  const invoice = getInvoiceById(invoiceId);
  if (!invoice) {
    return null;
  }

  invoice.status = 'paid';
  if (paymentIntentId) {
    invoice.stripePaymentIntentId = paymentIntentId;
    invoice.stripePaymentStatus = 'succeeded';
    invoice.stripePaymentError = null;
    invoice.stripePaymentUpdatedAt = nowIso();
  }
  invoice.updatedAt = nowIso();
  saveBusinessData({ clients: accounts, invoices });
  return invoice;
}

export function updateInvoiceStripeState(invoiceId, changes) {
  const invoice = getInvoiceById(invoiceId);
  if (!invoice) return null;
  if (invoice.status === 'paid' && changes.stripePaymentStatus !== 'succeeded') return invoice;
  for (const field of ['stripeCheckoutSessionId', 'stripeCheckoutUrl', 'stripeCheckoutExpiresAt', 'stripePaymentStatus', 'stripePaymentError', 'stripePaymentIntentId', 'stripeLivemode']) {
    if (Object.hasOwn(changes, field)) invoice[field] = changes[field];
  }
  invoice.stripePaymentUpdatedAt = nowIso();
  saveBusinessData({ clients: accounts, invoices });
  return invoice;
}

export function getContracts() {
  return contracts;
}

export function getContractById(contractId) {
  return contracts.find((contract) => contract.id === contractId) ?? null;
}

export function getContractByStripeSubscriptionId(subscriptionId) {
  return contracts.find((contract) => contract.stripeSubscriptionId === subscriptionId) ?? null;
}

export function getNextContractNumber(contractType = 'maintenance') {
  const normalizedType = contractType === 'labor' ? 'labor' : 'maintenance';
  const startingNumber = Number.isFinite(config.contractNumberStart) ? config.contractNumberStart : 2001;
  const existingNumbers = contracts
    .filter((contract) => (contract.contractType || 'maintenance') === normalizedType)
    .map((contract) => Number(String(contract.contractNumber || '').replace(/\D+/g, '')))
    .filter((value) => Number.isFinite(value) && value > 0);
  const highestKnown = existingNumbers.length ? Math.max(...existingNumbers) : 0;
  const nextValue = highestKnown > 0 ? Math.max(highestKnown + 1, startingNumber) : startingNumber;
  const prefix = normalizedType === 'labor' ? 'LCON' : 'MCON';
  return `${prefix}-${nextValue}`;
}
function normalizeLaborEstimateContractors(entries = [], previousEntries = []) {
  const previousByContractor = new Map(previousEntries.map((entry) => [entry.contractorId, entry]));
  const combined = new Map();
  entries.forEach((entry) => {
    const contractor = getContractorById(entry.contractorId);
    if (!contractor) throw new Error('Choose a valid contractor for every estimated-hours row.');
    const previous = previousByContractor.get(contractor.id);
    const existing = combined.get(contractor.id);
    combined.set(contractor.id, {
      contractorId: contractor.id,
      contractorName: contractor.name,
      hourlyRateCents: previous?.hourlyRateCents ?? contractor.hourlyRateCents,
      hours: Number(existing?.hours || 0) + Number(entry.hours || 0),
    });
  });
  return Array.from(combined.values());
}

function applyLaborEstimate(
  contract,
  entries = [],
  previousEntries = [],
  otherItems = contract.laborEstimatedOtherItems || [],
  materialsItems = contract.laborEstimatedMaterialsItems || [],
) {
  if (contract.contractType !== 'labor' || contract.laborPricingModel !== 'hourly_estimate') {
    contract.laborEstimatedContractorHours = [];
    contract.laborEstimatedHours = null;
    contract.laborEstimatedAmountCents = null;
    contract.laborEstimatedMaterialsCents = null;
    contract.laborEstimatedMaterialsItems = [];
    contract.laborEstimatedOtherItems = [];
    contract.laborEstimatedOtherAmountCents = null;
    return;
  }

  contract.laborEstimatedContractorHours = normalizeLaborEstimateContractors(entries, previousEntries);
  const estimate = calculateContractorLaborEstimate(contract.laborEstimatedContractorHours);
  contract.laborEstimatedHours = estimate.estimatedHours;
  contract.laborEstimatedAmountCents = estimate.estimatedAmountCents;
  const estimatedMaterialsTotalCents = materialsItems.reduce(
    (sum, item) => sum + Math.max(0, Math.round(Number(item.amountCents || 0))),
    0,
  );
  contract.laborEstimatedMaterialsItems = materialsItems.length ? [{ amountCents: estimatedMaterialsTotalCents }] : [];
  contract.laborEstimatedMaterialsCents = contract.laborEstimatedMaterialsItems.reduce((sum, item) => sum + item.amountCents, 0);
  contract.laborEstimatedOtherItems = otherItems.map((item) => ({
    description: String(item.description || '').trim(),
    amountCents: Math.max(0, Math.round(Number(item.amountCents || 0))),
  })).filter((item) => item.description);
  contract.laborEstimatedOtherAmountCents = contract.laborEstimatedOtherItems.reduce((sum, item) => sum + item.amountCents, 0);
}

export function createContract(input) {
  const contractType = input.contractType || 'maintenance';
  const contract = {
    id: `contract_${randomUUID()}`,
    accountId: input.accountId ?? input.clientId,
    contractNumber: getNextContractNumber(contractType),
    contractType,
    title: input.title ?? null,
    scope: input.scope ?? null,
    serviceAddress: input.serviceAddress ?? null,
    status: input.status ?? 'draft',
    billingCycle: contractType === 'labor' ? null : input.billingCycle ?? 'monthly',
    startDate: input.startDate ?? null,
    packageType: contractType === 'maintenance' ? (input.packageType ?? null) : null,
    packageCoverageType: input.packageCoverageType ?? 'single_home',
    packageLevel: contractType === 'maintenance' && input.packageType !== 'custom' ? (input.packageLevel ?? null) : null,
    packageMonthlyCostCents: input.packageMonthlyCostCents ?? null,
    packageRetainerHours: input.packageRetainerHours ?? null,
    packageRolloverHours: input.packageRolloverHours ?? null,
    packageDiscountPercent: input.packageDiscountPercent ?? null,
    laborPricingModel: input.laborPricingModel ?? null,
    laborFixedAmountCents: input.laborFixedAmountCents ?? null,
    laborEstimatedHours: null,
    laborEstimatedAmountCents: null,
    laborEstimatedMaterialsCents: 0,
    laborEstimatedMaterialsItems: input.laborEstimatedMaterialsItems
      ?? (Number(input.laborEstimatedMaterialsCents) > 0 ? [{ amountCents: input.laborEstimatedMaterialsCents }] : []),
    laborEstimatedOtherItems: input.laborEstimatedOtherItems || [],
    laborEstimatedOtherAmountCents: 0,
    laborEstimatedContractorHours: [],
    packagePriorityScheduling: Boolean(input.packagePriorityScheduling),
    packageAnnualInspection: Boolean(input.packageAnnualInspection),
    packageQuarterlyInspection: Boolean(input.packageQuarterlyInspection),
    packageOnCallService: Boolean(input.packageOnCallService),
    packageTenantCoordination: Boolean(input.packageTenantCoordination),
    signedAttachments: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  applyLaborEstimate(contract, input.laborEstimatedContractorHours || []);

  contracts.push(contract);
  saveBusinessData({ clients: accounts, invoices, contracts });
  return contract;
}

export function updateContract(contractId, changes) {
  const contract = getContractById(contractId);
  if (!contract) {
    return null;
  }

  if (typeof changes.status === 'string') {
    contract.status = changes.status;
  }

  if (typeof changes.billingCycle === 'string') {
    contract.billingCycle = changes.billingCycle;
  }

  if (typeof changes.startDate === 'string') {
    contract.startDate = changes.startDate;
  }
  ['title', 'scope', 'serviceAddress', 'contractType', 'laborPricingModel'].forEach((field) => {
    if (typeof changes[field] === 'string' || changes[field] === null) {
      contract[field] = changes[field];
    }
  });
  if (typeof changes.stripeSubscriptionId === 'string' || changes.stripeSubscriptionId === null) {
    contract.stripeSubscriptionId = changes.stripeSubscriptionId;
  }
  if (typeof changes.stripeCheckoutSessionId === 'string' || changes.stripeCheckoutSessionId === null) {
    contract.stripeCheckoutSessionId = changes.stripeCheckoutSessionId;
  }
  if (typeof changes.autopayEnabled === 'boolean') {
    contract.autopayEnabled = changes.autopayEnabled;
  }
  if (typeof changes.stripeSubscriptionStatus === 'string' || changes.stripeSubscriptionStatus === null) {
    contract.stripeSubscriptionStatus = changes.stripeSubscriptionStatus;
  }
  if (typeof changes.lastPaymentAt === 'string' || changes.lastPaymentAt === null) {
    contract.lastPaymentAt = changes.lastPaymentAt;
  }
  if (typeof changes.lastPaymentAmountCents === 'number' || changes.lastPaymentAmountCents === null) {
    contract.lastPaymentAmountCents = changes.lastPaymentAmountCents;
  }
  ['lastPaymentSource', 'manualPaymentPreviousLastPaymentAt', 'manualPaymentPreviousLastPaymentSource', 'manualPaymentPreviousNextPaymentDueAt'].forEach((field) => {
    if (typeof changes[field] === 'string' || changes[field] === null) contract[field] = changes[field];
  });
  ['manualPaymentPreviousLastPaymentAmountCents'].forEach((field) => {
    if (typeof changes[field] === 'number' || changes[field] === null) contract[field] = changes[field];
  });
  if (typeof changes.nextPaymentDueAt === 'string' || changes.nextPaymentDueAt === null) {
    contract.nextPaymentDueAt = changes.nextPaymentDueAt;
  }
  if (Array.isArray(changes.signedAttachments)) {
    contract.signedAttachments = changes.signedAttachments;
  }
  if (typeof changes.packageType === 'string' || changes.packageType === null) {
    contract.packageType = changes.packageType;
  }
  if (typeof changes.packageCoverageType === 'string') {
    contract.packageCoverageType = changes.packageCoverageType;
  }
  if (typeof changes.packageLevel === 'string' || changes.packageLevel === null) {
    contract.packageLevel = changes.packageLevel;
  }
  ['packageMonthlyCostCents', 'packageRetainerHours', 'packageRolloverHours', 'packageDiscountPercent', 'laborFixedAmountCents', 'laborEstimatedMaterialsCents'].forEach((field) => {
    if (typeof changes[field] === 'number' || changes[field] === null) {
      contract[field] = changes[field];
    }
  });
  ['packagePriorityScheduling', 'packageAnnualInspection', 'packageQuarterlyInspection', 'packageOnCallService', 'packageTenantCoordination'].forEach((field) => {
    if (typeof changes[field] === 'boolean') {
      contract[field] = changes[field];
    }
  });

  if (contract.contractType === 'labor') {
    contract.billingCycle = null;
  }
  applyLaborEstimate(
    contract,
    changes.laborEstimatedContractorHours ?? contract.laborEstimatedContractorHours ?? [],
    contract.laborEstimatedContractorHours || [],
    changes.laborEstimatedOtherItems ?? contract.laborEstimatedOtherItems ?? [],
    changes.laborEstimatedMaterialsItems
      ?? (typeof changes.laborEstimatedMaterialsCents === 'number'
        ? [{ amountCents: changes.laborEstimatedMaterialsCents }]
        : contract.laborEstimatedMaterialsItems ?? []),
  );

  contract.updatedAt = nowIso();
  saveBusinessData({ clients: accounts, invoices, contracts });
  return contract;
}

export function deleteContract(contractId) {
  const contractIndex = contracts.findIndex((entry) => entry.id === contractId);
  if (contractIndex < 0) {
    return { error: 'CONTRACT_NOT_FOUND' };
  }

  const contract = contracts[contractIndex];
  const subscriptionStatus = String(contract.stripeSubscriptionStatus || '').toLowerCase();
  const subscriptionIsUnsettled = Boolean(contract.stripeSubscriptionId)
    && !['canceled', 'incomplete_expired'].includes(subscriptionStatus);
  if (contract.autopayEnabled || subscriptionIsUnsettled) {
    return { error: 'CONTRACT_AUTOPAY_ACTIVE' };
  }

  contracts.splice(contractIndex, 1);
  saveBusinessData({ clients: accounts, invoices, contracts });
  return { contract };
}

export function getAdminUserByEmail(email) {
  return adminUsers.find((user) => normalize(user.email) === normalize(email)) ?? null;
}

export function issueAdminSession(adminUser) {
  const token = randomUUID();
  const expiresAt = Date.now() + config.adminSessionTtlHours * 60 * 60 * 1000;

  adminSessions.set(token, {
    adminId: adminUser.id,
    email: adminUser.email,
    expiresAt,
  });

  return { token, expiresAt };
}

export function verifyAdminSession(token) {
  const session = adminSessions.get(token);
  if (!session) {
    return null;
  }

  if (session.expiresAt <= Date.now()) {
    adminSessions.delete(token);
    return null;
  }

  return session;
}

export function revokeAdminSession(token) {
  return adminSessions.delete(token);
}

export function getAudits() {
  return audits;
}

export function recordAudit(entry) {
  const audit = {
    id: `audit_${randomUUID()}`,
    createdAt: nowIso(),
    ...entry,
  };

  audits.unshift(audit);
  return audit;
}

export function getDashboardSummary() {
  const activeClients = accounts.filter((account) => account.status === 'active').length;
  const invoiceRecords = getInvoices();
  const sentInvoices = invoices.filter((invoice) => invoice.status === 'sent').length;
  const openInvoices = invoices.filter((invoice) => ['sent', 'overdue'].includes(invoice.status)).length;
  const activeContracts = contracts.filter((contract) => contract.status === 'active').length;

  return {
    clients: accounts.length,
    activeClients,
    invoices: invoiceRecords.filter((invoice) => invoice.status !== 'ongoing').length,
    openInvoices,
    sentInvoices,
    contracts: contracts.length,
    activeContracts,
    recentAudits: audits.slice(0, 10),
  };
}

function normalizeInvoiceLineItems(lineItems) {
  return (Array.isArray(lineItems) ? lineItems : []).map((lineItem) => ({
    type: lineItem.type === 'material' || lineItem.type === 'package' ? lineItem.type : 'labor',
    description: String(lineItem.description ?? '').trim(),
    quantity: Number.isFinite(Number(lineItem.quantity)) ? Math.max(0.25, Math.round(Number(lineItem.quantity) * 4) / 4) : 1,
    unitPriceCents: Number.isFinite(Number(lineItem.unitPriceCents)) ? Math.max(0, Math.round(Number(lineItem.unitPriceCents))) : 0,
    taxable: Boolean(lineItem.taxable),
  })).filter((lineItem) => lineItem.description.length > 0);
}

function normalizeContractorHours(entries, previousEntries = []) {
  const normalized = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const contractor = getContractorById(String(entry.contractorId || ''));
    const previous = previousEntries.find((item) => item.contractorId === entry.contractorId);
    const hours = Number(entry.hours);
    if (!contractor || (contractor.status !== 'active' && !previous) || !Number.isFinite(hours) || hours <= 0) {
      continue;
    }

    const existing = normalized.get(contractor.id);
    normalized.set(contractor.id, {
      contractorId: contractor.id,
      contractorName: contractor.name,
      hours: (existing?.hours || 0) + Math.round(hours * 4) / 4,
      hourlyRateCents: previous?.hourlyRateCents ?? contractor.hourlyRateCents,
    });
  }

  return Array.from(normalized.values());
}

function buildInvoiceLineItems(lineItems, contractorHours, contractorHoursProvided) {
  const normalizedItems = normalizeInvoiceLineItems(lineItems);
  if (!contractorHoursProvided) {
    return normalizedItems;
  }

  const nonLaborItems = normalizedItems.filter((item) => item.type !== 'labor');
  const laborItems = [];
  for (const { hours: quantity, hourlyRateCents: unitPriceCents } of buildContractorHourTiers(contractorHours)) {
    if (quantity > 0 && unitPriceCents > 0) {
      laborItems.push({
        type: 'labor',
        description: 'Labor',
        quantity,
        unitPriceCents,
        taxable: false,
      });
    }
  }

  return [...laborItems, ...nonLaborItems];
}

function calculateLineItemsTotal(lineItems) {
  return (Array.isArray(lineItems) ? lineItems : []).reduce((sum, item) => {
    const quantity = Number.isFinite(Number(item.quantity)) ? Math.max(0.25, Number(item.quantity)) : 1;
    const unitPriceCents = Number.isFinite(Number(item.unitPriceCents)) ? Math.max(0, Math.round(Number(item.unitPriceCents))) : 0;
    return sum + Math.round(quantity * unitPriceCents);
  }, 0);
}

function normalize(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeLookupAddress(value) {
  const suffixes = [
    [/(?:street|st)/g, 'st'],
    [/(?:avenue|ave)/g, 'ave'],
    [/(?:road|rd)/g, 'rd'],
    [/(?:drive|dr)/g, 'dr'],
    [/(?:boulevard|blvd)/g, 'blvd'],
    [/(?:lane|ln)/g, 'ln'],
    [/(?:court|ct)/g, 'ct'],
    [/(?:circle|cir)/g, 'cir'],
    [/(?:place|pl)/g, 'pl'],
    [/(?:terrace|ter)/g, 'ter'],
    [/(?:parkway|pkwy)/g, 'pkwy'],
    [/(?:highway|hwy)/g, 'hwy'],
  ];
  let normalized = String(value ?? '').trim().toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ');
  for (const [pattern, replacement] of suffixes) {
    normalized = normalized.replace(new RegExp(`\\b${pattern.source}\\b`, 'g'), replacement);
  }
  return normalized.replace(/\s+/g, ' ').trim();
}

function buildLookupHash(name, address) {
  return createHash('sha256')
    .update(`${normalize(name)}|${normalize(address)}`)
    .digest('hex');
}

function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, passwordHash) {
  const [salt, storedHash] = String(passwordHash ?? '').split(':');
  if (!salt || !storedHash) {
    return false;
  }

  const incomingHash = scryptSync(password, salt, 64);
  const existingHash = Buffer.from(storedHash, 'hex');

  if (incomingHash.length !== existingHash.length) {
    return false;
  }

  return timingSafeEqual(incomingHash, existingHash);
}

function sanitizeClientUser(clientUser) {
  return {
    id: clientUser.id,
    accountId: clientUser.accountId,
    email: clientUser.email,
    notificationsEnabled: clientUser.notificationsEnabled,
    autopayEnabled: clientUser.autopayEnabled,
    emailVerifiedAt: clientUser.emailVerifiedAt,
    createdAt: clientUser.createdAt,
    updatedAt: clientUser.updatedAt,
  };
}
