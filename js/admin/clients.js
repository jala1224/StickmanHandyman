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
            <div class="client-service-address-header">
                <h4 class="client-service-address-title">Service Address</h4>
                <button type="button" class="admin-btn admin-btn-sm admin-btn-ghost client-service-address-remove-btn">Remove</button>
            </div>
            <div class="client-address-fields">
                <label class="client-address-street">Street Address <input data-address-part="street" autocomplete="address-line1" required></label>
                <label class="client-address-city">City <input data-address-part="city" autocomplete="address-level2" required></label>
                <label>State <select data-address-part="state" data-state-select autocomplete="address-level1" required></select></label>
                <label>ZIP Code <input data-address-part="zip" autocomplete="postal-code" inputmode="numeric" pattern="[0-9]{5}(-[0-9]{4})?" maxlength="10"></label>
            </div>
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
