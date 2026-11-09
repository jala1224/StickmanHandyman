export function getCheckoutOrigin(requestedOrigin, allowedOrigins) {
  try {
    const url = new URL(requestedOrigin);
    const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.origin === requestedOrigin && allowedOrigins.includes(url.origin)
      && (url.protocol === 'https:' || (isLocal && url.protocol === 'http:'))) {
      return url.origin;
    }
  } catch {}
  return 'https://www.stickman-handyman.com';
}

export function getCheckoutPresentation({ uiMode, origin, returnPath, successQuery, cancelQuery }) {
  const successUrl = `${origin}/${returnPath}?${successQuery}`;
  return uiMode === 'embedded' ? {
    ui_mode: 'embedded_page',
    redirect_on_completion: 'if_required',
    return_url: successUrl,
  } : {
    success_url: successUrl,
    cancel_url: `${origin}/${returnPath}?${cancelQuery}`,
  };
}

export function getCheckoutResponse(session, publishableKey) {
  return {
    checkoutUrl: session.url || null,
    clientSecret: session.client_secret || null,
    publishableKey,
  };
}

export function matchesInvoicePayment(invoice, payment) {
  return Boolean(invoice && !['ongoing', 'void'].includes(invoice.status)
    && Number.isInteger(payment.amountCents) && payment.amountCents === invoice.amountCents
    && String(payment.currency).toLowerCase() === String(invoice.currency || 'usd').toLowerCase());
}

export async function canReplaceCheckoutSession(stripe, session) {
  if (session.status !== 'complete') return true;
  if (session.payment_status === 'paid' || !session.payment_intent) return false;
  const intentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent.id;
  const intent = await stripe.paymentIntents.retrieve(intentId);
  return ['canceled', 'requires_payment_method'].includes(intent.status);
}

