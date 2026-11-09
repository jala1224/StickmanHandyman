import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const backendRoot = fileURLToPath(new URL('../', import.meta.url));
const projectRoot = path.dirname(backendRoot.replace(/[\\/]$/, ''));
const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'stickman-billing-test-'));
const isolatedBackend = path.join(temporaryRoot, 'backend');
mkdirSync(isolatedBackend);
cpSync(path.join(backendRoot, 'src'), path.join(isolatedBackend, 'src'), { recursive: true });
cpSync(path.join(backendRoot, 'package.json'), path.join(isolatedBackend, 'package.json'));
cpSync(path.join(backendRoot, 'node_modules'), path.join(isolatedBackend, 'node_modules'), { recursive: true });
cpSync(path.join(projectRoot, 'invoice_template'), path.join(temporaryRoot, 'invoice_template'), { recursive: true });
cpSync(path.join(projectRoot, 'fonts'), path.join(temporaryRoot, 'fonts'), { recursive: true });
after(() => rmSync(temporaryRoot, { recursive: true, force: true }));

mkdirSync(path.join(isolatedBackend, 'data'));
writeFileSync(path.join(isolatedBackend, 'data/contractors.json'), JSON.stringify({ contractors: [], timeEntries: [], ongoingJobs: [], invoiceHours: [], paymentTransactions: [] }));
const originalDirectory = process.cwd();
process.chdir(isolatedBackend);
const repository = await import(pathToFileURL(path.join(isolatedBackend, 'src/services/contractorRepository.js')));
const store = await import(pathToFileURL(path.join(isolatedBackend, 'src/services/store.js')));
const pdf = await import(pathToFileURL(path.join(isolatedBackend, 'src/services/invoicePdf.js')));
const contractPdf = await import(pathToFileURL(path.join(isolatedBackend, 'src/services/contractPdf.js')));
const maintenanceBilling = await import(pathToFileURL(path.join(isolatedBackend, 'src/services/maintenanceContractBilling.js')));
const contractPricing = await import(pathToFileURL(path.join(isolatedBackend, 'src/services/contractPricing.js')));
const contractInvoiceBilling = await import(pathToFileURL(path.join(isolatedBackend, 'src/services/contractInvoiceBilling.js')));
const stripeCheckout = await import(pathToFileURL(path.join(isolatedBackend, 'src/services/stripeCheckout.js')));
process.chdir(originalDirectory);
repository.updateContractor('contractor_owner', { hourlyRateCents: 8000 });
const firstContractor = repository.createContractor({ name: 'Test Contractor A', hourlyRateCents: 5000 });
const secondContractor = repository.createContractor({ name: 'Test Contractor B', hourlyRateCents: 5000 });
const owner = { contractorId: 'contractor_owner', hours: 1, hourlyRateCents: 8000 };
const first = { contractorId: firstContractor.id, hours: 1, hourlyRateCents: 5000 };
const second = { contractorId: secondContractor.id, hours: 1, hourlyRateCents: 5000 };

function frontendContext(extra = {}) {
  const html = readFileSync(path.join(projectRoot, 'portal-admin.html'), 'utf8');
  const linkedScripts = Array.from(html.matchAll(/<script\b[^>]*src=["']([^"']+)["'][^>]*>/g))
    .map(match => match[1].split('?')[0])
    .filter(source => !/^https?:/.test(source))
    .map(source => readFileSync(path.join(projectRoot, source), 'utf8'));
  const source = [html, ...linkedScripts].join('\n').replace(/\r\n/g, '\n');
  const context = vm.createContext({
    allContractors: repository.getContractors(),
    adminInvoices: [],
    ...extra,
  });
  for (const name of ['getContractorInvoiceRateCents', 'buildContractorLaborItems', 'getContractorPaymentReportDate', 'summarizeContractorPayments', 'summarizeOwnerHours', 'invoicePdfDownloadName']) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `Missing frontend function ${name}`);
    const end = source.indexOf('\n    }', start) + 6;
    vm.runInContext(source.slice(start, end), context);
  }
  return context;
}

test('fresh contractor storage supports the first invoice without pre-seeded payment transactions', async () => {
  const freshRoot = path.join(temporaryRoot, 'fresh-contractor');
  const serviceDirectory = path.join(freshRoot, 'src/services');
  const dataDirectory = path.join(freshRoot, 'data');
  mkdirSync(serviceDirectory, { recursive: true });
  const modulePath = path.join(serviceDirectory, 'contractorRepository.mjs');
  cpSync(path.join(isolatedBackend, 'src/services/contractorRepository.js'), modulePath);
  const previousDirectory = process.env.STICKMAN_DATA_DIR;
  let freshRepository;
  try {
    process.env.STICKMAN_DATA_DIR = dataDirectory;
    freshRepository = await import(pathToFileURL(modulePath));
  } finally {
    if (previousDirectory === undefined) delete process.env.STICKMAN_DATA_DIR;
    else process.env.STICKMAN_DATA_DIR = previousDirectory;
  }
  assert.deepEqual(freshRepository.getContractorPaymentTransactions(), []);
  const contractor = freshRepository.createContractor({ name: 'Fresh Contractor', hourlyRateCents: 5000 });
  freshRepository.saveContractorInvoiceHours({
    id: 'fresh-invoice', invoiceNumber: 'INV-FRESH', status: 'sent', issueDate: '2026-01-01',
    contractorHours: [{ contractorId: contractor.id, hours: 1, hourlyRateCents: 5000 }],
  });
  assert.equal(freshRepository.getContractorPaymentTransactions().length, 1);
  const saved = JSON.parse(readFileSync(path.join(dataDirectory, 'contractors.json'), 'utf8'));
  assert.equal(saved.paymentTransactions[0].amountCents, 5000);
});

test('Stripe checkout supports embedded and hosted sessions with trusted return origins', () => {
  const options = { origin: 'https://www.stickman-handyman.com', returnPath: 'portal-found.html', successQuery: 'session_id={CHECKOUT_SESSION_ID}', cancelQuery: 'cancelled=true' };
  const embedded = stripeCheckout.getCheckoutPresentation({ ...options, uiMode: 'embedded' });
  assert.equal(embedded.ui_mode, 'embedded_page');
  assert.equal(embedded.redirect_on_completion, 'if_required');
  assert.equal(embedded.success_url, undefined);
  assert.equal(embedded.cancel_url, undefined);
  assert.ok(embedded.return_url.includes('{CHECKOUT_SESSION_ID}'));
  const hosted = stripeCheckout.getCheckoutPresentation({ ...options, uiMode: 'hosted' });
  assert.ok(hosted.success_url);
  assert.ok(hosted.cancel_url);
  assert.equal(hosted.return_url, undefined);
  assert.equal(stripeCheckout.getCheckoutOrigin('https://untrusted.example', ['*']), options.origin);
  assert.equal(stripeCheckout.getCheckoutOrigin('http://127.0.0.1:8080', ['http://127.0.0.1:8080']), 'http://127.0.0.1:8080');
  assert.deepEqual(stripeCheckout.getCheckoutResponse({ client_secret: 'test-secret', url: null }, 'pk_test_example'), {
    checkoutUrl: null, clientSecret: 'test-secret', publishableKey: 'pk_test_example',
  });
});

test('Stripe invoice payments validate money and track asynchronous results without undoing paid invoices', () => {
  const invoice = store.createInvoice({ accountId: 'client_1', amountCents: 5000, lineItems: [{ type: 'labor', description: 'Payment test', quantity: 1, unitPriceCents: 5000 }] });
  assert.equal(stripeCheckout.matchesInvoicePayment(invoice, { amountCents: 5000, currency: 'usd' }), true);
  assert.equal(stripeCheckout.matchesInvoicePayment(invoice, { amountCents: 4999, currency: 'usd' }), false);
  assert.equal(stripeCheckout.matchesInvoicePayment(invoice, { amountCents: 5000, currency: 'eur' }), false);
  const processing = stripeCheckout.getInvoicePaymentEvent({ type: 'checkout.session.completed', data: { object: {
    id: 'cs_test', mode: 'payment', metadata: { invoiceId: invoice.id }, amount_total: 5000, currency: 'usd', payment_status: 'unpaid',
  } } });
  assert.equal(processing.status, 'processing');
  assert.equal(stripeCheckout.getInvoicePaymentEvent({ type: 'checkout.session.completed', data: { object: { metadata: { contractId: 'contract' } } } }), null);
  const completed = stripeCheckout.getInvoicePaymentEvent({ type: 'payment_intent.succeeded', data: { object: {
    id: 'pi_test', amount: 6000, amount_received: 5000, currency: 'usd', metadata: { invoiceId: invoice.id },
  } } });
  assert.equal(completed.amountCents, 5000);
  store.markInvoicePaid(invoice.id, completed.paymentIntentId);
  store.updateInvoiceStripeState(invoice.id, { stripePaymentStatus: 'failed', stripePaymentError: 'Older attempt' });
  assert.equal(invoice.stripePaymentStatus, 'succeeded');
  assert.equal(invoice.stripePaymentError, null);
});

test('Stripe invoice checkout reuses sessions and prevents concurrent duplicate sessions', async () => {
  const invoice = { id: 'session-invoice', invoiceNumber: 'INV-TEST', amountCents: 5000, currency: 'usd', status: 'sent', updatedAt: 'test' };
  let created = 0;
  const sessions = new Map();
  const stripe = { checkout: { sessions: {
    create: async params => {
      const session = { id: `cs_${++created}`, status: 'open', ui_mode: params.ui_mode || 'hosted', amount_total: 5000, currency: 'usd', expires_at: 2000000000, url: 'https://checkout.stripe.com/test' };
      sessions.set(session.id, session);
      return session;
    },
    retrieve: async id => sessions.get(id),
    expire: async id => { sessions.get(id).status = 'expired'; },
  } } };
  const options = { uiMode: 'hosted', origin: 'https://www.stickman-handyman.com', returnPath: 'portal-found.html' };
  const save = (invoiceId, changes) => Object.assign(invoice, changes);
  const results = await Promise.all([
    stripeCheckout.createInvoiceCheckoutSession(stripe, invoice, options, save),
    stripeCheckout.createInvoiceCheckoutSession(stripe, invoice, options, save),
  ]);
  assert.equal(created, 1);
  assert.equal(results[0].id, results[1].id);
  sessions.get(invoice.stripeCheckoutSessionId).status = 'expired';
  await stripeCheckout.createInvoiceCheckoutSession(stripe, invoice, options, save);
  assert.equal(created, 2);
  sessions.get(invoice.stripeCheckoutSessionId).status = 'complete';
  await assert.rejects(() => stripeCheckout.createInvoiceCheckoutSession(stripe, invoice, options, save), /already submitted/);
});

test('Stripe contract checkout reuses enrollment sessions and blocks duplicate subscriptions', async () => {
  const contract = { id: 'contract-session', updatedAt: 'test', autopayEnabled: false };
  let created = 0;
  let session;
  const stripe = { checkout: { sessions: {
    create: async parameters => { created += 1; session = { id: 'cs_contract', status: 'open', mode: parameters.mode, ui_mode: parameters.ui_mode, metadata: parameters.metadata, amount_total: 70000 }; return session; },
    retrieve: async () => session,
  } } };
  const parameters = { mode: 'subscription', ui_mode: 'embedded_page', metadata: { billingPeriod: '0' }, line_items: [{ price_data: { unit_amount: 70000 } }] };
  const save = (contractId, changes) => Object.assign(contract, changes);
  await Promise.all([
    stripeCheckout.createContractCheckoutSession(stripe, contract, parameters, save),
    stripeCheckout.createContractCheckoutSession(stripe, contract, parameters, save),
  ]);
  assert.equal(created, 1);
  session.status = 'complete';
  session.payment_status = 'paid';
  await assert.rejects(() => stripeCheckout.createContractCheckoutSession(stripe, contract, parameters, save), /already submitted/);
  contract.stripeSubscriptionStatus = 'canceled';
  await stripeCheckout.createContractCheckoutSession(stripe, contract, { ...parameters, metadata: { billingPeriod: '1' } }, save);
  assert.equal(created, 2);
});

test('Stripe checkout can retry failed payments but not completed paid sessions', async () => {
  const stripe = { paymentIntents: { retrieve: async () => ({ status: 'requires_payment_method' }) } };
  assert.equal(await stripeCheckout.canReplaceCheckoutSession(stripe, { status: 'complete', payment_status: 'unpaid', payment_intent: 'pi_failed' }), true);
  assert.equal(await stripeCheckout.canReplaceCheckoutSession(stripe, { status: 'complete', payment_status: 'paid', payment_intent: 'pi_paid' }), false);
});

test('Stripe invoice routes retain client checkout and omit admin payment action routes', async () => {
  const { invoicesRouter } = await import(pathToFileURL(path.join(isolatedBackend, 'src/routes/invoices.js')));
  const paths = invoicesRouter.stack.filter(layer => layer.route).map(layer => layer.route.path);
  assert.ok(paths.includes('/:invoiceId/checkout-session'));
  assert.ok(paths.includes('/:invoiceId/checkout-session'));
  assert.equal(paths.includes('/:invoiceId/stripe-status'), false);
  assert.equal(paths.includes('/:invoiceId/payment-link'), false);
  assert.equal(paths.includes('/:invoiceId/reconcile-payment'), false);
  const html = readFileSync(path.join(projectRoot, 'portal-admin.html'), 'utf8');
  assert.equal(html.includes('invoice-payment-create'), false);
  assert.equal(html.includes('invoice-payment-verify'), false);
  assert.equal(html.includes('Tap to Pay'), false);
  assert.equal(html.includes('modal-invoice-payments'), false);
  const invoiceScript = readFileSync(path.join(projectRoot, 'js/admin/invoices.js'), 'utf8');
  const adminScript = readFileSync(path.join(projectRoot, 'js/portal-admin.js'), 'utf8');
  assert.equal(invoiceScript.includes('data-invoice-payments'), false);
  assert.equal(adminScript.includes('data-invoice-payments'), false);
  assert.equal(invoiceScript.includes('stripePaymentLabel'), false);
});

