    const portal = window.StickmanPortal;
    portal.initTopnav();
    portal.populateStateSelects();

    let adminToken = portal.readAdminToken();
    let apiBase = portal.readApiBase();
    let allClients = [];
    let adminInvoices = [];
    let allContracts = [];
    let allContractors = [];
    let contractorPayments = [];
    let ownerHourEntries = [];
    let editingInvoiceId = null;
    let editingClientId = null;
    let editingClientLoginId = null;
    let editingContractId = null;
    let editingContractorId = null;
    let clientSortValue = 'name-asc';
    let invoiceFilterClientId = '';
    let invoiceSortValue = 'issueDate-desc';
    let contractFilterClientId = '';
    let contractFilterStatus = '';
    let contractSortValue = 'startDate-desc';

    const $ = (id) => document.getElementById(id);

    if (window.pdfjsLib) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }

    const pdfModalBackdrop = $('portal-pdf-modal-backdrop');
    const pdfModalCanvas = $('portal-pdf-modal-canvas');
    const pdfModalClose = $('portal-pdf-modal-close');
    const pdfModalDownload = $('portal-pdf-modal-download');
    let pdfRenderTask = null;
    let viewedInvoiceId = null;
    let viewedInvoiceDocument = null;
    let invoicePrintNumber = '';

    pdfModalClose.addEventListener('click', closePdfModal);
    pdfModalDownload.addEventListener('click', async () => {
        if (!viewedInvoiceId || !viewedInvoiceDocument) {
            return;
        }

        pdfModalDownload.disabled = true;
        try {
            const pdfData = await viewedInvoiceDocument.getData();
            const downloadUrl = URL.createObjectURL(new Blob([pdfData], { type: 'application/pdf' }));
            const link = document.createElement('a');
            link.href = downloadUrl;
            link.download = invoicePdfDownloadName(invoicePrintNumber);
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
        } catch (error) {
            console.error('Failed to download invoice PDF:', error);
            window.alert('Unable to download this invoice PDF. Please try again.');
        } finally {
            pdfModalDownload.disabled = false;
        }
    });
    pdfModalBackdrop.addEventListener('click', (event) => {
        if (event.target === pdfModalBackdrop) {
            closePdfModal();
        }
    });

    if (!adminToken || !apiBase) {
        window.location.replace('portal-login.html?reason=admin-session-required');
    }

    $('admin-refresh-btn').addEventListener('click', () => {
        apiBase = portal.readApiBase();
        loadAll();
    });

    $('admin-logout-btn').addEventListener('click', () => {
        portal.clearAdminSession();
        window.location.href = 'portal-login.html';
    });

    document.querySelectorAll('.admin-tab-btn').forEach((button) => {
        button.addEventListener('click', () => setAdminTab(button.dataset.tab));
    });

    function setAdminTab(tab) {
        const currentPanel = document.querySelector('.admin-tab-panel:not([hidden])');
        const nextPanel = $(`admin-tab-panel-${tab}`);
        const scrollPosition = window.scrollY;

        if (currentPanel && nextPanel && currentPanel !== nextPanel) {
            const retainedHeight = Math.max(currentPanel.getBoundingClientRect().height, nextPanel.getBoundingClientRect().height);
            nextPanel.style.minHeight = `${retainedHeight}px`;
        }

        document.querySelectorAll('.admin-tab-btn').forEach((button) => {
            button.classList.toggle('active', button.dataset.tab === tab);
        });
        ['clients', 'invoices', 'contracts', 'contractors'].forEach((name) => {
            $(`admin-tab-panel-${name}`).hidden = name !== tab;
        });

        requestAnimationFrame(() => window.scrollTo(0, scrollPosition));
    }

    $('client-sort-select').addEventListener('change', () => {
        clientSortValue = $('client-sort-select').value;
        renderClientsTable();
    });

    $('invoice-filter-client-select').addEventListener('change', () => {
        invoiceFilterClientId = $('invoice-filter-client-select').value;
        renderInvoicesTable();
    });

    $('invoice-sort-select').addEventListener('change', () => {
        invoiceSortValue = $('invoice-sort-select').value;
        renderInvoicesTable();
    });

    $('contract-filter-client-select').addEventListener('change', () => {
        contractFilterClientId = $('contract-filter-client-select').value;
        renderContractsTable();
    });

    $('contract-filter-status-select').addEventListener('change', () => {
        contractFilterStatus = $('contract-filter-status-select').value;
        renderContractsTable();
    });

    $('contract-sort-select').addEventListener('change', () => {
        contractSortValue = $('contract-sort-select').value;
        renderContractsTable();
    });

    $('contractor-tax-year').addEventListener('change', renderContractors);
    $('contractor-tax-period').addEventListener('change', () => {
        updateContractorTaxPeriodVisibility();
        renderContractors();
    });
    $('contractor-tax-quarter').addEventListener('change', renderContractors);
    $('contractor-tax-month').addEventListener('change', renderContractors);

    $('new-client-btn').addEventListener('click', () => {
        editingClientId = null;
        $('form-new-client').reset();
        resetClientServiceAddressRows();
        $('client-modal-title').textContent = 'New Client';
        $('client-submit-button').textContent = 'Create Client';
        openModal('modal-new-client');
    });
    $('add-client-service-address-btn').addEventListener('click', () => addClientServiceAddressRow());
    $('new-invoice-btn').addEventListener('click', () => {
        editingInvoiceId = null;
        $('form-new-invoice').reset();
        resetInvoiceItemRows();
        $('invoice-contractor-hours-container').innerHTML = '';
        populateInvoiceServiceAddressSelect('');
        setTodayInvoiceIssueDate();
        $('invoice-is-ongoing').disabled = false;
        $('invoice-job-name-wrapper').classList.add('hidden');
        $('invoice-submit-button').textContent = 'Create Invoice';
        $('invoice-modal-title').textContent = 'New Invoice';
        $('invoice-submit-button').textContent = 'Create Invoice';
        openModal('modal-new-invoice');
    });
    $('new-contract-btn').addEventListener('click', () => {
        editingContractId = null;
        $('form-new-contract').reset();
        $('contract-package-level').required = false;
        $('contract-package-level-wrapper').classList.add('hidden');
        $('contract-custom-package-fields').classList.add('hidden');
        $('form-new-contract').elements.namedItem('packageMonthlyCost').required = false;
        $('form-new-contract').elements.namedItem('packageRetainerHours').required = false;
        $('contract-modal-title').textContent = 'New Contract';
        $('contract-submit-button').textContent = 'Create Contract';
        openModal('modal-new-contract');
    });
    $('contract-package-type').addEventListener('change', () => {
        const packageType = $('contract-package-type').value;
        const isCustom = packageType === 'custom';
        const hasStandardPackage = packageType === 'single_home' || packageType === 'portfolio';
        $('contract-package-level-wrapper').classList.toggle('hidden', !hasStandardPackage);
        $('contract-package-level').required = hasStandardPackage;
        $('contract-custom-package-fields').classList.toggle('hidden', !isCustom);
        $('form-new-contract').elements.namedItem('packageMonthlyCost').required = isCustom;
        $('form-new-contract').elements.namedItem('packageRetainerHours').required = isCustom;
        if (isCustom) {
            $('contract-package-level').value = '';
        } else if (hasStandardPackage && !$('contract-package-level').value) {
            $('contract-package-level').value = 'basic';
        }
    });
    $('new-contractor-btn').addEventListener('click', () => openNewContractorForm());
    $('add-materials-row-btn').addEventListener('click', () => addInvoiceItemRow({ type: 'material', description: 'Materials', quantity: 1, unitPriceCents: 0 }));
    $('add-other-row-btn').addEventListener('click', () => addInvoiceItemRow({ type: 'package', description: '', quantity: 1, unitPriceCents: 0 }));

    document.addEventListener('input', (event) => {
        const target = event.target;
        if (target && target.closest('.invoice-item-input')) {
            updateInvoiceTotals();
        }
        if (target && target.id === 'invoice-total-display') {
            if (!Number.isFinite(Number(target.value))) {
                target.value = '0';
            }
            updateInvoiceTotals();
        }
    });

    document.querySelectorAll('[data-close-modal]').forEach((button) => {
        button.addEventListener('click', () => closeModal(button.dataset.closeModal));
    });

    document.querySelectorAll('.admin-modal-backdrop').forEach((backdrop) => {
        backdrop.addEventListener('click', (event) => {
            if (event.target === backdrop) {
                closeModal(backdrop.id);
            }
        });
    });

    $('form-new-client').addEventListener('submit', async (event) => {
        event.preventDefault();
        const data = new FormData($('form-new-client'));
        const billingAddress = formatClientAddress(getClientAddressParts($('client-billing-address')));
        const serviceAddresses = getClientServiceAddressRows();

        try {
            const requestPath = editingClientId ? `/api/clients/${encodeURIComponent(editingClientId)}` : '/api/clients';
            const response = await apiFetch(requestPath, {
                method: editingClientId ? 'PUT' : 'POST',
                body: JSON.stringify({
                    name: String(data.get('name') || '').trim(),
                    address: billingAddress,
                    serviceAddresses,
                }),
            });
            const payload = await response.json();
            if (!response.ok) {
                throw new Error(payload.error || 'Save failed.');
            }
            setMsg('msg-new-client', editingClientId ? 'Client updated.' : 'Client created.', false);
            $('form-new-client').reset();
            resetClientServiceAddressRows();
            editingClientId = null;
            closeModal('modal-new-client');
            await loadClients();
            await loadSummary();
        } catch (error) {
            setMsg('msg-new-client', error.message, true);
        }
    });

    $('form-client-login').addEventListener('submit', async (event) => {
        event.preventDefault();
        const clientId = editingClientLoginId;
        if (!clientId) {
            return;
        }

        const data = new FormData($('form-client-login'));
        const password = String(data.get('password') || '');
        try {
            const response = await apiFetch(`/api/clients/${encodeURIComponent(clientId)}/login`, {
                method: 'PUT',
                body: JSON.stringify({
                    email: String(data.get('email') || '').trim(),
                    ...(password ? { password } : {}),
                }),
            });
            const payload = await response.json();
            if (!response.ok) {
                throw new Error(payload.error || 'Unable to save client login.');
            }

            setMsg('msg-client-login', 'Client login details updated.', false);
            $('form-client-login').reset();
            editingClientLoginId = null;
            window.setTimeout(() => closeModal('modal-client-login'), 900);
            await loadClients();
        } catch (error) {
            setMsg('msg-client-login', error.message, true);
        }
    });

    $('form-new-invoice').addEventListener('submit', async (event) => {
        event.preventDefault();
        const data = new FormData($('form-new-invoice'));
        const lineItems = getInvoiceItemRows();
        const contractorHours = getContractorHoursRows();
        const laborItems = buildContractorLaborItems(contractorHours);
        const editedInvoice = adminInvoices.find((invoice) => invoice.id === editingInvoiceId);
        const legacyLaborInvoice = Boolean(editingInvoiceId && editedInvoice && !Array.isArray(editedInvoice.contractorHours));
        const invoiceItems = legacyLaborInvoice
            ? lineItems
            : [...laborItems, ...lineItems.filter((item) => item.type !== 'labor')];
        const calculatedSubtotal = invoiceItems.reduce((sum, item) => sum + Math.round(Math.max(0, Number(item.quantity || 1)) * Math.max(0, Number(item.unitPriceCents || 0))), 0);
        const finalTotalCents = Math.max(Math.round((Number($('invoice-total-display').value || '0') * 100)), 0);
        const discountCents = Math.max(calculatedSubtotal - finalTotalCents, 0);
        const selectedClientId = String(data.get('clientId') || '');
        const selectedServiceAddress = String(data.get('serviceAddress') || '').trim();
        const isOngoing = data.get('isOngoing') === 'on';
        const jobName = String(data.get('jobName') || '').trim();

        if (isOngoing && !jobName) {
            setMsg('msg-new-invoice', 'Enter a job name for an ongoing job.', true);
            $('invoice-job-name').focus();
            return;
        }

        try {
            const requestPath = editingInvoiceId ? `/api/invoices/${encodeURIComponent(editingInvoiceId)}` : '/api/invoices';
            const response = await apiFetch(requestPath, {
                method: editingInvoiceId ? 'PATCH' : 'POST',
                body: JSON.stringify({
                    accountId: selectedClientId,
                    issueDate: String(data.get('issueDate') || '') || getTodayLocalDate(),
                    jobName,
                    isOngoing,
                    contractorHours: legacyLaborInvoice && contractorHours.length === 0 ? undefined : contractorHours,
                    subtotalCents: calculatedSubtotal,
                    amountCents: finalTotalCents,
                    discountCents,
                    serviceAddress: selectedServiceAddress,
                    lineItems: invoiceItems.map((item) => ({
                        type: item.type,
                        description: String(item.description || '').trim(),
                        quantity: Math.max(0.25, Number(item.quantity || 1)),
                        unitPriceCents: Math.max(0, Math.round(Number(item.unitPriceCents || 0))),
                        taxable: false,
                    })),
                }),
            });
            const payload = await response.json();
            if (!response.ok) {
                const details = payload.details?.fieldErrors
                    ? Object.entries(payload.details.fieldErrors)
                        .flatMap(([field, messages]) => messages.map((message) => `${field}: ${message}`))
                        .join(' ')
                    : '';
                throw new Error([payload.error || 'Create failed.', details].filter(Boolean).join(' '));
            }
            setMsg('msg-new-invoice', editingInvoiceId ? 'Invoice updated.' : 'Invoice created.', false);
            $('form-new-invoice').reset();
            resetInvoiceItemRows();
            $('invoice-contractor-hours-container').innerHTML = '';
            $('invoice-submit-button').textContent = 'Create Invoice';
            editingInvoiceId = null;
            closeModal('modal-new-invoice');
            await loadInvoices();
            await loadContractors();
            await loadSummary();
        } catch (error) {
            setMsg('msg-new-invoice', error.message, true);
        }
    });

    $('form-new-contract').addEventListener('submit', async (event) => {
        event.preventDefault();
        const data = new FormData($('form-new-contract'));
        const contractId = editingContractId;
        const packageType = String(data.get('packageType') || '');
        const isCustomPackage = packageType === 'custom';
        try {
            const response = await apiFetch(contractId ? `/api/contracts/${encodeURIComponent(contractId)}` : '/api/contracts', {
                method: contractId ? 'PATCH' : 'POST',
                body: JSON.stringify({
                    clientId: String(data.get('clientId') || ''),
                    billingCycle: String(data.get('billingCycle') || 'monthly'),
                    startDate: String(data.get('startDate') || '') || undefined,
                    packageType: packageType || undefined,
                    packageLevel: isCustomPackage ? null : String(data.get('packageLevel') || '') || undefined,
                    packageMonthlyCostCents: isCustomPackage
                        ? Math.round(Number(data.get('packageMonthlyCost') || 0) * 100)
                        : undefined,
                    packageRetainerHours: isCustomPackage
                        ? Number(data.get('packageRetainerHours') || 0)
                        : undefined,
                    packageRolloverHours: isCustomPackage
                        ? Number(data.get('packageRolloverHours') || 0)
                        : undefined,
                    packageDiscountPercent: isCustomPackage
                        ? Number(data.get('packageDiscountPercent') || 0)
                        : undefined,
                    packagePriorityScheduling: isCustomPackage && data.get('packagePriorityScheduling') === 'on',
                    packageAnnualInspection: isCustomPackage && data.get('packageAnnualInspection') === 'on',
                    packageQuarterlyInspection: isCustomPackage && data.get('packageQuarterlyInspection') === 'on',
                    packageOnCallService: isCustomPackage && data.get('packageOnCallService') === 'on',
                    packageTenantCoordination: isCustomPackage && data.get('packageTenantCoordination') === 'on',
                }),
            });
            const payload = await response.json();
            if (!response.ok) {
                throw new Error(payload.error || 'Save failed.');
            }
            setMsg('msg-new-contract', contractId ? 'Contract updated.' : 'Contract created.', false);
            $('form-new-contract').reset();
            editingContractId = null;
            window.setTimeout(() => closeModal('modal-new-contract'), 900);
            await loadContracts();
            await loadSummary();
        } catch (error) {
            setMsg('msg-new-contract', error.message, true);
        }
    });

    $('form-contractor').addEventListener('submit', async (event) => {
        event.preventDefault();
        const data = new FormData($('form-contractor'));
        const contractorId = editingContractorId;
        try {
            const response = await apiFetch(contractorId ? `/api/contractors/${encodeURIComponent(contractorId)}` : '/api/contractors', {
                method: contractorId ? 'PATCH' : 'POST',
                body: JSON.stringify({
                    name: String(data.get('name') || '').trim(),
                    hourlyRateCents: Math.round(Number(data.get('hourlyRate') || 0) * 100),
                    status: String(data.get('status') || 'active'),
                }),
            });
            const payload = await response.json();
            if (!response.ok) {
                throw new Error(payload.error || 'Unable to save contractor.');
            }
            closeModal('modal-contractor');
            editingContractorId = null;
            await loadContractors();
        } catch (error) {
            setMsg('msg-contractor', error.message, true);
        }
    });

    loadAll();

    async function loadAll() {
        adminToken = portal.readAdminToken();
        apiBase = portal.readApiBase();
        if (!adminToken || !apiBase) {
            window.location.replace('portal-login.html?reason=admin-session-required');
            return;
        }

        setPageMessage('Loading dashboard...', false);
        try {
            const snapshot = await portal.fetchAdminSnapshot(apiBase, adminToken);
            renderSummary(snapshot.summary || {});
            renderClients(snapshot.clients || []);
            renderInvoices(snapshot.invoices || []);
            renderContracts(snapshot.contracts || []);
            await loadContractors();
            $('admin-greeting-name').textContent = 'Welcome';
            setPageMessage('', false);
        } catch (error) {
            if (error.status === 401 || error.status === 403) {
                portal.clearAdminSession();
                window.location.replace('portal-login.html?reason=session-expired');
                return;
            }

            setPageMessage(error.message || 'Unable to load the admin dashboard right now.', true);
        }
    }

    async function loadSummary() {
        try {
            const snapshot = await portal.fetchAdminSnapshot(apiBase, adminToken);
            renderSummary(snapshot.summary || {});
        } catch (error) {
            if (error.status === 401 || error.status === 403) {
                portal.clearAdminSession();
                window.location.replace('portal-login.html?reason=session-expired');
                return;
            }

            setPageMessage(error.message || 'Unable to refresh dashboard summary right now.', true);
        }
    }

    async function loadClients() {
        try {
            const response = await apiFetch('/api/clients');
            const payload = await response.json();
            if (!response.ok) {
                throw new Error(payload.error || 'Error loading clients.');
            }
            renderClients(payload.clients || []);
        } catch {
            $('clients-tbody').innerHTML = '<tr><td colspan="6" class="admin-empty">Error loading clients.</td></tr>';
        }
    }

    async function loadInvoices() {
        try {
            const response = await apiFetch('/api/invoices');
            const payload = await response.json();
            if (!response.ok) {
                throw new Error(payload.error || 'Error loading invoices.');
            }
            renderInvoices(payload.invoices || []);
        } catch {
            $('invoices-tbody').innerHTML = '<tr><td colspan="6" class="admin-empty">Error loading invoices.</td></tr>';
        }
    }

    async function loadContracts() {
        try {
            const response = await apiFetch('/api/contracts');
            const payload = await response.json();
            if (!response.ok) {
                throw new Error(payload.error || 'Error loading contracts.');
            }
            renderContracts(payload.contracts || []);
        } catch {
            $('contracts-tbody').innerHTML = '<tr><td colspan="6" class="admin-empty">Error loading contracts.</td></tr>';
        }
    }

    async function loadContractors() {
        try {
            const response = await apiFetch('/api/contractors');
            const payload = await response.json();
            if (!response.ok) {
                throw new Error(payload.error || 'Error loading contractors.');
            }
            allContractors = payload.contractors || [];
            contractorPayments = payload.payments || [];
            ownerHourEntries = payload.ownerHours || [];
            renderContractors();
        } catch (error) {
            $('contractors-tbody').innerHTML = '<tr><td colspan="7" class="admin-empty">Error loading contractors.</td></tr>';
            setPageMessage(error.message || 'Unable to load contractors.', true);
        }
    }

    async function updateStatus(entity, id, status) {
        try {
            const path = entity === 'invoice' ? `/api/invoices/${id}` : `/api/contracts/${id}`;
            const response = await apiFetch(path, {
                method: 'PATCH',
                body: JSON.stringify({ status }),
            });
            if (!response.ok) {
                throw new Error('Update failed.');
            }
            if (entity === 'invoice') {
                await loadInvoices();
                await loadContractors();
            } else {
                await loadContracts();
            }
            await loadSummary();
        } catch (error) {
            window.alert('Update failed: ' + error.message);
        }
    }

    function renderSummary(summary) {
        $('admin-summary-strip').innerHTML = [
            { label: 'Total Clients', value: summary.clients, sub: `${summary.activeClients} active` },
            { label: 'Invoices', value: summary.invoices, sub: `${summary.openInvoices} open` },
            { label: 'Contracts', value: summary.contracts, sub: `${summary.activeContracts} active` },
            { label: 'Sent Invoices', value: summary.sentInvoices, sub: 'ready for payment' },
        ].map((entry) => `
            <div class="admin-stat">
                <span class="admin-stat-label">${entry.label}</span>
                <span class="admin-stat-value">${entry.value || 0}</span>
                <span class="admin-stat-sub">${entry.sub}</span>
            </div>
        `).join('');
    }

    function mobileRecordCard(title, subtitle, summary, fields, actions, subtitleIsMarkup = false) {
        const detailRows = fields.map(([label, value]) => `
            <span class="mobile-record-label">${esc(label)}</span>
            <span class="mobile-record-value">${esc(value)}</span>
        `).join('');

        return `
            <details class="mobile-record-card ${subtitleIsMarkup ? 'mobile-record-card-with-status' : ''}">
                <summary>
                    ${subtitleIsMarkup
                        ? `<span class="mobile-record-heading"><span class="mobile-record-title">${esc(title)}</span><span class="mobile-record-subtitle">${subtitle}</span></span>`
                        : `<span class="mobile-record-title">${esc(title)}</span><span class="mobile-record-subtitle">${esc(subtitle)}</span>`}
                    <span class="mobile-record-summary-value">${summary}</span>
                </summary>
                <div class="mobile-record-details">
                    ${detailRows}
                    ${actions ? `<div class="mobile-record-actions">${actions}</div>` : ''}
                </div>
            </details>
        `;
    }

    document.addEventListener('click', (event) => {
        const viewInvoiceButton = event.target.closest('[data-view-invoice]');
        if (viewInvoiceButton) {
            openPdfModal(viewInvoiceButton.dataset.viewInvoice);
            return;
        }

        const editButton = event.target.closest('[data-edit-invoice]');
        if (editButton) {
            openInvoiceEditor(editButton.dataset.editInvoice);
            return;
        }

        const deleteButton = event.target.closest('[data-delete-invoice]');
        if (deleteButton) {
            deleteInvoice(deleteButton.dataset.deleteInvoice);
            return;
        }

        const finalizeInvoiceButton = event.target.closest('[data-finalize-invoice]');
        if (finalizeInvoiceButton) {
            finalizeOngoingInvoice(finalizeInvoiceButton.dataset.finalizeInvoice);
            return;
        }

        const editClientButton = event.target.closest('[data-edit-client]');
        if (editClientButton) {
            openClientEditor(editClientButton.dataset.editClient);
            return;
        }

        const editClientLoginButton = event.target.closest('[data-edit-client-login]');
        if (editClientLoginButton) {
            openClientLoginEditor(editClientLoginButton.dataset.editClientLogin);
            return;
        }

        const viewClientInvoicesButton = event.target.closest('[data-view-client-invoices]');
        if (viewClientInvoicesButton) {
            const clientId = viewClientInvoicesButton.dataset.viewClientInvoices;
            invoiceFilterClientId = clientId;
            $('invoice-filter-client-select').value = clientId;
            renderInvoicesTable();
            setAdminTab('invoices');
            return;
        }

        const deleteClientButton = event.target.closest('[data-delete-client]');
        if (deleteClientButton) {
            deleteClientRecord(deleteClientButton.dataset.deleteClient);
            return;
        }

        const deleteContractorButton = event.target.closest('[data-delete-contractor]');
        if (deleteContractorButton) {
            deleteContractorRecord(deleteContractorButton.dataset.deleteContractor);
            return;
        }

        const editContractButton = event.target.closest('[data-edit-contract]');
        if (editContractButton) {
            openContractEditor(editContractButton.dataset.editContract);
            return;
        }

        const deleteContractButton = event.target.closest('[data-delete-contract]');
        if (deleteContractButton) {
            deleteContractRecord(deleteContractButton.dataset.deleteContract);
            return;
        }

        const editContractorButton = event.target.closest('[data-edit-contractor]');
        if (editContractorButton) {
            openContractorEditor(editContractorButton.dataset.editContractor);
            return;
        }

        const button = event.target.closest('[data-entity][data-id][data-status]');
        if (!button) {
            return;
        }

        updateStatus(button.dataset.entity, button.dataset.id, button.dataset.status);
    });

    function apiFetch(path, options = {}) {
        return fetch(`${apiBase}${path}`, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${adminToken}`,
                ...(options.headers || {}),
            },
        });
    }

    function populateClientSelects(clients) {
        ['invoice-client-select', 'contract-client-select'].forEach((selectId) => {
            const select = $(selectId);
            const previousValue = select.value;
            select.innerHTML = '<option value="">Select a client…</option>'
                + clients.map((client) => `<option value="${esc(client.id)}">${esc(client.name)}</option>`).join('');
            if (previousValue) {
                select.value = previousValue;
            }
        });
    }

    function populateFilterClientSelects(clients) {
        ['invoice-filter-client-select', 'contract-filter-client-select'].forEach((selectId) => {
            const select = $(selectId);
            const previousValue = select.value;
            select.innerHTML = '<option value="">All Clients</option>'
                + clients.map((client) => `<option value="${esc(client.id)}">${esc(client.name)}</option>`).join('');
            select.value = previousValue;
        });
    }

    function sortRows(rows, sortValue, fieldGetters) {
        const [field, direction] = String(sortValue || '').split('-');
        const getter = fieldGetters[field];
        if (!getter) {
            return rows;
        }

        const sorted = rows.slice().sort((a, b) => {
            const valueA = getter(a);
            const valueB = getter(b);
            if (valueA < valueB) return -1;
            if (valueA > valueB) return 1;
            return 0;
        });

        return direction === 'desc' ? sorted.reverse() : sorted;
    }

    $('invoice-client-select').addEventListener('change', () => {
        populateInvoiceServiceAddressSelect($('invoice-client-select').value || '');
    });

    $('invoice-is-ongoing').addEventListener('change', () => {
        const isOngoing = $('invoice-is-ongoing').checked;
        $('invoice-job-name-wrapper').classList.toggle('hidden', !isOngoing);
        if (!isOngoing) {
            $('invoice-job-name').value = '';
        }
        $('invoice-submit-button').textContent = isOngoing ? 'Save Ongoing Job' : 'Create Invoice';
    });

    $('invoice-contractor-actions').addEventListener('click', (event) => {
        const button = event.target.closest('[data-add-contractor-hours]');
        if (button) {
            addContractorHoursRow({ contractorId: button.dataset.addContractorHours });
        }
    });

    $('invoice-contractor-hours-container').addEventListener('input', (event) => {
        if (event.target.matches('[data-contractor-hours]')) {
            updateInvoiceTotals();
        }
    });

    $('invoice-contractor-hours-container').addEventListener('change', (event) => {
        if (event.target.matches('[data-contractor-id]')) updateInvoiceTotals();
    });

    function getTodayLocalDate() {
        const date = new Date();
        const localOffset = date.getTimezoneOffset() * 60_000;
        return new Date(date.getTime() - localOffset).toISOString().slice(0, 10);
    }

    function formatCurrency(cents) {
        return `$${(Number(cents || 0) / 100).toFixed(2)}`;
    }

    function clientName(id) {
        const client = allClients.find((entry) => entry.id === id);
        if (client) {
            return client.name;
        }
        const invoiceSnapshot = adminInvoices.find((invoice) => invoice.accountId === id && invoice.clientSnapshot?.name);
        return invoiceSnapshot?.clientSnapshot.name || id || '—';
    }

    function fmtDate(value) {
        if (!value) {
            return '—';
        }
        return new Date(value).toLocaleDateString();
    }

    function esc(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function openModal(id) {
        const element = $(id);
        element.style.display = 'flex';
        element.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
    }

    function closeModal(id) {
        const element = $(id);
        element.style.display = 'none';
        element.classList.add('hidden');
        document.body.style.overflow = '';
    }

    function setMsg(id, message, isError) {
        const element = $(id);
        element.textContent = message;
        element.className = 'admin-message ' + (isError ? 'admin-message-error' : 'admin-message-success');
    }

    function setPageMessage(message, isError) {
        const element = $('admin-page-message');
        element.textContent = message;
        element.className = isError ? 'portal-page-message portal-message-error' : 'portal-page-message';
    }
