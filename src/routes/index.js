import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default function createRoutes(clients, sendCommandToCharger, getConnectorStatus) {
  const router = express.Router();

  function getChargerConnectors(chargePointId) {
    return getConnectorStatus ? getConnectorStatus(chargePointId) : [];
  }

  function parsePositiveInteger(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  function resolveTransactionId(chargePointId, body = {}) {
    const connectors = getChargerConnectors(chargePointId);
    const requestedConnectorId = parsePositiveInteger(body.connectorId);
    if (requestedConnectorId) {
      const connector = connectors.find((item) => item.connectorId === requestedConnectorId);
      if (!connector) {
        return { error: `Connector ${requestedConnectorId} not found` };
      }
      if (!connector.transactionId) {
        return { error: `Connector ${requestedConnectorId} has no active transaction` };
      }
      return { transactionId: connector.transactionId };
    }

    const requestedTransactionId = parsePositiveInteger(body.transactionId);
    if (requestedTransactionId) {
      return { transactionId: requestedTransactionId };
    }

    const activeConnectors = connectors.filter((item) => item.transactionId);
    if (activeConnectors.length === 1) {
      return { transactionId: activeConnectors[0].transactionId };
    }
    if (activeConnectors.length === 0) {
      return { error: 'No active transaction found' };
    }

    return {
      error: 'Multiple active transactions found; provide connectorId or transactionId',
    };
  }

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

    const connectors = getChargerConnectors(req.params.id);
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
    const connectors = getChargerConnectors(req.params.id);
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
      const resolution = resolveTransactionId(req.params.id, req.body);
      if (resolution.error) {
        return res.status(400).json({ success: false, error: resolution.error });
      }

      const response = await sendCommandToCharger(req.params.id, 'RemoteStopTransaction', {
        transactionId: resolution.transactionId
      });
      res.json({
        success: true,
        response,
        transactionId: resolution.transactionId,
      });
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
    res.sendFile(path.join(__dirname, '../../public/csms.html'));
  });

  return router;
}
