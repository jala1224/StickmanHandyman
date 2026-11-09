(function () {
    let scriptPromise;
    let checkout;
    let sequence = 0;
    let previousFocus;
    let previousOverflow = '';
    let active = false;
    const dialog = document.createElement('dialog');
    dialog.className = 'portal-checkout-modal';
    dialog.setAttribute('aria-labelledby', 'portal-checkout-title');
    dialog.innerHTML = '<header class="portal-checkout-header"><h2 id="portal-checkout-title">Payment</h2><button type="button" class="portal-checkout-close" aria-label="Close payment" title="Close payment">&times;</button></header><div class="portal-checkout-body"><p id="portal-checkout-status" role="status" aria-live="polite"></p><div id="portal-checkout-mount"></div></div>';
    document.body.appendChild(dialog);
    const status = dialog.querySelector('#portal-checkout-status');
    const mount = dialog.querySelector('#portal-checkout-mount');

    function syncViewport() {
        dialog.style.setProperty('--checkout-height', `${window.visualViewport?.height || window.innerHeight}px`);
        dialog.style.setProperty('--checkout-top', `${window.visualViewport?.offsetTop || 0}px`);
    }

    function loadStripe() {
        if (window.Stripe) return Promise.resolve();
        if (!scriptPromise) {
            scriptPromise = new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = 'https://js.stripe.com/endive/stripe.js';
                script.async = true;
                script.onload = () => resolve();
                script.onerror = () => {
                    scriptPromise = null;
                    script.remove();
                    reject(new Error('Unable to load secure checkout. Check your connection and try again.'));
                };
                document.head.appendChild(script);
            });
        }
        return scriptPromise;
    }

    function resetCheckout() {
        if (!active) return;
        active = false;
        sequence += 1;
        checkout?.destroy();
        checkout = null;
        mount.replaceChildren();
        document.body.style.overflow = previousOverflow;
        previousFocus?.focus();
    }

    function close() {
        dialog.close();
        resetCheckout();
    }

    dialog.querySelector('.portal-checkout-close').addEventListener('click', close);
    dialog.addEventListener('close', () => {
        if (!dialog.open) resetCheckout();
    });
    window.visualViewport?.addEventListener('resize', syncViewport, { passive: true });
    window.visualViewport?.addEventListener('scroll', syncViewport, { passive: true });

    async function open({ title, session, onComplete }) {
        if (session.checkoutUrl && !session.clientSecret) {
            window.location.assign(session.checkoutUrl);
            return;
        }
        if (!session.clientSecret || !session.publishableKey) {
            throw new Error('Secure checkout is unavailable. Please try again later.');
        }
        if (dialog.open) close();
        const currentSequence = ++sequence;
        active = true;
        previousFocus = document.activeElement;
        previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        dialog.querySelector('#portal-checkout-title').textContent = title;
        status.textContent = 'Loading secure checkout...';
        mount.setAttribute('aria-busy', 'true');
        syncViewport();
        dialog.showModal();
        try {
            await loadStripe();
            if (currentSequence !== sequence) return;
            const stripe = window.Stripe(session.publishableKey);
            const instance = await stripe.createEmbeddedCheckoutPage({
                fetchClientSecret: async () => session.clientSecret,
                onComplete: async () => {
                    if (currentSequence !== sequence) return;
                    checkout?.destroy();
                    checkout = null;
                    mount.replaceChildren();
                    status.textContent = 'Payment submitted. Your account will update after payment is confirmed.';
                    try {
                        await onComplete?.();
                    } catch {
                        status.textContent = 'Payment submitted. Refresh your account to check confirmation.';
                    }
                },
            });
            if (currentSequence !== sequence) {
                instance.destroy();
                return;
            }
            checkout = instance;
            status.textContent = '';
            mount.setAttribute('aria-busy', 'false');
            checkout.mount(mount);
        } catch (error) {
            if (currentSequence !== sequence) return;
            close();
            throw error;
        }
    }

    window.StickmanPayments = { open };
}());