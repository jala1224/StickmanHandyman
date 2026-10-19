    const portal = window.StickmanPortal;
    portal.initTopnav();
    portal.populateStateSelects();

    const lookupForm = document.getElementById('portal-lookup-form');
    const lookupMessage = document.getElementById('portal-lookup-message');

    lookupForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        portal.clearLastLookupPayload();
        setMessage(lookupMessage, 'Searching for your account...', false);

        const apiBase = portal.readApiBase();
        if (!apiBase) {
            setMessage(lookupMessage, 'Unable to determine the backend address for this site.', true);
            return;
        }

        const formData = new FormData(lookupForm);
        try {
            const payload = await portal.lookupAccount(apiBase, {
                name: String(formData.get('name') || '').trim(),
                address: portal.formatClientAddress({
                    street: formData.get('street'),
                    city: formData.get('city'),
                    state: formData.get('state'),
                    zip: formData.get('zip'),
                }),
            });

            if (!portal.saveLastLookupPayload(payload)) {
                throw new Error('Account found, but we could not prepare your details page. Please try again.');
            }

            window.location.href = 'portal-found.html';
        } catch (error) {
            portal.clearLookupAccess();
            portal.clearLastLookupPayload();
            setMessage(lookupMessage, error.message || 'No matching account found.', true);
        }
    });

    function setMessage(element, message, isError) {
        element.textContent = message;
        element.className = isError ? 'portal-message portal-message-error' : 'portal-message portal-message-success';
    }