test('only expired pending sandbox test checkouts can be deleted without Stripe', async () => {
  const { default: express } = await import(pathToFileURL(path.join(isolatedBackend, 'node_modules/express/index.js')));
  const { invoicesRouter } = await import(pathToFileURL(path.join(isolatedBackend, 'src/routes/invoices.js')));
  const { config } = await import(pathToFileURL(path.join(isolatedBackend, 'src/config.js')));
  const previous = { key: config.stripeSecretKey, localSandbox: config.localSandbox };
  const session = store.issueAdminSession(store.getAdminUserByEmail(config.adminBootstrapEmail));
  const app = express();
  app.use(express.json());
  app.use('/invoices', invoicesRouter);
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const createdIds = [];
  try {
    config.stripeSecretKey = '';
    config.localSandbox = true;
    const makeInvoice = (changes = {}) => {
      const invoice = store.createInvoice({ accountId: 'client_1', serviceAddress: 'Stripe Guard Test Address', lineItems: [{ type: 'labor', quantity: 1, unitPriceCents: 5000 }] });
      createdIds.push(invoice.id);
      store.updateInvoiceStripeState(invoice.id, {
        stripeCheckoutSessionId: 'cs_test_fixture', stripeLivemode: false, stripePaymentStatus: 'pending',
        stripeCheckoutExpiresAt: new Date(Date.now() - 60000).toISOString(), stripePaymentIntentId: null,
        ...changes,
      });
      return invoice;
    };
    const remove = (invoice, token = session.token) => fetch(`http://127.0.0.1:${server.address().port}/invoices/${invoice.id}`, {
      method: 'DELETE', headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const safeInvoice = makeInvoice();
    assert.equal((await remove(safeInvoice, '')).status, 401);
    assert.equal((await remove(safeInvoice)).status, 200);
    assert.equal(store.getInvoiceById(safeInvoice.id), null);

    const editableInvoice = makeInvoice();
    const edit = await fetch(`http://127.0.0.1:${server.address().port}/invoices/${editableInvoice.id}`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobName: 'Updated sandbox invoice' }),
    });
    assert.equal(edit.status, 200);
    assert.equal(store.getInvoiceById(editableInvoice.id).stripeCheckoutSessionId, null);

    for (const changes of [
      { stripeLivemode: true, stripeCheckoutSessionId: 'cs_live_fixture' },
      { stripeLivemode: null },
      { stripeCheckoutSessionId: 'cs_unknown_fixture' },
      { stripeCheckoutExpiresAt: new Date(Date.now() + 60000).toISOString() },
      { stripeCheckoutExpiresAt: null },
      { stripePaymentStatus: 'processing' },
      { stripePaymentStatus: 'succeeded' },
      { stripePaymentIntentId: 'pi_test_fixture' },
    ]) {
      const protectedInvoice = makeInvoice(changes);
      assert.equal((await remove(protectedInvoice)).status, 503);
      assert.ok(store.getInvoiceById(protectedInvoice.id));
    }
    config.localSandbox = false;
    const productionInvoice = makeInvoice();
    assert.equal((await remove(productionInvoice)).status, 503);
    assert.ok(store.getInvoiceById(productionInvoice.id));
  } finally {
    config.stripeSecretKey = previous.key;
    config.localSandbox = previous.localSandbox;
    await new Promise(resolve => server.close(resolve));
    for (const invoiceId of createdIds) store.deleteInvoice(invoiceId);
  }
});

