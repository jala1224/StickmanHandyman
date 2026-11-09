    function renderClients(clients) {
        allClients = clients;
        populateClientSelects(clients);
        populateFilterClientSelects(clients);
        populateInvoiceServiceAddressSelect($('invoice-client-select').value || '');
        renderClientsTable();
    }

    function renderClientsTable() {
        const clients = sortRows(allClients, clientSortValue, {
            name: (client) => (client.name || '').toLowerCase(),
            createdAt: (client) => client.createdAt || '',
            status: (client) => client.status || '',
        });

        if (!clients.length) {
            $('clients-tbody').innerHTML = '<tr><td colspan="6" class="admin-empty">No clients yet.</td></tr>';
            $('mobile-clients-list').innerHTML = '<p class="admin-empty">No clients yet.</p>';
            return;
        }

        $('clients-tbody').innerHTML = clients.map((client) => `
            <tr>
                <td>${esc(client.name)}</td>
                <td><span class="admin-badge badge-${client.status}">${client.status}</span></td>
                <td>${esc(client.address)}</td>
                <td>${client.clientLoginEnabled ? '✓' : ''}</td>
                <td>${fmtDate(client.createdAt)}</td>
                <td><div class="client-table-actions">
                    <button class="admin-btn admin-btn-sm admin-btn-ghost" data-view-client-invoices="${esc(client.id)}">Invoices</button>
                    <button class="admin-btn admin-btn-sm admin-btn-ghost" data-edit-client="${esc(client.id)}">Edit</button>
                    <button class="admin-btn admin-btn-sm admin-btn-ghost" data-edit-client-login="${esc(client.id)}">${client.clientLoginEnabled ? 'Edit Login' : 'Set Login'}</button>
                    <button class="admin-btn admin-btn-sm admin-btn-ghost admin-btn-remove" data-delete-client="${esc(client.id)}">Remove</button>
                </div></td>
            </tr>
        `).join('');
        $('mobile-clients-list').innerHTML = clients.map((client) => mobileRecordCard(
            client.name,
            `<span class="admin-badge badge-${esc(client.status)}">${esc(client.status)}</span>`,
            client.address,
            [
                ['Login', client.clientLoginEnabled ? '✓' : ''],
                ['Created', fmtDate(client.createdAt)],
            ],
            `
                <button class="admin-btn admin-btn-sm admin-btn-ghost" data-view-client-invoices="${esc(client.id)}">Invoices</button>
                <button class="admin-btn admin-btn-sm admin-btn-ghost" data-edit-client="${esc(client.id)}">Edit</button>
                <button class="admin-btn admin-btn-sm admin-btn-ghost" data-edit-client-login="${esc(client.id)}">${client.clientLoginEnabled ? 'Edit Login' : 'Set Login'}</button>
                <button class="admin-btn admin-btn-sm admin-btn-ghost admin-btn-remove" data-delete-client="${esc(client.id)}">Remove</button>
            `,
            true,
        )).join('');
    }

    function openClientEditor(clientId) {
        const client = allClients.find((entry) => entry.id === clientId);
        if (!client) {
            return;
        }

        editingClientId = client.id;
        $('form-new-client').reset();
        $('form-new-client').elements.name.value = client.name;
        setClientAddressParts($('client-billing-address'), client.address);
        resetClientServiceAddressRows();
        if (Array.isArray(client.serviceAddresses) && client.serviceAddresses.length) {
            client.serviceAddresses.forEach((address) => addClientServiceAddressRow(address));
        }
        resetClientBusinesses();
        (client.businesses || []).forEach((business) => addClientBusinessRow(business));
        populateClientMergeSourceSelect(client);
        $('client-modal-title').textContent = `Edit ${client.name}`;
        $('client-submit-button').textContent = 'Update Client';
        openModal('modal-new-client');
    }

    function openClientLoginEditor(clientId) {
        const client = allClients.find((entry) => entry.id === clientId);
        if (!client) {
            return;
        }

        editingClientLoginId = client.id;
        const form = $('form-client-login');
        form.reset();
        form.elements.namedItem('email').value = client.clientLoginEmail || '';
        form.elements.namedItem('password').required = !client.clientLoginEnabled;
        $('client-login-modal-title').textContent = client.clientLoginEnabled
            ? `Edit Login for ${client.name}`
            : `Set Login for ${client.name}`;
        $('client-login-submit-button').textContent = client.clientLoginEnabled ? 'Save Login' : 'Create Login';
        setMsg('msg-client-login', '', false);
        openModal('modal-client-login');
    }

    function addClientServiceAddressRow(value = '') {
        const container = $('client-service-addresses-container');
        const row = document.createElement('div');
        row.className = 'client-service-address-row';
        row.innerHTML = `
            <div class="client-address-fields">
                <label class="client-address-street">Service Address <input data-address-part="street" autocomplete="address-line1" required></label>
                <label class="client-address-city">City <input data-address-part="city" autocomplete="address-level2" required></label>
                <label>State <select data-address-part="state" data-state-select autocomplete="address-level1" required></select></label>
                <label>ZIP Code <input data-address-part="zip" autocomplete="postal-code" inputmode="numeric" pattern="[0-9]{5}(-[0-9]{4})?" maxlength="10"></label>
            </div>
            <button type="button" class="admin-btn admin-btn-sm admin-btn-ghost client-service-address-remove-btn">Remove</button>
        `;
        portal.populateStateSelects(row);
        setClientAddressParts(row, value);
        row.querySelector('.client-service-address-remove-btn').addEventListener('click', () => row.remove());
        container.appendChild(row);
    }

    function getClientServiceAddressRows() {
        return Array.from(document.querySelectorAll('.client-service-address-row'))
            .map((row) => formatClientAddress(getClientAddressParts(row)))
            .filter(Boolean);
    }

    function getClientAddressParts(container) {
        return Object.fromEntries(Array.from(container.querySelectorAll('[data-address-part]'))
            .map((input) => [input.dataset.addressPart, input.value.trim()]));
    }

    function setClientAddressParts(container, address) {
        const parts = parseClientAddress(address);
        Array.from(container.querySelectorAll('[data-address-part]')).forEach((input) => {
            input.value = parts[input.dataset.addressPart] || '';
        });
    }

    function parseClientAddress(address) {
        return portal.parseClientAddress(address);
    }

    function formatClientAddress(parts) {
        return portal.formatClientAddress(parts);
    }

    function resetClientServiceAddressRows() {
        $('client-service-addresses-container').innerHTML = '';
    }

    function addClientBusinessRow(business = {}) {
        const container = $('client-businesses-container');
        if (!container) return;
        const row = document.createElement('div');
        row.className = 'client-business-row';
        row.innerHTML = `
            <input type="hidden" data-business-id value="${esc(business.id || '')}">
            <label>Business Name <input data-business-name maxlength="160" value="${esc(business.name || '')}" required></label>
            <div class="client-address-fields">
                <label class="client-address-street">Street Address <input data-address-part="street" autocomplete="address-line1" required></label>
                <label class="client-address-city">City <input data-address-part="city" autocomplete="address-level2" required></label>
                <label>State <select data-address-part="state" data-state-select autocomplete="address-level1" required></select></label>
                <label>ZIP Code <input data-address-part="zip" autocomplete="postal-code" inputmode="numeric" pattern="[0-9]{5}(-[0-9]{4})?" maxlength="10"></label>
            </div>
            <button type="button" class="admin-btn admin-btn-sm admin-btn-ghost client-business-remove-btn">Remove Business</button>
        `;
        portal.populateStateSelects(row);
        setClientAddressParts(row, business.address || '');
        row.querySelector('.client-business-remove-btn').addEventListener('click', () => row.remove());
        container.appendChild(row);
    }

    function getClientBusinesses() {
        if (!$('client-businesses-container')) return [];
        return Array.from(document.querySelectorAll('.client-business-row')).map((row) => ({
            id: row.querySelector('[data-business-id]').value || undefined,
            name: row.querySelector('[data-business-name]').value.trim(),
            address: formatClientAddress(getClientAddressParts(row)),
        })).filter((business) => business.name && business.address);
    }

    function resetClientBusinesses() {
        const container = $('client-businesses-container');
        if (container) container.innerHTML = '';
    }

    function populateClientMergeSourceSelect(targetClient = null) {
        const select = $('client-merge-source-select');
        const section = $('client-merge-section');
        const showButton = $('show-client-merge-button');
        const mergeButton = $('merge-client-button');
        const message = $('client-merge-message');
        if (!select || !section || !showButton || !mergeButton || !message) return;
        const sources = allClients.filter((client) => client.id !== targetClient?.id);
        select.innerHTML = '<option value="">Select a client…</option>'
            + sources.map((client) => `<option value="${esc(client.id)}">${esc(client.name)} · ${esc(client.address)}</option>`).join('');
        section.hidden = true;
        showButton.setAttribute('aria-expanded', 'false');
        showButton.hidden = !targetClient;
        showButton.disabled = !targetClient || !sources.length;
        showButton.title = !targetClient ? 'Save the client before merging another account' : !sources.length ? 'No other clients to merge' : 'Choose an existing client account';
        $('merge-client-button').disabled = true;
        $('client-merge-message').textContent = '';
        $('client-merge-message').className = 'admin-message';
    }

    async function mergeClientRecord() {
        if (!$('client-merge-source-select') || !$('merge-client-button') || !$('client-merge-message')) return;
        const targetId = editingClientId;
        const sourceId = $('client-merge-source-select').value;
        const target = allClients.find((client) => client.id === targetId);
        const source = allClients.find((client) => client.id === sourceId);
        if (!target || !source) return;
        if (!window.confirm(`Merge ${source.name} into ${target.name} as a business? The separate ${source.name} client record will be removed after its records are moved.`)) return;

        const button = $('merge-client-button');
        button.disabled = true;
        $('client-merge-message').textContent = 'Moving invoices, contracts, and account details…';
        try {
            const response = await apiFetch(`/api/clients/${encodeURIComponent(targetId)}/merge-business`, {
                method: 'POST',
                body: JSON.stringify({ sourceClientId: sourceId }),
            });
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.error || 'Unable to merge these client accounts.');
            closeModal('modal-new-client');
            await loadAll();
            setPageMessage(`${source.name} was added to ${target.name} as a business. ${payload.invoiceCount} invoice(s) and ${payload.contractCount} contract(s) moved.`, false);
        } catch (error) {
            $('client-merge-message').textContent = error.message || 'Unable to merge these client accounts.';
            $('client-merge-message').className = 'admin-message admin-message-error';
            button.disabled = false;
        }
    }

    async function deleteClientRecord(clientId) {
        const client = allClients.find((entry) => entry.id === clientId);
        if (!client) {
            return;
        }

        if (!window.confirm(`Remove client ${client.name}? This cannot be undone.`)) {
            return;
        }

        try {
            const response = await apiFetch(`/api/clients/${encodeURIComponent(clientId)}`, {
                method: 'DELETE',
            });
            const payload = await response.json();
            if (!response.ok) {
                throw new Error(payload.error || 'Unable to remove client.');
            }

            await loadClients();
            await loadSummary();
        } catch (error) {
            window.alert('Unable to remove client: ' + error.message);
        }
    }
