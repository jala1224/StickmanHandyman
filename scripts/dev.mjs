import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { getLocalStripeEnvironment } from './local-stripe.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const localRoot = path.join(root, '.local');
const dataDirectory = path.join(localRoot, 'data');
const invoicesDirectory = path.join(localRoot, 'invoices');
const frontendPort = Number(process.argv.find(argument => argument.startsWith('--port='))?.split('=')[1] || 8080);
const apiPort = Number(process.argv.find(argument => argument.startsWith('--api-port='))?.split('=')[1] || 3000);
if (![frontendPort, apiPort].every(port => Number.isInteger(port) && port > 0 && port < 65536) || frontendPort === apiPort) {
  throw new Error('Choose two distinct port numbers between 1 and 65535.');
}
if (!existsSync(path.join(root, 'backend/node_modules/express'))) {
  throw new Error('Install API dependencies first: npm --prefix backend ci');
}
const stripeEnabled = process.argv.includes('--stripe-test');
const stripeFile = path.join(localRoot, 'stripe.env');
if (stripeEnabled && !existsSync(stripeFile)) {
  throw new Error('Create .local/stripe.env with Stripe test-mode credentials before running npm run dev:stripe.');
}
const stripeEnvironment = getLocalStripeEnvironment({
  enabled: stripeEnabled,
  contents: stripeEnabled ? readFileSync(stripeFile, 'utf8') : '',
});

async function checkPort(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error(`Port ${port} is occupied. Choose --port or --api-port explicitly.`)));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}
await checkPort(frontendPort);
await checkPort(apiPort);
mkdirSync(dataDirectory, { recursive: true });
mkdirSync(invoicesDirectory, { recursive: true });
const contractorFile = path.join(dataDirectory, 'contractors.json');
if (!existsSync(contractorFile)) {
  const timestamp = new Date().toISOString();
  writeFileSync(contractorFile, JSON.stringify({
    contractors: [
      { id: 'contractor_owner', name: 'Owner (Local Test)', hourlyRateCents: 8000, isOwner: true, status: 'active', createdAt: timestamp, updatedAt: timestamp },
      { id: 'contractor_test', name: 'Sample Contractor', hourlyRateCents: 5000, isOwner: false, status: 'active', createdAt: timestamp, updatedAt: timestamp },
    ],
    timeEntries: [], ongoingJobs: [], invoiceHours: [], paymentTransactions: [],
  }, null, 2));
}

const children = [];
let stopping = false;
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  for (const child of children) child.kill('SIGTERM');
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

function start(file, args, options) {
  const child = spawn(process.execPath, [file, ...args], { stdio: 'inherit', ...options });
  children.push(child);
  child.on('error', error => {
    console.error(error.message);
    stop(1);
  });
  child.on('exit', code => {
    if (!stopping) stop(code || 1);
  });
  return child;
}

start(path.join(root, 'backend/src/server.js'), [], {
  cwd: localRoot,
  env: {
    ...process.env,
    NODE_ENV: 'development', STICKMAN_LOCAL_SANDBOX: 'true', PORT: String(apiPort), STICKMAN_BIND_ADDRESS: '127.0.0.1',
    STICKMAN_DATA_DIR: dataDirectory, STICKMAN_INVOICES_DIR: invoicesDirectory,
    ADMIN_BOOTSTRAP_EMAIL: 'admin@local.test', ADMIN_BOOTSTRAP_PASSWORD: 'local-dev-only',
    CORS_ALLOWED_ORIGINS: `http://127.0.0.1:${frontendPort},http://localhost:${frontendPort}`,
    ...stripeEnvironment,
    SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', EMAIL_FROM: '',
  },
});
start(path.join(root, 'scripts/serve.mjs'), [`--port=${frontendPort}`], {
  env: { ...process.env, API_PORT: String(apiPort) },
});
console.log(`Local test site: http://127.0.0.1:${frontendPort}`);
console.log('Local admin: admin@local.test / local-dev-only');
console.log(`Sandbox: .local/ (separate records and PDFs; Stripe ${stripeEnabled ? 'TEST MODE' : 'disabled'}; email disabled). Ctrl+C stops both servers.`);
if (stripeEnabled && !stripeEnvironment.STRIPE_WEBHOOK_SECRET) {
  console.warn('Stripe webhook secret is missing. Add the Stripe CLI signing secret to .local/stripe.env and restart to receive payment confirmations.');
}