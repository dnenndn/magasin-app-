require('dotenv').config();
const express = require('express');
const cors = require('cors');

// Defense in depth: even with the per-route fixes, a single bad request
// should never take the whole backend down for every user. Log and keep
// running instead of letting Node's default "crash on unhandled rejection"
// behavior kill the process.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (backend kept running):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (backend kept running):', err);
});

const authRoutes = require('./routes/auth');
const articlesRoutes = require('./routes/articles');
const referenceDataRoutes = require('./routes/reference-data');
const bsmRoutes = require('./routes/bsm');
const receptionRoutes = require('./routes/reception');
const brmRoutes = require('./routes/brm');
const notificationsRoutes = require('./routes/notifications');
const adminRoutes = require('./routes/admin');
const movementsRoutes = require('./routes/movements');
const daRoutes = require('./routes/da');
const nfcRoutes = require('./routes/nfc');
const atelierRoutes = require('./routes/atelier');
const productionRoutes = require('./routes/production');

const app = express();

// Compress JSON responses (typically 5-10x smaller on the wire - the biggest
// single saving on mobile data). Optional: if the package is not installed
// yet (npm install not run), the server still starts, just uncompressed.
try {
  app.use(require('compression')());
} catch (e) {
  console.warn('compression package not installed - run "npm install" in backend/ to save mobile data.');
}

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', authRoutes);
app.use('/api/articles', articlesRoutes);
app.use('/api/reference-data', referenceDataRoutes);
app.use('/api/bsm', bsmRoutes);
app.use('/api/reception', receptionRoutes);
app.use('/api/brm', brmRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/movements', movementsRoutes);
app.use('/api/da', daRoutes);
app.use('/api/nfc', nfcRoutes);
app.use('/api/atelier', atelierRoutes);
app.use('/api/production', productionRoutes);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error' });
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`GMAO stock connector listening on port ${port}`));
