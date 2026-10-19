import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const backendRoot = fileURLToPath(new URL('../', import.meta.url));
const projectRoot = path.dirname(backendRoot.replace(/[\\/]$/, ''));
const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'stickman-billing-test-'));
const isolatedBackend = path.join(temporaryRoot, 'backend');
mkdirSync(isolatedBackend);
cpSync(path.join(backendRoot, 'src'), path.join(isolatedBackend, 'src'), { recursive: true });
cpSync(path.join(backendRoot, 'package.json'), path.join(isolatedBackend, 'package.json'));
cpSync(path.join(backendRoot, 'node_modules'), path.join(isolatedBackend, 'node_modules'), { recursive: true });
after(() => rmSync(temporaryRoot, { recursive: true, force: true }));

mkdirSync(path.join(isolatedBackend, 'data'));
writeFileSync(path.join(isolatedBackend, 'data/contractors.json'), JSON.stringify({ contractors: [], timeEntries: [], ongoingJobs: [], invoiceHours: [], paymentTransactions: [] }));
const originalDirectory = process.cwd();
process.chdir(isolatedBackend);
const repository = await import(pathToFileURL(path.join(isolatedBackend, 'src/services/contractorRepository.js')));
const store = await import(pathToFileURL(path.join(isolatedBackend, 'src/services/store.js')));
const pdf = await import(pathToFileURL(path.join(isolatedBackend, 'src/services/invoicePdf.js')));
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
    const invoice = store.createInvoice({ accountId: 'client_1', contractorHours: entries });
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
  assert.equal(store.createInvoice({ accountId: 'client_1', contractorHours: entries }).amountCents, previewTotal);
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
  const invoice = store.createInvoice({ accountId: 'client_1', contractorHours: entries });
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
  const invoice = store.createInvoice({ accountId: 'client_1', contractorHours: [owner, first] });
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