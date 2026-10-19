    const portal = window.StickmanPortal;
    portal.initTopnav();

    const loginForm = document.getElementById('portal-login-form');
    const loginMessage = document.getElementById('portal-login-message');

    const params = new URLSearchParams(window.location.search);
    const reason = params.get('reason');
    if (reason === 'client-session-required') {
        setMessage('Sign in to view your client portal.', true);
    } else if (reason === 'admin-session-required') {
        setMessage('Sign in to view the admin portal.', true);
    } else if (reason === 'session-expired') {
        setMessage('Your session expired. Sign in again.', true);
    }

    const apiBase = portal.readApiBase();
    if (apiBase) {
        if (portal.readAdminToken()) {
            window.location.replace('portal-admin.html');
        } else if (portal.readClientToken()) {
            window.location.replace('portal-client.html');
        }
    }

    loginForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        setMessage('Signing in...', false);

        const resolvedApiBase = portal.readApiBase();
        if (!resolvedApiBase) {
            setMessage('Unable to determine the backend address for this site.', true);
            return;
        }

        const formData = new FormData(loginForm);
        try {
            const result = await portal.signInShared(resolvedApiBase, {
                email: String(formData.get('email') || '').trim(),
                password: String(formData.get('password') || ''),
            });

            if (result.role === 'admin') {
                window.location.href = 'portal-admin.html';
                return;
            }

            window.location.href = 'portal-client.html';
        } catch (error) {
            setMessage(error.message || 'Unable to sign in right now.', true);
        }
    });

    function setMessage(message, isError) {
        loginMessage.textContent = message;
        loginMessage.className = isError ? 'portal-message portal-message-error' : 'portal-message portal-message-success';
    }
