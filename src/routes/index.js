import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default function createRoutes(clients, sendCommandToCharger, getConnectorStatus) {
  const router = express.Router();

  // Get all connected chargers
  router.get('/api/chargers', (req, res) => {
    const chargerList = Array.from(clients.keys()).map(id => ({
      id,
      connected: clients.get(id).readyState === 1,
      connectedAt: clients.get(id).connectedAt
    }));
    res.json({
      chargers: chargerList,
      lastUpdate: new Date(),
      count: chargerList.length
    });
  });

  // Get specific charger details
  router.get('/api/chargers/:id', (req, res) => {
    const charger = clients.get(req.params.id);

    if (!charger) {
      return res.status(404).json({ error: 'Charger not found' });
    }

    res.json({
      id: req.params.id,
      connected: charger.readyState === 1,
      connectedAt: charger.connectedAt
    });
  });

  // Get all connectors for a charger
  router.get('/api/chargers/:id/connectors', (req, res) => {
    const charger = clients.get(req.params.id);

    if (!charger) {
      return res.status(404).json({ error: 'Charger not found' });
    }

    const connectors = getConnectorStatus ? getConnectorStatus(req.params.id) : [];
    res.json({
      chargerId: req.params.id,
      connectors
    });
  });

  // Get specific connector status for a charger
  router.get('/api/chargers/:id/connectors/:connectorId', (req, res) => {
    const charger = clients.get(req.params.id);

    if (!charger) {
      return res.status(404).json({ error: 'Charger not found' });
    }

    const connectorId = Number(req.params.connectorId);
    const connectors = getConnectorStatus ? getConnectorStatus(req.params.id) : [];
    const connector = connectors.find(c => c.connectorId === connectorId);

    if (!connector) {
      return res.status(404).json({ error: 'Connector not found' });
    }

    res.json({
      chargerId: req.params.id,
      connector
    });
  });

  // Remote Start
  router.post('/api/chargers/:id/remote-start', async (req, res) => {
    try {
      const { idTag = 'REMOTE-TAG', connectorId = 1 } = req.body;
      const response = await sendCommandToCharger(req.params.id, 'RemoteStartTransaction', {
        idTag,
        connectorId
      });
      res.json({ success: true, response });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Remote Stop
  router.post('/api/chargers/:id/remote-stop', async (req, res) => {
    try {
      const { transactionId } = req.body;
      if (!transactionId) {
        return res.status(400).json({ success: false, error: 'transactionId is required' });
      }
      const response = await sendCommandToCharger(req.params.id, 'RemoteStopTransaction', {
        transactionId
      });
      res.json({ success: true, response });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.post('/api/chargers/:id/unlock', async (req, res) => {
    try {
      const { connectorId = 1 } = req.body;
      const response = await sendCommandToCharger(req.params.id, 'UnlockConnector', { connectorId });
      res.json({ success: true, response });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.post('/api/chargers/:id/reset', async (req, res) => {
    try {
      const { type = 'Soft' } = req.body;
      const response = await sendCommandToCharger(req.params.id, 'Reset', { type });
      res.json({ success: true, response });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.post('/api/chargers/:id/change-configuration', async (req, res) => {
    try {
      const { key, value } = req.body;
      if (!key || !value) {
        return res.status(400).json({ success: false, error: 'key and value are required' });
      }
      const response = await sendCommandToCharger(req.params.id, 'ChangeConfiguration', { key, value });
      res.json({ success: true, response });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.post('/api/chargers/:id/get-configuration', async (req, res) => {
    try {
      const { key } = req.body;
      const response = await sendCommandToCharger(req.params.id, 'GetConfiguration', key ? { key: [key] } : {});
      res.json({ success: true, response });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Health check endpoint for Digital Ocean App Platform
  router.get('/health', (req, res) => {
    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    });
  });

  router.get('/', (req, res) => {
    // #region agent log
    const htmlPath = path.join(__dirname, '../../public/csms.html');
    fetch('http://127.0.0.1:7244/ingest/de05f8cb-b467-480c-9bd1-258c14112157', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'routes/index.js:160', message: 'Resolving csms.html path', data: { __dirname, htmlPath, pathExists: existsSync(htmlPath) }, timestamp: Date.now(), sessionId: 'debug-session', runId: 'run1', hypothesisId: 'A' }) }).catch(() => { });
    // #endregion
    res.sendFile(htmlPath);
  });

  return router;
}