test('Stripe lookup autopay works without a login and preserves account and subscription safeguards', async (context) => {
  const { default: express } = await import(pathToFileURL(path.join(isolatedBackend, 'node_modules/express/index.js')));
  const { SessionResource } = await import(pathToFileURL(path.join(isolatedBackend, 'node_modules/stripe/esm/resources/Checkout/Sessions.js')));
  const { config } = await import(pathToFileURL(path.join(isolatedBackend, 'src/config.js')));
  const { contractsRouter } = await import(pathToFileURL(path.join(isolatedBackend, 'src/routes/contracts.js')));
  const previous = { key: config.stripeSecretKey, publishable: config.stripePublishableKey };
  config.stripeSecretKey = 'sk_test_local_fixture';
  config.stripePublishableKey = 'pk_test_local_fixture';
  const account = store.createClient({ name: 'Lookup Autopay Test', address: '1 Local St' });
  store.updateClient(account.id, { stripeCustomerId: 'cus_lookup_fixture' });
  const lookup = store.issueLookupSession(account.id);
  const foreignLookup = store.issueLookupSession('client_1');
  const captured = [];
  const sessions = new Map();
  context.mock.method(SessionResource.prototype, 'create', async parameters => {
    captured.push(parameters);
    const session = {
      id: `cs_lookup_${captured.length}`, status: 'open', mode: parameters.mode,
      ui_mode: parameters.ui_mode, metadata: parameters.metadata,
      amount_total: parameters.line_items[0].price_data.unit_amount, client_secret: 'lookup_test_secret',
    };
    sessions.set(session.id, session);
    return session;
  });
  context.mock.method(SessionResource.prototype, 'retrieve', async sessionId => sessions.get(sessionId));
  context.mock.method(SessionResource.prototype, 'expire', async sessionId => { sessions.get(sessionId).status = 'expired'; });
  const app = express();
  app.use(express.json());
  app.use('/contracts', contractsRouter);
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  try {
    const send = (contract, body) => fetch(`http://127.0.0.1:${server.address().port}/contracts/${contract.id}/checkout-session/lookup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    let contract;
    for (const [billingCycle, interval, intervalCount] of [['monthly', 'month', 1], ['quarterly', 'month', 3], ['annually', 'year', 1]]) {
      contract = store.createContract({ clientId: account.id, contractType: 'maintenance', status: 'active', packageType: 'portfolio', packageLevel: 'premium', billingCycle, startDate: '2026-01-01', serviceAddress: account.address });
      const response = await send(contract, { lookupAccessToken: lookup.token, autopay: true, uiMode: 'embedded' });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).clientSecret, 'lookup_test_secret');
      const parameters = captured.at(-1);
      assert.equal(parameters.mode, 'subscription');
      assert.deepEqual(parameters.line_items[0].price_data.recurring, { interval, interval_count: intervalCount });
      assert.equal(parameters.metadata.autopay, 'true');
      assert.equal(parameters.subscription_data.metadata.contractId, contract.id);
      assert.equal(parameters.payment_intent_data, undefined);
      assert.equal(Boolean(contract.autopayEnabled), false);
    }
    assert.equal((await send(contract, { lookupAccessToken: '00000000-0000-4000-8000-000000000000', autopay: true })).status, 401);
    assert.equal((await send(contract, { lookupAccessToken: foreignLookup.token, autopay: true })).status, 403);
    assert.equal((await send(contract, { autopay: true })).status, 400);
    store.updateContract(contract.id, { autopayEnabled: true });
    assert.equal((await send(contract, { lookupAccessToken: lookup.token, autopay: true })).status, 409);
    store.updateContract(contract.id, { autopayEnabled: false });
    const oneTime = await send(contract, { lookupAccessToken: lookup.token, uiMode: 'embedded' });
    assert.equal(oneTime.status, 200);
    assert.equal(captured.at(-1).mode, 'payment');
    assert.equal(captured.at(-1).line_items[0].price_data.recurring, undefined);
    store.updateContract(contract.id, { status: 'cancelled' });
    assert.equal((await send(contract, { lookupAccessToken: lookup.token, autopay: true })).status, 409);
    assert.equal(captured.length, 4);
  } finally {
    await new Promise(resolve => server.close(resolve));
    config.stripeSecretKey = previous.key;
    config.stripePublishableKey = previous.publishable;
  }
});

test('manual contract payment marks one maintenance cycle paid and advances overdue due dates', () => {
  const now = new Date('2026-11-08T12:00:00.000Z');
  const contract = {
    contractType: 'maintenance', packageType: 'portfolio', packageLevel: 'premium',
    billingCycle: 'monthly', startDate: '2026-08-08',
  };
  const payment = contractPricing.getManualContractPaymentChanges(contract, now);
  assert.equal(payment.changes.lastPaymentAt, now.toISOString());
  assert.equal(payment.changes.lastPaymentAmountCents, 70000);
  assert.equal(payment.changes.nextPaymentDueAt, '2026-12-08T12:00:00.000Z');
  const paidContract = { ...contract, ...payment.changes };
  assert.equal(contractPricing.getContractPaymentSummary(paidContract, now).paymentStatus, 'Paid');
  assert.equal(contractPricing.getManualContractPaymentChanges(paidContract, now).error, 'This billing cycle is already marked paid.');
  const futureDue = { ...contract, nextPaymentDueAt: '2026-12-01T00:00:00.000Z' };
  assert.equal(contractPricing.getManualContractPaymentChanges(futureDue, now).changes.nextPaymentDueAt, '2026-12-01');
  assert.equal(contractPricing.getManualContractPaymentChanges({ ...contract, contractType: 'labor' }, now).error, 'Manual cycle payments are only available for maintenance contracts.');
});

test('admin manual contract payment records amount and audit, while preventing duplicates and autopay conflicts', async () => {
  const { default: express } = await import(pathToFileURL(path.join(isolatedBackend, 'node_modules/express/index.js')));
  const { config } = await import(pathToFileURL(path.join(isolatedBackend, 'src/config.js')));
  const { contractsRouter } = await import(pathToFileURL(path.join(isolatedBackend, 'src/routes/contracts.js')));
  const admin = store.getAdminUserByEmail(config.adminBootstrapEmail);
  const session = store.issueAdminSession(admin);
  const contract = store.createContract({
    clientId: 'client_1', contractType: 'maintenance', status: 'active', packageType: 'portfolio', packageLevel: 'premium',
    billingCycle: 'monthly', startDate: '2026-08-08', serviceAddress: '123 Main St',
  });
  const previousPaymentAt = new Date(Date.now() - 70 * 24 * 60 * 60 * 1000).toISOString();
  const previousDueAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  store.updateContract(contract.id, { lastPaymentAt: previousPaymentAt, lastPaymentAmountCents: 70000, lastPaymentSource: 'stripe', nextPaymentDueAt: previousDueAt });
  const autopay = store.createContract({
    clientId: 'client_1', contractType: 'maintenance', status: 'active', packageType: 'single_home', packageLevel: 'basic',
    billingCycle: 'monthly', startDate: '2026-08-08', serviceAddress: '123 Main St',
  });
  store.updateContract(autopay.id, { autopayEnabled: true, stripeSubscriptionId: 'sub_manual_conflict', stripeSubscriptionStatus: 'active' });
  const app = express();
  app.use('/contracts', contractsRouter);
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  try {
    const request = (contractId, token = session.token) => fetch(`http://127.0.0.1:${server.address().port}/contracts/${contractId}/record-payment`, {
      method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    assert.equal((await request(contract.id, '')).status, 401);
    const response = await request(contract.id);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.contract.paymentStatus, 'Paid');
    assert.equal(payload.contract.lastPaymentAmountCents, 70000);
    assert.equal(payload.contract.lastPaymentSource, 'manual');
    assert.equal((await request(contract.id)).status, 409);
    const undo = await fetch(`http://127.0.0.1:${server.address().port}/contracts/${contract.id}/undo-manual-payment`, {
      method: 'POST', headers: { Authorization: `Bearer ${session.token}` },
    });
    assert.equal(undo.status, 200);
    const unpaid = await undo.json();
    assert.equal(unpaid.contract.paymentStatus, 'Unpaid');
    assert.equal(unpaid.contract.lastPaymentAt, previousPaymentAt);
    assert.equal(unpaid.contract.lastPaymentAmountCents, 70000);
    assert.equal(unpaid.contract.lastPaymentSource, 'stripe');
    assert.equal(unpaid.contract.nextPaymentDueAt, previousDueAt.slice(0, 10));
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/contracts/${contract.id}/undo-manual-payment`, {
      method: 'POST', headers: { Authorization: `Bearer ${session.token}` },
    })).status, 409);
    assert.equal((await request(autopay.id)).status, 409);
    assert.equal(store.getAudits().some(entry => entry.entityId === contract.id && entry.action === 'contract.payment.recorded_manually'), true);
    assert.equal(store.getAudits().some(entry => entry.entityId === contract.id && entry.action === 'contract.payment.manual_marked_unpaid'), true);
  } finally {
    store.deleteContract(contract.id);
    store.deleteContract(autopay.id);
    await new Promise(resolve => server.close(resolve));
  }
});

test('maintenance and labor contracts accept private signed PDF attachments with admin-only download/removal', async () => {
  const { default: express } = await import(pathToFileURL(path.join(isolatedBackend, 'node_modules/express/index.js')));
  const { config } = await import(pathToFileURL(path.join(isolatedBackend, 'src/config.js')));
  const { contractsRouter } = await import(pathToFileURL(path.join(isolatedBackend, 'src/routes/contracts.js')));
  const admin = store.getAdminUserByEmail(config.adminBootstrapEmail);
  const session = store.issueAdminSession(admin);
  const maintenance = store.createContract({
    clientId: 'client_1', contractType: 'maintenance', status: 'active', packageType: 'single_home', packageLevel: 'pro',
    billingCycle: 'monthly', startDate: '2026-01-01', serviceAddress: '123 Main St',
  });
  const labor = store.createContract({
    clientId: 'client_1', contractType: 'labor', status: 'active', title: 'Signed Remodel', scope: 'Kitchen remodel',
    serviceAddress: '123 Main St', laborPricingModel: 'fixed', laborFixedAmountCents: 500000,
  });
  const app = express();
  app.use(express.json());
  app.use('/contracts', contractsRouter);
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const headers = { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/pdf' };
    const pdf = Buffer.from('%PDF-1.7\nsigned agreement fixture\n%%EOF\n');
    const upload = async contract => fetch(`${origin}/contracts/${contract.id}/attachments?${new URLSearchParams({ filename: '../signed-agreement.pdf' })}`, { method: 'POST', headers, body: pdf });
    assert.equal((await fetch(`${origin}/contracts/${maintenance.id}/attachments`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: pdf })).status, 401);
    const badPdf = await fetch(`${origin}/contracts/${maintenance.id}/attachments?filename=wrong.pdf`, { method: 'POST', headers, body: Buffer.from('not a PDF') });
    assert.equal(badPdf.status, 415);
    for (const contract of [maintenance, labor]) {
      const response = await upload(contract);
      assert.equal(response.status, 201);
      const { attachment } = await response.json();
      assert.equal(attachment.fileName, 'signed-agreement.pdf');
      assert.equal(attachment.sizeBytes, pdf.length);
      assert.equal((contract.signedAttachments || []).some(item => item.id === attachment.id), true);
      const storedContract = store.getContractById(contract.id);
      assert.equal(storedContract.signedAttachments[0].id, attachment.id);
      const download = await fetch(`${origin}/contracts/${contract.id}/attachments/${attachment.id}`, { headers: { Authorization: `Bearer ${session.token}` } });
      assert.equal(download.status, 200);
      assert.equal(download.headers.get('content-type'), 'application/pdf');
      assert.equal(Buffer.from(await download.arrayBuffer()).toString(), pdf.toString());
      assert.equal((await fetch(`${origin}/contracts/${contract.id}/attachments/${attachment.id}`)).status, 401);
      const removal = await fetch(`${origin}/contracts/${contract.id}/attachments/${attachment.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${session.token}` } });
      assert.equal(removal.status, 200);
      assert.deepEqual(store.getContractById(contract.id).signedAttachments, []);
      assert.equal((await fetch(`${origin}/contracts/${contract.id}/attachments/${attachment.id}`, { headers: { Authorization: `Bearer ${session.token}` } })).status, 404);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('first-party contract signatures validate invite details, preserve evidence, and prevent replay', async () => {
  const { default: express } = await import(pathToFileURL(path.join(isolatedBackend, 'node_modules/express/index.js')));
  const { config } = await import(pathToFileURL(path.join(isolatedBackend, 'src/config.js')));
  const { contractsRouter } = await import(pathToFileURL(path.join(isolatedBackend, 'src/routes/contracts.js')));
  const { contractSignaturesRouter } = await import(pathToFileURL(path.join(isolatedBackend, 'src/routes/contractSignatures.js')));
  const { deleteContractAttachment, saveContractAttachment } = await import(pathToFileURL(path.join(isolatedBackend, 'src/services/contractAttachmentStorage.js')));
  const admin = store.getAdminUserByEmail(config.adminBootstrapEmail);
  const session = store.issueAdminSession(admin);
  const contract = store.createContract({
    clientId: 'client_1', contractType: 'labor', status: 'active', title: 'Signature Test', scope: 'Replace a door',
    serviceAddress: '123 Main St', laborPricingModel: 'fixed', laborFixedAmountCents: 50000,
  });
  const pdfDocument = await PDFDocument.load(await contractPdf.generateContractPdfBuffer(contract, { name: 'Jordan Client' }));
  pdfDocument.catalog.delete(PDFName.of('StickmanSignatureLines'));
  const pdfBytes = Buffer.from(await pdfDocument.save());
  const app = express();
  app.use(express.json());
  app.use('/contracts', contractsRouter);
  app.use('/signatures', contractSignaturesRouter);
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const adminHeaders = { Authorization: `Bearer ${session.token}` };
    const upload = await fetch(`${origin}/contracts/${contract.id}/attachments?filename=agreement.pdf`, {
      method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/pdf' }, body: pdfBytes,
    });
    assert.equal(upload.status, 201);
    const { attachment } = await upload.json();
    const requestResponse = await fetch(`${origin}/contracts/${contract.id}/attachments/${attachment.id}/signature-request`, {
      method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ signerName: 'Jordan Client', signerEmail: 'jordan@example.test' }),
    });
    assert.equal(requestResponse.status, 201);
    const requestPayload = await requestResponse.json();
    const token = new URL(requestPayload.signingUrl).hash.slice('#token='.length);
    assert.ok(token.length >= 40);
    assert.equal(JSON.stringify(requestPayload).includes('tokenHash'), false);
    const storedRequest = store.getContractById(contract.id).signedAttachments[0].signatureRequests[0];
    assert.equal(storedRequest.tokenHash.length, 64);
    assert.equal(storedRequest.tokenHash.includes(token), false);

    const postSignature = (path, body) => fetch(`${origin}/signatures/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, signerEmail: 'jordan@example.test', ...body }),
    });
    assert.equal((await postSignature('inspect', { signerEmail: 'wrong@example.test' })).status, 403);
    const inspect = await postSignature('inspect', {});
    assert.equal(inspect.status, 200);
    assert.equal((await postSignature('document', {})).status, 200);
    assert.equal((await postSignature('signed-document', {})).status, 409);
    const completion = { signerName: 'Jordan Client', signatureType: 'typed', signatureText: 'Jordan Client', consent: false };
    assert.equal((await postSignature('complete', completion)).status, 400);
    assert.equal((await postSignature('complete', { ...completion, consent: true, signerName: 'Different Person' })).status, 400);
    const signedResponse = await postSignature('complete', { ...completion, consent: true });
    assert.equal(signedResponse.status, 200);
    const signed = await signedResponse.json();
    assert.equal((await postSignature('complete', { ...completion, consent: true })).status, 409);

    const storedContract = store.getContractById(contract.id);
    const completedRequest = storedContract.signedAttachments[0].signatureRequests[0];
    assert.equal(completedRequest.status, 'completed');
    assert.equal(completedRequest.signerEmail, 'jordan@example.test');
    assert.ok(completedRequest.signedAt);
    assert.match(completedRequest.consentText, /same effect as my handwritten signature/);
    const listed = await fetch(`${origin}/contracts`, { headers: adminHeaders });
    const listedPayload = await listed.json();
    assert.equal(JSON.stringify(listedPayload).includes('tokenHash'), false);

    const signedAttachment = storedContract.signedAttachments.find(item => item.signedCopy);
    assert.ok(signedAttachment);
    const signedPdfResponse = await fetch(`${origin}/contracts/${contract.id}/attachments/${signedAttachment.id}`, { headers: adminHeaders });
    const savedPdf = await PDFDocument.load(Buffer.from(await signedPdfResponse.arrayBuffer()));
    assert.equal(savedPdf.getPageCount(), pdfDocument.getPageCount());
    const completedInspection = await postSignature('inspect', {});
    assert.equal(completedInspection.status, 200);
    const completedInfo = await completedInspection.json();
    assert.equal(completedInfo.request.status, 'completed');
    assert.equal(completedInfo.document.fileName, signedAttachment.fileName);
    const signedDownload = await postSignature('signed-document', {});
    assert.equal(signedDownload.status, 200);
    assert.equal(signedDownload.headers.get('content-type'), 'application/pdf');
    assert.equal(signedDownload.headers.get('cache-control'), 'no-store');
    const downloadedPdf = await PDFDocument.load(Buffer.from(await signedDownload.arrayBuffer()));
    assert.equal(downloadedPdf.getPageCount(), savedPdf.getPageCount());
    assert.equal((await postSignature('document', {})).status, 409);
    assert.equal((await postSignature('signed-document', { signerEmail: 'wrong@example.test' })).status, 403);
    assert.equal((await postSignature('signed-document', { signerEmail: undefined })).status, 403);
    assert.equal((await postSignature('signed-document', { token: 'z'.repeat(43) })).status, 404);
    const completedExpiry = completedRequest.expiresAt;
    completedRequest.expiresAt = '2000-01-01T00:00:00.000Z';
    assert.equal((await postSignature('signed-document', {})).status, 410);
    completedRequest.expiresAt = completedExpiry;

    const changedUpload = await fetch(`${origin}/contracts/${contract.id}/attachments?filename=changed.pdf`, {
      method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/pdf' }, body: pdfBytes,
    });
    const { attachment: changedAttachment } = await changedUpload.json();
    const changedRequestResponse = await fetch(`${origin}/contracts/${contract.id}/attachments/${changedAttachment.id}/signature-request`, {
      method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ signerName: 'Jordan Client', signerEmail: 'jordan@example.test' }),
    });
    const firstChangedRequest = await changedRequestResponse.json();
    const obsoleteToken = new URL(firstChangedRequest.signingUrl).hash.slice('#token='.length);
    const replacementResponse = await fetch(`${origin}/contracts/${contract.id}/attachments/${changedAttachment.id}/signature-request`, {
      method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ signerName: 'Jordan Client', signerEmail: 'jordan@example.test', replaceExisting: true }),
    });
    assert.equal(replacementResponse.status, 201);
    const replacement = await replacementResponse.json();
    const changedToken = new URL(replacement.signingUrl).hash.slice('#token='.length);
    const obsoleteLinkResponse = await fetch(`${origin}/signatures/inspect`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: obsoleteToken, signerEmail: 'jordan@example.test' }),
    });
    assert.equal(obsoleteLinkResponse.status, 410);
    const differentPdf = await PDFDocument.create();
    differentPdf.addPage([300, 400]);
    await deleteContractAttachment(contract.id, changedAttachment.id);
    await saveContractAttachment(contract.id, changedAttachment.id, Buffer.from(await differentPdf.save()));
    const changedCompletion = await fetch(`${origin}/signatures/complete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: changedToken, signerEmail: 'jordan@example.test', signerName: 'Jordan Client', signatureType: 'typed', signatureText: 'Jordan Client', consent: true }),
    });
    assert.equal(changedCompletion.status, 409);

    const expiryUpload = await fetch(`${origin}/contracts/${contract.id}/attachments?filename=expiry.pdf`, {
      method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/pdf' }, body: pdfBytes,
    });
    const { attachment: expiryAttachment } = await expiryUpload.json();
    const expiryRequestResponse = await fetch(`${origin}/contracts/${contract.id}/attachments/${expiryAttachment.id}/signature-request`, {
      method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const expiryRequest = await expiryRequestResponse.json();
    assert.equal(expiryRequest.request.signerName, 'Sample Client');
    assert.equal(expiryRequest.request.signerEmail, null);
    const expiryToken = new URL(expiryRequest.signingUrl).hash.slice('#token='.length);
    const contractWithExpiryRequest = store.getContractById(contract.id);
    const expiredAttachments = contractWithExpiryRequest.signedAttachments.map(item => item.id === expiryAttachment.id
      ? { ...item, signatureRequests: item.signatureRequests.map(request => ({ ...request, expiresAt: new Date(Date.now() - 1000).toISOString() })) }
      : item);
    store.updateContract(contract.id, { signedAttachments: expiredAttachments });
    const expiredResponse = await fetch(`${origin}/signatures/inspect`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: expiryToken, signerEmail: 'jordan@example.test' }),
    });
    assert.equal(expiredResponse.status, 410);

    const generatedLinkResponse = await fetch(`${origin}/contracts/${contract.id}/signature-request`, {
      method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(generatedLinkResponse.status, 201);
    const generatedLink = await generatedLinkResponse.json();
    assert.equal(generatedLink.attachment.generatedContract, true);
    assert.equal(generatedLink.request.signerName, 'Sample Client');
    assert.equal(generatedLink.request.signerEmail, null);
    const generatedAttachment = store.getContractById(contract.id).signedAttachments.find(item => item.id === generatedLink.attachment.id);
    assert.equal(generatedAttachment.generatedContract, true);
    const pendingList = await (await fetch(`${origin}/contracts`, { headers: adminHeaders })).json();
    assert.equal(pendingList.contracts.find(item => item.id === contract.id).signedAttachments.some(item => item.id === generatedAttachment.id), false);
    const generatedPdfResponse = await fetch(`${origin}/contracts/${contract.id}/attachments/${generatedAttachment.id}`, { headers: adminHeaders });
    const generatedPdf = await PDFDocument.load(Buffer.from(await generatedPdfResponse.arrayBuffer()));
    assert.ok(generatedPdf.getPageCount() >= 1);
    const firstGeneratedToken = new URL(generatedLink.signingUrl).hash.slice('#token='.length);
    const generatedReplacementResponse = await fetch(`${origin}/contracts/${contract.id}/signature-request`, {
      method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(generatedReplacementResponse.status, 201);
    const generatedReplacement = await generatedReplacementResponse.json();
    const generatedToken = new URL(generatedReplacement.signingUrl).hash.slice('#token='.length);
    const oldGeneratedLinkResponse = await fetch(`${origin}/signatures/inspect`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: firstGeneratedToken, signerEmail: 'jordan@example.test' }),
    });
    assert.equal(oldGeneratedLinkResponse.status, 410);
    const generatedCompletion = await fetch(`${origin}/signatures/complete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: generatedToken, signerName: 'Sample Client', signatureType: 'typed', signatureText: 'Sample Client', consent: true }),
    });
    assert.equal(generatedCompletion.status, 200);
    const generatedSource = store.getContractById(contract.id).signedAttachments.find(item => item.id === generatedReplacement.attachment.id);
    const generatedRequest = generatedSource.signatureRequests[0];
    assert.equal(generatedRequest.businessSignature, 'Jacob Lancaster');
    assert.equal(generatedRequest.businessSignatureFor, 'Stickman Handyman');
    assert.equal(generatedRequest.businessSignatureMethod, 'typed');
    const signedGeneratedResponse = await fetch(`${origin}/contracts/${contract.id}/attachments/${generatedRequest.signedAttachmentId}`, { headers: adminHeaders });
    const signedGeneratedPdf = await PDFDocument.load(Buffer.from(await signedGeneratedResponse.arrayBuffer()));
    assert.equal(signedGeneratedPdf.getPageCount(), generatedPdf.getPageCount());

    const maintenanceContract = store.createContract({
      clientId: 'client_1', contractType: 'maintenance', status: 'active', packageType: 'single_home', packageLevel: 'pro',
      billingCycle: 'quarterly', startDate: '2026-01-01', serviceAddress: '123 Main St', packageRolloverHours: 1,
      packageDiscountPercent: 5, packagePriorityScheduling: true,
    });
    const maintenanceLinkResponse = await fetch(`${origin}/contracts/${maintenanceContract.id}/signature-request`, {
      method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(maintenanceLinkResponse.status, 201);
    const maintenanceLink = await maintenanceLinkResponse.json();
    const maintenanceAttachment = store.getContractById(maintenanceContract.id).signedAttachments.find(item => item.id === maintenanceLink.attachment.id);
    assert.equal(maintenanceAttachment.generatedContract, true);
    assert.equal(maintenanceLink.request.signerName, 'Sample Client');
    const maintenancePdfResponse = await fetch(`${origin}/contracts/${maintenanceContract.id}/attachments/${maintenanceAttachment.id}`, { headers: adminHeaders });
    const maintenancePdf = await PDFDocument.load(Buffer.from(await maintenancePdfResponse.arrayBuffer()));
    assert.ok(maintenancePdf.getPageCount() >= 1);
    const maintenanceToken = new URL(maintenanceLink.signingUrl).hash.slice('#token='.length);
    const maintenanceCompletion = await fetch(`${origin}/signatures/complete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: maintenanceToken, signerName: 'Sample Client', signatureType: 'typed', signatureText: 'Sample Client', consent: true }),
    });
    assert.equal(maintenanceCompletion.status, 200);
    const maintenanceSource = store.getContractById(maintenanceContract.id).signedAttachments.find(item => item.id === maintenanceAttachment.id);
    const maintenanceRequest = maintenanceSource.signatureRequests[0];
    assert.equal(maintenanceRequest.businessSignature, 'Jacob Lancaster');
    assert.equal(maintenanceRequest.businessSignatureFor, 'Stickman Handyman');
    assert.equal(maintenanceRequest.businessSignedAt, maintenanceRequest.signedAt);
    const signedMaintenanceResponse = await fetch(`${origin}/contracts/${maintenanceContract.id}/attachments/${maintenanceRequest.signedAttachmentId}`, { headers: adminHeaders });
    const signedMaintenancePdf = await PDFDocument.load(Buffer.from(await signedMaintenanceResponse.arrayBuffer()));
    assert.equal(signedMaintenancePdf.getPageCount(), maintenancePdf.getPageCount());
    const signaturePage = signedMaintenancePdf.getPages().at(-1);
    const signatureContents = signaturePage.node.Contents();
    const signatureStreams = signatureContents instanceof PDFArray ? signatureContents.asArray() : [signatureContents];
    const signatureText = signatureStreams.map(ref => signedMaintenancePdf.context.lookup(ref))
      .filter(stream => stream instanceof PDFRawStream)
      .flatMap(stream => [...Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1').matchAll(/<([\da-f]+)>\s*Tj/gi)]
        .map(match => Buffer.from(match[1], 'hex').toString('latin1'))).join(' ');
    assert.ok(signatureText.includes('Sample Client'));
    assert.ok(signatureText.includes('Jacob Lancaster'));
    assert.equal(signatureText.includes('For Stickman Handyman'), false);
    assert.equal(signatureText.includes('ELECTRONIC SIGNATURE RECORD'), false);
    const expectedDate = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(maintenanceRequest.signedAt));
    assert.equal(signatureText.split(expectedDate).length - 1, 2);
    const placement = maintenancePdf.catalog.lookup(PDFName.of('StickmanSignatureLines'), PDFDict);
    const coordinate = name => placement.lookup(PDFName.of(name), PDFNumber).asNumber();
    const signatureOperations = signatureStreams.map(ref => signedMaintenancePdf.context.lookup(ref))
      .filter(stream => stream instanceof PDFRawStream)
      .map(stream => Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1')).join('\n');
    for (const [signatureX, signatureY] of [
      [coordinate('signatureX'), coordinate('signatureY')],
      [coordinate('dateX'), coordinate('signatureY')],
      [coordinate('signatureX'), coordinate('businessY')],
      [coordinate('dateX'), coordinate('businessY')],
    ]) assert.ok(signatureOperations.includes(`1 0 0 1 ${signatureX} ${signatureY} Tm`));
    const completedList = await (await fetch(`${origin}/contracts`, { headers: adminHeaders })).json();
    const visibleDocuments = completedList.contracts.find(item => item.id === maintenanceContract.id).signedAttachments;
    assert.equal(visibleDocuments.length, 1);
    assert.equal(visibleDocuments[0].signedCopy, true);
    assert.equal(visibleDocuments[0].signatureRequests[0].documentSha256, maintenanceRequest.documentSha256);

    const drawnLink = await (await fetch(`${origin}/contracts/${maintenanceContract.id}/signature-request`, {
      method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    })).json();
    const drawnToken = new URL(drawnLink.signingUrl).hash.slice('#token='.length);
    const png = Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG4kAAAAASUVORK5CYII=', 'base64'), Buffer.alloc(100)]);
    const drawnResponse = await fetch(`${origin}/signatures/complete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: drawnToken, signerName: 'Sample Client', signatureType: 'drawn', signatureImageDataUrl: `data:image/png;base64,${png.toString('base64')}`, consent: true }),
    });
    assert.equal(drawnResponse.status, 200);
    const drawnSource = store.getContractById(maintenanceContract.id).signedAttachments.find(item => item.id === drawnLink.attachment.id);
    const drawnRequest = drawnSource.signatureRequests[0];
    assert.equal(drawnRequest.signatureType, 'drawn');
    assert.equal(drawnRequest.businessSignature, 'Jacob Lancaster');
    const drawnPdfResponse = await fetch(`${origin}/contracts/${maintenanceContract.id}/attachments/${drawnRequest.signedAttachmentId}`, { headers: adminHeaders });
    const drawnPdf = await PDFDocument.load(Buffer.from(await drawnPdfResponse.arrayBuffer()));
    assert.equal(drawnPdf.getPageCount(), maintenancePdf.getPageCount());
    assert.ok(drawnPdf.getPages().at(-1).node.Resources().lookupMaybe(PDFName.of('XObject'), PDFDict));

    const legacyInvite = await (await fetch(`${origin}/contracts/${contract.id}/attachments/${attachment.id}/signature-request`, {
      method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ signerName: 'Jordan Client', signerEmail: 'jordan@example.test' }),
    })).json();
    const legacyToken = new URL(legacyInvite.signingUrl).hash.slice('#token='.length);
    const legacyComplete = await fetch(`${origin}/signatures/complete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: legacyToken, signerEmail: 'jordan@example.test', signerName: 'Jordan Client', signatureType: 'drawn', signatureImageDataUrl: `data:image/png;base64,${png.toString('base64')}`, consent: true }),
    });
    assert.equal(legacyComplete.status, 200);
    const legacySource = store.getContractById(contract.id).signedAttachments.find(item => item.id === attachment.id);
    const legacyRequest = legacySource.signatureRequests.at(-1);
    assert.equal(legacyRequest.signatureType, 'drawn');
    assert.equal(legacyRequest.businessSignature, 'Jacob Lancaster');
    const legacyPdfResponse = await fetch(`${origin}/contracts/${contract.id}/attachments/${legacyRequest.signedAttachmentId}`, { headers: adminHeaders });
    const legacyPdf = await PDFDocument.load(Buffer.from(await legacyPdfResponse.arrayBuffer()));
    assert.equal(legacyPdf.getPageCount(), pdfDocument.getPageCount());
    assert.ok(legacyPdf.getPages().at(-1).node.Resources().lookupMaybe(PDFName.of('XObject'), PDFDict));

    const unsupported = await PDFDocument.create();
    unsupported.addPage();
    const unsupportedUpload = await (await fetch(`${origin}/contracts/${contract.id}/attachments?filename=unsupported.pdf`, {
      method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/pdf' }, body: Buffer.from(await unsupported.save()),
    })).json();
    const unsupportedInvite = await (await fetch(`${origin}/contracts/${contract.id}/attachments/${unsupportedUpload.attachment.id}/signature-request`, {
      method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ signerName: 'Jordan Client' }),
    })).json();
    const unsupportedToken = new URL(unsupportedInvite.signingUrl).hash.slice('#token='.length);
    const unsupportedComplete = await fetch(`${origin}/signatures/complete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: unsupportedToken, signerName: 'Jordan Client', signatureType: 'typed', signatureText: 'Jordan Client', consent: true }),
    });
    assert.equal(unsupportedComplete.status, 409);
    assert.equal((await unsupportedComplete.json()).code, 'SIGNATURE_LINES_NOT_FOUND');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('admin client merge preserves business invoices, contracts, ongoing jobs, and a single login', async () => {
  const { default: express } = await import(pathToFileURL(path.join(isolatedBackend, 'node_modules/express/index.js')));
  const { config } = await import(pathToFileURL(path.join(isolatedBackend, 'src/config.js')));
  const { clientsRouter } = await import(pathToFileURL(path.join(isolatedBackend, 'src/routes/clients.js')));
  const admin = store.getAdminUserByEmail(config.adminBootstrapEmail);
  const adminSession = store.issueAdminSession(admin);
  const target = store.createClient({ name: 'Merge Target Owner', address: '10 Home Street' });
  const source = store.createClient({ name: 'Merge Source Business', address: '20 Business Avenue', serviceAddresses: ['21 Business Avenue'] });
  const sourceUser = store.createClientUser({ accountId: source.id, email: 'merge-source@example.test', password: 'merge-test-password' });
  const sourceSession = store.issueClientSession(sourceUser);
  const invoice = store.createInvoice({ accountId: source.id, issueDate: '2026-10-12', serviceAddress: source.address, lineItems: [{ type: 'labor', description: 'Business repair', quantity: 1, unitPriceCents: 5000 }] });
  const ongoing = store.createInvoice({ accountId: source.id, isOngoing: true, jobName: 'Business follow-up', serviceAddress: source.address });
  const contract = store.createContract({
    clientId: source.id, contractType: 'maintenance', status: 'active', packageType: 'portfolio', packageLevel: 'pro',
    billingCycle: 'monthly', startDate: '2026-10-01', serviceAddress: source.address,
  });
  const app = express();
  app.use(express.json());
  app.use('/clients', clientsRouter);
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/clients/${target.id}/merge-business`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminSession.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceClientId: source.id }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.invoiceCount, 2);
    assert.equal(payload.contractCount, 1);
    assert.equal(payload.loginTransferred, true);
    assert.equal(store.getClientById(source.id), null);
    assert.equal(payload.client.businesses[0].name, source.name);
    assert.equal(store.getInvoiceById(invoice.id).accountId, target.id);
    assert.equal(store.getInvoiceById(invoice.id).billingEntityName, source.name);
    assert.equal(store.getInvoiceById(invoice.id).billingEntityAddress, source.address);
    assert.equal(store.getInvoiceById(ongoing.id).accountId, target.id);
    assert.equal(store.getContractById(contract.id).accountId, target.id);
    assert.equal(store.verifyClientSession(sourceSession.token).accountId, target.id);
  } finally {
    await new Promise(resolve => server.close(resolve));
    store.deleteInvoice(invoice.id);
    store.deleteInvoice(ongoing.id);
    store.deleteContract(contract.id);
    store.deleteClient(target.id);
  }
});

test('client merge refuses two logins or an active source subscription without removing either account', () => {
  let target = store.createClient({ name: 'Merge Guard Target', address: '30 Target Street' });
  let source = store.createClient({ name: 'Merge Guard Source', address: '40 Source Street' });
  try {
    store.createClientUser({ accountId: target.id, email: 'merge-target@example.test', password: 'merge-test-password' });
    store.createClientUser({ accountId: source.id, email: 'merge-conflict@example.test', password: 'merge-test-password' });
    assert.equal(store.mergeClientAsBusiness(target.id, source.id).error, 'CLIENT_MERGE_LOGIN_CONFLICT');
    assert.ok(store.getClientById(source.id));

    store.deleteClient(source.id);
    store.deleteClient(target.id);
    target = store.createClient({ name: 'Subscription Guard Target', address: '31 Target Street' });
    source = store.createClient({ name: 'Subscription Guard Source', address: '41 Source Street' });
    const contract = store.createContract({
      clientId: source.id, contractType: 'maintenance', status: 'active', packageType: 'single_home', packageLevel: 'basic',
      billingCycle: 'monthly', serviceAddress: source.address,
    });
    store.updateContract(contract.id, { autopayEnabled: true, stripeSubscriptionId: 'sub_merge_guard', stripeSubscriptionStatus: 'active' });
    assert.equal(store.mergeClientAsBusiness(target.id, source.id).error, 'CLIENT_MERGE_ACTIVE_SUBSCRIPTION');
    assert.ok(store.getClientById(source.id));
    assert.equal(store.getContractById(contract.id).accountId, source.id);
  } finally {
    for (const contract of store.getContracts().filter(item => item.clientId === source.id || item.accountId === source.id)) {
      store.deleteContract(contract.id);
    }
    store.deleteClient(target.id);
    store.deleteClient(source.id);
  }
});

test('mobile client activity uses bearer authentication and returns only the account records', async () => {
  const { default: express } = await import(pathToFileURL(path.join(isolatedBackend, 'node_modules/express/index.js')));
  const { clientAuthRouter } = await import(pathToFileURL(path.join(isolatedBackend, 'src/routes/client-auth.js')));
  const { clientsRouter } = await import(pathToFileURL(path.join(isolatedBackend, 'src/routes/clients.js')));
  const account = store.createClient({ name: 'App Activity Client', address: '7 App St' });
  const other = store.createClient({ name: 'Other App Client', address: '8 App St' });
  const user = store.createClientUser({ accountId: account.id, email: 'app-activity@example.test', password: 'app-test-password' });
  const session = store.issueClientSession(user);
  const invoice = store.createInvoice({ accountId: account.id, amountCents: 5000 });
  store.createInvoice({ accountId: other.id, amountCents: 6000 });
  store.createInvoice({ accountId: account.id, isOngoing: true, jobName: 'Private ongoing job' });
  const contract = store.createContract({ clientId: account.id, contractType: 'maintenance', status: 'active', packageType: 'portfolio', packageLevel: 'premium', billingCycle: 'monthly', startDate: '2026-01-01', serviceAddress: account.address });
  store.updateContract(contract.id, { stripeSubscriptionId: 'sub_private_fixture', signedAttachments: [{ id: 'private-attachment', fileName: 'signed.pdf' }] });
  const app = express();
  app.use(express.json());
  app.use('/client', clientAuthRouter);
  app.use('/clients', clientsRouter);
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${origin}/client/me/activity`)).status, 401);
    const response = await fetch(`${origin}/client/me/activity`, { headers: { Authorization: `Bearer ${session.token}` } });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.invoices.map(item => item.id), [invoice.id]);
    assert.deepEqual(payload.contracts.map(item => item.id), [contract.id]);
    assert.equal(payload.contracts[0].maintenanceTerms.retainerHours, 10);
    assert.equal(payload.contracts[0].stripeSubscriptionId, undefined);
    assert.equal(payload.contracts[0].signedAttachments, undefined);
    const lookupResponse = await fetch(`${origin}/clients/lookup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: account.name, address: account.address }) });
    const lookup = await lookupResponse.json();
    assert.deepEqual(lookup.invoices, payload.invoices);
    assert.deepEqual(lookup.contracts, payload.contracts);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('mobile client bearer tokens authorize own invoice checkout and PDFs without lookup tokens', async (context) => {
  const { default: express } = await import(pathToFileURL(path.join(isolatedBackend, 'node_modules/express/index.js')));
  const { SessionResource } = await import(pathToFileURL(path.join(isolatedBackend, 'node_modules/stripe/esm/resources/Checkout/Sessions.js')));
  const { config } = await import(pathToFileURL(path.join(isolatedBackend, 'src/config.js')));
  const { invoicesRouter } = await import(pathToFileURL(path.join(isolatedBackend, 'src/routes/invoices.js')));
  const previous = { key: config.stripeSecretKey, publishable: config.stripePublishableKey };
  config.stripeSecretKey = 'sk_test_local_fixture';
  config.stripePublishableKey = 'pk_test_local_fixture';
  const account = store.createClient({ name: 'Bearer Payment Client', address: '9 App St' });
  const session = store.issueClientSession({ id: 'bearer-client', accountId: account.id, email: 'bearer@example.test' });
  const otherSession = store.issueClientSession({ id: 'other-client', accountId: 'client_1', email: 'other@example.test' });
  const lookup = store.issueLookupSession(account.id);
  const invoice = store.createInvoice({ accountId: account.id, lineItems: [{ type: 'labor', description: 'Mobile invoice', quantity: 1, unitPriceCents: 5000 }] });
  let createdSession;
  context.mock.method(SessionResource.prototype, 'create', async parameters => {
    createdSession = { id: 'cs_mobile', status: 'open', ui_mode: parameters.ui_mode, amount_total: 5000, currency: 'usd', client_secret: 'mobile_test_secret', expires_at: 2000000000 };
    return createdSession;
  });
  context.mock.method(SessionResource.prototype, 'retrieve', async () => createdSession);
  const app = express();
  app.use(express.json());
  app.use('/invoices', invoicesRouter);
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}/invoices/${invoice.id}`;
    const checkout = (token, body = {}) => fetch(`${endpoint}/checkout-session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ uiMode: 'embedded', ...body }),
    });
    assert.equal((await checkout()).status, 401);
    assert.equal((await checkout('invalid', { lookupAccessToken: lookup.token })).status, 401);
    assert.equal((await checkout(otherSession.token)).status, 403);
    const response = await checkout(session.token);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).clientSecret, 'mobile_test_secret');
    assert.equal((await checkout(null, { lookupAccessToken: lookup.token })).status, 200);
    assert.equal((await fetch(`${endpoint}/pdf`, { headers: { Authorization: `Bearer ${otherSession.token}` } })).status, 403);
    store.markInvoicePaid(invoice.id, 'pi_mobile_fixture');
    assert.equal((await checkout(session.token)).status, 409);
    const pdfResponse = await fetch(`${endpoint}/pdf`, { headers: { Authorization: `Bearer ${session.token}` } });
    assert.equal(pdfResponse.status, 200);
    assert.equal(pdfResponse.headers.get('content-type'), 'application/pdf');
    assert.equal((await pdfResponse.text()).slice(0, 4), '%PDF');
  } finally {
    await new Promise(resolve => server.close(resolve));
    config.stripeSecretKey = previous.key;
    config.stripePublishableKey = previous.publishable;
  }
});

test('mobile API sessions expose expiry and support role-separated idempotent logout', async () => {
  const { default: express } = await import(pathToFileURL(path.join(isolatedBackend, 'node_modules/express/index.js')));
  const { authRouter } = await import(pathToFileURL(path.join(isolatedBackend, 'src/routes/auth.js')));
  const { clientAuthRouter } = await import(pathToFileURL(path.join(isolatedBackend, 'src/routes/client-auth.js')));
  const { config } = await import(pathToFileURL(path.join(isolatedBackend, 'src/config.js')));
  const account = store.createClient({ name: 'App Session Client', address: '10 App St' });
  store.createClientUser({ accountId: account.id, email: 'app-session@example.test', password: 'app-session-password' });
  const app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
  app.use('/client', clientAuthRouter);
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const login = async (endpoint, credentials) => {
      const response = await fetch(`${origin}${endpoint}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.ok(payload.token);
      assert.ok(payload.expiresAt > Date.now());
      return payload;
    };
    const admin = await login('/auth', { email: config.adminBootstrapEmail, password: config.adminBootstrapPassword });
    const client = await login('/client', { email: 'app-session@example.test', password: 'app-session-password' });
    const call = (endpoint, token, method = 'GET') => fetch(`${origin}${endpoint}`, { method, headers: { Authorization: `bearer ${token}` } });
    assert.equal((await call('/auth/me', admin.token)).status, 200);
    assert.equal((await call('/client/me', client.token)).status, 200);
    assert.equal((await call('/auth/me', client.token)).status, 401);
    assert.equal((await call('/client/me', admin.token)).status, 401);
    const previousClientTtl = config.clientSessionTtlHours;
    const previousAdminTtl = config.adminSessionTtlHours;
    let expiredClient;
    let expiredAdmin;
    try {
      config.clientSessionTtlHours = 0;
      config.adminSessionTtlHours = 0;
      expiredClient = store.issueClientSession(client.clientUser);
      expiredAdmin = store.issueAdminSession(store.getAdminUserByEmail(config.adminBootstrapEmail));
    } finally {
      config.clientSessionTtlHours = previousClientTtl;
      config.adminSessionTtlHours = previousAdminTtl;
    }
    assert.equal((await call('/client/me', expiredClient.token)).status, 401);
    assert.equal((await call('/auth/me', expiredAdmin.token)).status, 401);
    assert.equal((await call('/auth/logout', client.token, 'POST')).status, 204);
    assert.equal((await call('/client/me', client.token)).status, 200);
    assert.equal((await call('/client/logout', client.token, 'POST')).status, 204);
    assert.equal((await call('/client/logout', client.token, 'POST')).status, 204);
    assert.equal((await call('/client/me', client.token)).status, 401);
    assert.equal((await call('/auth/logout', admin.token, 'POST')).status, 204);
    assert.equal((await call('/auth/me', admin.token)).status, 401);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Stripe signed webhooks confirm payments only after validating amounts and preserve successful state', async () => {
  const { default: express } = await import(pathToFileURL(path.join(isolatedBackend, 'node_modules/express/index.js')));
  const { default: Stripe } = await import(pathToFileURL(path.join(isolatedBackend, 'node_modules/stripe/esm/stripe.esm.node.js')));
  const { config } = await import(pathToFileURL(path.join(isolatedBackend, 'src/config.js')));
  const { stripeRouter } = await import(pathToFileURL(path.join(isolatedBackend, 'src/routes/stripe.js')));
  const previous = { key: config.stripeSecretKey, secret: config.stripeWebhookSecret };
  config.stripeSecretKey = 'sk_test_local_fixture';
  config.stripeWebhookSecret = 'whsec_local_fixture';
  const invoice = store.createInvoice({ accountId: 'client_1', serviceAddress: 'Webhook Test Address', lineItems: [{ type: 'labor', description: 'Webhook test', quantity: 1, unitPriceCents: 5000 }] });
  const app = express();
  app.use('/stripe', express.raw({ type: 'application/json' }), stripeRouter);
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  try {
    const send = async (type, currency = 'usd', validSignature = true) => {
      const payload = JSON.stringify({ id: `evt_${type}`, type, created: Math.floor(Date.now() / 1000), data: { object: {
        id: 'pi_webhook', amount: 5000, amount_received: 5000, currency, metadata: { invoiceId: invoice.id },
      } } });
      const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: validSignature ? config.stripeWebhookSecret : 'wrong_secret' });
      return fetch(`http://127.0.0.1:${server.address().port}/stripe/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': signature }, body: payload });
    };
    assert.equal((await send('payment_intent.succeeded', 'usd', false)).status, 400);
    assert.equal((await send('payment_intent.processing')).status, 200);
    assert.equal(invoice.status, 'sent');
    assert.equal(invoice.stripePaymentStatus, 'processing');
    assert.equal((await send('payment_intent.payment_failed')).status, 200);
    assert.equal(invoice.stripePaymentStatus, 'failed');
    assert.equal((await send('payment_intent.succeeded', 'eur')).status, 409);
    assert.equal(invoice.status, 'sent');
    assert.equal((await send('payment_intent.succeeded')).status, 200);
    assert.equal(invoice.status, 'paid');
    assert.equal((await send('payment_intent.payment_failed')).status, 200);
    assert.equal(invoice.stripePaymentStatus, 'succeeded');
  } finally {
    await new Promise(resolve => server.close(resolve));
    config.stripeSecretKey = previous.key;
    config.stripeWebhookSecret = previous.secret;
  }
});

for (const [label, entries, billCents, payRates] of [
  ['owner only', [owner], 8000, [8000]],
  ['one contractor', [owner, first], 14000, [8000, 5000]],
  ['two contractors', [owner, first, second], 20000, [8000, 5000, 5000]],
]) {
  test(`${label}: preview, saved invoice, and payroll stay consistent`, () => {
    const [tier] = repository.buildContractorHourTiers(entries);
    assert.equal(tier.hourlyRateCents, billCents);
    assert.deepEqual(repository.buildContractorHourBreakdown(entries).map(entry => entry.hourlyRateCents), payRates);
    const context = frontendContext({ entries });
    assert.equal(vm.runInContext('buildContractorLaborItems(entries)[0].unitPriceCents', context), billCents);
    const invoice = store.createInvoice({ accountId: 'client_1', serviceAddress: 'Contractor Payroll Regression Address', contractorHours: entries });
    assert.equal(invoice.subtotalCents, billCents);
    assert.equal(invoice.amountCents, billCents);
  });
}

test('unequal hours bill only the people present in each tier', () => {
  const entries = [{ ...owner, hours: 4 }, { ...first, hours: 2 }, second];
  const tiers = repository.buildContractorHourTiers(entries);
  assert.deepEqual(tiers.map(tier => [tier.hours, tier.hourlyRateCents]), [[1, 20000], [1, 14000], [2, 8000]]);
  const context = frontendContext({ entries });
  const previewTotal = vm.runInContext('buildContractorLaborItems(entries).reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0)', context);
  assert.equal(previewTotal, 50000);
  assert.equal(store.createInvoice({ accountId: 'client_1', serviceAddress: 'Unequal Hours Regression Address', contractorHours: entries }).amountCents, previewTotal);
  const payroll = repository.buildContractorHourBreakdown(entries);
  assert.equal(payroll.filter(entry => entry.contractorId === first.contractorId).reduce((sum, entry) => sum + entry.hours * entry.hourlyRateCents, 0), 10000);
});

test('duplicate frontend hour rows combine without charging an owner markup', () => {
  const context = frontendContext({ entries: [owner, owner] });
  assert.equal(vm.runInContext('buildContractorLaborItems(entries)[0].quantity', context), 2);
  assert.equal(vm.runInContext('buildContractorLaborItems(entries)[0].unitPriceCents', context), 8000);
});

test('quarter-hour billing and payroll remain exact in cents', () => {
  const entries = [{ ...owner, hours: 0.25 }, { ...first, hours: 0.25 }];
  const invoice = store.createInvoice({ accountId: 'client_1', serviceAddress: 'Quarter Hour Regression Address', contractorHours: entries });
  assert.equal(invoice.amountCents, 3500);
  const payment = repository.getContractorPaymentTransactions().find(entry => entry.invoiceId === invoice.id);
  assert.equal(payment.amountCents, 1250);
});

test('owner paid totals use invoice status and retain the base rate', () => {
  const entries = [
    { contractorId: owner.contractorId, hours: 2, hourlyRateCents: 8000, invoiceStatus: 'paid' },
    { contractorId: owner.contractorId, hours: 1, hourlyRateCents: 8000, invoiceStatus: 'sent' },
  ];
  const context = frontendContext({ entries });
  const summary = vm.runInContext('summarizeOwnerHours(entries).values().next().value', context);
  assert.equal(summary.paidCents, 16000);
  assert.equal(summary.unpaidCents, 8000);
});

test('invoice edits preserve saved base pay rates and material lines', () => {
  const invoice = store.createInvoice({ accountId: 'client_1', serviceAddress: 'Invoice Edit Regression Address', contractorHours: [owner, first] });
  repository.updateContractor(firstContractor.id, { hourlyRateCents: 7000 });
  try {
    const edited = store.updateInvoice(invoice.id, {
      contractorHours: [{ ...owner, hours: 2 }, { ...first, hours: 2 }],
      lineItems: [{ type: 'material', description: 'Materials', quantity: 1, unitPriceCents: 2500 }],
    });
    assert.equal(edited.contractorHours.find(entry => entry.contractorId === firstContractor.id).hourlyRateCents, 5000);
    assert.equal(edited.subtotalCents, 30500);
    assert.equal(edited.amountCents, 30500);
    assert.equal(edited.lineItems.at(-1).description, 'Materials');
    const payment = repository.getContractorPaymentTransactions().find(entry => entry.invoiceId === invoice.id);
    assert.equal(payment.payRateCents, 5000);
    assert.equal(payment.amountCents, 10000);
  } finally {
    repository.updateContractor(firstContractor.id, { hourlyRateCents: 5000 });
  }
});

test('paid invoice totals do not mark contractor payroll as paid', () => {
  const invoice = store.createInvoice({ accountId: 'client_1', contractorHours: [owner, first] });
  store.updateInvoice(invoice.id, { status: 'paid' });
  const payments = repository.getContractorPaymentTransactions().filter(entry => entry.invoiceId === invoice.id);
  const context = frontendContext({ adminInvoices: [invoice], payments });
  const paid = vm.runInContext('summarizeContractorPayments(payments).values().next().value', context);
  assert.equal(paid.paidCents, 5000);
  assert.equal(paid.unpaidCents, 0);
  assert.equal(payments[0].status, 'unpaid');
  store.updateInvoice(invoice.id, { status: 'sent' });
  const unpaid = vm.runInContext('summarizeContractorPayments(payments).values().next().value', context);
  assert.equal(unpaid.paidCents, 0);
  assert.equal(unpaid.unpaidCents, 5000);
});

test('contractor report dates follow invoice dates with legacy fallback', () => {
  const context = frontendContext({ adminInvoices: [{ id: 'invoice-test', issueDate: '2026-10-19', status: 'paid' }] });
  context.payment = { invoiceId: 'invoice-test', status: 'paid', paidAt: '2027-01-01', date: '2026-10-18' };
  assert.equal(vm.runInContext('getContractorPaymentReportDate(payment)', context), '2026-10-19');
  context.payment.invoiceId = 'legacy';
  assert.equal(vm.runInContext('getContractorPaymentReportDate(payment)', context), '2027-01-01');
});

test('download filenames agree with the server and omit INV-', () => {
  const context = frontendContext();
  assert.equal(vm.runInContext("invoicePdfDownloadName('INV-1031')", context), 'StickmanHandyman_1031.pdf');
  assert.equal(pdf.invoicePdfFileName('INV-1031'), 'StickmanHandyman_1031.pdf');
});

test('discounted invoice PDF regenerates instead of returning a stale cached file', async () => {
  const invoicesDirectory = path.join(temporaryRoot, 'invoices');
  mkdirSync(invoicesDirectory, { recursive: true });
  writeFileSync(path.join(invoicesDirectory, 'StickmanHandyman_9999.pdf'), 'stale cached PDF');
  const buffer = await pdf.getInvoicePdfBuffer({
    invoiceNumber: 'INV-9999',
    accountId: 'client_1',
    contractId: 'maintenance-test',
    contractType: 'maintenance',
    issueDate: '2026-10-26',
    subtotalCents: 10000,
    retainerCreditCents: 3000,
    serviceDiscountCents: 1000,
    discountCents: 4000,
    amountCents: 6000,
    lineItems: [{ type: 'labor', description: 'Labor', quantity: 1, unitPriceCents: 10000 }],
  }, { name: 'Test Client', address: '1 Test St' });

  assert.equal(buffer.subarray(0, 4).toString(), '%PDF');
  assert.notEqual(buffer.toString(), 'stale cached PDF');
});

test('invoice PDF renders city names with ordinary fi glyphs', async () => {
  const city = 'Broomfield, CO 80020';
  const buffer = await pdf.generateInvoicePdfBuffer({
    invoiceNumber: 'INV-9000', issueDate: '2026-10-26', amountCents: 5000,
    serviceAddress: `12 Service Street, ${city}`,
    lineItems: [{ type: 'labor', description: 'Labor', quantity: 1, unitPriceCents: 5000 }],
  }, { name: 'Test Client', address: `1 Billing Street, ${city}` });
  const document = await PDFDocument.load(buffer);
  document.registerFontkit(fontkit);
  const fontBytes = readFileSync(path.join(temporaryRoot, 'fonts', 'stix-two-text-bold.ttf'));
  const normalFont = await document.embedFont(fontBytes, { features: { liga: false } });
  const ligatureFont = await document.embedFont(fontBytes);
  const normalEncoding = normalFont.encodeText(city).toString();
  const ligatureEncoding = ligatureFont.encodeText(city).toString();
  assert.notEqual(normalEncoding, ligatureEncoding);
  const page = document.getPage(0);
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray() : [contents];
  const decoded = streams.map(ref => document.context.lookup(ref))
    .filter(stream => stream instanceof PDFRawStream)
    .map(stream => Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1'))
    .join('\n');
  assert.equal(decoded.split(normalEncoding).length - 1, 2);
  assert.equal(decoded.includes(ligatureEncoding), false);
});

test('invoice PDF regenerates cached copies for addresses containing fi', async () => {
  const invoicesDirectory = path.join(temporaryRoot, 'invoices');
  mkdirSync(invoicesDirectory, { recursive: true });
  writeFileSync(path.join(invoicesDirectory, 'StickmanHandyman_9998.pdf'), 'stale cached PDF');
  const buffer = await pdf.getInvoicePdfBuffer({
    invoiceNumber: 'INV-9998', issueDate: '2026-10-26', amountCents: 5000,
    lineItems: [{ type: 'labor', description: 'Labor', quantity: 1, unitPriceCents: 5000 }],
  }, { name: 'Test Client', address: '1 Main Street, Broomfield, CO 80020' });
  assert.equal(buffer.subarray(0, 4).toString(), '%PDF');
});

test('standard package maintenance allowances match published package terms', () => {
  const packageTerms = [
    ['single_home', 'basic', 2, 0, 0],
    ['single_home', 'pro', 2, 1, 5],
    ['single_home', 'premium', 4, 2, 10],
    ['portfolio', 'basic', 4, 0, 0],
    ['portfolio', 'pro', 6, 2, 5],
    ['portfolio', 'premium', 10, 4, 10],
  ];
  packageTerms.forEach(([packageType, packageLevel, retainerHours, rolloverHours, discountPercent]) => {
    assert.deepEqual(
      maintenanceBilling.getMaintenanceContractTerms({ packageType, packageLevel }),
      { retainerHours, rolloverHours, discountPercent },
    );
  });
});

test('maintenance contracts match one active normalized service address only', () => {
  const contract = { id: 'maint-1', accountId: 'client_1', contractType: 'maintenance', status: 'active', startDate: '2026-01-01', serviceAddress: '12 Main St' };
  assert.equal(maintenanceBilling.findMaintenanceContractForAddress([contract], 'client_1', ' 12 MAIN ST '), contract);
  assert.equal(maintenanceBilling.findMaintenanceContractForAddress([contract], 'client_2', '12 Main St'), null);
  assert.equal(maintenanceBilling.findMaintenanceContractForAddress([{ ...contract, status: 'draft' }], 'client_1', '12 Main St'), null);
  assert.equal(maintenanceBilling.findMaintenanceContractForAddress([contract, { ...contract, id: 'maint-2' }], 'client_1', '12 Main St'), null);
});

test('custom maintenance coverage defaults to one home and can be changed to a portfolio', async () => {
  const { default: express } = await import(pathToFileURL(path.join(isolatedBackend, 'node_modules/express/index.js')));
  const { config } = await import(pathToFileURL(path.join(isolatedBackend, 'src/config.js')));
  const { contractsRouter } = await import(pathToFileURL(path.join(isolatedBackend, 'src/routes/contracts.js')));
  const session = store.issueAdminSession(store.getAdminUserByEmail(config.adminBootstrapEmail));
  const app = express();
  app.use(express.json());
  app.use('/contracts', contractsRouter);
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const origin = `http://127.0.0.1:${server.address().port}/contracts`;
  const headers = { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' };
  let contract;
  try {
    const created = await fetch(origin, { method: 'POST', headers, body: JSON.stringify({
      clientId: 'client_1', contractType: 'maintenance', status: 'active', packageType: 'custom',
      packageMonthlyCostCents: 25000, packageRetainerHours: 3, serviceAddress: '1 Custom Home',
      startDate: '2026-01-01',
    }) });
    assert.equal(created.status, 201);
    contract = (await created.json()).contract;
    const client = { address: '1 Custom Home', businesses: [{ address: '2 Custom Business' }] };
    assert.equal(contract.packageCoverageType, 'single_home');
    assert.equal(maintenanceBilling.contractCoversServiceAddress(contract, '2 Custom Business', client), false);
    const response = await fetch(`${origin}/${contract.id}`, { method: 'PATCH', headers, body: JSON.stringify({ packageCoverageType: 'portfolio' }) });
    assert.equal(response.status, 200);
    const updated = (await response.json()).contract;
    assert.equal(updated.packageCoverageType, 'portfolio');
    assert.equal(store.getContractById(contract.id).packageCoverageType, 'portfolio');
    assert.equal(maintenanceBilling.contractCoversServiceAddress(updated, '2 Custom Business', client), true);
    assert.equal(maintenanceBilling.contractCoversServiceAddress(updated, 'Unlisted Address', client), true);
    assert.equal(maintenanceBilling.findContractsForInvoiceAddress([updated], updated.accountId, 'Unlisted Address', '2026-11-08', client).length, 1);
    assert.equal(maintenanceBilling.findContractsForInvoiceAddress([updated], 'another-account', 'Unlisted Address', '2026-11-08', client).length, 0);
    assert.equal(updated.packageMonthlyCostCents, 25000);
    assert.equal(updated.packageRetainerHours, 3);
    const invalid = await fetch(`${origin}/${contract.id}`, { method: 'PATCH', headers, body: JSON.stringify({ packageCoverageType: 'invalid' }) });
    assert.equal(invalid.status, 400);
  } finally {
    if (contract) store.deleteContract(contract.id);
    await new Promise(resolve => server.close(resolve));
  }
});

test('contract cycle boundaries clamp month ends and respect billing cycle lengths', () => {
  const contract = { startDate: '2026-01-31', billingCycle: 'monthly' };
  assert.equal(maintenanceBilling.getContractPeriodIndex(contract, '2026-02-27'), 0);
  assert.equal(maintenanceBilling.getContractPeriodIndex(contract, '2026-02-28'), 1);
  assert.equal(maintenanceBilling.getContractPeriodIndex(contract, '2026-03-31'), 2);
  assert.equal(maintenanceBilling.getContractPeriodIndex({ startDate: '2026-01-31', billingCycle: 'quarterly' }, '2026-04-29'), 0);
  assert.equal(maintenanceBilling.getContractPeriodIndex({ startDate: '2026-01-31', billingCycle: 'quarterly' }, '2026-04-30'), 1);
});

test('date-only invoice eligibility uses the Colorado payment day', () => {
  const contract = {
    contractType: 'maintenance', packageType: 'single_home', packageLevel: 'basic',
    startDate: '2026-11-07', billingCycle: 'monthly',
    lastPaymentAt: '2026-11-09T04:00:14.577Z', nextPaymentDueAt: '2026-12-07',
  };
  assert.equal(maintenanceBilling.isMaintenanceContractBillingPeriodPaid(contract, '2026-11-07'), false);
  assert.equal(maintenanceBilling.isMaintenanceContractBillingPeriodPaid(contract, '2026-11-08'), true);
  assert.equal(maintenanceBilling.isMaintenanceContractBillingPeriodPaid(contract, '2026-12-06'), true);
  assert.equal(maintenanceBilling.isMaintenanceContractBillingPeriodPaid(contract, '2026-12-07'), false);
  assert.equal(maintenanceBilling.isMaintenanceContractBillingPeriodPaid({ ...contract, stripeSubscriptionStatus: 'past_due' }, '2026-11-08'), false);
  assert.equal(maintenanceBilling.isMaintenanceContractBillingPeriodPaid(contract, '2026-11-09T03:59:00.000Z'), false);
});

test('editing an invoice corrects false eligibility only when payment preceded creation', () => {
  const contract = {
    id: 'paid-edit', accountId: 'paid-client', contractType: 'maintenance', status: 'active',
    packageType: 'portfolio', packageLevel: 'pro', serviceAddress: 'Paid Edit Address',
    startDate: '2026-11-07', billingCycle: 'monthly',
    lastPaymentAt: '2026-11-09T04:00:14.577Z', nextPaymentDueAt: '2026-12-07',
  };
  const invoice = {
    id: 'edit-invoice', accountId: contract.accountId, contractId: contract.id, status: 'sent',
    serviceAddress: contract.serviceAddress, issueDate: '2026-11-08', createdAt: '2026-11-09T04:05:06.386Z',
    contractPooledHoursEligible: false, includedHoursApplied: 0, contractJobHours: 0,
    contractorHours: [{ hours: 5 }], lineItems: [{ type: 'labor', quantity: 5, unitPriceCents: 8000 }],
  };
  const input = {
    contracts: [contract], invoices: [invoice], accountId: invoice.accountId,
    contractId: contract.id, invoiceId: invoice.id, issueDate: invoice.issueDate,
    serviceAddress: invoice.serviceAddress, contractorHours: invoice.contractorHours,
    lineItems: invoice.lineItems, contractPooledHoursEligible: false,
  };
  const corrected = contractInvoiceBilling.getInvoiceContractPricingInput(input);
  assert.equal(corrected.contractPooledHoursEligible, true);
  assert.equal(corrected.includedHoursApplied, 5);
  assert.equal(corrected.retainerCreditCents, 40000);
  assert.equal(corrected.amountCents, 0);

  const beforePayment = { ...invoice, createdAt: '2026-11-09T03:59:00.000Z' };
  const unpaid = contractInvoiceBilling.getInvoiceContractPricingInput({ ...input, invoices: [beforePayment] });
  assert.equal(unpaid.contractPooledHoursEligible, false);
  assert.equal(unpaid.includedHoursApplied, 0);
});

test('maintenance hours are shared elapsed hours, allocated FIFO, with rollover capped per cycle', () => {
  const contract = {
    id: 'maint-pool', contractType: 'maintenance', status: 'active', startDate: '2026-01-01', billingCycle: 'monthly',
    packageRetainerHours: 2, packageRolloverHours: 1, packageDiscountPercent: 0,
  };
  const invoices = [
    { id: 'jan-1', contractId: contract.id, issueDate: '2026-01-05', status: 'sent', contractorHours: [{ hours: 0.5 }, { hours: 0.25 }] },
    { id: 'feb-1', contractId: contract.id, issueDate: '2026-02-05', status: 'sent', contractorHours: [{ hours: 2.5 }, { hours: 1.5 }] },
    { id: 'mar-1', contractId: contract.id, issueDate: '2026-03-05', status: 'sent', contractorHours: [{ hours: 4 }, { hours: 2 }] },
    { id: 'voided', contractId: contract.id, issueDate: '2026-03-10', status: 'void', contractorHours: [{ hours: 3 }] },
  ];
  const allocations = maintenanceBilling.allocateMaintenanceContractHours(contract, invoices);
  assert.equal(allocations.get('jan-1').jobHours, 0.5);
  assert.equal(allocations.get('jan-1').includedHours, 0.5);
  assert.equal(allocations.get('feb-1').includedHours, 2.5);
  assert.equal(allocations.get('mar-1').includedHours, 2.5);
  assert.equal(allocations.has('voided'), false);
});

test('maintenance balance includes capped rollover through unused cycles and excludes future usage', () => {
  const contract = {
    id: 'balance', accountId: 'balance-client', contractType: 'maintenance', status: 'active', startDate: '2026-01-31',
    billingCycle: 'monthly', packageType: 'single_home', packageLevel: 'basic', serviceAddress: '12 Main St', packageRetainerHours: 4, packageRolloverHours: 2,
    lastPaymentAt: '2026-03-30T12:00:00.000Z', nextPaymentDueAt: '2026-04-30T00:00:00.000Z',
  };
  assert.equal(maintenanceBilling.calculateMaintenanceContractSummary(contract, [], '2026-01-30').remainingHours, 0);
  assert.equal(maintenanceBilling.calculateMaintenanceContractSummary(contract, [], '2026-01-31').remainingHours, 4);
  assert.deepEqual(maintenanceBilling.calculateMaintenanceContractSummary(contract, [], '2026-03-31'), {
    periodIndex: 2, retainerHours: 4, rolloverHours: 2, availableHours: 6, usedHours: 0, remainingHours: 6,
  });
  const invoices = [
    { id: 'legacy', accountId: contract.accountId, serviceAddress: ' 12 MAIN ST ', issueDate: '2026-03-31', status: 'paid', contractorHours: [{ hours: 2.5 }, { hours: 1 }] },
    { id: 'future', contractId: contract.id, issueDate: '2026-04-02', status: 'sent', contractJobHours: 10 },
    { id: 'void', contractId: contract.id, issueDate: '2026-03-31', status: 'void', contractJobHours: 10 },
    { id: 'ongoing', contractId: contract.id, issueDate: '2026-03-31', status: 'ongoing', contractJobHours: 10 },
  ];
  const summary = contractInvoiceBilling.getMaintenanceContractSummary(contract, invoices, null, '2026-03-31');
  assert.equal(summary.usedHours, 2.5);
  assert.equal(summary.remainingHours, 3.5);
  const nextInvoice = { id: 'next', accountId: contract.accountId, serviceAddress: contract.serviceAddress, issueDate: '2026-03-31', contractJobHours: 8 };
  const pricing = contractInvoiceBilling.calculateContractInvoicePricing({
    contract, invoice: nextInvoice, invoices, client: null,
    lineItems: [{ type: 'labor', quantity: 8, unitPriceCents: 8000 }],
  });
  assert.equal(pricing.includedHoursApplied, summary.remainingHours);
  assert.equal(pricing.retainerCreditCents, 28000);
  assert.equal(maintenanceBilling.calculateMaintenanceContractSummary({ ...contract, packageRolloverHours: 6 }, [], '2026-03-31').remainingHours, 10);
  assert.equal(contractInvoiceBilling.getMaintenanceContractSummary(contract, invoices, null, '2026-04-30').remainingHours, 4);
  assert.equal(maintenanceBilling.calculateMaintenanceContractSummary({ ...contract, packageRolloverHours: 0 }, [], '2026-03-31').remainingHours, 4);
});

test('maintenance pool only deducts hours actually credited on saved invoices', () => {
  const contract = {
    id: 'pool-credits', accountId: 'pool-client', contractType: 'maintenance', status: 'active',
    packageType: 'single_home', packageLevel: 'basic', serviceAddress: '1 Pool Street',
    startDate: '2026-11-01', billingCycle: 'monthly', packageRetainerHours: 4, packageRolloverHours: 0,
    lastPaymentAt: '2026-11-10T12:00:00.000Z', nextPaymentDueAt: '2026-12-01T00:00:00.000Z',
  };
  const invoices = [
    { id: 'unpaid', contractId: contract.id, issueDate: '2026-11-02', status: 'sent', contractJobHours: 3, contractPooledHoursEligible: false, includedHoursApplied: 0 },
    { id: 'legacy-no-credit', contractId: contract.id, issueDate: '2026-11-03', status: 'sent', contractJobHours: 2, includedHoursApplied: 0 },
    { id: 'credited', contractId: contract.id, issueDate: '2026-11-11', status: 'sent', contractJobHours: 3, includedHoursApplied: 1 },
  ];
  const summary = contractInvoiceBilling.getMaintenanceContractSummary(contract, invoices, null, '2026-11-12');
  assert.equal(summary.usedHours, 1);
  assert.equal(summary.remainingHours, 3);

  const nextInvoice = { id: 'next', accountId: contract.accountId, serviceAddress: contract.serviceAddress, issueDate: '2026-11-12', contractJobHours: 3 };
  const pricing = contractInvoiceBilling.calculateContractInvoicePricing({
    contract, invoice: nextInvoice, invoices, client: null,
    lineItems: [{ type: 'labor', quantity: 3, unitPriceCents: 8000 }],
  });
  assert.equal(pricing.includedHoursApplied, 3);
  assert.equal(pricing.retainerCreditCents, 24000);

  const legacy = { id: 'legacy', contractId: contract.id, issueDate: '2026-11-04', status: 'sent', contractJobHours: 2 };
  assert.equal(maintenanceBilling.calculateMaintenanceContractSummary(contract, [legacy], '2026-11-12').usedHours, 2);
});

test('maintenance credits consume included time before discounting remaining labor only', () => {
  const discount = maintenanceBilling.calculateMaintenanceContractDiscountCents([
    { quantity: 1, unitPriceCents: 20000 },
    { quantity: 2, unitPriceCents: 8000 },
  ], 1, 10);
  assert.equal(discount, 21600);
});

test('associated business invoices share portfolio hours only after that period is paid', () => {
  const client = store.createClient({
    name: 'Portfolio Owner',
    address: '1 Home Street, Boulder, CO',
    businesses: [{ name: 'Portfolio Works LLC', address: '99 Business Park, Boulder, CO' }],
  });
  const business = client.businesses[0];
  const contract = store.createContract({
    clientId: client.id, contractType: 'maintenance', status: 'active', packageType: 'portfolio', packageLevel: 'basic',
    billingCycle: 'monthly', startDate: '2026-10-01', serviceAddress: client.address,
    packageRetainerHours: 2, packageRolloverHours: 0, packageDiscountPercent: 0,
  });
  const invoiceIds = [];
  try {
    assert.ok(business.id);
    store.updateContract(contract.id, { lastPaymentAt: '2026-10-02T12:00:00.000Z', lastPaymentAmountCents: 30000, nextPaymentDueAt: '2026-11-01T00:00:00.000Z' });
    const paidPeriodInvoice = store.createInvoice({
      accountId: client.id, billingBusinessId: business.id, issueDate: '2026-10-10', serviceAddress: 'Unlisted Portfolio Job Address',
      contractorHours: [{ contractorId: owner.contractorId, hours: 3, hourlyRateCents: 8000 }],
      lineItems: [{ type: 'labor', description: 'Business labor', quantity: 3, unitPriceCents: 8000 }],
    });
    invoiceIds.push(paidPeriodInvoice.id);
    assert.equal(paidPeriodInvoice.billingEntityName, business.name);
    assert.equal(paidPeriodInvoice.billingEntityAddress, business.address);
    assert.equal(paidPeriodInvoice.contractId, contract.id);
    assert.equal(paidPeriodInvoice.contractPooledHoursEligible, true);
    assert.equal(paidPeriodInvoice.includedHoursApplied, 2);

    const unpaidPeriodInvoice = store.createInvoice({
      accountId: client.id, billingBusinessId: business.id, issueDate: '2026-11-05', serviceAddress: business.address,
      contractorHours: [{ contractorId: owner.contractorId, hours: 1, hourlyRateCents: 8000 }],
      lineItems: [{ type: 'labor', description: 'Business labor', quantity: 1, unitPriceCents: 8000 }],
    });
    invoiceIds.push(unpaidPeriodInvoice.id);
    assert.equal(unpaidPeriodInvoice.contractPooledHoursEligible, false);
    assert.equal(unpaidPeriodInvoice.includedHoursApplied, 0);
    assert.equal(unpaidPeriodInvoice.retainerCreditCents, 0);

    store.updateContract(contract.id, { lastPaymentAt: '2026-11-11T04:00:00.000Z', lastPaymentAmountCents: 30000, nextPaymentDueAt: '2026-12-01T00:00:00.000Z' });
    const afterPaymentInput = {
      accountId: client.id, billingBusinessId: business.id, issueDate: '2026-11-10', serviceAddress: business.address,
      contractorHours: [{ contractorId: owner.contractorId, hours: 2, hourlyRateCents: 8000 }],
      lineItems: [{ type: 'labor', description: 'Business labor', quantity: 2, unitPriceCents: 8000 }],
    };
    const preview = store.previewInvoiceContractPricing(afterPaymentInput);
    assert.equal(preview.contractPooledHoursEligible, true);
    assert.equal(preview.includedHoursApplied, 2);
    const afterPaymentInvoice = store.createInvoice(afterPaymentInput);
    invoiceIds.push(afterPaymentInvoice.id);
    assert.equal(afterPaymentInvoice.contractPooledHoursEligible, true);
    assert.equal(afterPaymentInvoice.includedHoursApplied, 2);
  } finally {
    invoiceIds.forEach((invoiceId) => store.deleteInvoice(invoiceId));
    store.deleteContract(contract.id);
    store.deleteClient(client.id);
  }
});

test('address-matched maintenance invoice uses prior shared hours before discounting labor', () => {
  const contract = {
    id: 'maintenance-address', accountId: 'client_1', contractType: 'maintenance', status: 'active',
    packageType: 'single_home', packageLevel: 'pro', serviceAddress: '123 Main St',
    startDate: '2026-10-01', billingCycle: 'monthly', packageRetainerHours: 2,
    packageRolloverHours: 1, packageDiscountPercent: 5, lastPaymentAt: '2026-10-02T12:00:00.000Z',
  };
  const previousInvoice = {
    id: 'previous-service', accountId: 'client_1', status: 'sent', issueDate: '2026-10-05',
    serviceAddress: '123 Main St', contractJobHours: 1, lineItems: [{ type: 'labor', quantity: 1, unitPriceCents: 8000 }],
  };
  const pricing = contractInvoiceBilling.getInvoiceContractPricingInput({
    contracts: [contract], invoices: [previousInvoice], accountId: 'client_1',
    serviceAddress: '123 Main St', issueDate: '2026-10-10',
    contractorHours: [{ contractorId: 'contractor_owner', hours: 2, hourlyRateCents: 8000 }],
    lineItems: [{ type: 'labor', description: 'Labor', quantity: 2, unitPriceCents: 8000 }, { type: 'material', description: 'Materials', quantity: 1, unitPriceCents: 5000 }],
  });
  assert.equal(pricing.contractId, contract.id);
  assert.equal(pricing.includedHoursApplied, 1);
  assert.equal(pricing.retainerCreditCents, 8000);
  assert.equal(pricing.serviceDiscountCents, 400);
  assert.equal(pricing.amountCents, 12600);
  assert.equal(pricing.billingPeriodIndex, 0);
});

test('created invoices persist maintenance credits and consume the shared pool in order', () => {
  const contract = store.createContract({
    clientId: 'client_1', contractType: 'maintenance', status: 'active', packageType: 'single_home', packageLevel: 'pro',
    billingCycle: 'monthly', startDate: '2026-10-01', serviceAddress: '123 Main St, Boulder, CO',
    packageRetainerHours: 2, packageRolloverHours: 1, packageDiscountPercent: 5, lastPaymentAt: '2026-10-02T12:00:00.000Z',
  });
  store.updateContract(contract.id, { lastPaymentAt: '2026-10-02T12:00:00.000Z' });
  const firstInvoice = store.createInvoice({
    accountId: 'client_1', contractId: contract.id, issueDate: '2026-10-05', serviceAddress: contract.serviceAddress,
    contractorHours: [{ contractorId: 'contractor_owner', hours: 4, hourlyRateCents: 8000 }],
    lineItems: [{ type: 'labor', description: 'Labor', quantity: 4, unitPriceCents: 8000 }], amountCents: 32000,
  });
  assert.equal(firstInvoice.contractId, contract.id);
  assert.equal(firstInvoice.contractJobHours, 4);
  assert.equal(firstInvoice.includedHoursApplied, 2);
  assert.equal(firstInvoice.retainerCreditCents, 16000);
  assert.equal(firstInvoice.serviceDiscountCents, 800);
  assert.equal(firstInvoice.amountCents, 15200);

  const secondInvoice = store.createInvoice({
    accountId: 'client_1', contractId: contract.id, issueDate: '2026-10-10', serviceAddress: contract.serviceAddress,
    contractorHours: [{ contractorId: 'contractor_owner', hours: 1, hourlyRateCents: 8000 }],
    lineItems: [{ type: 'labor', description: 'Labor', quantity: 1, unitPriceCents: 8000 }], amountCents: 8000,
  });
  assert.equal(secondInvoice.contractId, contract.id);
  assert.equal(secondInvoice.includedHoursApplied, 0);
  assert.equal(secondInvoice.serviceDiscountCents, 400);
  assert.equal(secondInvoice.amountCents, 7600);
});

test('same-day maintenance invoices consume one shared retainer pool in creation order', () => {
  const contract = store.createContract({
    clientId: 'client_1', contractType: 'maintenance', status: 'active',
    packageType: 'portfolio', packageLevel: 'premium', billingCycle: 'monthly',
    startDate: '2026-10-26', serviceAddress: 'Pool Regression Address, Boulder, CO',
    packageRetainerHours: 10, packageRolloverHours: 0, packageDiscountPercent: 10, lastPaymentAt: '2026-10-26T00:00:00.000Z',
  });
  store.updateContract(contract.id, { lastPaymentAt: '2026-10-26T00:00:00.000Z' });
  const makeInvoice = (hours) => store.createInvoice({
    accountId: 'client_1', contractId: contract.id, issueDate: '2026-10-26', serviceAddress: contract.serviceAddress,
    contractorHours: [{ contractorId: 'contractor_owner', hours, hourlyRateCents: 8000 }],
    lineItems: [{ type: 'labor', description: 'Labor', quantity: hours, unitPriceCents: 8000 }],
  });

  const firstInvoice = makeInvoice(9);
  const secondInput = {
    accountId: 'client_1', contractId: contract.id, issueDate: '2026-10-26', serviceAddress: contract.serviceAddress,
    contractorHours: [{ contractorId: 'contractor_owner', hours: 5, hourlyRateCents: 8000 }],
    lineItems: [{ type: 'labor', description: 'Labor', quantity: 5, unitPriceCents: 8000 }],
  };
  const secondPreview = store.previewInvoiceContractPricing(secondInput);
  assert.equal(secondPreview.includedHoursApplied, 1);
  assert.equal(secondPreview.retainerCreditCents, 8000);
  assert.equal(secondPreview.serviceDiscountCents, 3200);

  const secondInvoice = makeInvoice(5);
  assert.equal(firstInvoice.includedHoursApplied, 9);
  assert.equal(secondInvoice.includedHoursApplied, 1);
  assert.equal(secondInvoice.retainerCreditCents, 8000);
  assert.equal(secondInvoice.serviceDiscountCents, 3200);
  assert.equal(secondInvoice.amountCents, 28800);
});

test('contract pricing preview and saved invoice agree on maintenance credits', () => {
  const contract = store.createContract({
    clientId: 'client_1', contractType: 'maintenance', status: 'active', packageType: 'single_home', packageLevel: 'basic',
    billingCycle: 'monthly', startDate: '2026-01-01', serviceAddress: '99 Preview Road, Boulder, CO', lastPaymentAt: '2026-10-10T12:00:00.000Z',
    packageRetainerHours: 1, packageRolloverHours: 0, packageDiscountPercent: 0,
  });
  store.updateContract(contract.id, { lastPaymentAt: '2026-10-10T12:00:00.000Z' });
  const input = {
    accountId: 'client_1', contractId: contract.id, issueDate: '2026-10-19', serviceAddress: contract.serviceAddress,
    contractorHours: [{ contractorId: 'contractor_owner', hours: 2, hourlyRateCents: 8000 }],
  };
  const preview = store.previewInvoiceContractPricing(input);
  const invoice = store.createInvoice(input);
  assert.equal(invoice.contractId, contract.id);
  assert.equal(invoice.amountCents, preview.amountCents);
  assert.equal(invoice.includedHoursApplied, 1);
  assert.equal(invoice.amountCents, 8000);
});

test('maintenance invoice preview resolves contractor rates when the request omits them', () => {
  const contract = store.createContract({
    clientId: 'client_1', contractType: 'maintenance', status: 'active', packageType: 'single_home', packageLevel: 'pro',
    billingCycle: 'monthly', startDate: '2026-10-01', serviceAddress: 'Rate preview address, Boulder, CO',
    packageRetainerHours: 2, packageRolloverHours: 0, packageDiscountPercent: 5, lastPaymentAt: '2026-10-02T12:00:00.000Z',
  });
  store.updateContract(contract.id, { lastPaymentAt: '2026-10-02T12:00:00.000Z' });
  const invoiceInput = {
    accountId: 'client_1', contractId: contract.id, issueDate: '2026-10-26', serviceAddress: contract.serviceAddress,
    contractorHours: [{ contractorId: owner.contractorId, hours: 3 }],
  };
  const preview = store.previewInvoiceContractPricing(invoiceInput);
  const invoice = store.createInvoice(invoiceInput);

  assert.equal(preview.subtotalCents, 24000);
  assert.equal(preview.includedHoursApplied, 2);
  assert.equal(preview.retainerCreditCents, 16000);
  assert.equal(preview.serviceDiscountCents, 400);
  assert.equal(preview.amountCents, invoice.amountCents);
});

test('automatic maintenance matching refuses ambiguous addresses and ignores future contracts', () => {
  const contract = { id: 'future', accountId: 'client_1', contractType: 'maintenance', status: 'active', serviceAddress: '123 Main St', startDate: '2027-01-01', packageType: 'single_home', packageLevel: 'basic' };
  const input = { contracts: [contract], invoices: [], accountId: 'client_1', serviceAddress: '123 Main St', issueDate: '2026-10-01', lineItems: [] };
  assert.equal(contractInvoiceBilling.getInvoiceContractPricingInput(input).contractId, null);
  const matches = [{ ...contract, startDate: '2026-01-01' }, { ...contract, id: 'second', startDate: '2026-02-01' }];
  assert.match(contractInvoiceBilling.getInvoiceContractPricingInput({ ...input, contracts: matches }).error, /more than one active contract/i);
});

test('maintenance and labor contracts receive distinct independently advancing numbers', () => {
  const maintenanceNext = Number(store.getNextContractNumber('maintenance').match(/\d+$/)?.[0]);
  const laborNext = Number(store.getNextContractNumber('labor').match(/\d+$/)?.[0]);
  const maintenance = store.createContract({
    clientId: 'client_1', contractType: 'maintenance', status: 'draft', packageType: 'single_home', packageLevel: 'basic',
    billingCycle: 'monthly', serviceAddress: '987 Numbering Test Way',
  });
  const labor = store.createContract({
    clientId: 'client_1', contractType: 'labor', status: 'draft', title: 'Numbering Test', scope: 'Test scope',
    serviceAddress: '987 Numbering Test Way', laborPricingModel: 'fixed', laborFixedAmountCents: 10000,
  });

  try {
    assert.equal(maintenance.contractNumber, `MCON-${maintenanceNext}`);
    assert.equal(labor.contractNumber, `LCON-${laborNext}`);
    assert.notEqual(maintenance.contractNumber, labor.contractNumber);
    assert.equal(store.getNextContractNumber('maintenance'), `MCON-${maintenanceNext + 1}`);
    assert.equal(store.getNextContractNumber('labor'), `LCON-${laborNext + 1}`);
  } finally {
    store.deleteContract(maintenance.id);
    store.deleteContract(labor.id);
  }
});

test('labor contracts enforce quoted price balances and track hourly estimates', () => {
  const previous = [{ id: 'prior', contractId: 'labor-fixed', status: 'sent', amountCents: 30000 }];
  const fixed = { id: 'labor-fixed', accountId: 'client_1', contractType: 'labor', status: 'active', startDate: '2026-01-01', serviceAddress: '123 Main St', laborPricingModel: 'fixed', laborFixedAmountCents: 100000 };
  const base = { contracts: [fixed], invoices: previous, accountId: 'client_1', serviceAddress: '123 Main St', issueDate: '2026-10-19', lineItems: [{ type: 'labor', quantity: 1, unitPriceCents: 40000 }] };
  assert.equal(contractInvoiceBilling.getInvoiceContractPricingInput({ ...base, requestedAmountCents: 30000 }).amountCents, 30000);
  assert.match(contractInvoiceBilling.getInvoiceContractPricingInput({ ...base, requestedAmountCents: 70001 }).error, /exceeds the labor contract balance/i);
  const hourly = { ...fixed, id: 'labor-hourly', laborPricingModel: 'hourly_estimate', laborFixedAmountCents: null, laborEstimatedHours: 6 };
  const estimate = contractInvoiceBilling.getInvoiceContractPricingInput({
    ...base,
    contracts: [hourly],
    invoices: [{ ...previous[0], contractId: hourly.id }],
    contractorHours: [{ contractorId: 'worker-a', hours: 0.5 }, { contractorId: 'worker-b', hours: 1 }],
    requestedAmountCents: 40000,
  });
  assert.equal(estimate.error, undefined);
  assert.equal(estimate.amountCents, 40000);
  assert.equal(estimate.contractEstimatedHours, 6);
  assert.equal(estimate.contractActualHours, 1.5);
  assert.equal(estimate.contractRemainingHours, 4.5);
});

test('hourly contract estimates use each contractor rate and preserve the rate snapshot', () => {
  const estimateRows = [{ ...owner, hours: 2 }, { ...first, hours: 1 }];
  assert.deepEqual(repository.calculateContractorLaborEstimate(estimateRows), {
    estimatedHours: 3,
    estimatedAmountCents: 22000,
  });
  const contract = store.createContract({
    clientId: 'client_1', contractType: 'labor', title: 'Mixed-rate project', scope: 'Two-person crew',
    serviceAddress: '123 Main St, Boulder, CO', laborPricingModel: 'hourly_estimate',
    laborEstimatedContractorHours: estimateRows,
    laborEstimatedMaterialsItems: [{ amountCents: 10000 }, { amountCents: 2500 }],
    laborEstimatedOtherItems: [{ description: 'Permit', amountCents: 4500 }],
  });
  assert.equal(contract.laborEstimatedHours, 3);
  assert.equal(contract.laborEstimatedAmountCents, 22000);
  assert.equal(contract.laborEstimatedMaterialsCents, 12500);
  assert.deepEqual(contract.laborEstimatedMaterialsItems, [{ amountCents: 12500 }]);
  assert.equal(contract.laborEstimatedOtherAmountCents, 4500);
  assert.equal(maintenanceBilling.calculateLaborContractSummary(contract, []).estimatedTotalAmountCents, 39000);
  assert.deepEqual(contract.laborEstimatedContractorHours.map((entry) => entry.hourlyRateCents), [8000, 5000]);
  const updated = store.updateContract(contract.id, {
    laborEstimatedOtherItems: [{ description: 'Permit', amountCents: 5000 }],
  });
  assert.equal(updated.laborEstimatedOtherAmountCents, 5000);
  assert.equal(maintenanceBilling.calculateLaborContractSummary(updated, []).estimatedTotalAmountCents, 39500);
  const updatedMaterials = store.updateContract(contract.id, {
    laborEstimatedMaterialsItems: [{ amountCents: 9000 }, { amountCents: 4000 }],
  });
  assert.equal(updatedMaterials.laborEstimatedMaterialsCents, 13000);
  assert.deepEqual(updatedMaterials.laborEstimatedMaterialsItems, [{ amountCents: 13000 }]);
  assert.equal(maintenanceBilling.calculateLaborContractSummary(updatedMaterials, []).estimatedTotalAmountCents, 40000);
});

test('saved fixed-bid invoices accumulate progress and reject amounts above the balance', () => {
  const contract = store.createContract({
    clientId: 'client_1', contractType: 'labor', status: 'active', title: 'Kitchen remodel', scope: 'Cabinet installation',
    serviceAddress: '123 Main St, Boulder, CO', startDate: '2026-10-01', billingCycle: 'monthly',
    laborPricingModel: 'fixed', laborFixedAmountCents: 100000,
  });
  assert.equal(contract.billingCycle, null);
  const createProgressInvoice = (amountCents) => store.createInvoice({
    accountId: 'client_1', contractId: contract.id, serviceAddress: contract.serviceAddress,
    contractorHours: [owner], lineItems: [{ type: 'labor', description: 'Progress', quantity: 1, unitPriceCents: amountCents }], amountCents,
  });
  assert.equal(createProgressInvoice(40000).contractBalanceCents, 60000);
  assert.equal(createProgressInvoice(60000).contractBalanceCents, 0);
  assert.throws(() => createProgressInvoice(1), /exceeds the labor contract balance/i);
});

test('saved labor contract invoices retain their explicit contract link', () => {
  const contract = store.createContract({
    clientId: 'client_1', contractType: 'labor', status: 'active', title: 'Deck rebuild', scope: 'Replace deck boards',
    serviceAddress: '123 Main St, Boulder, CO', startDate: '2026-10-01', billingCycle: 'monthly',
    laborPricingModel: 'fixed', laborFixedAmountCents: 20000,
  });
  const invoice = store.createInvoice({
    accountId: 'client_1', contractId: contract.id, serviceAddress: contract.serviceAddress,
    contractorHours: [owner], lineItems: [{ type: 'labor', description: 'Progress', quantity: 1, unitPriceCents: 10000 }], amountCents: 10000,
  });
  assert.equal(invoice.contractId, contract.id);
  assert.equal(invoice.contractType, 'labor');
  assert.equal(invoice.contractBalanceCents, 10000);
});

test('editing a progress invoice does not count its prior amount against its own quoted balance', () => {
  const contract = { id: 'edit-labor', accountId: 'client_1', contractType: 'labor', status: 'active', startDate: '2026-01-01', serviceAddress: '123 Main St', laborPricingModel: 'fixed', laborFixedAmountCents: 100000 };
  const existingInvoice = { id: 'progress-1', contractId: contract.id, accountId: 'client_1', status: 'sent', amountCents: 60000, issueDate: '2026-10-01', serviceAddress: contract.serviceAddress };
  const pricing = contractInvoiceBilling.calculateContractInvoicePricing({
    contract,
    invoice: { ...existingInvoice, amountCents: 50000, lineItems: [{ type: 'labor', quantity: 1, unitPriceCents: 50000 }] },
    invoices: [existingInvoice],
    lineItems: [{ type: 'labor', quantity: 1, unitPriceCents: 50000 }],
    requestedAmountCents: 50000,
  });
  assert.equal(pricing.error, undefined);
  assert.equal(pricing.contractBalanceCents, 50000);
});

test('maintenance agreement PDFs contain package-specific coverage, benefits, and rules', async () => {
  const client = {
    name: 'Maintenance Client', address: '1 Home Street',
    serviceAddresses: ['2 Rental Street'],
    businesses: [{ name: 'Client Business', address: '3 Business Street', serviceAddresses: ['4 Shop Street'] }],
  };
  const packages = [
    ['single_home', 'basic', 16000, 2, 0, 0],
    ['single_home', 'pro', 20000, 2, 1, 5],
    ['single_home', 'premium', 35000, 4, 2, 10],
    ['portfolio', 'basic', 30000, 4, 0, 0],
    ['portfolio', 'pro', 40000, 6, 2, 5],
    ['portfolio', 'premium', 70000, 10, 4, 10],
    ['custom', null, 25000, 3, 1, 7],
    ['custom', null, 25000, 3, 1, 7, 'portfolio'],
  ];
  for (const [packageType, packageLevel, monthlyPrice, hours, rollover, discount, coverageType = 'single_home'] of packages) {
    const custom = packageType === 'custom';
    const portfolio = packageType === 'portfolio' || (custom && coverageType === 'portfolio');
    const contract = {
      contractType: 'maintenance', contractNumber: 'MCON-9001', serviceAddress: client.address,
      startDate: '2026-11-07', billingCycle: custom ? 'quarterly' : 'monthly', packageType, packageLevel,
      ...(custom ? {
        packageCoverageType: coverageType,
        packageMonthlyCostCents: monthlyPrice, packageRetainerHours: hours,
        packageRolloverHours: rollover, packageDiscountPercent: discount,
        packagePriorityScheduling: true, packageTenantCoordination: true,
      } : {}),
    };
    const buffer = await contractPdf.generateContractPdfBuffer(contract, client);
    const document = await PDFDocument.load(buffer);
    assert.equal(document.getPageCount(), 2, `${packageType}/${packageLevel}: compact agreement should fit two pages`);
    const pageLines = document.getPages().map(page => {
      const contents = page.node.Contents();
      const streams = contents instanceof PDFArray ? contents.asArray() : [contents];
      return streams.map(ref => document.context.lookup(ref))
        .filter(stream => stream instanceof PDFRawStream)
        .flatMap(stream => [...Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1').matchAll(/<([\da-f]+)>\s*Tj/gi)]
          .map(match => Buffer.from(match[1], 'hex').toString('latin1')));
    });
    const text = pageLines.flat().join(' ');
    const sectionTitles = new Set([
      'Client and Service Property', 'Client and Account', 'Package and Billing', 'Included Services',
      'Portfolio Account Coverage', 'Service Property Coverage', 'Retainer Hours and Rollover',
      'Labor, Materials, and Service Discount', 'Scheduling, Inspections, and Access',
      'Scope, Exclusions, and Approved Changes', 'Billing and Contract Changes', 'Approval',
    ]);
    let sectionPage = null;
    let activeSection = '';
    pageLines.forEach((lines, pageIndex) => lines.forEach(line => {
      if (sectionTitles.has(line)) {
        sectionPage = pageIndex;
        activeSection = line;
      } else if (sectionPage !== null && !/^Page \d+ of \d+$/.test(line)) {
        assert.equal(pageIndex, sectionPage, `${packageType}/${packageLevel}: ${activeSection} must stay on one page`);
      }
    }));
    assert.ok(text.includes('MAINTENANCE SERVICE AGREEMENT'));
    assert.ok(text.includes('MCON-9001'));
    assert.ok(text.includes(`Amount per billing cycle: $${((custom ? monthlyPrice * 3 : monthlyPrice) / 100).toFixed(2)}`));
    assert.ok(text.includes(`Retainer hours per cycle: ${hours}`));
    assert.ok(text.includes(`Maximum rollover hours: ${rollover}`));
    assert.ok(text.includes(`Service discount: ${discount}%`));
    assert.ok(text.includes('standard two-hour service minimum is waived'));
    assert.ok(text.includes('payment has been recorded for the invoice billing period'));
    assert.ok(text.includes('not automatically credited by a later payment'));
    assert.ok(text.includes('longest individual crew attendance'));
    assert.ok(text.includes('Materials, parts, and other non-labor charges'));
    assert.ok(text.includes('Scope, Exclusions, and Approved Changes'));
    assert.ok(text.includes('Billing and Contract Changes'));
    assert.ok(text.includes('Client signature'));
    assert.equal(text.includes('Portfolio Account Coverage'), portfolio);
    assert.equal(text.includes('1 Home Street'), !portfolio);
    assert.equal(text.includes('All maintenance work under this client account'), portfolio);
    assert.equal(text.includes('3 Business Street'), false);
    assert.equal(text.includes('4 Shop Street'), false);
    assert.equal(text.includes('2 Rental Street'), false);
    if (custom) assert.ok(text.includes(`Package: Custom ${portfolio ? 'Portfolio' : 'Single Home'}`));
    assert.equal(text.includes('Priority scheduling is included'), custom || packageLevel !== 'basic');
    assert.equal(text.includes('Annual home inspection'), !custom && packageLevel !== 'basic');
    assert.equal(text.includes('Quarterly home inspection'), packageLevel === 'premium');
    assert.equal(text.includes('On-call service is included'), packageLevel === 'premium');
    assert.equal(text.includes('Tenant coordination is included'), custom || (packageType === 'portfolio' && packageLevel !== 'basic'));
    assert.ok(text.includes(`Page ${document.getPageCount()} of ${document.getPageCount()}`));
  }
});

test('portfolio agreements omit all property addresses even for large accounts', async () => {
  const addresses = Array.from({ length: 90 }, (_, index) => `${index + 1} Portfolio Street, Boulder, CO 80301`);
  const buffer = await contractPdf.generateContractPdfBuffer({
    contractType: 'maintenance', contractNumber: 'MCON-9002', packageType: 'portfolio',
    packageLevel: 'premium', billingCycle: 'monthly', startDate: '2026-11-07', serviceAddress: addresses[0],
  }, { name: 'Large Portfolio Client', address: addresses[0], serviceAddresses: addresses });
  const document = await PDFDocument.load(buffer);
  const allLines = document.getPages().flatMap(page => {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray() : [contents];
    const lines = streams.map(ref => document.context.lookup(ref))
      .filter(stream => stream instanceof PDFRawStream)
      .flatMap(stream => [...Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1').matchAll(/<([\da-f]+)>\s*Tj/gi)]
        .map(match => Buffer.from(match[1], 'hex').toString('latin1')));
    return lines;
  });
  assert.ok(allLines.includes('Portfolio Account Coverage'));
  assert.ok(allLines.join(' ').includes('Coverage is account-wide'));
  addresses.forEach(address => assert.equal(allLines.includes(address), false, address));
  assert.ok(allLines.includes('Client signature'));
});

test('labor contract agreement PDF generates from saved quote and estimate details', async () => {
  const contract = store.createContract({
    clientId: 'client_1', contractType: 'labor', title: 'Deck rebuild', scope: 'Replace deck boards and stairs',
    serviceAddress: '123 Main St, Boulder, CO', laborPricingModel: 'hourly_estimate',
    laborEstimatedContractorHours: [{ ...owner, hours: 3 }],
    laborEstimatedMaterialsItems: [{ amountCents: 12000 }],
    laborEstimatedOtherItems: [{ description: 'Permit', amountCents: 2500 }],
  });
  const buffer = await contractPdf.generateContractPdfBuffer(contract, store.getClientById('client_1'));
  const generatedPdf = await (await import('pdf-lib')).PDFDocument.load(buffer);
  assert.ok(generatedPdf.getPageCount() >= 1);
  assert.equal(buffer.subarray(0, 4).toString(), '%PDF');
  assert.equal(contractPdf.contractPdfFileName(contract.contractNumber), `StickmanHandyman_${contract.contractNumber}_Agreement.pdf`);
});