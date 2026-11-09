(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get('token') || '';
    const status = document.getElementById('signing-status');
    const emailForm = document.getElementById('signer-email-form');
    const emailInput = document.getElementById('signer-email');
    const loadButton = document.getElementById('load-document-button');
    const content = document.getElementById('signing-content');
    const signatureForm = document.getElementById('signature-form');
    const signerName = document.getElementById('signer-name');
    const signatureText = document.getElementById('signature-text');
    const consent = document.getElementById('signature-consent');
    const submitButton = document.getElementById('submit-signature-button');
    const canvas = document.getElementById('signature-canvas');
    const context = canvas.getContext('2d');
    let signatureRequest = null;
    let documentUrl = null;
    let completedDocument = null;
    let drawing = false;
    let hasDrawing = false;

    function setStatus(message, isError = false) {
        status.textContent = message;
        status.classList.toggle('is-error', isError);
        status.classList.toggle('is-success', !isError);
    }

    async function postJson(path, body) {
        const apiBase = window.StickmanPortal?.readApiBase() || window.location.origin;
        const response = await fetch(`${apiBase}/api/contract-signatures/${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            const error = new Error(payload.error || 'The request could not be completed.');
            error.code = payload.code;
            throw error;
        }
        return response;
    }

    function selectedSignatureType() {
        return document.querySelector('input[name="signatureType"]:checked').value;
    }

    function resizeCanvas() {
        const bounds = canvas.getBoundingClientRect();
        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.max(1, Math.round(bounds.width * ratio));
        canvas.height = Math.max(1, Math.round(bounds.height * ratio));
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.lineWidth = 2.4;
        context.lineCap = 'round';
        context.lineJoin = 'round';
        context.strokeStyle = '#172d32';
        hasDrawing = false;
    }

    function pointFromEvent(event) {
        const bounds = canvas.getBoundingClientRect();
        return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    }

    function stopDrawing(event) {
        if (!drawing) return;
        drawing = false;
        canvas.releasePointerCapture?.(event.pointerId);
    }

    async function loadSignedDocument(credentials, receipt) {
        completedDocument = { credentials, receipt };
        signatureForm.hidden = true;
        submitButton.disabled = true;
        content.hidden = false;
        content.classList.add('is-signed');
        const retry = document.getElementById('retry-signed-document');
        retry.hidden = true;
        retry.disabled = true;
        document.getElementById('document-preview').src = 'about:blank';
        if (documentUrl) URL.revokeObjectURL(documentUrl);
        documentUrl = null;
        setStatus('Your signature is saved. Loading the signed agreement...');
        try {
            const response = await postJson('signed-document', credentials);
            documentUrl = URL.createObjectURL(await response.blob());
            const view = window.matchMedia('(max-width: 900px)').matches ? 'FitH' : 'Fit';
            document.getElementById('document-preview').src = `${documentUrl}#view=${view}&toolbar=0&navpanes=0`;
            document.getElementById('document-preview').title = 'Signed contract PDF preview';
            document.getElementById('document-file-name').textContent = receipt.fileName;
            document.getElementById('document-expires').textContent = `Signed ${new Date(receipt.signedAt).toLocaleDateString()}`;
            setStatus(`Document signed successfully on ${new Date(receipt.signedAt).toLocaleString()}.`);
        } catch (error) {
            retry.hidden = false;
            setStatus(`Your signature is saved, but the signed PDF could not be loaded. ${error.message}`, true);
        } finally {
            retry.disabled = false;
        }
    }

    document.getElementById('retry-signed-document').addEventListener('click', () => {
        if (completedDocument) void loadSignedDocument(completedDocument.credentials, completedDocument.receipt);
    });

    async function loadSigningDocument(signerEmail = '') {
        if (!token) {
            setStatus('This signing link is missing or invalid. Contact the sender for a new link.', true);
            return;
        }
        const credentials = { token, ...(signerEmail ? { signerEmail } : {}) };
        loadButton.disabled = true;
        setStatus('Checking the signing link and loading the PDF...');
        try {
            const inspectedResponse = await postJson('inspect', credentials);
            const inspected = await inspectedResponse.json();
            signatureRequest = inspected;
            document.getElementById('document-contract-title').textContent = inspected.contract.title || `Contract ${inspected.contract.contractNumber}`;
            emailInput.readOnly = true;
            emailForm.hidden = true;
            loadButton.hidden = true;
            if (inspected.request.status === 'completed') {
                await loadSignedDocument(credentials, { signedAt: inspected.request.signedAt, fileName: inspected.document.fileName });
                return;
            }
            const documentResponse = await postJson('document', credentials);
            const documentBlob = await documentResponse.blob();
            if (documentUrl) URL.revokeObjectURL(documentUrl);
            documentUrl = URL.createObjectURL(documentBlob);
            document.getElementById('document-file-name').textContent = inspected.document.fileName;
            document.getElementById('document-expires').textContent = `Link expires ${new Date(inspected.request.expiresAt).toLocaleDateString()}`;
            document.getElementById('document-preview').src = `${documentUrl}#view=FitH&toolbar=0&navpanes=0`;
            document.getElementById('signer-summary').textContent = `Signing as ${inspected.request.signerName}${inspected.request.signerEmail ? ` · ${inspected.request.signerEmail}` : ''}`;
            signerName.value = inspected.request.signerName;
            signatureText.value = '';
            content.hidden = false;
            setStatus('Review the complete document before signing.');
        } catch (error) {
            if (error.code === 'SIGNER_EMAIL_REQUIRED') emailForm.hidden = false;
            setStatus(error.message, true);
        } finally {
            loadButton.disabled = false;
        }
    }

    emailForm.addEventListener('submit', event => {
        event.preventDefault();
        void loadSigningDocument(emailInput.value.trim());
    });

    document.querySelectorAll('input[name="signatureType"]').forEach(input => {
        input.addEventListener('change', () => {
            const drawn = selectedSignatureType() === 'drawn';
            document.getElementById('typed-signature-panel').hidden = drawn;
            document.getElementById('drawn-signature-panel').hidden = !drawn;
            signatureText.required = !drawn;
            if (drawn) requestAnimationFrame(resizeCanvas);
        });
    });

    canvas.addEventListener('pointerdown', event => {
        event.preventDefault();
        canvas.setPointerCapture(event.pointerId);
        const point = pointFromEvent(event);
        context.beginPath();
        context.moveTo(point.x, point.y);
        drawing = true;
        hasDrawing = true;
    });
    canvas.addEventListener('pointermove', event => {
        if (!drawing) return;
        const point = pointFromEvent(event);
        context.lineTo(point.x, point.y);
        context.stroke();
    });
    canvas.addEventListener('pointerup', stopDrawing);
    canvas.addEventListener('pointercancel', stopDrawing);
    document.getElementById('clear-signature-button').addEventListener('click', resizeCanvas);

    signatureForm.addEventListener('submit', async event => {
        event.preventDefault();
        if (!signatureRequest) return;
        const signatureType = selectedSignatureType();
        if (signatureType === 'drawn' && !hasDrawing) {
            setStatus('Draw your signature before submitting.', true);
            return;
        }
        submitButton.disabled = true;
        setStatus('Saving your signature...');
        const payload = {
            token,
            signerEmail: emailInput.value.trim() || undefined,
            signerName: signerName.value.trim(),
            signatureType,
            signatureText: signatureType === 'typed' ? signatureText.value.trim() : undefined,
            signatureImageDataUrl: signatureType === 'drawn' ? canvas.toDataURL('image/png') : undefined,
            consent: consent.checked,
        };
        try {
            const response = await postJson('complete', payload);
            const result = await response.json();
            await loadSignedDocument({ token, ...(payload.signerEmail ? { signerEmail: payload.signerEmail } : {}) }, result);
        } catch (error) {
            setStatus(error.message, true);
            submitButton.disabled = false;
        }
    });

    if (token) void loadSigningDocument();
    else setStatus('This signing link is missing or invalid. Contact the sender for a new link.', true);
})();
