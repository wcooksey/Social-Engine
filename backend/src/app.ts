import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import fs from 'fs';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import { config } from './config/environment';
import { authMiddleware } from './middleware/auth.middleware';
import { errorMiddleware } from './middleware/error.middleware';
import agentRoutes from './routes/agent.routes';
import authRoutes from './routes/auth.routes';
import calendarRoutes from './routes/calendar.routes';
import campaignsRoutes from './routes/campaigns.routes';
import contactsRoutes from './routes/contacts.routes';
import conversationsRoutes from './routes/conversations.routes';
import experimentsRoutes from './routes/experiments.routes';
import inboundWebhookRoutes from './routes/webhooks.inbound.routes';
import dashboardRoutes from './routes/dashboard.routes';
import engineRoutes from './routes/engine.routes';
import leadGroupsRoutes from './routes/lead-groups.routes';
import leadsRoutes from './routes/leads.routes';
import modelsRoutes from './routes/models.routes';
import organizationsRoutes from './routes/organizations.routes';
import playbooksRoutes from './routes/playbooks.routes';
import settingsRoutes from './routes/settings.routes';
import socialAccountsRoutes from './routes/social-accounts.routes';
import vapiWebhookRoutes from './routes/webhooks.vapi.routes';

const app = express();
app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(
  cors({
    origin: config.isProduction ? true : ['http://localhost:4200'],
    credentials: true,
  })
);
app.use(express.json({ limit: '2mb' }));
// Inbound provider webhooks (Mailgun, Twilio) post form-encoded bodies.
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(morgan(config.isProduction ? 'combined' : 'dev'));

const authRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 50 });
const apiRateLimit = rateLimit({ windowMs: 60 * 1000, max: 300 });

app.get('/api/health', (_req, res) => res.json({ success: true, data: { status: 'ok' } }));

app.use('/api/auth', authRateLimit, authRoutes);
app.use('/api/dashboard', apiRateLimit, authMiddleware, dashboardRoutes);
app.use('/api/lead-groups', apiRateLimit, authMiddleware, leadGroupsRoutes);
app.use('/api/leads', apiRateLimit, authMiddleware, leadsRoutes);
app.use('/api/contacts', apiRateLimit, authMiddleware, contactsRoutes);
app.use('/api/conversations', apiRateLimit, authMiddleware, conversationsRoutes);
app.use('/api/campaigns', apiRateLimit, authMiddleware, campaignsRoutes);
app.use('/api/calendar', apiRateLimit, authMiddleware, calendarRoutes);
app.use('/api/agent', apiRateLimit, authMiddleware, agentRoutes);
app.use('/api/engine', apiRateLimit, authMiddleware, engineRoutes);
app.use('/api/organizations', apiRateLimit, authMiddleware, organizationsRoutes);
app.use('/api/models', apiRateLimit, authMiddleware, modelsRoutes);
app.use('/api/playbooks', apiRateLimit, authMiddleware, playbooksRoutes);
app.use('/api/settings', apiRateLimit, authMiddleware, settingsRoutes);
app.use('/api/social-accounts', apiRateLimit, authMiddleware, socialAccountsRoutes);
app.use('/api/experiments', apiRateLimit, authMiddleware, experimentsRoutes);

// Webhooks: no auth middleware; validated inside handlers
const webhookRateLimit = rateLimit({ windowMs: 60 * 1000, max: 600 });
app.use('/api/webhooks/vapi', webhookRateLimit, vapiWebhookRoutes);
app.use('/api/webhooks/inbound', webhookRateLimit, inboundWebhookRoutes);

// Serve the built Angular frontend (single-service deployment, Railway-style)
const frontendDistPath = path.join(__dirname, '../../frontend/dist/social-engine-frontend/browser');
const frontendIndexPath = path.join(frontendDistPath, 'index.html');
if (fs.existsSync(frontendIndexPath)) {
  app.use(express.static(frontendDistPath, { maxAge: '1y', etag: true, index: false }));
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) {
      res.status(404).json({ success: false, error: 'API route not found' });
      return;
    }
    res.sendFile(frontendIndexPath);
  });
}

app.use(errorMiddleware);

export default app;
