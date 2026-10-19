    function renderContracts(contracts) {
        allContracts = contracts;
        renderContractsTable();
    }

    function renderContractsTable() {
        let contracts = contractFilterClientId
            ? allContracts.filter((contract) => (contract.accountId || contract.clientId) === contractFilterClientId)
            : allContracts.slice();

        if (contractFilterStatus) {
            contracts = contracts.filter((contract) => contract.status === contractFilterStatus);
        }

        contracts = sortRows(contracts, contractSortValue, {
            startDate: (contract) => contract.startDate || contract.createdAt || '',
            client: (contract) => clientName(contract.accountId || contract.clientId).toLowerCase(),
            status: (contract) => contract.status || '',
        });

        if (!contracts.length) {
            $('contracts-tbody').innerHTML = '<tr><td colspan="6" class="admin-empty">No contracts match the current filters.</td></tr>';
            $('mobile-contracts-list').innerHTML = '<p class="admin-empty">No contracts match the current filters.</p>';
            return;
        }

        $('contracts-tbody').innerHTML = contracts.map((contract) => `
            <tr>
                <td>${esc(contract.contractNumber)}</td>
                <td><span class="contract-status-indicators"><span class="admin-badge badge-${esc(contract.status)}">${esc(contract.status)}</span><span class="admin-badge badge-${contract.paymentStatus === 'Paid' ? 'paid' : 'draft'}">${esc(contract.paymentStatus || 'Unpaid')}</span></span></td>
                <td>${esc(clientName(contract.accountId || contract.clientId))}</td>
                <td><div class="contract-table-metadata"><span>${esc(contractPackageLabel(contract))}</span><span>${esc(contract.billingCycle || 'monthly')}</span></div></td>
                <td><div class="contract-table-metadata"><span>Start: ${esc(fmtDate(contract.startDate) || '—')}</span><span>Next due: ${esc(fmtDate(contract.nextPaymentDueAt) || '—')}</span></div></td>
                <td><div class="contract-table-actions">
                    <button class="admin-btn admin-btn-sm admin-btn-ghost" data-edit-contract="${esc(contract.id)}">Edit</button>
                    ${contract.status === 'draft' ? `<button class="admin-btn admin-btn-sm admin-btn-ghost" data-entity="contract" data-id="${contract.id}" data-status="active">Activate</button>` : ''}
                    ${contract.status === 'active' ? `<button class="admin-btn admin-btn-sm admin-btn-ghost" data-entity="contract" data-id="${contract.id}" data-status="cancelled">Cancel</button>` : ''}
                    <button class="admin-btn admin-btn-sm admin-btn-ghost admin-btn-remove" data-delete-contract="${esc(contract.id)}">Remove</button>
                </div></td>
            </tr>
        `).join('');
        $('mobile-contracts-list').innerHTML = contracts.map((contract) => {
            const actions = `
                <button class="admin-btn admin-btn-sm admin-btn-ghost" data-edit-contract="${esc(contract.id)}">Edit</button>
                ${contract.status === 'draft' ? `<button class="admin-btn admin-btn-sm admin-btn-ghost" data-entity="contract" data-id="${esc(contract.id)}" data-status="active">Activate</button>` : ''}
                ${contract.status === 'active' ? `<button class="admin-btn admin-btn-sm admin-btn-ghost" data-entity="contract" data-id="${esc(contract.id)}" data-status="cancelled">Cancel</button>` : ''}
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

    async function deleteContractRecord(contractId) {
        const contract = allContracts.find((entry) => entry.id === contractId);
        if (!contract || !window.confirm(`Remove contract ${contract.contractNumber}? This cannot be undone.`)) {
            return;
        }

        try {
            const response = await apiFetch(`/api/contracts/${encodeURIComponent(contractId)}`, { method: 'DELETE' });
            const payload = await response.json();
            if (!response.ok) {
                throw new Error(payload.error || 'Unable to remove contract.');
            }
            await loadContracts();
            await loadSummary();
        } catch (error) {
            window.alert(error.message || 'Unable to remove contract.');
        }
    }

    function openContractEditor(contractId) {
        const contract = allContracts.find((entry) => entry.id === contractId);
        if (!contract) {
            return;
        }

        editingContractId = contract.id;
        const form = $('form-new-contract');
        form.reset();
        form.elements.namedItem('clientId').value = contract.accountId || contract.clientId || '';
        $('contract-package-type').value = contract.packageType || '';
        $('contract-package-type').dispatchEvent(new Event('change', { bubbles: true }));
        $('contract-package-level').value = contract.packageLevel || '';
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
        $('contract-modal-title').textContent = `Edit Contract ${contract.contractNumber || ''}`.trim();
        $('contract-submit-button').textContent = 'Save Contract Changes';
        openModal('modal-new-contract');
    }

    function contractPackageLabel(contract) {
        if (contract.packageType === 'custom') {
            return `Custom · ${formatCurrency(contract.packageMonthlyCostCents)}/mo`;
        }
        if (!contract.packageType || !contract.packageLevel) {
            return '—';
        }
        const type = contract.packageType === 'single_home' ? 'Single Home' : 'Portfolio';
        const level = contract.packageLevel.charAt(0).toUpperCase() + contract.packageLevel.slice(1);
        return `${type} · ${level}`;
    }

    function contractPackageDetails(contract) {
        if (contract.packageType !== 'custom') {
            return [['Package', contractPackageLabel(contract)]];
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
            ['Retainer', `${Number(contract.packageRetainerHours || 0)} hours`],
            ['Rollover', `${Number(contract.packageRolloverHours || 0)} hours`],
            ['Discount', `${Number(contract.packageDiscountPercent || 0)}%`],
            ['Included services', includedServices.length ? includedServices.join(', ') : 'None'],
        ];
    }
