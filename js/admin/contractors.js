    function renderContractors() {
        const activeContractors = allContractors.filter((contractor) => contractor.status === 'active');
        $('invoice-contractor-actions').innerHTML = activeContractors.map((contractor) =>
            `<button type="button" class="admin-btn admin-btn-sm admin-btn-ghost" data-add-contractor-hours="${esc(contractor.id)}">+ ${esc(contractor.name)}</button>`).join('');
        populateContractorTaxYearOptions();
        updateContractorTaxPeriodVisibility();
        renderContractorsTable();
    }

    function getContractorPaymentReportDate(payment) {
        const invoice = adminInvoices.find((entry) => entry.id === payment.invoiceId);
        if (invoice) {
            return String(invoice.issueDate || payment.date || invoice.updatedAt || payment.createdAt || '').slice(0, 10);
        }
        const date = payment.status === 'paid'
            ? payment.paidAt || payment.date
            : payment.date;
        return String(date || payment.createdAt || '').slice(0, 10);
    }

    function populateContractorTaxYearOptions() {
        const select = $('contractor-tax-year');
        const previousYear = select.value;
        const currentYear = String(new Date().getFullYear());
        const years = new Set([currentYear]);
        contractorPayments.forEach((payment) => {
            const year = getContractorPaymentReportDate(payment).slice(0, 4);
            if (/^\d{4}$/.test(year)) {
                years.add(year);
            }
        });
        ownerHourEntries.forEach((entry) => {
            const year = String(entry.date || '').slice(0, 4);
            if (/^\d{4}$/.test(year)) {
                years.add(year);
            }
        });
        const sortedYears = Array.from(years).sort((first, second) => Number(second) - Number(first));
        select.innerHTML = sortedYears.map((year) => `<option value="${year}">${year}</option>`).join('');
        select.value = sortedYears.includes(previousYear) ? previousYear : currentYear;
    }

    function updateContractorTaxPeriodVisibility() {
        const period = $('contractor-tax-period').value;
        $('contractor-tax-quarter-wrapper').hidden = period !== 'quarter';
        $('contractor-tax-month-wrapper').hidden = period !== 'month';
    }

    function getFilteredContractorPayments() {
        const year = $('contractor-tax-year').value;
        const period = $('contractor-tax-period').value;
        const quarter = Number($('contractor-tax-quarter').value);
        const month = Number($('contractor-tax-month').value);

        return contractorPayments.filter((payment) => {
            const contractor = allContractors.find((entry) => entry.id === payment.contractorId);
            if (contractor?.isOwner) {
                return false;
            }

            const dateMatch = getContractorPaymentReportDate(payment).match(/^(\d{4})-(\d{2})-(\d{2})$/);
            if (!dateMatch || dateMatch[1] !== year) {
                return false;
            }
            const paymentMonth = Number(dateMatch[2]);
            if (period === 'quarter' && Math.ceil(paymentMonth / 3) !== quarter) {
                return false;
            }
            if (period === 'month' && paymentMonth !== month) {
                return false;
            }
            return true;
        });
    }

    function summarizeContractorPayments(payments) {
        const summaries = new Map();
        payments.forEach((payment) => {
            const summary = summaries.get(payment.contractorId) || { hours: 0, paidHours: 0, unpaidHours: 0, paidCents: 0, unpaidCents: 0 };
            summary.hours += Number(payment.hours || 0);
            const invoice = adminInvoices.find((entry) => entry.id === payment.invoiceId);
            if ((invoice?.status ?? payment.status) === 'paid') {
                summary.paidHours += Number(payment.hours || 0);
                summary.paidCents += Number(payment.amountCents || 0);
            } else {
                summary.unpaidHours += Number(payment.hours || 0);
                summary.unpaidCents += Number(payment.amountCents || 0);
            }
            summaries.set(payment.contractorId, summary);
        });
        return summaries;
    }

    function getFilteredOwnerHours() {
        const year = $('contractor-tax-year').value;
        const period = $('contractor-tax-period').value;
        const quarter = Number($('contractor-tax-quarter').value);
        const month = Number($('contractor-tax-month').value);

        return ownerHourEntries.filter((entry) => {
            const dateMatch = String(entry.date || '').slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
            if (!dateMatch || dateMatch[1] !== year) {
                return false;
            }
            const entryMonth = Number(dateMatch[2]);
            if (period === 'quarter' && Math.ceil(entryMonth / 3) !== quarter) {
                return false;
            }
            if (period === 'month' && entryMonth !== month) {
                return false;
            }
            return true;
        });
    }

    function summarizeOwnerHours(entries) {
        const summaries = new Map();
        entries.forEach((entry) => {
            const summary = summaries.get(entry.contractorId) || { paidHours: 0, unpaidHours: 0, paidCents: 0, unpaidCents: 0 };
            const hours = Number(entry.hours || 0);
            const amountCents = Math.round(hours * Number(entry.hourlyRateCents || 0));
            if (entry.invoiceStatus === 'paid') {
                summary.paidHours += hours;
                summary.paidCents += amountCents;
            } else {
                summary.unpaidHours += hours;
                summary.unpaidCents += amountCents;
            }
            summaries.set(entry.contractorId, summary);
        });
        return summaries;
    }

    function renderContractorsTable() {
        const selectedPayments = getFilteredContractorPayments();
        const paymentSummaries = summarizeContractorPayments(selectedPayments);
        const ownerHourSummaries = summarizeOwnerHours(getFilteredOwnerHours());

        if (!allContractors.length) {
            $('contractors-tbody').innerHTML = '<tr><td colspan="7" class="admin-empty">No contractors found.</td></tr>';
            $('mobile-contractors-list').innerHTML = '<p class="admin-empty">No contractors found.</p>';
            return;
        }

        $('contractors-tbody').innerHTML = allContractors.map((contractor) => {
            const paymentSummary = paymentSummaries.get(contractor.id) || { hours: 0, paidHours: 0, unpaidHours: 0, paidCents: 0, unpaidCents: 0 };
            const ownerSummary = ownerHourSummaries.get(contractor.id) || { paidHours: 0, unpaidHours: 0, paidCents: 0, unpaidCents: 0 };
            const paidHours = contractor.isOwner ? ownerSummary.paidHours : paymentSummary.paidHours;
            const unpaidHours = contractor.isOwner ? ownerSummary.unpaidHours : paymentSummary.unpaidHours;
            const totalHours = paidHours + unpaidHours;
            const paidCents = contractor.isOwner ? ownerSummary.paidCents : paymentSummary.paidCents;
            const unpaidCents = contractor.isOwner ? ownerSummary.unpaidCents : paymentSummary.unpaidCents;
            const rateLabel = contractor.isOwner
                ? `${formatCurrency(contractor.hourlyRateCents)}/hr base + $10/hr per overlapping contractor`
                : `${formatCurrency(contractor.hourlyRateCents)}/hr`;
            return `
                <tr>
                    <td>${esc(contractor.name)}${contractor.isOwner ? ' <span class="admin-badge badge-draft">Owner</span>' : ''}</td>
                    <td><span class="admin-badge badge-${esc(contractor.status)}">${esc(contractor.status)}</span></td>
                    <td>${rateLabel}</td>
                    <td>${totalHours.toFixed(2)}</td>
                    <td>${formatCurrency(paidCents)}</td>
                    <td>${formatCurrency(unpaidCents)}</td>
                    <td>
                        <button class="admin-btn admin-btn-sm admin-btn-ghost" data-edit-contractor="${esc(contractor.id)}">Edit</button>
                        ${!contractor.isOwner ? `<button class="admin-btn admin-btn-sm admin-btn-ghost admin-btn-remove" data-delete-contractor="${esc(contractor.id)}">Remove</button>` : ''}
                    </td>
                </tr>
            `;
        }).join('');
        $('mobile-contractors-list').innerHTML = allContractors.map((contractor) => {
            const paymentSummary = paymentSummaries.get(contractor.id) || { hours: 0, paidHours: 0, unpaidHours: 0, paidCents: 0, unpaidCents: 0 };
            const ownerSummary = ownerHourSummaries.get(contractor.id) || { paidHours: 0, unpaidHours: 0, paidCents: 0, unpaidCents: 0 };
            const paidHours = contractor.isOwner ? ownerSummary.paidHours : paymentSummary.paidHours;
            const unpaidHours = contractor.isOwner ? ownerSummary.unpaidHours : paymentSummary.unpaidHours;
            const totalHours = paidHours + unpaidHours;
            const paidCents = contractor.isOwner ? ownerSummary.paidCents : paymentSummary.paidCents;
            const unpaidCents = contractor.isOwner ? ownerSummary.unpaidCents : paymentSummary.unpaidCents;
            const rateLabel = contractor.isOwner
                ? `${formatCurrency(contractor.hourlyRateCents)}/hr base + $10/hr per overlapping contractor`
                : `${formatCurrency(contractor.hourlyRateCents)}/hr`;
            return mobileRecordCard(
                contractor.name,
                `<span class="admin-badge badge-${esc(contractor.status)}">${contractor.isOwner ? 'Owner · ' : ''}${esc(contractor.status)}</span>`,
                `${totalHours.toFixed(2)} hrs`,
                [
                    ['Pay rate', rateLabel],
                    ['Paid amount', formatCurrency(paidCents)],
                    ['Unpaid amount', formatCurrency(unpaidCents)],
                ],
                `
                    <button class="admin-btn admin-btn-sm admin-btn-ghost" data-edit-contractor="${esc(contractor.id)}">Edit</button>
                    ${!contractor.isOwner ? `<button class="admin-btn admin-btn-sm admin-btn-ghost admin-btn-remove" data-delete-contractor="${esc(contractor.id)}">Remove</button>` : ''}
                `,
                true,
            );
        }).join('');
    }

    function openNewContractorForm() {
        editingContractorId = null;
        const form = $('form-contractor');
        form.reset();
        form.elements.namedItem('status').disabled = false;
        $('contractor-status-label').classList.remove('hidden');
        $('contractor-modal-title').textContent = 'New Contractor';
        $('contractor-submit-button').textContent = 'Create Contractor';
        openModal('modal-contractor');
    }

    function openContractorEditor(contractorId) {
        const contractor = allContractors.find((entry) => entry.id === contractorId);
        if (!contractor) {
            return;
        }

        editingContractorId = contractor.id;
        const form = $('form-contractor');
        form.reset();
        form.elements.namedItem('name').value = contractor.name;
        form.elements.namedItem('hourlyRate').value = (Number(contractor.hourlyRateCents || 0) / 100).toFixed(2);
        form.elements.namedItem('status').value = contractor.status;
        form.elements.namedItem('status').disabled = contractor.isOwner;
        $('contractor-status-label').classList.toggle('hidden', contractor.isOwner);
        $('contractor-modal-title').textContent = `Edit ${contractor.name}`;
        $('contractor-submit-button').textContent = 'Save Changes';
        openModal('modal-contractor');
    }

    async function deleteContractorRecord(contractorId) {
        const contractor = allContractors.find((entry) => entry.id === contractorId);
        if (!contractor || contractor.isOwner) {
            return;
        }
        if (!window.confirm(`Remove contractor ${contractor.name}? Contractors with recorded hours or payments cannot be removed.`)) {
            return;
        }

        try {
            const response = await apiFetch(`/api/contractors/${encodeURIComponent(contractorId)}`, { method: 'DELETE' });
            const payload = await response.json();
            if (!response.ok) {
                throw new Error(payload.error || 'Unable to remove contractor.');
            }
            await loadContractors();
            await loadSummary();
        } catch (error) {
            window.alert('Unable to remove contractor: ' + error.message);
        }
    }
