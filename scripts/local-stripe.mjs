import { createRequire } from 'node:module';

const require = createRequire(new URL('../backend/package.json', import.meta.url));
const { parse } = require('dotenv');

export function getLocalStripeEnvironment({ enabled = false, contents = '', nodeEnv = process.env.NODE_ENV } = {}) {
  const disabled = { STRIPE_SECRET_KEY: '', STRIPE_PUBLISHABLE_KEY: '', STRIPE_WEBHOOK_SECRET: '' };
  if (!enabled) return disabled;
  if (nodeEnv === 'production') throw new Error('Local Stripe test mode cannot run in production.');
  const values = parse(contents);
  if (!/^sk_test_[A-Za-z0-9]+$/.test(values.STRIPE_SECRET_KEY || '')
    || !/^pk_test_[A-Za-z0-9]+$/.test(values.STRIPE_PUBLISHABLE_KEY || '')) {
    throw new Error('Local Stripe mode requires sk_test_ and pk_test_ credentials in .local/stripe.env. Live keys are not allowed.');
  }
  const webhookSecret = values.STRIPE_WEBHOOK_SECRET || '';
  if (webhookSecret && !/^whsec_[A-Za-z0-9]+$/.test(webhookSecret)) {
    throw new Error('Use the Stripe CLI webhook signing secret beginning with whsec_.');
  }
  return {
    STRIPE_SECRET_KEY: values.STRIPE_SECRET_KEY,
    STRIPE_PUBLISHABLE_KEY: values.STRIPE_PUBLISHABLE_KEY,
    STRIPE_WEBHOOK_SECRET: webhookSecret,
  };
}