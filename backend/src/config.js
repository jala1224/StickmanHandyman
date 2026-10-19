import dotenv from 'dotenv';

dotenv.config();

const corsOriginValue = process.env.CORS_ALLOWED_ORIGINS ?? process.env.CORS_ORIGIN ?? '*';
export const config = {
  port: Number.parseInt(process.env.PORT ?? '3000', 10),
  corsOrigins: corsOriginValue.split(',').map((origin) => origin.trim()).filter(Boolean),
  adminBootstrapEmail: process.env.ADMIN_BOOTSTRAP_EMAIL ?? 'admin@example.com',
  adminBootstrapPassword: process.env.ADMIN_BOOTSTRAP_PASSWORD ?? 'change-me-now',
  adminSessionTtlHours: Number.parseInt(process.env.ADMIN_SESSION_TTL_HOURS ?? '12', 10),
  clientSessionTtlHours: Number.parseInt(process.env.CLIENT_SESSION_TTL_HOURS ?? '720', 10),
  lookupSessionTtlMinutes: Number.parseInt(process.env.LOOKUP_SESSION_TTL_MINUTES ?? '15', 10),
  stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? '',
  stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
  invoiceNumberStart: Number.parseInt(process.env.INVOICE_NUMBER_START ?? '1031', 10),
  contractNumberStart: Number.parseInt(process.env.CONTRACT_NUMBER_START ?? '2001', 10),
  smtpHost: process.env.SMTP_HOST ?? '',
  smtpPort: Number.parseInt(process.env.SMTP_PORT ?? '587', 10),
  smtpUser: process.env.SMTP_USER ?? '',
  smtpPass: process.env.SMTP_PASS ?? '',
  emailFrom: process.env.EMAIL_FROM ?? '',
};