export function getInvoicePaymentEvent(event) {
  const object = event.data.object;
  const invoiceId = object.metadata?.invoiceId;
  if (!invoiceId) return null;
  if (['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'checkout.session.expired'].includes(event.type)) {
    if (object.mode !== 'payment') return null;
    return {
      invoiceId,
      paymentIntentId: typeof object.payment_intent === 'string' ? object.payment_intent : object.payment_intent?.id,
      checkoutSessionId: object.id,
      amountCents: object.amount_total,
      currency: object.currency,
      livemode: object.livemode,
      status: object.payment_status === 'paid' ? 'succeeded'
        : event.type === 'checkout.session.expired' ? 'expired'
            : event.type === 'checkout.session.async_payment_failed' ? 'failed' : 'processing',
      error: event.type === 'checkout.session.async_payment_failed' ? 'Payment was not completed.' : null,
    };
  }
  const statuses = {
    'payment_intent.succeeded': 'succeeded',
    'payment_intent.processing': 'processing',
    'payment_intent.payment_failed': 'failed',
    'payment_intent.canceled': 'canceled',
  };
  if (!statuses[event.type]) return null;
  return {
    invoiceId, paymentIntentId: object.id,
    amountCents: event.type === 'payment_intent.succeeded' ? object.amount_received : object.amount,
    currency: object.currency, status: statuses[event.type], livemode: object.livemode,
    error: object.last_payment_error?.message || null,
  };
}

const pendingInvoiceSessions = new Map();

export async function createContractCheckoutSession(stripe, contract, parameters, saveState) {
  const key = `contract:${contract.id}`;
  const previous = pendingInvoiceSessions.get(key) || Promise.resolve();
  const request = previous.catch(() => {}).then(async () => {
    if (parameters.mode === 'subscription' && contract.autopayEnabled) throw Object.assign(new Error('Autopay is already enabled.'), { statusCode: 409 });
    if (contract.stripeCheckoutSessionId) {
      const current = await stripe.checkout.sessions.retrieve(contract.stripeCheckoutSessionId);
      const subscriptionEnded = ['canceled', 'incomplete_expired'].includes(contract.stripeSubscriptionStatus);
      if (current.status === 'complete' && ((current.mode === 'subscription' && !subscriptionEnded) || current.metadata?.billingPeriod === parameters.metadata.billingPeriod)) {
        if (!await canReplaceCheckoutSession(stripe, current)) throw Object.assign(new Error('A contract payment or autopay enrollment is already submitted. Refresh your account.'), { statusCode: 409 });
      }
      if (current.status === 'open') {
        if (current.mode === parameters.mode && current.ui_mode === (parameters.ui_mode || 'hosted')
          && current.amount_total === parameters.line_items[0].price_data.unit_amount
          && current.metadata?.billingPeriod === parameters.metadata.billingPeriod) return current;
        await stripe.checkout.sessions.expire(current.id);
      }
    }
    const session = await stripe.checkout.sessions.create(parameters, {
      idempotencyKey: `${contract.id}:${contract.updatedAt}:${parameters.mode}:${parameters.ui_mode || 'hosted'}:${contract.stripeCheckoutSessionId || 'initial'}`,
    });
    saveState(contract.id, { stripeCheckoutSessionId: session.id });
    return session;
  });
  pendingInvoiceSessions.set(key, request);
  try {
    return await request;
  } finally {
    if (pendingInvoiceSessions.get(key) === request) pendingInvoiceSessions.delete(key);
  }
}

export async function createInvoiceCheckoutSession(stripe, invoice, options, saveState) {
  const previous = pendingInvoiceSessions.get(invoice.id) || Promise.resolve();
  const request = previous.catch(() => {}).then(async () => {
    if (['paid', 'void', 'ongoing'].includes(invoice.status) || invoice.amountCents <= 0) {
      throw Object.assign(new Error('This invoice is not currently payable.'), { statusCode: 409 });
    }
    if (invoice.stripeCheckoutSessionId) {
      const current = await stripe.checkout.sessions.retrieve(invoice.stripeCheckoutSessionId);
      if (!await canReplaceCheckoutSession(stripe, current)) {
        throw Object.assign(new Error('A payment is already submitted for this invoice. Refresh its payment status.'), { statusCode: 409 });
      }
      if (current.status === 'open') {
        const isEmbedded = current.ui_mode === 'embedded' || current.ui_mode === 'embedded_page';
        if (matchesInvoicePayment(invoice, { amountCents: current.amount_total, currency: current.currency })
          && isEmbedded === (options.uiMode === 'embedded')) return current;
        await stripe.checkout.sessions.expire(current.id);
      }
    }
    const session = await stripe.checkout.sessions.create({
      mode: 'payment', client_reference_id: invoice.id,
      metadata: { invoiceId: invoice.id },
      payment_intent_data: { metadata: { invoiceId: invoice.id } },
      line_items: [{ quantity: 1, price_data: {
        currency: invoice.currency || 'usd', unit_amount: invoice.amountCents,
        product_data: { name: `Invoice ${invoice.invoiceNumber}` },
      } }],
      ...getCheckoutPresentation({
        ...options,
        successQuery: `invoicePaid=${encodeURIComponent(invoice.id)}&session_id={CHECKOUT_SESSION_ID}`,
        cancelQuery: `invoiceCanceled=${encodeURIComponent(invoice.id)}`,
      }),
    }, { idempotencyKey: `${invoice.id}:${invoice.updatedAt}:${options.uiMode}:${invoice.stripeCheckoutSessionId || 'initial'}` });
    saveState(invoice.id, {
      stripeCheckoutSessionId: session.id, stripeCheckoutUrl: session.url || null,
      stripeCheckoutExpiresAt: new Date(session.expires_at * 1000).toISOString(),
      stripePaymentStatus: 'pending', stripePaymentError: null, stripePaymentIntentId: null,
      stripeLivemode: session.livemode,
    });
    return session;
  });
  pendingInvoiceSessions.set(invoice.id, request);
  try {
    return await request;
  } finally {
    if (pendingInvoiceSessions.get(invoice.id) === request) pendingInvoiceSessions.delete(invoice.id);
  }
}