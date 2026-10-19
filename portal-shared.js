(function () {
    const storageKeys = Object.freeze({
        token: 'stickmanPortalToken',
        adminToken: 'stickmanPortalAdminToken',
        apiBase: 'stickmanPortalApiBase',
        lookupAccessToken: 'stickmanLookupAccessToken',
        lookupAccessExpiresAt: 'stickmanLookupAccessExpiresAt',
        lastLookupPayload: 'stickmanPortalLastLookupPayload',
        legacyAdminToken: 'stickmanAdminToken',
        legacyAdminApiBase: 'stickmanAdminApiBase',
    });

    const stateCodes = Object.freeze([
        'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA',
        'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA',
        'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY',
        'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX',
        'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
    ]);

    function saveJsonStorage(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch {
            return false;
        }
    }

    function readJsonStorage(key) {
        const raw = localStorage.getItem(key);
        if (!raw) {
            return null;
        }

        try {
            return JSON.parse(raw);
        } catch {
            localStorage.removeItem(key);
            return null;
        }
    }

    function clearLastLookupPayload() {
        localStorage.removeItem(storageKeys.lastLookupPayload);
    }

    function isLookupPayloadExpired(payload) {
        if (!payload || !payload.lookupAccessExpiresAt) {
            return false;
        }

        const expiresAt = new Date(payload.lookupAccessExpiresAt).getTime();
        if (!Number.isFinite(expiresAt)) {
            return true;
        }

        return Date.now() > expiresAt;
    }

    function saveLastLookupPayload(payload) {
        if (!payload || typeof payload !== 'object') {
            clearLastLookupPayload();
            return false;
        }

        const account = payload.account;
        if (!account || typeof account !== 'object' || !account.accountKey) {
            clearLastLookupPayload();
            return false;
        }

        const normalizedPayload = {
            account: {
                accountKey: String(account.accountKey || ''),
                name: String(account.name || ''),
                address: String(account.address || ''),
                clientLoginEnabled: Boolean(account.clientLoginEnabled),
            },
            invoices: Array.isArray(payload.invoices) ? payload.invoices : [],
            contracts: Array.isArray(payload.contracts) ? payload.contracts : [],
            lookupAccessExpiresAt: payload.lookupAccessExpiresAt || null,
        };

        if (!saveJsonStorage(storageKeys.lastLookupPayload, normalizedPayload)) {
            clearLastLookupPayload();
            return false;
        }

        return true;
    }

    function readLastLookupPayload() {
        const payload = readJsonStorage(storageKeys.lastLookupPayload);
        if (!payload || typeof payload !== 'object') {
            return null;
        }

        const account = payload.account;
        if (!account || typeof account !== 'object' || !account.accountKey) {
            clearLastLookupPayload();
            return null;
        }

        if (isLookupPayloadExpired(payload)) {
            clearLastLookupPayload();
            return null;
        }

        return payload;
    }

    function normalizeApiBase(value) {
        return String(value || '').trim().replace(/\/$/, '');
    }

    function isLocalHostname(hostname) {
        return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
    }

    function defaultApiBase() {
        const hostname = window.location.hostname.toLowerCase();
        if (!hostname) {
            return '';
        }
        return isLocalHostname(hostname) ? window.location.origin : 'https://api.stickman-handyman.com';
    }

    function formatClientAddress(parts) {
        const street = String(parts?.street || '').trim();
        const city = String(parts?.city || '').trim();
        const state = String(parts?.state || '').trim().toUpperCase();
        const zip = String(parts?.zip || '').trim();
        const locality = [city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
        return [street, locality].filter(Boolean).join(', ');
    }

    function parseClientAddress(address) {
        const [street = '', ...remainder] = String(address || '').split(',');
        const location = remainder.join(',').trim();
        const locationParts = location.split(',').map((part) => part.trim()).filter(Boolean);
        let city = '';
        let region = '';

        if (locationParts.length >= 2) {
            city = locationParts[0];
            region = locationParts.slice(1).join(' ');
        } else {
            const regionMatch = location.match(/^(.*?)\s+([A-Za-z]{2})\s+([0-9-]{5,10})$/);
            if (regionMatch) {
                city = regionMatch[1];
                region = `${regionMatch[2]} ${regionMatch[3]}`;
            } else {
                city = location;
            }
        }

        const regionMatch = region.match(/^([A-Za-z]{2})\s*(.*)$/);
        return {
            street: street.trim(),
            city,
            state: regionMatch ? regionMatch[1].toUpperCase() : '',
            zip: regionMatch ? regionMatch[2].trim() : '',
        };
    }

    function populateStateSelects(root = document) {
        root.querySelectorAll('[data-state-select]').forEach((select) => {
            const selectedValue = String(select.value || '').trim().toUpperCase();
            select.innerHTML = '<option value="">Select state</option>'
                + stateCodes.map((stateCode) => `<option value="${stateCode}">${stateCode}</option>`).join('');
            select.value = stateCodes.includes(selectedValue) ? selectedValue : '';
        });
    }

    function readApiBase() {
        const pageHostname = window.location.hostname.toLowerCase();
        if (pageHostname) {
            return defaultApiBase();
        }

        const storedApiBase = normalizeApiBase(
            localStorage.getItem(storageKeys.apiBase)
            || localStorage.getItem(storageKeys.legacyAdminApiBase)
            || ''
        );
        return storedApiBase || defaultApiBase();
    }

    function writeApiBase(value) {
        const normalizedValue = normalizeApiBase(value);
        if (normalizedValue) {
            localStorage.setItem(storageKeys.apiBase, normalizedValue);
            localStorage.setItem(storageKeys.legacyAdminApiBase, normalizedValue);
        } else {
            localStorage.removeItem(storageKeys.apiBase);
            localStorage.removeItem(storageKeys.legacyAdminApiBase);
        }
        return normalizedValue;
    }

    function syncApiBaseInput(input) {
        if (!input) {
            return;
        }

        const persistedValue = readApiBase();
        if (persistedValue && !input.value.trim()) {
            input.value = persistedValue;
        }

        const persistValue = () => {
            input.value = normalizeApiBase(input.value);
            writeApiBase(input.value);
        };

        input.addEventListener('change', persistValue);
        input.addEventListener('blur', persistValue);
    }

    function readClientToken() {
        return localStorage.getItem(storageKeys.token) || '';
    }

    function writeClientToken(token) {
        if (token) {
            localStorage.setItem(storageKeys.token, token);
        } else {
            localStorage.removeItem(storageKeys.token);
        }
        return token || '';
    }

    function clearClientSession() {
        localStorage.removeItem(storageKeys.token);
    }

    function readAdminToken() {
        return localStorage.getItem(storageKeys.adminToken)
            || localStorage.getItem(storageKeys.legacyAdminToken)
            || '';
    }

    function writeAdminToken(token) {
        if (token) {
            localStorage.setItem(storageKeys.adminToken, token);
            localStorage.setItem(storageKeys.legacyAdminToken, token);
        } else {
            localStorage.removeItem(storageKeys.adminToken);
            localStorage.removeItem(storageKeys.legacyAdminToken);
        }
        return token || '';
    }

    function clearAdminSession() {
        localStorage.removeItem(storageKeys.adminToken);
        localStorage.removeItem(storageKeys.legacyAdminToken);
    }

    function clearLookupAccess() {
        localStorage.removeItem(storageKeys.lookupAccessToken);
        localStorage.removeItem(storageKeys.lookupAccessExpiresAt);
    }

    function saveLookupAccess(payload) {
        if (payload.lookupAccessToken) {
            localStorage.setItem(storageKeys.lookupAccessToken, payload.lookupAccessToken);
        }
        if (payload.lookupAccessExpiresAt) {
            localStorage.setItem(storageKeys.lookupAccessExpiresAt, payload.lookupAccessExpiresAt);
        }
    }

    function readLookupAccessToken() {
        return localStorage.getItem(storageKeys.lookupAccessToken) || '';
    }

    async function parseJson(response) {
        const text = await response.text();
        if (!text) {
            return {};
        }

        try {
            return JSON.parse(text);
        } catch {
            return {};
        }
    }

    async function requestJson(url, options) {
        const response = await fetch(url, options);
        const payload = await parseJson(response);
        return { response, payload };
    }

    async function lookupAccount(apiBase, criteria) {
        const { response, payload } = await requestJson(`${apiBase}/api/clients/lookup`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                name: String(criteria.name || '').trim(),
                address: String(criteria.address || '').trim(),
            }),
        });

        if (!response.ok) {
            throw new Error(payload.message || payload.error || 'No matching account found.');
        }

        saveLookupAccess(payload);
        return payload;
    }

    async function activateAccount(apiBase, account, credentials) {
        const { response: activationResponse, payload: activationPayload } = await requestJson(`${apiBase}/api/client-auth/activate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                accountKey: account.accountKey,
                name: account.name,
                address: account.address,
                email: String(credentials.email || '').trim(),
                password: String(credentials.password || ''),
                notificationsEnabled: true,
                autopayEnabled: false,
            }),
        });

        if (!activationResponse.ok) {
            throw new Error(activationPayload.error || 'Unable to activate account access.');
        }

        const signInResult = await signInShared(apiBase, credentials);
        if (signInResult.role !== 'client') {
            throw new Error('Account activated, but client sign-in did not complete.');
        }

        return {
            activationPayload,
            signInResult,
        };
    }

    async function signInShared(apiBase, credentials) {
        const email = String(credentials.email || '').trim();
        const password = String(credentials.password || '');

        const { response: adminResponse, payload: adminPayload } = await requestJson(`${apiBase}/api/auth/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ email, password }),
        });

        if (adminResponse.ok) {
            clearClientSession();
            writeAdminToken(adminPayload.token);
            return {
                role: 'admin',
                token: adminPayload.token,
                admin: adminPayload.admin || null,
            };
        }

        const adminAuthStyleFailure = adminResponse.status === 400 || adminResponse.status === 401;
        if (!adminAuthStyleFailure) {
            throw new Error(adminPayload.error || 'Unable to sign in right now.');
        }

        const { response: clientResponse, payload: clientPayload } = await requestJson(`${apiBase}/api/client-auth/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ email, password }),
        });

        if (clientResponse.ok) {
            clearAdminSession();
            writeClientToken(clientPayload.token);
            return {
                role: 'client',
                token: clientPayload.token,
                clientUser: clientPayload.clientUser || null,
            };
        }

        const clientAuthStyleFailure = clientResponse.status === 400 || clientResponse.status === 401;
        if (clientAuthStyleFailure) {
            throw new Error('Invalid email or password.');
        }

        throw new Error(clientPayload.error || 'Unable to sign in right now.');
    }

    async function fetchClientMe(apiBase, token) {
        const { response, payload } = await requestJson(`${apiBase}/api/client-auth/me`, {
            headers: {
                'Authorization': `Bearer ${token}`,
            },
        });

        if (!response.ok) {
            const error = new Error(payload.error || 'Unable to load account.');
            error.status = response.status;
            throw error;
        }

        return payload;
    }

    async function updateClientPreferences(apiBase, token, preferences) {
        const { response, payload } = await requestJson(`${apiBase}/api/client-auth/preferences`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify(preferences),
        });

        if (!response.ok) {
            throw new Error(payload.error || 'Preferences update failed.');
        }

        return payload;
    }

    async function updateClientCredentials(apiBase, token, credentials) {
        const { response, payload } = await requestJson(`${apiBase}/api/client-auth/credentials`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify(credentials),
        });

        if (!response.ok) {
            throw new Error(payload.error || 'Sign-in details update failed.');
        }

        return payload;
    }

    async function updateClientProfile(apiBase, token, profile) {
        const { response, payload } = await requestJson(`${apiBase}/api/client-auth/me`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify(profile),
        });

        if (!response.ok) {
            throw new Error(payload.error || 'Account update failed.');
        }

        return payload;
    }

    async function fetchAdminSnapshot(apiBase, token) {
        const headers = {
            'Authorization': `Bearer ${token}`,
        };

        const responses = await Promise.all([
            requestJson(`${apiBase}/api/dashboard/summary`, { headers }),
            requestJson(`${apiBase}/api/clients`, { headers }),
            requestJson(`${apiBase}/api/invoices`, { headers }),
            requestJson(`${apiBase}/api/contracts`, { headers }),
        ]);

        const [summaryResult, clientsResult, invoicesResult, contractsResult] = responses;
        if (!summaryResult.response.ok) {
            const error = new Error(summaryResult.payload.error || 'Unable to load dashboard summary.');
            error.status = summaryResult.response.status;
            throw error;
        }
        if (!clientsResult.response.ok) {
            const error = new Error(clientsResult.payload.error || 'Unable to load clients.');
            error.status = clientsResult.response.status;
            throw error;
        }
        if (!invoicesResult.response.ok) {
            const error = new Error(invoicesResult.payload.error || 'Unable to load invoices.');
            error.status = invoicesResult.response.status;
            throw error;
        }
        if (!contractsResult.response.ok) {
            const error = new Error(contractsResult.payload.error || 'Unable to load contracts.');
            error.status = contractsResult.response.status;
            throw error;
        }

        return {
            summary: summaryResult.payload.summary || {},
            clients: clientsResult.payload.clients || [],
            invoices: invoicesResult.payload.invoices || [],
            contracts: contractsResult.payload.contracts || [],
        };
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function resolveAccountNavDestination() {
        if (readAdminToken()) {
            return 'portal-admin.html';
        }

        if (readClientToken()) {
            return 'portal-client.html';
        }

        return 'portal-find.html';
    }

    function applyAccountNavDestination(root = document) {
        const accountLink = Array
            .from(root.querySelectorAll('.nav-links a'))
            .find((link) => String(link.textContent || '').trim().toLowerCase() === 'account');

        if (accountLink) {
            accountLink.setAttribute('href', resolveAccountNavDestination());
        }
    }

    function initTopnav() {
        applyAccountNavDestination();

        const toggleButton = document.querySelector('.menu-toggle');
        const topnav = document.querySelector('.topnav');
        if (!toggleButton || !topnav) {
            return;
        }

        toggleButton.addEventListener('click', (event) => {
            event.stopPropagation();
            topnav.classList.toggle('expanded');
            toggleButton.setAttribute('aria-expanded', String(topnav.classList.contains('expanded')));
        });

        document.addEventListener('click', (event) => {
            if (!topnav.contains(event.target)) {
                topnav.classList.remove('expanded');
                toggleButton.setAttribute('aria-expanded', 'false');
            }
        });

        const preloadLinks = document.querySelectorAll('.nav-links a, .logo-bubble a');
        preloadLinks.forEach((link) => {
            link.addEventListener('mouseenter', () => {
                const href = link.getAttribute('href');
                if (href && !document.querySelector(`link[href="${href}"]`)) {
                    const preloadLink = document.createElement('link');
                    preloadLink.rel = 'preload';
                    preloadLink.href = href;
                    preloadLink.as = 'document';
                    document.head.appendChild(preloadLink);
                }
            });
        });
    }

    window.StickmanPortal = {
        storageKeys,
        normalizeApiBase,
        formatClientAddress,
        parseClientAddress,
        populateStateSelects,
        readApiBase,
        writeApiBase,
        syncApiBaseInput,
        readClientToken,
        writeClientToken,
        clearClientSession,
        readAdminToken,
        writeAdminToken,
        clearAdminSession,
        clearLookupAccess,
        saveLookupAccess,
        readLookupAccessToken,
        saveLastLookupPayload,
        readLastLookupPayload,
        clearLastLookupPayload,
        lookupAccount,
        activateAccount,
        signInShared,
        fetchClientMe,
        updateClientProfile,
        updateClientPreferences,
        updateClientCredentials,
        fetchAdminSnapshot,
        escapeHtml,
        resolveAccountNavDestination,
        applyAccountNavDestination,
        initTopnav,
    };
}());