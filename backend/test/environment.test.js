import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { test } from 'node:test';
import vm from 'node:vm';
import { getLocalStripeEnvironment } from '../../scripts/local-stripe.mjs';
import { apiErrorHandler, apiRequestContext, denyPrivateStaticPaths } from '../src/middleware/api.js';

const source = readFileSync(new URL('../../portal-shared.js', import.meta.url), 'utf8');

test('admin startup binds contract and contractor creation buttons and Cancel dismissal', async () => {
  const html = readFileSync(new URL('../../portal-admin.html', import.meta.url), 'utf8');
  const elements = new Map();
  const documentListeners = new Map();
  function makeElement() {
    const listeners = new Map();
    const classes = new Set();
    return {
      value: '', dataset: {}, style: {}, innerHTML: '', textContent: '',
      classList: {
        add: value => classes.add(value), remove: value => classes.delete(value),
        contains: value => classes.has(value),
        toggle: (value, enabled) => enabled ? classes.add(value) : classes.delete(value),
      },
      addEventListener: (type, handler) => listeners.set(type, [...(listeners.get(type) || []), handler]),
      dispatchEvent(event) { for (const handler of listeners.get(event.type) || []) handler(event); },
      setAttribute(name, value) { this[name] = value; },
      focus() { this.focused = true; },
      querySelectorAll: () => [], querySelector: () => null, reset() {},
    };
  }
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) elements.set(match[1], makeElement());
  const fields = new Map();
  for (const match of html.matchAll(/<(?:input|select|textarea)\b([^>]+)>/g)) {
    const name = /\bname="([^"]+)"/.exec(match[1])?.[1];
    const id = /\bid="([^"]+)"/.exec(match[1])?.[1];
    if (name) fields.set(name, elements.get(id) || makeElement());
  }
  for (const [id, element] of elements) {
    if (id.startsWith('form-')) element.elements = Object.assign(Object.fromEntries(fields), { namedItem: name => fields.get(name) });
  }
  const document = {
    getElementById: id => elements.get(id) || null,
    querySelectorAll: () => [], querySelector: () => null,
    body: { style: {} },
    addEventListener: (type, handler) => documentListeners.set(type, [...(documentListeners.get(type) || []), handler]),
  };
  const context = vm.createContext({
    document, Event: class { constructor(type) { this.type = type; } },
    window: {
      StickmanPortal: {
        initTopnav() {}, populateStateSelects() {}, readAdminToken: () => 'test-token',
        readApiBase: () => 'http://localhost:8080',
        fetchAdminSnapshot: () => new Promise(() => {}),
      },
    },
  });
  for (const file of ['js/admin/invoices.js', 'js/admin/contractors.js', 'js/admin/clients.js', 'js/admin/contracts.js', 'js/portal-admin.js']) {
    vm.runInContext(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'), context, { filename: file });
  }
  for (const [buttonId, modalId, type] of [
    ['new-contract-btn', 'modal-new-contract', 'maintenance'],
    ['new-labor-contract-btn', 'modal-new-contract', 'labor'],
    ['new-contractor-btn', 'modal-contractor', null],
  ]) {
    elements.get(buttonId).dispatchEvent({ type: 'click' });
    assert.equal(elements.get(modalId).style.display, 'flex', buttonId);
    if (type) assert.equal(fields.get('contractType').value, type);
    const target = { dataset: { closeModal: modalId }, closest: selector => selector === '[data-close-modal]' ? target : null };
    for (const handler of documentListeners.get('click') || []) handler({ target });
    assert.equal(elements.get(modalId).style.display, 'none', `Cancel ${modalId}`);
  }
  vm.runInContext("allClients = [{ id: 'target', name: 'Owner', address: 'Home' }, { id: 'source', name: 'Business', address: 'Office' }]; populateClientMergeSourceSelect(allClients[0]);", context);
  const mergeSection = elements.get('client-merge-section');
  const showMerge = elements.get('show-client-merge-button');
  assert.equal(mergeSection.hidden, true);
  assert.equal(showMerge.hidden, false);
  assert.equal(showMerge.disabled, false);
  elements.get('show-client-merge-button').dispatchEvent({ type: 'click' });
  assert.equal(mergeSection.hidden, false);
  assert.equal(showMerge['aria-expanded'], 'true');
  assert.equal(elements.get('client-merge-source-select').focused, true);
  assert.match(elements.get('client-merge-source-select').innerHTML, /Business/);
  assert.doesNotMatch(elements.get('client-merge-source-select').innerHTML, /value="target"/);
  elements.get('new-client-btn').dispatchEvent({ type: 'click' });
  assert.equal(mergeSection.hidden, true);
  assert.equal(showMerge.hidden, true);
  assert.equal(showMerge.disabled, true);

  context.requests = [];
  context.refreshes = [];
  context.alerts = [];
  context.window.confirm = () => true;
  context.window.alert = message => context.alerts.push(message);
  vm.runInContext(`
    allContracts = [
      { id: 'maintenance/id', contractNumber: 'MCON-1', contractType: 'maintenance' },
      { id: 'labor-id', contractNumber: 'LCON-1', contractType: 'labor' },
    ];
    apiFetch = async (path, options) => {
      requests.push({ path, method: options.method });
      return { ok: !path.includes('labor-id'), json: async () => ({ error: 'Cancel autopay first.' }) };
    };
    loadContracts = async () => { refreshes.push('contracts'); };
    loadSummary = async () => { refreshes.push('summary'); };
  `, context);
  const clickRemove = contractId => {
    const target = { dataset: { deleteContract: contractId }, closest: selector => selector === '[data-delete-contract]' ? target : null };
    for (const handler of documentListeners.get('click') || []) handler({ target });
  };
  context.window.confirm = () => false;
  clickRemove('maintenance/id');
  assert.equal(context.requests.length, 0);
  context.window.confirm = () => true;
  clickRemove('maintenance/id');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.requests[0].path, '/api/contracts/maintenance%2Fid');
  assert.equal(context.requests[0].method, 'DELETE');
  assert.deepEqual(context.refreshes, ['contracts', 'summary']);
  clickRemove('labor-id');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.requests[1].path, '/api/contracts/labor-id');
  assert.match(context.alerts[0], /Cancel autopay first/);

  context.views = [];
  vm.runInContext(`
    openPdfModal = (id, type) => { views.push({ id, type }); };
    renderContractsTable();
  `, context);
  assert.match(elements.get('contracts-tbody').innerHTML, /data-view-contract="maintenance\/id"/);
  assert.match(elements.get('mobile-contracts-list').innerHTML, /data-view-contract="maintenance\/id"/);
  const viewTarget = { dataset: { viewContract: 'maintenance/id' }, closest: selector => selector === '[data-view-contract]' ? viewTarget : null };
  for (const handler of documentListeners.get('click') || []) handler({ target: viewTarget });
  assert.equal(context.views.length, 1);
  assert.equal(context.views[0].id, 'maintenance/id');
  assert.equal(context.views[0].type, 'contract');

  context.savedContracts = [];
  context.FormData = class {
    get(name) { const field = fields.get(name); return field?.checked ? 'on' : field?.value || ''; }
  };
  context.window.setTimeout = handler => handler();
  vm.runInContext(`
    allContracts = [{ id: 'custom-portfolio', contractNumber: 'MCON-2', contractType: 'maintenance',
      accountId: 'target', serviceAddress: 'Home', packageType: 'custom', packageCoverageType: 'portfolio',
      packageMonthlyCostCents: 25000, packageRetainerHours: 3 }];
    populateLaborEstimateRows = () => {};
    populateLaborEstimateMaterialsItems = () => {};
    populateLaborEstimateOtherItems = () => {};
    openContractEditor('custom-portfolio');
    apiFetch = async (path, options) => { savedContracts.push({ path, ...JSON.parse(options.body) }); return { ok: true, json: async () => ({}) }; };
  `, context);
  assert.equal(elements.get('contract-package-coverage-type').value, 'portfolio');
  assert.equal(elements.get('contract-package-coverage-type').required, true);
  assert.equal(elements.get('contract-custom-package-fields').classList.contains('hidden'), false);
  assert.equal(vm.runInContext("invoiceContractCoversAddress(allContracts[0], { businesses: [{ address: 'Office' }] }, 'Office')", context), true);
  assert.equal(vm.runInContext("invoiceContractCoversAddress(allContracts[0], null, 'Unlisted Job Address')", context), true);
  assert.equal(vm.runInContext("invoiceContractCoversAddress({ ...allContracts[0], packageType: 'portfolio' }, null, 'Unlisted Job Address')", context), true);
  assert.match(vm.runInContext('contractPackageLabel(allContracts[0])', context), /Custom Portfolio/);
  elements.get('form-new-contract').dispatchEvent({ type: 'submit', preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.savedContracts[0].path, '/api/contracts/custom-portfolio');
  assert.equal(context.savedContracts[0].packageCoverageType, 'portfolio');
  assert.equal(context.savedContracts[0].packageMonthlyCostCents, 25000);
  vm.runInContext("delete allContracts[0].packageCoverageType; openContractEditor('custom-portfolio');", context);
  assert.equal(elements.get('contract-package-coverage-type').value, 'single_home');
  assert.equal(vm.runInContext("invoiceContractCoversAddress(allContracts[0], { businesses: [{ address: 'Office' }] }, 'Office')", context), false);

  context.URL = URL;
  context.generatedUrl = `https://www.stickman-handyman.com/sign-contract.html#token=${'a'.repeat(43)}`;
  context.copiedLinks = [];
  context.refreshCopyCounts = [];
  context.navigator = { clipboard: { writeText: async value => { context.copiedLinks.push(value); } } };
  elements.get('contract-signing-link').select = function () { this.selected = true; };
  vm.runInContext(`
    activeAttachmentContractId = 'custom-portfolio';
    apiFetch = async () => ({ ok: true, json: async () => ({ attachment: { id: 'generated-test' }, signingUrl: generatedUrl }) });
    loadContracts = async () => { refreshCopyCounts.push(copiedLinks.length); };
  `, context);
  for (const origin of ['http://127.0.0.1:8080', 'http://localhost:8127', 'http://[::1]:8128', 'https://www.stickman-handyman.com']) {
    context.window.location = new URL(`${origin}/portal-admin.html`);
    await vm.runInContext("createGeneratedContractSigningLink(document.getElementById('generate-contract-signing-link-btn'))", context);
    assert.equal(context.copiedLinks.at(-1), `${origin}/sign-contract.html#token=${'a'.repeat(43)}`);
    assert.equal(context.refreshCopyCounts.at(-1), context.copiedLinks.length);
    assert.equal(elements.get('contract-signing-link-copy').hidden, true);
    assert.match(elements.get('contract-attachments-message').textContent, /copied to clipboard/);
  }
  context.window.location = new URL('http://127.0.0.1:8080/portal-admin.html');
  context.navigator.clipboard.writeText = async () => { throw new Error('Clipboard blocked'); };
  document.execCommand = command => {
    assert.equal(command, 'copy');
    context.copiedLinks.push(elements.get('contract-signing-link').value);
    return true;
  };
  await vm.runInContext("createGeneratedContractSigningLink(document.getElementById('generate-contract-signing-link-btn'))", context);
  assert.equal(context.copiedLinks.at(-1), `http://127.0.0.1:8080/sign-contract.html#token=${'a'.repeat(43)}`);
  assert.equal(elements.get('contract-signing-link').selected, true);
  assert.equal(elements.get('contract-signing-link-copy').hidden, true);
  assert.match(elements.get('contract-attachments-message').textContent, /copied to clipboard/);
  document.execCommand = () => false;
  await vm.runInContext("createGeneratedContractSigningLink(document.getElementById('generate-contract-signing-link-btn'))", context);
  assert.equal(elements.get('contract-signing-link-copy').hidden, false);
  assert.match(elements.get('contract-attachments-message').textContent, /blocked automatic copying/);
  assert.equal(elements.get('generate-contract-signing-link-btn').disabled, false);
});

