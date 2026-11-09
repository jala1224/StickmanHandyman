    function renderContracts(contracts) {
        allContracts = contracts;
        renderContractsTable();
        renderLaborContractsTable();
    }

    function renderContractAttachments(contract) {
        if (!contract?.id) return;
        activeAttachmentContractId = contract.id;
        $('contract-attachments-title').textContent = `Contract Documents · ${contract.contractNumber}`;
        $('contract-attachment-file').value = '';
        $('choose-contract-attachment-btn').disabled = false;
        $('contract-attachments-message').textContent = '';
        $('generate-contract-signing-link-btn').hidden = false;
        const cachedSigningLink = contractSigningLinkCache.get(contract.id);
        $('contract-signing-link').value = cachedSigningLink?.url || '';
        $('contract-signing-link-copy').hidden = !cachedSigningLink?.url;
        const attachments = Array.isArray(contract.signedAttachments) ? contract.signedAttachments : [];
        $('contract-attachments-list').innerHTML = attachments.length
            ? attachments.map(attachment => `
                <li class="contract-attachment-row">
                    <span class="contract-attachment-info">
                        <strong>${esc(attachment.fileName)}</strong>
                        <span class="contract-attachment-meta">${fmtDate(attachment.uploadedAt)} · ${(Number(attachment.sizeBytes || 0) / 1024 / 1024).toFixed(2)} MB</span>
                    </span>
                    <span class="contract-attachment-actions">
                        <button type="button" class="admin-btn admin-btn-sm admin-btn-ghost" data-view-contract-attachment="${esc(attachment.id)}" data-contract-id="${esc(contract.id)}">View</button>
                        <button type="button" class="contract-attachment-delete" data-delete-contract-attachment="${esc(attachment.id)}" data-contract-id="${esc(contract.id)}" aria-label="Delete ${esc(attachment.fileName)}" title="Delete PDF">&times;</button>
                    </span>
                </li>
            `).join('')
            : '<li class="contract-attachment-empty">No PDFs attached yet.</li>';
    }

    function contractAttachmentsAction(contract) {
        const count = Array.isArray(contract.signedAttachments) ? contract.signedAttachments.length : 0;
        return `<button type="button" class="admin-btn admin-btn-sm admin-btn-ghost" data-open-contract-attachments="${esc(contract.id)}">Documents${count ? ` (${count})` : ''}</button>`;
    }

    let activeAttachmentContractId = null;
    const contractSigningLinkCache = new Map();

    function openContractAttachments(contractId) {
        const contract = allContracts.find(item => item.id === contractId);
        if (!contract) return;
        renderContractAttachments(contract);
        openModal('modal-contract-attachments');
    }

    async function uploadContractAttachment() {
        const fileInput = $('contract-attachment-file');
        const file = fileInput.files?.[0];
        if (!activeAttachmentContractId || !file) return;
        if (file.type !== 'application/pdf' || !file.name.toLowerCase().endsWith('.pdf') || file.size > 10 * 1024 * 1024) {
            $('contract-attachments-message').textContent = 'Choose a PDF file no larger than 10 MB.';
            $('contract-attachments-message').className = 'admin-message admin-message-error';
            return;
        }

        const button = $('choose-contract-attachment-btn');
        button.disabled = true;
        $('contract-attachments-message').textContent = 'Uploading PDF...';
        $('contract-attachments-message').className = 'admin-message';
        try {
            const query = new URLSearchParams({ filename: file.name });
            const response = await apiFetch(`/api/contracts/${encodeURIComponent(activeAttachmentContractId)}/attachments?${query}`, {
                method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: file,
            });
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.error || 'Unable to upload the signed PDF.');
            await loadContracts();
            renderContractAttachments(allContracts.find(contract => contract.id === activeAttachmentContractId));
            $('contract-attachments-message').textContent = 'PDF attached.';
            $('contract-attachments-message').className = 'admin-message admin-message-success';
        } catch (error) {
            $('contract-attachments-message').textContent = error.message || 'Unable to upload the PDF.';
            $('contract-attachments-message').className = 'admin-message admin-message-error';
            button.disabled = false;
        }
    }

    async function viewContractAttachment(button) {
        const previewWindow = window.open('about:blank', '_blank');
        if (!previewWindow) {
            $('contract-attachments-message').textContent = 'Allow pop-ups to view this PDF.';
            $('contract-attachments-message').className = 'admin-message admin-message-error';
            return;
        }
        previewWindow.opener = null;
        button.disabled = true;
        try {
            const response = await apiFetch(`/api/contracts/${encodeURIComponent(button.dataset.contractId)}/attachments/${encodeURIComponent(button.dataset.viewContractAttachment)}`);
            if (!response.ok) {
                const payload = await response.json();
                throw new Error(payload.error || 'Unable to open this PDF.');
            }
            const pdfUrl = URL.createObjectURL(await response.blob());
            previewWindow.location.replace(pdfUrl);
            window.setTimeout(() => URL.revokeObjectURL(pdfUrl), 60_000);
        } catch (error) {
            previewWindow.close();
            $('contract-attachments-message').textContent = error.message || 'Unable to open this PDF.';
            $('contract-attachments-message').className = 'admin-message admin-message-error';
        } finally {
            button.disabled = false;
        }
    }

    async function deleteContractAttachment(button) {
        if (!window.confirm('Delete this attached PDF?')) return;
        const contractId = button.dataset.contractId;
        const attachmentId = button.dataset.deleteContractAttachment;
        button.disabled = true;
        try {
            const response = await apiFetch(`/api/contracts/${encodeURIComponent(contractId)}/attachments/${encodeURIComponent(attachmentId)}`, { method: 'DELETE' });
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.error || 'Unable to delete this PDF.');
            if (contractSigningLinkCache.get(contractId)?.attachmentId === attachmentId) contractSigningLinkCache.delete(contractId);
            await loadContracts();
            renderContractAttachments(allContracts.find(contract => contract.id === contractId));
            $('contract-attachments-message').textContent = 'PDF deleted.';
            $('contract-attachments-message').className = 'admin-message admin-message-success';
        } catch (error) {
            $('contract-attachments-message').textContent = error.message || 'Unable to delete this PDF.';
            $('contract-attachments-message').className = 'admin-message admin-message-error';
            button.disabled = false;
        }
    }

    async function createGeneratedContractSigningLink(button) {
        const contractId = activeAttachmentContractId;
        if (!contractId) return;
        const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);

        button.disabled = true;
        $('contract-attachments-message').textContent = 'Generating the agreement and secure signing link...';
        $('contract-attachments-message').className = 'admin-message';
        try {
            const response = await apiFetch(`/api/contracts/${encodeURIComponent(contractId)}/signature-request`, {
                method: 'POST',
                body: JSON.stringify({}),
            });
            const payload = await response.json();
            if (!response.ok) {
                const routeNotFound = payload.error === 'Route not found.';
                const routeHelp = isLocal
                    ? 'Restart the local dev server and reload the portal to load the signing route.'
                    : 'Deploy the latest backend to enable generated signing links.';
                throw new Error(routeNotFound ? routeHelp : payload.error || 'Unable to generate a signing link.');
            }
            const signingUrl = new URL(payload.signingUrl);
            if (isLocal) {
                signingUrl.protocol = window.location.protocol;
                signingUrl.host = window.location.host;
            }
            const link = signingUrl.href;
            contractSigningLinkCache.set(contractId, { attachmentId: payload.attachment.id, url: link });
            const linkInput = $('contract-signing-link');
            linkInput.value = link;
            let copied = false;
            try {
                await navigator.clipboard.writeText(link);
                copied = true;
            } catch {
                $('contract-signing-link-copy').hidden = false;
                linkInput.focus();
                linkInput.select();
                try {
                    copied = Boolean(document.execCommand?.('copy'));
                } catch {
                    copied = false;
                }
            }
            await loadContracts();
            renderContractAttachments(allContracts.find(contract => contract.id === contractId));
            $('contract-signing-link-copy').hidden = copied;
            $('contract-attachments-message').textContent = copied
                ? isLocal ? 'Local signing link copied to clipboard.' : 'Signing link copied to clipboard.'
                : 'Your browser blocked automatic copying. Copy the link below.';
            $('contract-attachments-message').className = copied ? 'admin-message admin-message-success' : 'admin-message admin-message-error';
        } catch (error) {
            $('contract-attachments-message').textContent = error.message || 'Unable to generate a signing link.';
            $('contract-attachments-message').className = 'admin-message admin-message-error';
        } finally {
            button.disabled = false;
        }
    }

    document.addEventListener('click', event => {
        const viewAttachmentButton = event.target.closest('[data-view-contract-attachment]');
        if (viewAttachmentButton) {
            void viewContractAttachment(viewAttachmentButton);
            return;
        }
        const deleteAttachmentButton = event.target.closest('[data-delete-contract-attachment]');
        if (deleteAttachmentButton) {
            void deleteContractAttachment(deleteAttachmentButton);
            return;
        }
        const attachmentsButton = event.target.closest('[data-open-contract-attachments]');
        if (attachmentsButton) {
            openContractAttachments(attachmentsButton.dataset.openContractAttachments);
            return;
        }
        const generatedSigningButton = event.target.closest('#generate-contract-signing-link-btn');
        if (generatedSigningButton) {
            void createGeneratedContractSigningLink(generatedSigningButton);
        }
    });

    function renderContractsTable() {
        const manualPaymentAction = (contract) => {
            if (contract.status !== 'active' || contract.autopayEnabled) return '';
            if (contract.paymentStatus === 'Paid' && contract.lastPaymentSource === 'manual') {
                return `<button class="admin-btn admin-btn-sm admin-btn-ghost" data-contract-manual-payment="${esc(contract.id)}" data-payment-action="undo">Mark Unpaid</button>`;
            }
            if (contract.paymentStatus !== 'Paid') {
                return `<button class="admin-btn admin-btn-sm admin-btn-ghost" data-contract-manual-payment="${esc(contract.id)}" data-payment-action="record">Mark Paid</button>`;
            }
            return '';
        };
        let contracts = contractFilterClientId
            ? allContracts.filter((contract) => (contract.accountId || contract.clientId) === contractFilterClientId)
            : allContracts.slice();

        contracts = contracts.filter((contract) => (contract.contractType || 'maintenance') === 'maintenance');

        if (contractFilterStatus) {
            contracts = contracts.filter((contract) => contract.status === contractFilterStatus);
        }

        contracts = sortRows(contracts, contractSortValue, {
            startDate: (contract) => contract.startDate || contract.createdAt || '',
            client: (contract) => clientName(contract.accountId || contract.clientId).toLowerCase(),
            status: (contract) => contract.status || '',
        });

        if (!contracts.length) {
            $('contracts-tbody').innerHTML = '<tr><td colspan="10" class="admin-empty">No contracts match the current filters.</td></tr>';
            $('mobile-contracts-list').innerHTML = '<p class="admin-empty">No contracts match the current filters.</p>';
            return;
        }

        $('contracts-tbody').innerHTML = contracts.map((contract) => `
            <tr>
                <td>${esc(contract.contractNumber)}</td>
                <td><span class="admin-badge badge-${esc(contract.status)}">${esc(contract.status)}</span></td>
                <td><span class="admin-badge badge-${contract.paymentStatus === 'Paid' ? 'paid' : 'draft'}">${esc(contract.paymentStatus || 'Unpaid')}</span></td>
                <td>${esc(clientName(contract.accountId || contract.clientId))}</td>
                <td>${esc(contractPackageLabel(contract))}</td>
                <td>${esc(contract.billingCycle || 'monthly')}</td>
                <td>${Number(contract.maintenanceSummary?.remainingHours ?? 0)} hours remaining</td>
                <td>${esc(fmtDate(contract.startDate) || '—')}</td>
                <td>${esc(fmtDate(contract.nextPaymentDueAt) || '—')}</td>
                <td><div class="contract-table-actions">
                    <button class="admin-btn admin-btn-sm admin-btn-ghost" data-view-contract="${esc(contract.id)}" title="View contract PDF">View</button>
                    <button class="admin-btn admin-btn-sm admin-btn-ghost" data-edit-contract="${esc(contract.id)}">Edit</button>
                    ${contract.status === 'draft' ? `<button class="admin-btn admin-btn-sm admin-btn-ghost" data-entity="contract" data-id="${contract.id}" data-status="active">Activate</button>` : ''}
                    ${contract.status === 'active' ? `<button class="admin-btn admin-btn-sm admin-btn-ghost" data-entity="contract" data-id="${contract.id}" data-status="cancelled">Cancel</button>` : ''}
                    ${manualPaymentAction(contract)}
                    ${contractAttachmentsAction(contract)}
                    <button class="admin-btn admin-btn-sm admin-btn-ghost admin-btn-remove" data-delete-contract="${esc(contract.id)}">Remove</button>
                </div></td>
            </tr>
        `).join('');
        $('mobile-contracts-list').innerHTML = contracts.map((contract) => {
            const actions = `
                <button class="admin-btn admin-btn-sm admin-btn-ghost" data-view-contract="${esc(contract.id)}" title="View contract PDF">View</button>
                <button class="admin-btn admin-btn-sm admin-btn-ghost" data-edit-contract="${esc(contract.id)}">Edit</button>
                ${contract.status === 'draft' ? `<button class="admin-btn admin-btn-sm admin-btn-ghost" data-entity="contract" data-id="${esc(contract.id)}" data-status="active">Activate</button>` : ''}
                ${contract.status === 'active' ? `<button class="admin-btn admin-btn-sm admin-btn-ghost" data-entity="contract" data-id="${esc(contract.id)}" data-status="cancelled">Cancel</button>` : ''}
                ${manualPaymentAction(contract)}
                ${contractAttachmentsAction(contract)}
                <button class="admin-btn admin-btn-sm admin-btn-ghost admin-btn-remove" data-delete-contract="${esc(contract.id)}">Remove</button>
            `;
            return mobileRecordCard(
                contract.contractNumber,
                `<span class="contract-status-indicators"><span class="admin-badge badge-${esc(contract.status)}">${esc(contract.status)}</span><span class="admin-badge badge-${contract.paymentStatus === 'Paid' ? 'paid' : 'draft'}">${esc(contract.paymentStatus || 'Unpaid')}</span></span>`,
                clientName(contract.accountId || contract.clientId),
                [
                    ['Next due', fmtDate(contract.nextPaymentDueAt) || '—'],
                    ...contractPackageDetails(contract),
                    ['Billing cycle', contract.billingCycle],
                    ['Start date', contract.startDate || '—'],
                ],
                actions,
                true,
            );
        }).join('');
    }

    function renderLaborContractsTable() {
        let laborContracts = allContracts
            .filter((contract) => contract.contractType === 'labor')
            .filter((contract) => !laborContractFilterClientId || (contract.accountId || contract.clientId) === laborContractFilterClientId)
            .filter((contract) => !laborContractFilterStatus || contract.status === laborContractFilterStatus);

        laborContracts = sortRows(laborContracts, laborContractSortValue, {
            startDate: (contract) => contract.startDate || contract.createdAt || '',
            client: (contract) => clientName(contract.accountId || contract.clientId).toLowerCase(),
            status: (contract) => contract.status || '',
        });

        if (!laborContracts.length) {
            $('labor-contracts-tbody').innerHTML = '<tr><td colspan="6" class="admin-empty">No labor contracts match the current filters.</td></tr>';
            $('mobile-labor-contracts-list').innerHTML = '<p class="admin-empty">No labor contracts match the current filters.</p>';
            return;
        }

        const projectName = (contract) => contract.title || contract.contractNumber;
        const pricingSummary = (contract) => contract.laborPricingModel === 'fixed'
            ? `Quoted price · ${formatCurrency(contract.laborFixedAmountCents)}`
            : `${Number(contract.laborEstimatedHours || 0).toFixed(2)} hours · Labor ${formatCurrency(contract.laborEstimatedAmountCents || 0)} · Materials ${formatCurrency(contract.laborEstimatedMaterialsCents || 0)} · Other ${formatCurrency(contract.laborEstimatedOtherAmountCents || 0)} · Total ${formatCurrency(contract.laborSummary?.estimatedTotalAmountCents ?? (Number(contract.laborEstimatedAmountCents || 0) + Number(contract.laborEstimatedMaterialsCents || 0) + Number(contract.laborEstimatedOtherAmountCents || 0)))}`;
        const progressSummary = (contract) => {
            const summary = contract.laborSummary || {};
            return contract.laborPricingModel === 'fixed'
                ? `${formatCurrency(summary.invoicedAmountCents || 0)} invoiced · ${formatCurrency(summary.remainingAmountCents ?? contract.laborFixedAmountCents)} remaining`
                : `${Number(summary.actualHours || 0).toFixed(2)} of ${Number(summary.estimatedHours ?? contract.laborEstimatedHours ?? 0).toFixed(2)} hours tracked · ${formatCurrency(summary.invoicedAmountCents || 0)} invoiced`;
        };

        $('labor-contracts-tbody').innerHTML = laborContracts.map((contract) => `
            <tr>
                <td>${esc(contract.contractNumber)}</td>
                <td><span class="admin-badge badge-${esc(contract.status)}">${esc(contract.status)}</span></td>
                <td>${esc(projectName(contract))}</td>
                <td>${esc(clientName(contract.accountId || contract.clientId))}</td>
                <td>${esc(contract.serviceAddress || '—')}</td>
                <td><div class="contract-table-actions">
                    <button class="admin-btn admin-btn-sm admin-btn-ghost" data-view-contract="${esc(contract.id)}" title="View contract PDF">View</button>
                    <button class="admin-btn admin-btn-sm admin-btn-ghost" data-edit-contract="${esc(contract.id)}">Edit</button>
                    ${contract.status === 'draft' ? `<button class="admin-btn admin-btn-sm admin-btn-ghost" data-entity="contract" data-id="${esc(contract.id)}" data-status="active">Activate</button>` : ''}
                    ${contractAttachmentsAction(contract)}
                    <button class="admin-btn admin-btn-sm admin-btn-ghost admin-btn-remove" data-delete-contract="${esc(contract.id)}">Remove</button>
                </div></td>
            </tr>
        `).join('');
        $('mobile-labor-contracts-list').innerHTML = laborContracts.map((contract) => mobileRecordCard(
            `${contract.contractNumber} · ${projectName(contract)}`,
            `<span class="admin-badge badge-${esc(contract.status)}">${esc(contract.status)}</span>`,
            progressSummary(contract),
            [
                ['Client', clientName(contract.accountId || contract.clientId)],
                ['Pricing', pricingSummary(contract)],
                ['Service address', contract.serviceAddress || '—'],
                ['Scope', contract.scope || '—'],
            ],
            `
                <button class="admin-btn admin-btn-sm admin-btn-ghost" data-view-contract="${esc(contract.id)}" title="View contract PDF">View</button>
                <button class="admin-btn admin-btn-sm admin-btn-ghost" data-edit-contract="${esc(contract.id)}">Edit</button>
                ${contract.status === 'draft' ? `<button class="admin-btn admin-btn-sm admin-btn-ghost" data-entity="contract" data-id="${esc(contract.id)}" data-status="active">Activate</button>` : ''}
                ${contractAttachmentsAction(contract)}
                <button class="admin-btn admin-btn-sm admin-btn-ghost admin-btn-remove" data-delete-contract="${esc(contract.id)}">Remove</button>
            `,
            true,
        )).join('');
    }

    async function deleteContractRecord(contractId) {
        const contract = allContracts.find((entry) => entry.id === contractId);
        if (!contract || !window.confirm(`Remove contract ${contract.contractNumber}? This cannot be undone.`)) return;

        try {
            const response = await apiFetch(`/api/contracts/${encodeURIComponent(contractId)}`, { method: 'DELETE' });
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.error || 'Unable to remove contract.');
            await loadContracts();
            await loadSummary();
        } catch (error) {
            window.alert('Unable to remove contract: ' + error.message);
        }
    }

    function getLaborEstimateOtherItems() {
        return Array.from(document.querySelectorAll('#labor-estimate-other-container .labor-estimate-other-row')).map((row) => ({
            description: row.querySelector('[data-estimate-other-description]').value.trim(),
            amountCents: Math.max(0, Math.round(Number(row.querySelector('[data-estimate-other-amount]').value || 0) * 100)),
        })).filter((item) => item.description);
    }

    function getLaborEstimateMaterialsItems() {
        return Array.from(document.querySelectorAll('#labor-estimate-materials-container .labor-estimate-material-row')).map((row) => ({
            amountCents: Math.max(0, Math.round(Number(row.querySelector('[data-estimate-material-total]').value || 0) * 100)),
        }));
    }

    function addLaborEstimateMaterialItem(initialValues = {}) {
        const container = $('labor-estimate-materials-container');
        if (container.querySelector('.labor-estimate-material-row')) return;
        const addButton = $('add-labor-estimate-material-btn');
        addButton.classList.add('hidden');
        addButton.disabled = true;
        const row = document.createElement('div');
        row.className = 'invoice-item-row labor-estimate-material-row';
        row.innerHTML = `
            <span class="invoice-item-trigger invoice-item-kind">Materials</span>
            <div class="invoice-item-value-group">
                <label class="invoice-item-inline-label">Total
                    <input class="invoice-item-input" data-estimate-material-total type="number" min="0" step="0.01" value="${(Number(initialValues.amountCents || 0) / 100).toFixed(2)}" placeholder="0.00">
                </label>
            </div>
            <button type="button" class="admin-btn admin-btn-sm admin-btn-ghost invoice-remove-row-btn">Remove</button>
        `;
        row.querySelector('[data-estimate-material-total]').addEventListener('input', updateLaborEstimateSummary);
        row.querySelector('.invoice-remove-row-btn').addEventListener('click', () => {
            row.remove();
            addButton.classList.remove('hidden');
            addButton.disabled = $('labor-pricing-model').value === 'fixed';
            updateLaborEstimateSummary();
        });
        container.appendChild(row);
        updateLaborEstimateSummary();
    }

    function populateLaborEstimateMaterialsItems(items = []) {
        $('labor-estimate-materials-container').innerHTML = '';
        $('add-labor-estimate-material-btn').classList.remove('hidden');
        const totalAmountCents = items.reduce((sum, item) => sum + Math.max(0, Number(item.amountCents || 0)), 0);
        if (items.length) addLaborEstimateMaterialItem({ amountCents: totalAmountCents });
        const hasMaterialsRow = Boolean($('labor-estimate-materials-container').querySelector('.labor-estimate-material-row'));
        $('add-labor-estimate-material-btn').classList.toggle('hidden', hasMaterialsRow);
        $('add-labor-estimate-material-btn').disabled = $('labor-pricing-model').value === 'fixed' || hasMaterialsRow;
    }

    function addLaborEstimateOtherItem(initialValues = {}) {
        const row = document.createElement('div');
        row.className = 'invoice-item-row labor-estimate-other-row';
        row.innerHTML = `
            <label class="invoice-item-inline-label invoice-item-description-label">Description
                <input class="invoice-item-input" data-estimate-other-description type="text" maxlength="160" value="${esc(initialValues.description || '')}" placeholder="Enter item description" required>
            </label>
            <label class="invoice-item-inline-label">Total
                <input class="invoice-item-input" data-estimate-other-amount type="number" min="0" step="0.01" value="${(Number(initialValues.amountCents || 0) / 100).toFixed(2)}" placeholder="0.00">
            </label>
            <button type="button" class="admin-btn admin-btn-sm admin-btn-ghost invoice-remove-row-btn">Remove</button>
        `;
        row.querySelector('[data-estimate-other-description]').addEventListener('input', updateLaborEstimateSummary);
        row.querySelector('[data-estimate-other-amount]').addEventListener('input', updateLaborEstimateSummary);
        row.querySelector('.invoice-remove-row-btn').addEventListener('click', () => {
            row.remove();
            updateLaborEstimateSummary();
        });
        $('labor-estimate-other-container').appendChild(row);
        updateLaborEstimateSummary();
    }

    function populateLaborEstimateOtherItems(items = []) {
        $('labor-estimate-other-container').innerHTML = '';
        items.forEach((item) => addLaborEstimateOtherItem(item));
    }

    function addLaborEstimateRow(initialValues = {}) {
        const container = $('labor-estimate-contractor-hours-container');
        const availableContractors = allContractors.filter((contractor) => contractor.status === 'active'
            || contractor.id === initialValues.contractorId);
        const contractorId = initialValues.contractorId || availableContractors[0]?.id || '';
        const contractor = allContractors.find((entry) => entry.id === contractorId);
        const rateCents = Number(initialValues.hourlyRateCents ?? contractor?.hourlyRateCents ?? 0);
        const row = document.createElement('div');
        row.className = 'invoice-item-row invoice-contractor-row labor-estimate-row';
        row.innerHTML = `
            <label class="invoice-item-inline-label">Contractor
                <select data-estimate-contractor-id>
                    ${availableContractors.map((entry) => `<option value="${esc(entry.id)}" ${entry.id === contractorId ? 'selected' : ''}>${esc(entry.name)}</option>`).join('')}
                </select>
            </label>
            <label class="invoice-item-inline-label">Estimated Hours
                <input class="invoice-item-input" data-estimate-hours type="number" min="0.25" step="0.25" value="${Number(initialValues.hours || 1)}">
            </label>
            <span class="invoice-contractor-rate" data-estimate-rate-cents="${rateCents}">${formatCurrency(getContractorInvoiceRateCents(contractor, rateCents))}/hr</span>
            <button type="button" class="admin-btn admin-btn-sm admin-btn-ghost invoice-remove-row-btn">Remove</button>
        `;
        row.querySelector('[data-estimate-contractor-id]').addEventListener('change', (event) => {
            const selected = allContractors.find((entry) => entry.id === event.target.value);
            const rate = Number(selected?.hourlyRateCents || 0);
            const display = row.querySelector('.invoice-contractor-rate');
            display.dataset.estimateRateCents = String(rate);
            display.textContent = `${formatCurrency(getContractorInvoiceRateCents(selected, rate))}/hr`;
            updateLaborEstimateSummary();
        });
        row.querySelector('[data-estimate-hours]').addEventListener('input', updateLaborEstimateSummary);
        row.querySelector('.invoice-remove-row-btn').addEventListener('click', () => {
            row.remove();
            updateLaborEstimateSummary();
        });
        container.appendChild(row);
        updateLaborEstimateSummary();
    }

    function populateLaborEstimateRows(entries = []) {
        $('labor-estimate-contractor-hours-container').innerHTML = '';
        (entries.length ? entries : [{}]).forEach((entry) => addLaborEstimateRow(entry));
    }

    function getLaborEstimateRows() {
        return Array.from(document.querySelectorAll('#labor-estimate-contractor-hours-container .labor-estimate-row')).map((row) => ({
            contractorId: row.querySelector('[data-estimate-contractor-id]').value,
            hours: Number(row.querySelector('[data-estimate-hours]').value || 0),
            hourlyRateCents: Number(row.querySelector('[data-estimate-rate-cents]').dataset.estimateRateCents || 0),
        })).filter((entry) => entry.contractorId && entry.hours > 0);
    }

    function updateLaborEstimateSummary() {
        const entries = getLaborEstimateRows();
        const laborCents = buildContractorLaborItems(entries).reduce((total, item) => total + Math.round(item.quantity * item.unitPriceCents), 0);
        const materialsCents = getLaborEstimateMaterialsItems().reduce((total, item) => total + item.amountCents, 0);
        const otherCents = getLaborEstimateOtherItems().reduce((total, item) => total + item.amountCents, 0);
        $('labor-estimate-summary').textContent = `Labor ${formatCurrency(laborCents)} · Materials ${formatCurrency(materialsCents)} · Other ${formatCurrency(otherCents)} · Total ${formatCurrency(laborCents + materialsCents + otherCents)}`;
    }

    function updateContractFormType() {
        const form = $('form-new-contract');
        const isLabor = form.elements.namedItem('contractType').value === 'labor';
        $('contract-maintenance-fields').classList.toggle('hidden', isLabor);
        $('contract-labor-fields').classList.toggle('hidden', !isLabor);
        $('contract-billing-cycle-wrapper').classList.toggle('hidden', isLabor);
        $('contract-maintenance-fields').querySelectorAll('input, select').forEach((input) => {
            input.disabled = isLabor;
            if (isLabor) input.required = false;
        });
        $('contract-labor-fields').querySelectorAll('input, select, textarea').forEach((input) => {
            input.disabled = !isLabor;
            if (!isLabor) input.required = false;
        });
        form.elements.namedItem('billingCycle').disabled = isLabor;
        form.elements.namedItem('title').required = isLabor;
        form.elements.namedItem('scope').required = isLabor;
        form.elements.namedItem('packageType').required = !isLabor;
        if (!isLabor) $('contract-package-type').dispatchEvent(new Event('change', { bubbles: true }));
        updateLaborPricingFields();
    }

    function openNewContractForm(contractType = 'maintenance') {
        editingContractId = null;
        const form = $('form-new-contract');
        form.reset();
        form.elements.namedItem('contractType').value = contractType;
        form.elements.namedItem('laborPricingModel').value = 'fixed';
        $('labor-estimate-contractor-hours-container').innerHTML = '';
        $('labor-estimate-materials-container').innerHTML = '';
        $('labor-estimate-other-container').innerHTML = '';
        $('add-labor-estimate-material-btn').classList.remove('hidden');
        populateContractServiceAddressSelect('');
        updateContractFormType();
        $('contract-modal-title').textContent = contractType === 'labor' ? 'New Labor Contract' : 'New Maintenance Contract';
        $('contract-submit-button').textContent = 'Create Contract';
        $('msg-new-contract').textContent = '';
        openModal('modal-new-contract');
    }

    function updateLaborPricingFields() {
        const model = $('labor-pricing-model').value;
        const isLabor = $('form-new-contract').elements.namedItem('contractType').value === 'labor';
        const isFixed = isLabor && model === 'fixed';
        const isHourlyEstimate = isLabor && model === 'hourly_estimate';
        $('labor-fixed-amount-wrapper').classList.toggle('hidden', !isFixed);
        $('labor-estimate-wrapper').classList.toggle('hidden', !isHourlyEstimate);
        $('form-new-contract').elements.namedItem('laborFixedAmount').required = isFixed;
        $('form-new-contract').elements.namedItem('laborFixedAmount').disabled = !isFixed;
        $('labor-estimate-other-container').querySelectorAll('input').forEach((input) => {
            input.disabled = !isHourlyEstimate;
            input.required = isHourlyEstimate && input.matches('[data-estimate-other-description]');
        });
        $('add-labor-estimate-other-btn').disabled = !isHourlyEstimate;
        $('labor-estimate-materials-container').querySelectorAll('input').forEach((input) => {
            input.disabled = !isHourlyEstimate;
        });
        const hasMaterialsRow = Boolean($('labor-estimate-materials-container').querySelector('.labor-estimate-material-row'));
        $('add-labor-estimate-material-btn').classList.toggle('hidden', hasMaterialsRow);
        $('add-labor-estimate-material-btn').disabled = !isHourlyEstimate || hasMaterialsRow;
        $('labor-estimate-contractor-hours-container').querySelectorAll('[data-estimate-contractor-id], [data-estimate-hours]').forEach((input) => {
            input.required = isHourlyEstimate;
            input.disabled = !isHourlyEstimate;
        });
        updateLaborEstimateSummary();
    }

    function populateContractServiceAddressSelect(clientId, selectedAddress = '') {
        const select = $('contract-service-address-select');
        const client = allClients.find((entry) => entry.id === clientId);
        if (!client) {
            select.innerHTML = '<option value="">Select a client first…</option>';
            return;
        }

        const addresses = [...new Set([client.address, ...(Array.isArray(client.serviceAddresses) ? client.serviceAddresses : []), ...(client.businesses || []).map((business) => business.address)]
            .map((address) => String(address || '').trim())
            .filter(Boolean))];
        if (selectedAddress && !addresses.some((address) => address.toLocaleLowerCase() === selectedAddress.toLocaleLowerCase())) {
            addresses.unshift(selectedAddress.trim());
        }
        select.innerHTML = '<option value="">Select a service address…</option>'
            + addresses.map((address) => `<option value="${esc(address)}">${esc(address)}</option>`).join('');
        select.value = selectedAddress || addresses[0] || '';
    }

    function openContractEditor(contractId) {
        const contract = allContracts.find((entry) => entry.id === contractId);
        if (!contract) {
            return;
        }

        editingContractId = contract.id;
        const form = $('form-new-contract');
        form.reset();
        form.elements.namedItem('contractType').value = contract.contractType || 'maintenance';
        form.elements.namedItem('clientId').value = contract.accountId || contract.clientId || '';
        populateContractServiceAddressSelect(form.elements.namedItem('clientId').value, contract.serviceAddress || '');
        form.elements.namedItem('title').value = contract.title || '';
        form.elements.namedItem('scope').value = contract.scope || '';
        form.elements.namedItem('laborPricingModel').value = contract.laborPricingModel || 'fixed';
        form.elements.namedItem('laborFixedAmount').value = contract.laborFixedAmountCents == null ? '' : (Number(contract.laborFixedAmountCents) / 100).toFixed(2);
        populateLaborEstimateMaterialsItems(contract.laborEstimatedMaterialsItems
            || (Number(contract.laborEstimatedMaterialsCents) > 0 ? [{ amountCents: contract.laborEstimatedMaterialsCents }] : []));
        populateLaborEstimateRows(contract.laborEstimatedContractorHours || []);
        populateLaborEstimateOtherItems(contract.laborEstimatedOtherItems || []);
        updateContractFormType();
        $('contract-package-type').value = contract.packageType || '';
        $('contract-package-type').dispatchEvent(new Event('change', { bubbles: true }));
        $('contract-package-level').value = contract.packageLevel || '';
        $('contract-package-coverage-type').value = contract.packageCoverageType || 'single_home';
        form.elements.namedItem('packageMonthlyCost').value = contract.packageMonthlyCostCents == null
            ? ''
            : (Number(contract.packageMonthlyCostCents) / 100).toFixed(2);
        form.elements.namedItem('packageRetainerHours').value = contract.packageRetainerHours ?? '';
        form.elements.namedItem('packageRolloverHours').value = contract.packageRolloverHours ?? 0;
        form.elements.namedItem('packageDiscountPercent').value = contract.packageDiscountPercent ?? 0;
        form.elements.namedItem('packagePriorityScheduling').checked = Boolean(contract.packagePriorityScheduling);
        form.elements.namedItem('packageAnnualInspection').checked = Boolean(contract.packageAnnualInspection);
        form.elements.namedItem('packageQuarterlyInspection').checked = Boolean(contract.packageQuarterlyInspection);
        form.elements.namedItem('packageOnCallService').checked = Boolean(contract.packageOnCallService);
        form.elements.namedItem('packageTenantCoordination').checked = Boolean(contract.packageTenantCoordination);
        form.elements.namedItem('billingCycle').value = contract.billingCycle || 'monthly';
        form.elements.namedItem('startDate').value = contract.startDate || '';
        $('contract-modal-title').textContent = contract.contractType === 'labor'
            ? `Edit Labor Contract ${contract.contractNumber || ''}`.trim()
            : `Edit Maintenance Contract ${contract.contractNumber || ''}`.trim();
        $('contract-submit-button').textContent = 'Save Contract Changes';
        openModal('modal-new-contract');
    }

    function contractPackageLabel(contract) {
        if (contract.packageType === 'custom') {
            return `Custom ${contract.packageCoverageType === 'portfolio' ? 'Portfolio' : 'Single Home'} · ${formatCurrency(contract.packageMonthlyCostCents)}/mo`;
        }
        if (!contract.packageType || !contract.packageLevel) {
            return '—';
        }
        const type = contract.packageType === 'single_home' ? 'Single Home' : 'Portfolio';
        const level = contract.packageLevel.charAt(0).toUpperCase() + contract.packageLevel.slice(1);
        return `${type} · ${level}`;
    }

    function contractPackageDetails(contract) {
        const retainerDetails = [
            ['Retainer', `${Number(contract.maintenanceSummary?.remainingHours ?? 0)} hours remaining`],
        ];
        if (contract.packageType !== 'custom') {
            return [['Package', contractPackageLabel(contract)], ...retainerDetails];
        }

        const includedServices = [
            ['packagePriorityScheduling', 'Priority scheduling'],
            ['packageAnnualInspection', 'Annual inspection'],
            ['packageQuarterlyInspection', 'Quarterly inspection'],
            ['packageOnCallService', 'On-call service'],
            ['packageTenantCoordination', 'Tenant coordination'],
        ].filter(([field]) => contract[field]).map(([, label]) => label);

        return [
            ['Package', contractPackageLabel(contract)],
            ...retainerDetails,
            ['Discount', `${Number(contract.packageDiscountPercent || 0)}%`],
            ['Included services', includedServices.length ? includedServices.join(', ') : 'None'],
        ];
    }
