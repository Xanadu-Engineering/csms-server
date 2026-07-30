import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CERT_DIRECTORY = path.join(__dirname, '../../cert');
const DEFAULT_CERTIFICATE_TYPE = 'CSMSRootCertificate';
const CERTIFICATE_TYPES = ['CSMSRootCertificate', 'V2GRootCertificate'];
const CERTIFICATE_FILE_PREFERENCE = ['chain.pem', 'fullchain.pem', 'cert.pem'];

export default function createRoutes(clients, sendCommandToCharger, getConnectorStatus, getSessions, getChargers) {
  const router = express.Router();

  function getChargerConnectors(chargePointId) {
    return getConnectorStatus ? getConnectorStatus(chargePointId) : [];
  }

  function findCharger(chargePointId) {
    const restored = getChargers?.().find((charger) => charger.id === chargePointId);
    if (restored) return restored;
    const socket = clients.get(chargePointId);
    return socket
      ? { id: chargePointId, connected: socket.readyState === 1, connectedAt: socket.connectedAt }
      : null;
  }

  function parsePositiveInteger(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  function parseTransactionId(value) {
    if (value === undefined || value === null || String(value).trim() === '') {
      return null;
    }
    const normalized = String(value).trim();
    return /^\d+$/.test(normalized) ? Number(normalized) : normalized;
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

    const requestedTransactionId = parseTransactionId(body.transactionId);
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

  function listCertificateFiles() {
    if (!fs.existsSync(CERT_DIRECTORY)) {
      return [];
    }

    return fs.readdirSync(CERT_DIRECTORY)
      .filter((fileName) => /\.(pem|crt|cer)$/i.test(fileName))
      .sort((left, right) => left.localeCompare(right));
  }

  function getDefaultCertificateFileName(files = listCertificateFiles()) {
    for (const preferredFile of CERTIFICATE_FILE_PREFERENCE) {
      if (files.includes(preferredFile)) {
        return preferredFile;
      }
    }
    return files[0] || null;
  }

  function readCertificateFile(fileName) {
    const safeFileName = path.basename(fileName || '');
    const filePath = path.join(CERT_DIRECTORY, safeFileName);

    if (!safeFileName || filePath !== path.join(CERT_DIRECTORY, safeFileName)) {
      throw new Error('Invalid certificate file name');
    }
    if (!fs.existsSync(filePath)) {
      throw new Error(`Certificate file not found: ${safeFileName}`);
    }

    return fs.readFileSync(filePath, 'utf8').trim();
  }

  // Get all connected chargers
  router.get('/api/chargers', (req, res) => {
    const chargerList = getChargers
      ? getChargers()
      : Array.from(clients.keys()).map(id => ({
          id,
          connected: clients.get(id).readyState === 1,
          connectedAt: clients.get(id).connectedAt,
          protocol: clients.get(id).protocol || clients.get(id).ocppProtocol || 'unknown',
          lastHeartbeatAt: clients.get(id).lastHeartbeatAt,
          connectors: getChargerConnectors(id),
        }));
    res.json({
      chargers: chargerList,
      lastUpdate: new Date(),
      count: chargerList.length,
      connectedCount: chargerList.filter((charger) => charger.connected).length,
    });
  });

  // Get specific charger details
  router.get('/api/chargers/:id', (req, res) => {
    const charger = findCharger(req.params.id);

    if (!charger) {
      return res.status(404).json({ error: 'Charger not found' });
    }

    res.json({
      ...charger,
      connectors: getChargerConnectors(req.params.id),
    });
  });

  // Get all connectors for a charger
  router.get('/api/chargers/:id/connectors', (req, res) => {
    const charger = findCharger(req.params.id);

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
    const charger = findCharger(req.params.id);

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

  router.get('/api/sessions', (req, res) => {
    const sessions = getSessions
      ? getSessions({
          status: req.query.status,
          chargerId: req.query.chargerId,
          limit: req.query.limit,
        })
      : [];
    res.json({
      sessions,
      count: sessions.length,
      activeCount: sessions.filter((session) => session.status === 'Active').length,
      lastUpdate: new Date(),
    });
  });

  router.get('/api/certificates', (req, res) => {
    const certificateFiles = listCertificateFiles();
    res.json({
      certificateFiles,
      certificateTypes: CERTIFICATE_TYPES,
      defaultCertificateFileName: getDefaultCertificateFileName(certificateFiles),
      defaultCertificateType: DEFAULT_CERTIFICATE_TYPE,
    });
  });

  // Remote Start
  router.post('/api/chargers/:id/remote-start', async (req, res) => {
    try {
      const { idTag = 'REMOTE-TAG', connectorId = 1 } = req.body;
      const activeConnector = getChargerConnectors(req.params.id)
        .find((connector) => connector.transactionId || connector.state === 'Charging');
      if (activeConnector) {
        return res.status(409).json({
          success: false,
          error: `Charger already has an active session on connector ${activeConnector.connectorId}`,
          transactionId: activeConnector.transactionId || null,
        });
      }
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

  router.post('/api/chargers/:id/install-certificate', async (req, res) => {
    try {
      const certificateFiles = listCertificateFiles();
      const defaultCertificateFileName = getDefaultCertificateFileName(certificateFiles);
      if (!defaultCertificateFileName) {
        return res.status(400).json({
          success: false,
          error: `No certificate files found in ${CERT_DIRECTORY}`,
        });
      }

      const {
        certificateType = DEFAULT_CERTIFICATE_TYPE,
        certificateFileName = defaultCertificateFileName,
      } = req.body;

      const certificate = readCertificateFile(certificateFileName);
      const response = await sendCommandToCharger(req.params.id, 'InstallCertificate', {
        certificateType,
        certificate,
      });

      res.json({
        success: true,
        response,
        certificateType,
        certificateFileName,
      });
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
    res.sendFile(path.join(__dirname, '../../public/csms.html'), {
      cacheControl: false,
      etag: false,
      lastModified: false,
    });
  });

  return router;
}