test('signing page uses shared website navigation and its mobile menu', async () => {
  const html = readFileSync(new URL('../../sign-contract.html', import.meta.url), 'utf8');
  assert.match(html, /id="nav-placeholder"/);
  assert.match(html, /id="footer-placeholder"/);
  assert.match(html, /src="load-components.js"/);
  assert.match(html, /css\/navigation.css/);
  const placeholders = new Map([['nav-placeholder', {}], ['footer-placeholder', {}]]);
  const events = new Map();
  const classes = new Set();
  const toggle = { addEventListener: (type, handler) => events.set('toggle', handler), setAttribute(name, value) { this[name] = value; } };
  const company = { addEventListener: (type, handler) => events.set('company', handler) };
  const topnav = {
    contains: target => target === toggle,
    classList: { toggle: value => classes.has(value) ? classes.delete(value) : classes.add(value), contains: value => classes.has(value), remove: value => classes.delete(value) },
  };
  const context = vm.createContext({
    fetch: async name => ({ text: async () => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8') }),
    window: { matchMedia: () => ({ matches: true }) },
    document: {
      getElementById: id => placeholders.get(id),
      querySelector: selector => ({ '.menu-toggle': toggle, '.topnav': topnav, '.logo-bubble a': company })[selector],
      addEventListener: (type, handler) => events.set('outside', handler),
    },
  });
  vm.runInContext(readFileSync(new URL('../../load-components.js', import.meta.url), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  for (const page of ['home.html', 'gallery.html', 'maintenance-packages.html', 'portal-find.html', 'contact.html']) {
    assert.ok(placeholders.get('nav-placeholder').innerHTML.includes(page));
  }
  assert.ok(placeholders.get('footer-placeholder').innerHTML);
  events.get('toggle')({ stopPropagation() {} });
  assert.equal(toggle['aria-expanded'], 'true');
  events.get('outside')({ target: {} });
  assert.equal(toggle['aria-expanded'], 'false');
});

test('signing page fits signed copies to the desktop page and mobile width without extra controls', async () => {
  const html = readFileSync(new URL('../../sign-contract.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /id="(?:print|open|download)-signed-document"/);
  const signingSource = readFileSync(new URL('../../js/sign-contract.js', import.meta.url), 'utf8');
  for (const [scenario, mobile] of [['complete', false], ['reopen', false], ['retry', false], ['complete', true], ['reopen', true]]) {
    const elements = new Map();
    const handlers = new Map();
    const requests = [];
    const revoked = [];
    let failedDownload = false;
    for (const match of html.matchAll(/\bid="([^"]+)"/g)) {
      const id = match[1];
      const classes = new Set();
      elements.set(id, {
        value: '', hidden: false, disabled: false, checked: false,
        classList: { add: value => classes.add(value), toggle: (value, enabled) => enabled ? classes.add(value) : classes.delete(value) },
        addEventListener: (type, handler) => handlers.set(`${id}:${type}`, handler),
        getContext: () => ({}),
      });
    }
    const receipt = { signed: true, signedAt: '2026-11-09T12:00:00.000Z', fileName: 'Agreement_signed.pdf' };
    const context = vm.createContext({
      URLSearchParams,
      URL: { createObjectURL: blob => `blob:${blob.label}`, revokeObjectURL: value => revoked.push(value) },
      window: { location: { hash: `#token=${'a'.repeat(43)}`, origin: 'http://localhost:8080' }, matchMedia: () => ({ matches: mobile }) },
      document: {
        getElementById: id => elements.get(id),
        querySelector: () => ({ value: 'typed' }), querySelectorAll: () => [],
      },
      fetch: async (url, options) => {
        const path = url.split('/').at(-1);
        requests.push({ path, body: JSON.parse(options.body) });
        if (path === 'inspect') return { ok: true, json: async () => ({
          request: { signerName: 'Test Client', status: scenario === 'reopen' ? 'completed' : 'pending', signedAt: receipt.signedAt, expiresAt: '2026-11-20T12:00:00.000Z' },
          contract: { contractNumber: 'MCON-1' }, document: { fileName: scenario === 'reopen' ? receipt.fileName : 'Agreement.pdf' },
        }) };
        if (path === 'complete') return { ok: true, json: async () => receipt };
        if (path === 'signed-document' && scenario === 'retry' && !failedDownload) {
          failedDownload = true;
          return { ok: false, json: async () => ({ error: 'Download unavailable' }) };
        }
        return { ok: true, blob: async () => ({ label: path === 'signed-document' ? 'signed' : 'unsigned' }) };
      },
    });
    vm.runInContext(signingSource, context);
    await new Promise(resolve => setImmediate(resolve));
    if (scenario !== 'reopen') {
      assert.equal(elements.get('document-preview').src, 'blob:unsigned#view=FitH&toolbar=0&navpanes=0');
      elements.get('signature-text').value = 'Test Client';
      elements.get('signature-consent').checked = true;
      await handlers.get('signature-form:submit')({ preventDefault() {} });
      assert.equal(elements.get('signature-form').hidden, true);
      assert.equal(elements.get('submit-signature-button').disabled, true);
      assert.ok(revoked.includes('blob:unsigned'));
    } else {
      assert.equal(requests.some(request => ['document', 'complete'].includes(request.path)), false);
    }
    if (scenario === 'retry') {
      assert.equal(elements.get('document-preview').src, 'about:blank');
      assert.equal(elements.get('retry-signed-document').hidden, false);
      assert.match(elements.get('signing-status').textContent, /signature is saved/);
      handlers.get('retry-signed-document:click')();
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(elements.get('document-preview').src, `blob:signed#view=${mobile ? 'FitH' : 'Fit'}&toolbar=0&navpanes=0`);
    assert.equal(requests.filter(request => request.path === 'complete').length, scenario === 'reopen' ? 0 : 1);
  }
});

test('business editor uses structured address fields and preserves address formatting', () => {
  const rows = [];
  const portal = portalFor('http://localhost:8080/portal-admin.html');
  let populatedStates = false;
  const context = vm.createContext({
    portal: {
      parseClientAddress: portal.parseClientAddress,
      formatClientAddress: portal.formatClientAddress,
      populateStateSelects: () => { populatedStates = true; },
    },
    $: id => ['client-businesses-container', 'client-service-addresses-container'].includes(id) ? { appendChild: row => rows.push(row) } : null,
    esc: value => String(value),
    document: {
      querySelectorAll: () => rows,
      createElement: () => {
        const controls = new Map([
          ['[data-business-id]', { value: 'business-test' }],
          ['[data-business-name]', { value: 'Business LLC' }],
          ['.client-business-remove-btn', { addEventListener() {} }],
          ['.client-service-address-remove-btn', { addEventListener() {} }],
        ]);
        const parts = ['street', 'city', 'state', 'zip'].map(part => ({ dataset: { addressPart: part }, value: '' }));
        return { querySelector: selector => controls.get(selector), querySelectorAll: () => parts };
      },
    },
  });
  vm.runInContext(readFileSync(new URL('../../js/admin/clients.js', import.meta.url), 'utf8'), context);
  vm.runInContext("addClientBusinessRow({ id: 'business-test', name: 'Business LLC', address: '123 Main St, Boulder, CO 80301' });", context);
  assert.equal(populatedStates, true);
  for (const part of ['street', 'city', 'state', 'zip']) assert.ok(rows[0].innerHTML.includes(`data-address-part="${part}"`));
  assert.ok(rows[0].innerHTML.includes('data-state-select'));
  assert.equal(vm.runInContext('getClientBusinesses()[0].address', context), '123 Main St, Boulder, CO 80301');
  vm.runInContext("addClientServiceAddressRow('123 Main St, Boulder, CO 80301');", context);
  const serviceMarkup = rows[1].innerHTML;
  assert.ok(serviceMarkup.includes('>Service Address <input'));
  assert.ok(!serviceMarkup.includes('Street Address'));
  assert.ok(!serviceMarkup.includes('<h4'));
  assert.ok(serviceMarkup.indexOf('client-service-address-remove-btn') > serviceMarkup.lastIndexOf('</div>'));
});

function portalFor(url, saved = {}) {
  const entries = new Map(Object.entries(saved));
  const context = vm.createContext({
    window: { location: new URL(url) },
    localStorage: {
      getItem: key => entries.get(key) ?? null,
      setItem: (key, value) => entries.set(key, value),
      removeItem: key => entries.delete(key),
    },
  });
  vm.runInContext(source, context);
  return context.window.StickmanPortal;
}

for (const origin of ['http://localhost:8080', 'http://127.0.0.1:8127', 'http://[::1]:8080']) {
  test(`${origin} uses its local API proxy despite stale production overrides`, () => {
    const portal = portalFor(`${origin}/portal-admin.html`, {
      stickmanPortalApiBase: 'https://api.stickman-handyman.com',
      stickmanAdminApiBase: 'https://api.stickman-handyman.com',
    });
    assert.equal(portal.readApiBase(), origin);
  });
}

for (const host of ['stickman-handyman.com', 'www.stickman-handyman.com']) {
  test(`${host} always uses the production API`, () => {
    const portal = portalFor(`https://${host}/portal-admin.html`, {
      stickmanPortalApiBase: 'http://localhost:3000',
    });
    assert.equal(portal.readApiBase(), 'https://api.stickman-handyman.com');
  });
}

test('file previews retain an explicit API override', () => {
  const portal = portalFor('file:///preview/portal-admin.html', { stickmanPortalApiBase: 'http://localhost:3000/' });
  assert.equal(portal.readApiBase(), 'http://localhost:3000');
});

test('local Stripe is disabled unless explicitly enabled, even when credentials are provided', () => {
  assert.deepEqual(getLocalStripeEnvironment({ contents: 'STRIPE_SECRET_KEY=sk_live_fixture\nSTRIPE_PUBLISHABLE_KEY=pk_live_fixture' }), {
    STRIPE_SECRET_KEY: '', STRIPE_PUBLISHABLE_KEY: '', STRIPE_WEBHOOK_SECRET: '',
  });
});

test('local Stripe accepts only test credentials and forwards only Stripe configuration', () => {
  const result = getLocalStripeEnvironment({ enabled: true, nodeEnv: 'development', contents: [
    'STRIPE_SECRET_KEY="sk_test_fixture"',
    'STRIPE_PUBLISHABLE_KEY=pk_test_fixture',
    'STRIPE_WEBHOOK_SECRET=whsec_fixture',
    'STICKMAN_DATA_DIR=production-data',
    'NODE_ENV=production',
  ].join('\n') });
  assert.deepEqual(result, { STRIPE_SECRET_KEY: 'sk_test_fixture', STRIPE_PUBLISHABLE_KEY: 'pk_test_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture' });
  assert.throws(() => getLocalStripeEnvironment({ enabled: true, contents: 'STRIPE_SECRET_KEY=sk_live_fixture\nSTRIPE_PUBLISHABLE_KEY=pk_test_fixture' }), /Live keys are not allowed/);
  assert.throws(() => getLocalStripeEnvironment({ enabled: true, contents: 'STRIPE_SECRET_KEY=sk_test_fixture\nSTRIPE_PUBLISHABLE_KEY=pk_live_fixture' }), /Live keys are not allowed/);
  assert.throws(() => getLocalStripeEnvironment({ enabled: true, contents: '' }), /requires/);
  assert.throws(() => getLocalStripeEnvironment({ enabled: true, nodeEnv: 'production' }), /cannot run in production/);
});

test('mobile API errors are JSON, non-cacheable, traceable, and do not disclose exception details', async (context) => {
  context.mock.method(console, 'error', () => {});
  const app = express();
  app.use('/api', apiRequestContext);
  app.use(express.json({ limit: '100b' }));
  app.post('/api/echo', (req, res) => res.json(req.body));
  app.get('/api/failure', () => { throw new Error('private-fixture-secret'); });
  app.use(apiErrorHandler);
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const invalid = await fetch(`${origin}/api/echo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{invalid' });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, 'Invalid JSON request body.');
    const oversized = await fetch(`${origin}/api/echo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'a'.repeat(200) }) });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).error, 'Request body is too large.');
    const failure = await fetch(`${origin}/api/failure`);
    assert.equal(failure.status, 500);
    assert.equal(failure.headers.get('cache-control'), 'no-store');
    const payload = await failure.json();
    assert.equal(payload.requestId, failure.headers.get('x-request-id'));
    assert.match(payload.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(JSON.stringify(payload).includes('private-fixture-secret'), false);
    const success = await fetch(`${origin}/api/echo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(success.status, 200);
    assert.equal(success.headers.get('cache-control'), 'no-store');
    assert.notEqual(success.headers.get('x-request-id'), payload.requestId);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('backend static files explicitly block private files and hidden directories', async () => {
  const serverSource = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.ok(serverSource.includes("express.static(siteRoot, { dotfiles: 'ignore' })"));
  const directory = mkdtempSync(path.join(tmpdir(), 'stickman-private-files-'));
  mkdirSync(path.join(directory, '.local'));
  mkdirSync(path.join(directory, 'backend/data'), { recursive: true });
  writeFileSync(path.join(directory, '.local/stripe.env'), 'private-fixture');
  writeFileSync(path.join(directory, '.env'), 'private-fixture');
  writeFileSync(path.join(directory, 'backend/data/business.json'), 'private-business-fixture');
  writeFileSync(path.join(directory, 'home.html'), 'public-fixture');
  const app = express();
  app.use(denyPrivateStaticPaths);
  app.use(express.static(directory, { dotfiles: 'ignore' }));
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const privatePath of ['/.local/stripe.env', '/%2elocal/stripe.env', '/.env']) {
      const response = await fetch(`${origin}${privatePath}`);
      assert.equal(response.status, 404);
      assert.equal((await response.text()).includes('private-fixture'), false);
    }
    const privateData = await fetch(`${origin}/backend/data/business.json`);
    assert.equal(privateData.status, 404);
    assert.equal((await privateData.text()).includes('private-business-fixture'), false);
    assert.equal((await fetch(`${origin}/home.html`)).status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});