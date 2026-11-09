    let invoiceContractPreviewSequence = 0;
    let invoiceContractPreviewTimer = null;
    let invoiceContractPricingReady = true;

    function setInvoiceContractPricingReady(ready) {
        invoiceContractPricingReady = ready;
        $('invoice-submit-button').disabled = !ready;
    }

    function isInvoiceContractPricingReady() {
        return invoiceContractPricingReady;
    }

    function invoicePdfDownloadName(invoiceNumber) {
        const safeInvoiceNumber = String(invoiceNumber || 'Invoice').trim().replace(/^INV-/i, '').replace(/[^\w.-]+/g, '_');
        return `StickmanHandyman_${safeInvoiceNumber || 'Invoice'}.pdf`;
    }

    function contractPdfDownloadName(contractNumber) {
        const safeContractNumber = String(contractNumber || 'Contract').trim().replace(/[^\w.-]+/g, '_');
        return `StickmanHandyman_${safeContractNumber || 'Contract'}_Agreement.pdf`;
    }

    async function openPdfModal(invoiceId, documentType = 'invoice') {
        const isContract = documentType === 'contract';
        const record = isContract
            ? allContracts.find((contract) => contract.id === invoiceId)
            : adminInvoices.find((invoice) => invoice.id === invoiceId);
        viewedInvoiceId = invoiceId;
        invoicePrintNumber = isContract ? record?.contractNumber || '' : record?.invoiceNumber || '';
        pdfDownloadFileName = isContract
            ? contractPdfDownloadName(invoicePrintNumber)
            : invoicePdfDownloadName(invoicePrintNumber);
        viewedInvoiceDocument = null;
        viewedPdfFile = null;
        pdfModalDownload.disabled = true;
        pdfModalBackdrop.style.display = 'flex';
        pdfModalBackdrop.classList.remove('hidden');
        document.body.style.overflow = 'hidden';

        try {
            const endpoint = isContract ? 'contracts' : 'invoices';
            const url = `${apiBase}/api/${endpoint}/${encodeURIComponent(invoiceId)}/pdf?disposition=inline`;
            const pdf = await window.pdfjsLib.getDocument({
                url,
                httpHeaders: { Authorization: `Bearer ${adminToken}` },
            }).promise;
            viewedInvoiceDocument = pdf;
            // Prepared ahead so the share sheet opens inside the tap's user gesture on iOS.
            pdf.getData().then((data) => {
                if (viewedInvoiceDocument === pdf) viewedPdfFile = new File([data], pdfDownloadFileName, { type: 'application/pdf' });
            }).catch(() => {});
            viewedPdfPageCount = pdf.numPages;
            viewedPdfPageNumber = 1;
            pdfModalPages.hidden = viewedPdfPageCount <= 1;
            pdfModalBackdrop.querySelector('.portal-pdf-modal').classList.toggle('has-multiple-pages', viewedPdfPageCount > 1);
            await renderPdfViewerPage(1);
        } catch (error) {
            console.error('Failed to render invoice PDF:', error);
        }
    }

    async function renderPdfViewerPage(pageNumber) {
        if (!viewedInvoiceDocument) return;
        const nextPageNumber = Math.max(1, Math.min(viewedPdfPageCount, pageNumber));
        viewedPdfPageNumber = nextPageNumber;
        pdfModalPrevious.disabled = nextPageNumber === 1;
        pdfModalNext.disabled = nextPageNumber === viewedPdfPageCount;
        pdfModalPageLabel.textContent = `Page ${nextPageNumber} of ${viewedPdfPageCount}`;

        try {
            const page = await viewedInvoiceDocument.getPage(nextPageNumber);
            const containerRect = pdfModalCanvas.getBoundingClientRect();
            const displayWidth = Math.round(containerRect.width);
            const displayHeight = Math.round(containerRect.height);
            const pixelRatio = Math.min((window.devicePixelRatio || 1) * 2, 4);
            const unscaledViewport = page.getViewport({ scale: 1 });
            const scale = Math.min(displayWidth / unscaledViewport.width, displayHeight / unscaledViewport.height);
            const viewport = page.getViewport({ scale: scale * pixelRatio });

            pdfModalCanvas.width = Math.round(viewport.width);
            pdfModalCanvas.height = Math.round(viewport.height);

            const context = pdfModalCanvas.getContext('2d');
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, pdfModalCanvas.width, pdfModalCanvas.height);
            if (pdfRenderTask) pdfRenderTask.cancel();
            pdfRenderTask = page.render({ canvasContext: context, viewport });
            await pdfRenderTask.promise;
            pdfModalDownload.disabled = false;
        } catch (error) {
            if (error?.name !== 'RenderingCancelledException') {
                console.error('Failed to render PDF page:', error);
            }
        }
    }

    function closePdfModal() {
        pdfModalBackdrop.style.display = 'none';
        pdfModalBackdrop.classList.add('hidden');
        document.body.style.overflow = '';
        viewedInvoiceId = null;
        viewedInvoiceDocument = null;
        viewedPdfFile = null;
        viewedPdfPageNumber = 1;
        viewedPdfPageCount = 0;
        pdfModalDownload.disabled = true;
        pdfModalPages.hidden = true;
        pdfModalBackdrop.querySelector('.portal-pdf-modal').classList.remove('has-multiple-pages');
        if (pdfRenderTask) {
            pdfRenderTask.cancel();
            pdfRenderTask = null;
        }
    }

    function renderInvoices(invoices) {
        adminInvoices = invoices;
        renderInvoicesTable();
    }

    function renderInvoicesTable() {
        const invoiceBillingName = (invoice) => invoice.billingEntityName || clientName(invoice.accountId || invoice.clientId);
        let invoices = invoiceFilterClientId
            ? adminInvoices.filter((invoice) => (invoice.accountId || invoice.clientId) === invoiceFilterClientId)
            : adminInvoices.slice();

        invoices = sortRows(invoices, invoiceSortValue, {
            issueDate: (invoice) => invoice.issueDate || invoice.createdAt || '',
            client: (invoice) => clientName(invoice.accountId || invoice.clientId).toLowerCase(),
            amount: (invoice) => Number(invoice.amountCents || 0),
            status: (invoice) => invoice.status || '',
        });

        if (!invoices.length) {
            $('invoices-tbody').innerHTML = '<tr><td colspan="6" class="admin-empty">No invoices match the current filters.</td></tr>';
            $('mobile-invoices-list').innerHTML = '<p class="admin-empty">No invoices match the current filters.</p>';
            return;
        }

        $('invoices-tbody').innerHTML = invoices.map((invoice) => `
            <tr>
                <td>${esc(invoice.invoiceNumber || invoice.jobName || 'Ongoing Job')}</td>
                <td><span class="admin-badge badge-${esc(invoice.status)}">${esc(invoice.status)}</span></td>
                <td>${esc(invoiceBillingName(invoice))}</td>
                <td>$${(invoice.amountCents / 100).toFixed(2)}</td>
                <td>${fmtDate(invoice.issueDate || invoice.createdAt)}</td>
                <td><div class="invoice-table-actions">
                    ${invoice.status !== 'ongoing' ? `<button class="admin-btn admin-btn-sm admin-btn-ghost" data-view-invoice="${esc(invoice.id)}">View</button>` : ''}
                    ${invoice.status === 'ongoing' ? `<button class="admin-btn admin-btn-sm admin-btn-ghost" data-finalize-invoice="${esc(invoice.id)}">Create Invoice</button>` : ''}
                    ${invoice.status !== 'paid' && invoice.status !== 'void' ? `
                    <button class="admin-btn admin-btn-sm admin-btn-ghost" data-edit-invoice="${esc(invoice.id)}">Edit</button>
                    ${invoice.status !== 'ongoing' ? `<button class="admin-btn admin-btn-sm admin-btn-ghost" data-entity="invoice" data-id="${esc(invoice.id)}" data-status="paid">Mark Paid</button>` : ''}
                    <button class="admin-btn admin-btn-sm admin-btn-ghost admin-btn-remove" data-delete-invoice="${esc(invoice.id)}">Remove</button>` : ''}
                    ${invoice.status === 'paid' ? `<button class="admin-btn admin-btn-sm admin-btn-ghost" data-entity="invoice" data-id="${esc(invoice.id)}" data-status="sent">Unmark Paid</button>` : ''}
                </div></td>
            </tr>
        `).join('');
        $('mobile-invoices-list').innerHTML = invoices.map((invoice) => {
            const invoiceLabel = invoice.invoiceNumber || invoice.jobName || 'Ongoing Job';
            const actions = `
                ${invoice.status !== 'ongoing' ? `<button class="admin-btn admin-btn-sm admin-btn-ghost" data-view-invoice="${esc(invoice.id)}">View</button>` : ''}
                ${invoice.status === 'ongoing' ? `<button class="admin-btn admin-btn-sm admin-btn-ghost" data-finalize-invoice="${esc(invoice.id)}">Create Invoice</button>` : ''}
                ${invoice.status !== 'paid' && invoice.status !== 'void' ? `
                    <button class="admin-btn admin-btn-sm admin-btn-ghost" data-edit-invoice="${esc(invoice.id)}">Edit</button>
                    ${invoice.status !== 'ongoing' ? `<button class="admin-btn admin-btn-sm admin-btn-ghost" data-entity="invoice" data-id="${esc(invoice.id)}" data-status="paid">Mark Paid</button>` : ''}
                    <button class="admin-btn admin-btn-sm admin-btn-ghost admin-btn-remove" data-delete-invoice="${esc(invoice.id)}">Remove</button>` : ''}
                ${invoice.status === 'paid' ? `<button class="admin-btn admin-btn-sm admin-btn-ghost" data-entity="invoice" data-id="${esc(invoice.id)}" data-status="sent">Unmark Paid</button>` : ''}
            `;
            return mobileRecordCard(
                invoiceLabel,
                `<span class="admin-badge badge-${esc(invoice.status)}">${esc(invoice.status)}</span>`,
                `${invoiceBillingName(invoice)} · $${(Number(invoice.amountCents || 0) / 100).toFixed(2)}`,
                [['Issue date', fmtDate(invoice.issueDate || invoice.createdAt)]],
                actions,
                true,
            );
        }).join('');
    }

    function openInvoiceEditor(invoiceId) {
        const invoice = adminInvoices.find((entry) => entry.id === invoiceId);
        if (!invoice || invoice.status === 'paid' || invoice.status === 'void') {
            return;
        }

        editingInvoiceId = invoice.id;
        resetInvoiceItemRows();
        $('invoice-contractor-hours-container').innerHTML = '';
        $('form-new-invoice').reset();
        if (!allClients.some((clientEntry) => clientEntry.id === (invoice.accountId || invoice.clientId)) && invoice.clientSnapshot) {
            const snapshotOption = document.createElement('option');
            snapshotOption.value = invoice.clientSnapshot.id;
            snapshotOption.textContent = invoice.clientSnapshot.name;
            $('invoice-client-select').append(snapshotOption);
        }
        $('invoice-client-select').value = invoice.accountId || invoice.clientId || '';
        populateInvoiceServiceAddressSelect($('invoice-client-select').value || '', invoice.serviceAddress || '', invoice.billingBusinessId || '');
        if (invoice.serviceAddress && !Array.from($('invoice-service-address-select').options).some((option) => option.value === invoice.serviceAddress)) {
            const serviceOption = document.createElement('option');
            serviceOption.value = invoice.serviceAddress;
            serviceOption.textContent = invoice.serviceAddress;
            $('invoice-service-address-select').append(serviceOption);
            $('invoice-service-address-wrapper').classList.remove('hidden');
        }
        const client = allClients.find((entry) => entry.id === (invoice.accountId || invoice.clientId)) || null;
        const presetServiceAddress = invoice.serviceAddress || '';
        $('invoice-service-address-select').value = presetServiceAddress || '';
        $('invoice-job-name').value = invoice.jobName || '';
        $('invoice-is-ongoing').checked = invoice.status === 'ongoing';
        $('invoice-is-ongoing').disabled = invoice.status !== 'ongoing';
        $('invoice-job-name-wrapper').classList.toggle('hidden', invoice.status !== 'ongoing');
        $('invoice-issue-date').value = invoice.issueDate || getTodayLocalDate();
        updateInvoiceContractOptions($('invoice-client-select').value, invoice.contractId || '');
        $('invoice-total-display').value = (Number(invoice.amountCents || 0) / 100).toFixed(2);
        (invoice.contractorHours || []).forEach((entry) => addContractorHoursRow(entry));
        if (!Array.isArray(invoice.contractorHours)) {
            (invoice.lineItems || []).filter((item) => item.type === 'labor').forEach((item) => addInvoiceItemRow({
                ...item,
                description: 'Labor',
                rateOverride: Number(item.unitPriceCents || 0) / 100,
            }));
        }
        (invoice.lineItems || []).filter((item) => item.type !== 'labor').forEach((item) => addInvoiceItemRow({
            ...item,
            description: item.description,
        }));
        updateInvoiceTotals();
        $('invoice-modal-title').textContent = invoice.status === 'ongoing'
            ? `Edit ${invoice.jobName || 'Ongoing Job'}`
            : `Edit ${invoice.invoiceNumber}`;
        $('invoice-submit-button').textContent = invoice.status === 'ongoing' ? 'Save Ongoing Job' : 'Update Invoice';
        openModal('modal-new-invoice');
    }

    async function deleteInvoice(invoiceId) {
        const invoice = adminInvoices.find((entry) => entry.id === invoiceId);
        if (!invoice || invoice.status === 'paid' || invoice.status === 'void') {
            return;
        }

        if (!window.confirm(`Remove invoice ${invoice.invoiceNumber || invoice.jobName || 'this ongoing job'}? This cannot be undone.`)) {
            return;
        }

        try {
            const response = await apiFetch(`/api/invoices/${encodeURIComponent(invoiceId)}`, {
                method: 'DELETE',
            });
            const payload = await response.json();
            if (!response.ok) {
                throw new Error(payload.error || 'Unable to remove invoice.');
            }

            await loadInvoices();
            await loadSummary();
        } catch (error) {
            window.alert('Unable to remove invoice: ' + error.message);
        }
    }

    async function finalizeOngoingInvoice(invoiceId) {
        const invoice = adminInvoices.find((entry) => entry.id === invoiceId);
        if (!invoice || invoice.status !== 'ongoing') {
            return;
        }
        if (!window.confirm(`Create and number an invoice for ${invoice.jobName || 'this ongoing job'} now?`)) {
            return;
        }

        try {
            const response = await apiFetch(`/api/invoices/${encodeURIComponent(invoiceId)}`, {
                method: 'PATCH',
                body: JSON.stringify({ isOngoing: false }),
            });
            const payload = await response.json();
            if (!response.ok) {
                throw new Error(payload.error || 'Unable to create invoice.');
            }
            await loadInvoices();
            await loadContractors();
            await loadSummary();
        } catch (error) {
            window.alert(error.message);
        }
    }

    function populateInvoiceBillingBusinessSelect(clientId, selectedBusinessId = '') {
        const wrapper = $('invoice-billing-business-wrapper');
        const select = $('invoice-billing-business-select');
        const client = allClients.find((entry) => entry.id === clientId);
        const businesses = client?.businesses || [];
        select.innerHTML = `<option value="">${esc(client?.name || 'Client')}</option>`
            + businesses.map((business) => `<option value="${esc(business.id)}">${esc(business.name)}</option>`).join('');
        wrapper.classList.toggle('hidden', !businesses.length);
        select.value = businesses.some((business) => business.id === selectedBusinessId) ? selectedBusinessId : '';
    }

    function populateInvoiceServiceAddressSelect(clientId, selectedAddress = '', selectedBusinessId = '') {
        const select = $('invoice-service-address-select');
        const wrapper = $('invoice-service-address-wrapper');
        const client = allClients.find((entry) => entry.id === clientId) || null;
        populateInvoiceBillingBusinessSelect(clientId, selectedBusinessId);
        const addressOptions = [];
        const addAddress = (address, label) => {
            const value = String(address || '').trim();
            if (!value) return;
            const existing = addressOptions.find((option) => option.value.toLocaleLowerCase() === value.toLocaleLowerCase());
            if (existing) {
                if (!existing.label.includes(label)) existing.label = `${existing.label} / ${label}`;
                return;
            }
            addressOptions.push({ value, label: `${label} · ${value}` });
        };
        if (client) {
            addAddress(client.address, 'Client');
            (client.serviceAddresses || []).forEach((address) => addAddress(address, 'Service'));
            (client.businesses || []).forEach((business) => addAddress(business.address, business.name));
        }

        select.innerHTML = '<option value="">Select a service address…</option>'
            + addressOptions.map((option) => `<option value="${esc(option.value)}">${esc(option.label)}</option>`).join('');

        if (addressOptions.length > 1) {
            wrapper.classList.remove('hidden');
            const selectedBusiness = client?.businesses?.find((business) => business.id === selectedBusinessId);
            select.value = selectedAddress || selectedBusiness?.address || '';
        } else {
            wrapper.classList.add('hidden');
            select.value = addressOptions[0]?.value || selectedAddress || '';
        }
        updateInvoiceContractOptions(clientId);
    }

    function invoiceContractCoversAddress(contract, client, serviceAddress) {
        const address = String(serviceAddress || '').trim().toLocaleLowerCase();
        if (!address) return false;
        if (String(contract.serviceAddress || '').trim().toLocaleLowerCase() === address) return true;
        const portfolio = contract.packageType === 'portfolio'
            || (contract.packageType === 'custom' && contract.packageCoverageType === 'portfolio');
        return contract.contractType !== 'labor' && portfolio;
    }

    function updateInvoiceContractOptions(clientId, preferredContractId = '') {
        const wrapper = $('invoice-contract-wrapper');
        const select = $('invoice-contract-select');
        const client = allClients.find((entry) => entry.id === clientId);
        const serviceAddress = $('invoice-service-address-select').value || client?.address || '';
        const invoiceDate = $('invoice-issue-date').value || getTodayLocalDate();
        const matches = allContracts.filter((contract) => {
            const startDate = String(contract.startDate || contract.createdAt || '').slice(0, 10);
            return contract.status === 'active'
                && (contract.accountId || contract.clientId) === clientId
                && invoiceContractCoversAddress(contract, client, serviceAddress)
                && (!startDate || startDate <= invoiceDate);
        });

        if (!matches.length) {
            select.innerHTML = '<option value="">No matching contract</option>';
            wrapper.classList.add('hidden');
            updateInvoiceTotals();
            return;
        }

        select.innerHTML = [
            ...(matches.length > 1 ? ['<option value="">Select a contract…</option>'] : []),
            ...matches.map((contract) => {
                const label = contract.contractType === 'labor'
                    ? contract.title || 'Labor project'
                    : contract.packageType === 'custom'
                        ? `Custom ${contract.packageCoverageType === 'portfolio' ? 'Portfolio' : 'Single Home'}`
                        : `${contract.packageType === 'portfolio' ? 'Portfolio' : 'Single Home'} ${contract.packageLevel || ''}`.trim();
                return `<option value="${esc(contract.id)}">${esc(contract.contractNumber)} · ${esc(label)}</option>`;
            }),
        ].join('');
        wrapper.classList.remove('hidden');
        const selection = matches.some((contract) => contract.id === preferredContractId)
            ? preferredContractId
            : matches.length === 1 ? matches[0].id : '';
        select.value = selection;
        updateInvoiceTotals();
    }

    function getInvoiceBillingLineItems() {
        const contractorHours = getContractorHoursRows();
        const lineItems = getInvoiceItemRows();
        const existing = adminInvoices.find((invoice) => invoice.id === editingInvoiceId);
        const legacyManualLabor = Boolean(existing && !Array.isArray(existing.contractorHours) && contractorHours.length === 0);
        return legacyManualLabor ? lineItems : [
            ...buildContractorLaborItems(contractorHours),
            ...lineItems.filter((item) => item.type !== 'labor'),
        ];
    }

    async function refreshInvoiceContractPricing(subtotalCents, requestedAmountCents, sequence) {
        const summary = $('invoice-contract-pricing-summary');
        const selectedContractId = $('invoice-contract-select').value;
        const clientId = $('invoice-client-select').value;
        if (!clientId || $('invoice-is-ongoing').checked) {
            summary.textContent = '';
            summary.classList.add('hidden');
            $('invoice-total-display').value = (subtotalCents / 100).toFixed(2);
            $('invoice-total-display').dataset.calculatedCents = String(subtotalCents);
            delete $('invoice-total-display').dataset.contractPreviewCents;
            setInvoiceContractPricingReady(true);
            return;
        }
        const contractSelectionRequired = !$('invoice-contract-wrapper').classList.contains('hidden')
            && allContracts.filter((contract) => contract.status === 'active'
                && (contract.accountId || contract.clientId) === clientId
                && invoiceContractCoversAddress(contract, allClients.find((entry) => entry.id === clientId), $('invoice-service-address-select').value || allClients.find((entry) => entry.id === clientId)?.address || '')
                && String(contract.startDate || contract.createdAt || '').slice(0, 10) <= ($('invoice-issue-date').value || getTodayLocalDate())).length > 1;

        if (contractSelectionRequired && !selectedContractId) {
            summary.textContent = 'Select which active contract to apply.';
            summary.classList.remove('hidden');
            $('invoice-total-display').value = (subtotalCents / 100).toFixed(2);
            $('invoice-total-display').dataset.calculatedCents = String(subtotalCents);
            setInvoiceContractPricingReady(false);
            return;
        }

        const finalInput = $('invoice-total-display');
        const existingInvoice = adminInvoices.find((invoice) => invoice.id === editingInvoiceId);
        const lineItems = getInvoiceBillingLineItems();
        const contractorHours = getContractorHoursRows();
        const payload = {
            accountId: clientId,
            billingBusinessId: $('invoice-billing-business-select').value || null,
            issueDate: $('invoice-issue-date').value || getTodayLocalDate(),
            serviceAddress: $('invoice-service-address-select').value || undefined,
            contractId: selectedContractId || undefined,
            contractorHours: existingInvoice && !Array.isArray(existingInvoice.contractorHours) && !contractorHours.length ? undefined : contractorHours,
            lineItems,
            ...(requestedAmountCents == null ? {} : { amountCents: requestedAmountCents }),
        };

        try {
            const response = await apiFetch('/api/invoices/contract-pricing-preview', {
                method: 'POST',
                body: JSON.stringify(payload),
            });
            const result = await response.json();
            if (sequence !== invoiceContractPreviewSequence) return;
            if (!response.ok) throw new Error(result.error || 'Unable to calculate contract pricing.');

            if (result.pricing.contractId) {
                finalInput.value = (Number(result.pricing.amountCents || 0) / 100).toFixed(2);
                finalInput.dataset.contractPreviewCents = String(result.pricing.amountCents);
                const pooledHoursUnavailable = result.pricing.contractType === 'maintenance'
                    && result.pricing.contractPooledHoursEligible === false;
                summary.textContent = pooledHoursUnavailable
                    ? 'Pooled retainer hours are unavailable until this billing period is paid.'
                    : '';
                summary.classList.toggle('hidden', !pooledHoursUnavailable);
            } else {
                summary.textContent = '';
                summary.classList.add('hidden');
                if (requestedAmountCents == null) finalInput.value = (subtotalCents / 100).toFixed(2);
                delete finalInput.dataset.contractPreviewCents;
            }
            finalInput.dataset.calculatedCents = String(subtotalCents);
            setInvoiceContractPricingReady(true);
        } catch (error) {
            if (sequence !== invoiceContractPreviewSequence) return;
            summary.textContent = error.message || 'Unable to calculate contract pricing.';
            summary.classList.remove('hidden');
            setInvoiceContractPricingReady(false);
        }
    }

    function addInvoiceItemRow(initialValues = {}) {
        const container = $('invoice-items-container');
        const row = document.createElement('div');
        const type = initialValues.type || 'labor';
        const hourlyRateDollars = Number(initialValues.rateOverride ?? (Number(initialValues.unitPriceCents || 0) / 100) ?? 0);
        const rateCents = Math.round(hourlyRateDollars * 100);
        const label = type === 'material' ? 'Materials' : type === 'package' ? 'Other' : 'Labor';
        row.className = 'invoice-item-row';

        if (type === 'labor') {
            row.innerHTML = `
                <span class="invoice-item-trigger invoice-item-kind">${label}</span>
                <div class="invoice-item-value-group">
                    <label class="invoice-item-inline-label">Hours
                        <input class="invoice-item-input" data-field="quantity" type="number" min="0" step="0.25" value="${Number(initialValues.quantity || 1)}" placeholder="Hours" />
                    </label>
                </div>
                <input type="hidden" data-field="type" value="${type}" />
                <input type="hidden" data-field="unitPriceCents" value="${rateCents}" />
                <input type="hidden" data-field="description" value="${esc(initialValues.description || label)}" />
                <button type="button" class="admin-btn admin-btn-sm admin-btn-ghost invoice-remove-row-btn">Remove</button>
            `;
        } else if (type === 'material') {
            row.innerHTML = `
                <span class="invoice-item-trigger invoice-item-kind">Materials</span>
                <div class="invoice-item-value-group">
                    <label class="invoice-item-inline-label">Total
                        <input class="invoice-item-input" data-field="unitPriceCents" type="number" min="0" step="0.01" value="${Number(initialValues.unitPriceCents || 0) / 100}" placeholder="0.00" />
                    </label>
                </div>
                <input type="hidden" data-field="type" value="${type}" />
                <input type="hidden" data-field="quantity" value="1" />
                <input type="hidden" data-field="description" value="Materials" />
                <button type="button" class="admin-btn admin-btn-sm admin-btn-ghost invoice-remove-row-btn">Remove</button>
            `;
        } else {
            row.innerHTML = `
                <span class="invoice-item-trigger invoice-item-kind">Other</span>
                <div class="invoice-item-value-group invoice-item-description-input">
                    <label class="invoice-item-inline-label invoice-item-description-label">Description
                        <input class="invoice-item-input" data-field="description" type="text" value="${esc(initialValues.description || '')}" placeholder="Enter item description" required />
                    </label>
                    <label class="invoice-item-inline-label">Total
                        <input class="invoice-item-input" data-field="unitPriceCents" type="number" min="0" step="0.01" value="${Number(initialValues.unitPriceCents || 0) / 100}" placeholder="0.00" />
                    </label>
                </div>
                <input type="hidden" data-field="type" value="${type}" />
                <input type="hidden" data-field="quantity" value="1" />
                <button type="button" class="admin-btn admin-btn-sm admin-btn-ghost invoice-remove-row-btn">Remove</button>
            `;
        }

        row.querySelector('.invoice-remove-row-btn').addEventListener('click', () => {
            row.remove();
            updateInvoiceTotals();
        });

        container.appendChild(row);
        updateInvoiceTotals();
    }

    function addContractorHoursRow(initialValues = {}) {
        const container = $('invoice-contractor-hours-container');
        const row = document.createElement('div');
        const availableContractors = allContractors.filter((contractor) => contractor.status === 'active'
            || contractor.id === initialValues.contractorId);
        const contractorId = initialValues.contractorId || availableContractors[0]?.id || '';
        row.className = 'invoice-item-row invoice-contractor-row';
        const contractor = allContractors.find((entry) => entry.id === contractorId);
        const hourlyRateCents = Number(initialValues.hourlyRateCents ?? contractor?.hourlyRateCents ?? 0);
        row.innerHTML = `
            <label class="invoice-item-inline-label">Contractor
                <select data-contractor-id>
                    ${availableContractors.map((contractor) => `<option value="${esc(contractor.id)}" ${contractor.id === contractorId ? 'selected' : ''}>${esc(contractor.name)}</option>`).join('')}
                </select>
            </label>
            <label class="invoice-item-inline-label">Hours
                <input class="invoice-item-input" data-contractor-hours type="number" min="0.25" step="0.25" value="${Number(initialValues.hours || 1)}">
            </label>
            <span class="invoice-contractor-rate" data-hourly-rate-cents="${hourlyRateCents}">${formatCurrency(getContractorInvoiceRateCents(contractor, hourlyRateCents))}/hr</span>
            <button type="button" class="admin-btn admin-btn-sm admin-btn-ghost invoice-remove-row-btn">Remove</button>
        `;
        row.querySelector('[data-contractor-id]').addEventListener('change', (event) => {
            const contractor = allContractors.find((entry) => entry.id === event.target.value);
            const rateDisplay = row.querySelector('.invoice-contractor-rate');
            rateDisplay.dataset.hourlyRateCents = String(contractor?.hourlyRateCents || 0);
            rateDisplay.textContent = `${formatCurrency(getContractorInvoiceRateCents(contractor))}/hr`;
            updateInvoiceTotals();
        });
        row.querySelector('.invoice-remove-row-btn').addEventListener('click', () => {
            row.remove();
            updateInvoiceTotals();
        });
        container.appendChild(row);
        updateInvoiceTotals();
    }

    function getContractorHoursRows() {
        return Array.from(document.querySelectorAll('#invoice-contractor-hours-container .invoice-contractor-row')).map((row) => ({
            contractorId: row.querySelector('[data-contractor-id]').value,
            hours: Number(row.querySelector('[data-contractor-hours]').value || 0),
            hourlyRateCents: Number(row.querySelector('[data-hourly-rate-cents]').dataset.hourlyRateCents || 0),
        })).filter((entry) => entry.contractorId && entry.hours > 0);
    }

    function getContractorInvoiceRateCents(contractor, hourlyRateCents = contractor?.hourlyRateCents) {
        return Number(hourlyRateCents || 0) + (contractor && !contractor.isOwner ? 1_000 : 0);
    }

    function buildContractorLaborItems(contractorHours) {
        const combinedHours = new Map();
        contractorHours.forEach((entry) => {
            const contractor = allContractors.find((candidate) => candidate.id === entry.contractorId);
            if (!contractor) {
                return;
            }
            const current = combinedHours.get(entry.contractorId) || {
                contractorId: entry.contractorId,
                hours: 0,
                hourlyRateCents: entry.hourlyRateCents ?? contractor.hourlyRateCents,
            };
            current.hours += Number(entry.hours || 0);
            combinedHours.set(entry.contractorId, current);
        });
        const entries = Array.from(combinedHours.values());
        const hourLevels = [...new Set(entries.map((entry) => entry.hours))].sort((first, second) => first - second);
        const laborItems = [];
        let previousHours = 0;
        hourLevels.forEach((hourLevel) => {
            const hours = hourLevel - previousHours;
            const activeContractors = entries.filter((entry) => entry.hours >= hourLevel);
            const hourlyRateCents = activeContractors.reduce((sum, entry) => {
                const contractor = allContractors.find((candidate) => candidate.id === entry.contractorId);
                return sum + getContractorInvoiceRateCents(contractor, entry.hourlyRateCents);
            }, 0);
            if (hours > 0 && hourlyRateCents > 0) {
                laborItems.push({ type: 'labor', description: 'Labor', quantity: hours, unitPriceCents: hourlyRateCents });
            }
            previousHours = hourLevel;
        });
        return laborItems;
    }

    function getInvoiceItemRows() {
        return Array.from(document.querySelectorAll('#invoice-items-container .invoice-item-row')).map((row) => {
            const type = row.querySelector('[data-field="type"]').value;
            const description = (row.querySelector('[data-field="description"]').value || '').trim();
            const quantity = Number(row.querySelector('[data-field="quantity"]')?.value || 1);
            const rawUnitPrice = Number(row.querySelector('[data-field="unitPriceCents"]').value || 0);
            const unitPriceCents = type === 'labor'
                ? Math.round(rawUnitPrice)
                : Math.round(rawUnitPrice * 100);

            return {
                type,
                description,
                quantity,
                unitPriceCents,
            };
        }).filter((item) => item.description.length > 0 || item.type === 'material' || item.type === 'package');
    }

    function updateInvoiceTotals() {
        const rows = getInvoiceItemRows();
        const contractorLabor = buildContractorLaborItems(getContractorHoursRows());
        const subtotalCents = rows.reduce((sum, item) => {
            if (item.type === 'labor') {
                return sum + Math.round(Math.max(0, Number(item.quantity || 0)) * Math.max(0, Number(item.unitPriceCents || 0)));
            }
            return sum + Math.max(0, Number(item.unitPriceCents || 0));
        }, 0) + contractorLabor.reduce((sum, item) => sum + Math.round(item.quantity * item.unitPriceCents), 0);
        $('invoice-calculated-total').textContent = formatCurrency(subtotalCents);

        const finalTotalInput = $('invoice-total-display');
        const currentFinalTotal = Number(finalTotalInput.value || '0');
        const previousCalculatedCents = Number(finalTotalInput.dataset.calculatedCents || 'NaN');
        const previousContractPreviewCents = Number(finalTotalInput.dataset.contractPreviewCents || 'NaN');
        const currentAmountCents = Math.max(0, Math.round(currentFinalTotal * 100));
        const isManualOverride = finalTotalInput.dataset.manualOverride === 'true'
            && Number.isFinite(currentFinalTotal)
            && currentAmountCents < subtotalCents
            && currentAmountCents !== previousCalculatedCents
            && currentAmountCents !== previousContractPreviewCents;

        if (!isManualOverride) {
            finalTotalInput.value = (subtotalCents / 100).toFixed(2);
        }

        finalTotalInput.dataset.calculatedCents = String(subtotalCents);
        const sequence = ++invoiceContractPreviewSequence;
        const requestedAmountCents = isManualOverride ? currentAmountCents : null;
        setInvoiceContractPricingReady(!$('invoice-client-select').value || $('invoice-is-ongoing').checked);
        window.clearTimeout(invoiceContractPreviewTimer);
        invoiceContractPreviewTimer = window.setTimeout(() => {
            void refreshInvoiceContractPricing(subtotalCents, requestedAmountCents, sequence);
        }, 120);
    }

    function resetInvoiceItemRows() {
        const container = $('invoice-items-container');
        container.innerHTML = '';
        $('invoice-contractor-hours-container').innerHTML = '';
        $('invoice-total-display').value = '0.00';
        $('invoice-total-display').dataset.calculatedCents = '0';
        delete $('invoice-total-display').dataset.manualOverride;
        delete $('invoice-total-display').dataset.contractPreviewCents;
        $('invoice-calculated-total').textContent = '$0.00';
    }

    function setTodayInvoiceIssueDate() {
        const input = $('invoice-issue-date');
        if (!input) {
            return;
        }

        input.value = getTodayLocalDate();
    }
