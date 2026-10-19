    const portal = window.StickmanPortal;
    portal.initTopnav();

    const foundPanel = document.getElementById('portal-found-panel');
    const fallbackPanel = document.getElementById('portal-found-fallback');
    const activationPanel = document.getElementById('portal-activation-panel');
    const activationToggle = document.getElementById('portal-activation-toggle');
    const signInPanel = document.getElementById('portal-signin-panel');
    const activationForm = document.getElementById('portal-activation-form');
    const activationMessage = document.getElementById('portal-activation-message');
    const activityPanel = document.getElementById('portal-activity-panel');
    const invoicesList = document.getElementById('portal-invoices-list');
    const contractsList = document.getElementById('portal-contracts-list');
    const contractsTab = document.getElementById('portal-contracts-tab');
    const contractsTabPanel = document.getElementById('portal-tab-panel-contracts');

    const tabButtons = Array.from(document.querySelectorAll('.portal-tab-btn'));
    const tabPanels = Array.from(document.querySelectorAll('[data-portal-tab-panel]'));

    function setPortalTab(tab) {
        tabButtons.forEach((button) => button.classList.toggle('active', button.dataset.portalTab === tab));
        tabPanels.forEach((panel) => {
            panel.hidden = panel.dataset.portalTabPanel !== tab;
        });
    }

    tabButtons.forEach((button) => {
        button.addEventListener('click', () => {
            setPortalTab(button.dataset.portalTab);
        });
    });

    let currentLookupAccount = null;

    const pdfModalBackdrop = document.getElementById('portal-pdf-modal-backdrop');
    const pdfModalCanvas = document.getElementById('portal-pdf-modal-canvas');
    const pdfModalClose = document.getElementById('portal-pdf-modal-close');

    if (window.pdfjsLib) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }

    let pdfRenderTask = null;

    async function openPdfModal(url) {
        pdfModalBackdrop.style.display = 'flex';
        pdfModalBackdrop.classList.remove('hidden');
        document.body.style.overflow = 'hidden';

        try {
            const pdf = await window.pdfjsLib.getDocument(url).promise;
            const page = await pdf.getPage(1);
            const containerRect = pdfModalCanvas.getBoundingClientRect();
            const displayWidth = Math.round(containerRect.width);
            const displayHeight = Math.round(containerRect.height);
            const pixelRatio = Math.min((window.devicePixelRatio || 1) * 2, 4);
            const unscaledViewport = page.getViewport({ scale: 1 });
            const scale = Math.min(displayWidth / unscaledViewport.width, displayHeight / unscaledViewport.height);
            const viewport = page.getViewport({ scale: scale * pixelRatio });

            pdfModalCanvas.style.width = `${displayWidth}px`;
            pdfModalCanvas.style.height = `${displayHeight}px`;
            pdfModalCanvas.width = Math.round(viewport.width);
            pdfModalCanvas.height = Math.round(viewport.height);

            const context = pdfModalCanvas.getContext('2d');
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, pdfModalCanvas.width, pdfModalCanvas.height);

            if (pdfRenderTask) {
                pdfRenderTask.cancel();
            }
            pdfRenderTask = page.render({ canvasContext: context, viewport });
            await pdfRenderTask.promise;
        } catch (error) {
            console.error('Failed to render invoice PDF:', error);
        }
    }

    function closePdfModal() {
        pdfModalBackdrop.style.display = 'none';
        pdfModalBackdrop.classList.add('hidden');
        document.body.style.overflow = '';
        if (pdfRenderTask) {
            pdfRenderTask.cancel();
            pdfRenderTask = null;
        }
    }

    pdfModalClose.addEventListener('click', closePdfModal);
    pdfModalBackdrop.addEventListener('click', (event) => {
        if (event.target === pdfModalBackdrop) {
            closePdfModal();
        }
    });

    document.addEventListener('click', (event) => {
        const viewButton = event.target.closest('[data-view-invoice]');
        if (!viewButton) {
            return;
        }
        openPdfModal(viewButton.dataset.viewInvoice);
    });

    refreshLookupPayload();

    async function refreshLookupPayload() {
        const currentUrl = new URL(window.location.href);
        let checkoutReturn = false;
        ['contractCheckout', 'contractId', 'session_id'].forEach((parameter) => {
            if (currentUrl.searchParams.has(parameter)) {
                checkoutReturn = true;
                currentUrl.searchParams.delete(parameter);
            }
        });
        if (checkoutReturn) {
            window.history.replaceState({}, '', `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
        }

        const cachedPayload = portal.readLastLookupPayload();
        if (!cachedPayload?.account) {
            portal.clearLookupAccess();
            showFallback();
            return;
        }

        const apiBase = portal.readApiBase();
        if (!apiBase) {
            showFound(cachedPayload);
            return;
        }

        try {
            const refreshedPayload = await portal.lookupAccount(apiBase, {
                name: cachedPayload.account.name,
                address: cachedPayload.account.address,
            });
            portal.saveLastLookupPayload(refreshedPayload);
            showFound(refreshedPayload);
        } catch {
            showFound(cachedPayload);
        }
    }

    activityPanel.addEventListener('click', async (event) => {
        const button = event.target.closest('[data-payment-action]');
        if (!button) {
            return;
        }

        const paymentType = button.dataset.paymentAction;
        const paymentId = button.dataset.paymentId;
        const paymentMessage = document.getElementById(`portal-payment-action-${paymentId}`);
        const lookupAccessToken = portal.readLookupAccessToken();
        const apiBase = portal.readApiBase();

        if (!paymentId || !apiBase) {
            if (paymentMessage) {
                paymentMessage.textContent = 'Account details are missing. Search again.';
                paymentMessage.className = 'portal-inline-message portal-inline-message-error';
            }
            return;
        }

        if (paymentType === 'contract-autopay') {
            setPortalTab('account');
            if (currentLookupAccount?.clientLoginEnabled) {
                window.location.href = 'portal-login.html';
            } else if (activationToggle && activationForm.classList.contains('hidden')) {
                activationToggle.click();
            }
            return;
        }

        if (paymentType === 'contract') {
            if (!lookupAccessToken) {
                if (paymentMessage) {
                    paymentMessage.textContent = 'Lookup access expired. Search for your account again.';
                    paymentMessage.className = 'portal-inline-message portal-inline-message-error';
                }
                return;
            }

            button.disabled = true;
            if (paymentMessage) {
                paymentMessage.textContent = 'Redirecting to Stripe checkout...';
                paymentMessage.className = 'portal-inline-message';
            }

            try {
                const response = await fetch(`${apiBase}/api/contracts/${encodeURIComponent(paymentId)}/checkout-session/lookup`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ lookupAccessToken }),
                });
                const payload = await response.json();
                if (!response.ok || !payload.checkoutUrl) {
                    throw new Error(payload.error || 'Unable to start contract checkout right now.');
                }
                window.location.href = payload.checkoutUrl;
            } catch (error) {
                button.disabled = false;
                if (paymentMessage) {
                    paymentMessage.textContent = error.message || 'Unable to start contract checkout right now.';
                    paymentMessage.className = 'portal-inline-message portal-inline-message-error';
                }
            }
            return;
        }

        if (paymentType !== 'invoice') {
            if (paymentMessage) {
                paymentMessage.textContent = 'Unsupported payment action.';
                paymentMessage.className = 'portal-inline-message portal-inline-message-error';
            }
            return;
        }

        if (!lookupAccessToken) {
            if (paymentMessage) {
                paymentMessage.textContent = 'Lookup access expired. Search for your account again.';
                paymentMessage.className = 'portal-inline-message portal-inline-message-error';
            }
            return;
        }

        button.disabled = true;
        if (paymentMessage) {
            paymentMessage.textContent = 'Redirecting to Stripe checkout...';
            paymentMessage.className = 'portal-inline-message';
        }

        try {
            const response = await fetch(`${apiBase}/api/invoices/${encodeURIComponent(paymentId)}/checkout-session`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ lookupAccessToken, returnPath: 'portal-found.html' }),
            });
            const payload = await response.json();
            if (!response.ok || !payload.checkoutUrl) {
                throw new Error(payload.error || 'Unable to start checkout right now.');
            }
            window.location.href = payload.checkoutUrl;
        } catch (error) {
            button.disabled = false;
            if (paymentMessage) {
                paymentMessage.textContent = error.message || 'Unable to start checkout right now.';
                paymentMessage.className = 'portal-inline-message portal-inline-message-error';
            }
        }
    });

    activationToggle.addEventListener('click', () => {
        activationToggle.classList.add('hidden');
        activationForm.classList.remove('hidden');
    });

    activationForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!currentLookupAccount) {
            setMessage(activationMessage, 'Search for an account before creating account access.', true);
            return;
        }

        const apiBase = portal.readApiBase();
        if (!apiBase) {
            setMessage(activationMessage, 'Backend API URL is missing. Search for your account again.', true);
            return;
        }

        const formData = new FormData(activationForm);
        const email = String(formData.get('email') || '').trim();
        const password = String(formData.get('password') || '');
        if (!email || !password) {
            setMessage(activationMessage, 'Email and password are required.', true);
            return;
        }

        setMessage(activationMessage, 'Creating your account access...', false);

        try {
            await portal.activateAccount(apiBase, currentLookupAccount, { email, password });
            portal.clearLastLookupPayload();
            window.location.href = 'portal-client.html';
        } catch (error) {
            setMessage(activationMessage, error.message || 'Unable to activate account access.', true);
        }
    });

    function showFallback() {
        foundPanel.classList.add('hidden');
        fallbackPanel.classList.remove('hidden');
    }

    function showFound(payload) {
        currentLookupAccount = payload.account || null;
        if (!currentLookupAccount) {
            showFallback();
            return;
        }

        if (currentLookupAccount.clientLoginEnabled) {
            activationPanel.classList.add('hidden');
            signInPanel.classList.remove('hidden');
        } else {
            activationPanel.classList.remove('hidden');
            activationToggle.classList.remove('hidden');
            activationForm.classList.add('hidden');
            signInPanel.classList.add('hidden');
        }

        renderLookupActivity(payload.invoices || [], payload.contracts || []);

        foundPanel.classList.remove('hidden');
        fallbackPanel.classList.add('hidden');
    }

    function setMessage(element, message, isError) {
        element.textContent = message;
        element.className = isError ? 'portal-message portal-message-error' : 'portal-message portal-message-success';
    }

    function renderLookupActivity(invoices, contracts) {
        const visibleInvoices = invoices.filter((invoice) => invoice.status !== 'ongoing');
        const activeContracts = contracts.filter((contract) => contract.status === 'active');

        contractsTab.classList.toggle('hidden', !activeContracts.length);
        contractsTabPanel.hidden = true;
        if (!activeContracts.length && contractsTab.classList.contains('active')) {
            setPortalTab('invoices');
        }

        if (!visibleInvoices.length) {
            invoicesList.innerHTML = '<li class="portal-activity-item">No invoices found for this account.</li>';
        } else {
            invoicesList.innerHTML = visibleInvoices.map((invoice) => {
                const displayStatus = invoice.status === 'paid' ? 'Paid' : 'Unpaid';
                const isPayable = invoice.status !== 'paid' && invoice.status !== 'void';
                const amount = typeof invoice.amountCents === 'number'
                    ? `$${(invoice.amountCents / 100).toFixed(2)} ${(invoice.currency || 'usd').toUpperCase()}`
                    : 'Amount unavailable';
                const actionId = `portal-payment-action-${invoice.id}`;
                const apiBase = portal.readApiBase();
                const lookupAccessToken = portal.readLookupAccessToken();
                const downloadUrl = apiBase ? `${apiBase}/api/invoices/${encodeURIComponent(invoice.id)}/pdf?lookupAccessToken=${encodeURIComponent(lookupAccessToken || '')}` : '#';
                const viewUrl = apiBase ? `${apiBase}/api/invoices/${encodeURIComponent(invoice.id)}/pdf?lookupAccessToken=${encodeURIComponent(lookupAccessToken || '')}&disposition=inline` : '#';
                return `
                    <li class="portal-activity-item">
                        <strong>${portal.escapeHtml(invoice.invoiceNumber || 'Invoice')}</strong>
                        <p class="portal-activity-meta">Status: ${displayStatus} | ${portal.escapeHtml(amount)}</p>
                        <div class="portal-inline-actions">
                            <button type="button" class="portal-button portal-button-secondary" data-view-invoice="${viewUrl}">View</button>
                            <a class="portal-button portal-button-secondary" href="${downloadUrl}" target="_blank" rel="noopener">Download</a>
                            ${isPayable ? `<button type="button" class="portal-button portal-button-secondary" data-payment-action="invoice" data-payment-id="${portal.escapeHtml(invoice.id)}">Pay</button>` : ''}
                            <p id="${actionId}" class="portal-inline-message" aria-live="polite"></p>
                        </div>
                    </li>
                `;
            }).join('');
        }

        if (!activeContracts.length) {
            contractsList.innerHTML = '';
            return;
        }

        contractsList.innerHTML = activeContracts.map((contract) => {
            const isPayable = contract.status !== 'paid' && contract.status !== 'void' && contract.status !== 'cancelled';
            const amountCents = Number(contract.billingAmountCents || 0);
            const billingCycle = contract.billingCycle === 'quarterly' ? 'quarter'
                : contract.billingCycle === 'annually' ? 'year'
                    : 'month';
            const packageLabel = contract.packageType === 'custom'
                ? 'Custom package'
                : `${contract.packageType === 'portfolio' ? 'Portfolio' : 'Single Home'} ${contract.packageLevel ? `${contract.packageLevel.charAt(0).toUpperCase()}${contract.packageLevel.slice(1)}` : ''}`.trim();
            const autopayEnabled = Boolean(contract.autopayEnabled);
            const actionId = `portal-payment-action-${contract.id}`;
            return `
                <li class="portal-activity-item">
                    <strong>${portal.escapeHtml(contract.contractNumber || 'Contract')}</strong>
                    <p class="portal-activity-meta">${portal.escapeHtml(packageLabel)} | Status: ${portal.escapeHtml(contract.status || 'unknown')} | Start: ${portal.escapeHtml(contract.startDate || 'No start date')} | ${amountCents > 0 ? `$${(amountCents / 100).toFixed(2)} per ${billingCycle}` : 'Price unavailable'}</p>
                    ${isPayable ? `
                        <div class="portal-inline-actions">
                            ${amountCents > 0 ? `<button type="button" class="portal-button portal-button-secondary" data-payment-action="contract" data-payment-id="${portal.escapeHtml(contract.id)}">Pay This ${billingCycle}</button>` : ''}
                            ${autopayEnabled
                                ? `<span class="admin-badge badge-paid">Autopay active</span><button type="button" class="portal-button portal-button-secondary" data-payment-action="contract-autopay" data-payment-id="${portal.escapeHtml(contract.id)}">Manage Autopay</button>`
                                : `<button type="button" class="portal-button portal-button-secondary" data-payment-action="contract-autopay" data-payment-id="${portal.escapeHtml(contract.id)}">Enable Autopay</button>`}
                            <p id="${actionId}" class="portal-inline-message" aria-live="polite"></p>
                        </div>
                    ` : ''}
                </li>
            `;
        }).join('');
    }
