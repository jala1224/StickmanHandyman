import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { config } from './config.js';
import { authRouter } from './routes/auth.js';
import { clientAuthRouter } from './routes/client-auth.js';
import { clientsRouter } from './routes/clients.js';
import { contractsRouter } from './routes/contracts.js';
import { contractorsRouter } from './routes/contractors.js';
import { dashboardRouter } from './routes/dashboard.js';
import { healthRouter } from './routes/health.js';
import { invoicesRouter } from './routes/invoices.js';
import { stripeRouter } from './routes/stripe.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const siteRoot = path.join(__dirname, '..', '..');

const app = express();
const corsOrigin = config.corsOrigins.includes('*') ? true : config.corsOrigins;
app.set('trust proxy', 1);

// CSP disabled: the static site relies on inline scripts and Stripe.js, which the default policy blocks.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: corsOrigin }));
app.use('/api/stripe', express.raw({ type: 'application/json' }), stripeRouter);
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

app.use('/health', healthRouter);
app.use('/api/auth', authRouter);
app.use('/api/client-auth', clientAuthRouter);
app.use('/api/clients', clientsRouter);
app.use('/api/invoices', invoicesRouter);
app.use('/api/contracts', contractsRouter);
app.use('/api/contractors', contractorsRouter);
app.use('/api/dashboard', dashboardRouter);

app.use(express.static(siteRoot));

app.get('/', (req, res) => {
  res.sendFile(path.join(siteRoot, 'home.html'));
});

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found.' });
});

app.listen(config.port, config.bindAddress, () => {
  console.log(`Stickman Handyman backend running on port ${config.port}`);
});
