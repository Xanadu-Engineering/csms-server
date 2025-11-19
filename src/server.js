import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const OCPP_PORT = process.env.OCPP_PORT || 9220;
const HOST = process.env.HOST || '0.0.0.0';
const USE_SAME_PORT = process.env.USE_SAME_PORT === 'true' || process.env.OCPP_PORT === undefined;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Store connected chargers and pending requests
const clients = new Map();
const pendingRequests = new Map();
let messageIdCounter = 1;

const serverUrl = process.env.SERVER_URL || `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
const wsUrl = USE_SAME_PORT
  ? (process.env.WS_URL || `ws://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`)
  : (process.env.WS_URL || `ws://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${OCPP_PORT}`);

console.log('🚀 CSMS Server starting...');
console.log(`📊 Dashboard: ${serverUrl}`);
console.log(`🔌 OCPP WebSocket: ${wsUrl}${USE_SAME_PORT ? ' (on same port as HTTP)' : ''}`);
console.log(`🌐 Listening on: ${HOST}`);
console.log('');

// Helper function to send OCPP command to charger
function sendCommandToCharger(chargePointId, command, payload) {
  return new Promise((resolve, reject) => {
    const ws = clients.get(chargePointId);

    if (!ws || ws.readyState !== 1) {
      reject(new Error(`Charger ${chargePointId} is not connected`));
      return;
    }

    const msgId = String(messageIdCounter++);
    const message = JSON.stringify([2, msgId, command, payload]);

    console.log(`📤 [${chargePointId}] Sending: ${command}`);

    pendingRequests.set(msgId, { resolve, reject, chargePointId, command });
    ws.send(message);

    setTimeout(() => {
      if (pendingRequests.has(msgId)) {
        pendingRequests.delete(msgId);
        reject(new Error('Request timeout'));
      }
    }, 30000);
  });
}

// Get all connected chargers
app.get('/api/chargers', (req, res) => {
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
app.get('/api/chargers/:id', (req, res) => {
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

// Remote Start
app.post('/api/chargers/:id/remote-start', async (req, res) => {
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
app.post('/api/chargers/:id/remote-stop', async (req, res) => {
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

app.post('/api/chargers/:id/unlock', async (req, res) => {
  try {
    const { connectorId = 1 } = req.body;
    const response = await sendCommandToCharger(req.params.id, 'UnlockConnector', { connectorId });
    res.json({ success: true, response });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/chargers/:id/reset', async (req, res) => {
  try {
    const { type = 'Soft' } = req.body;
    const response = await sendCommandToCharger(req.params.id, 'Reset', { type });
    res.json({ success: true, response });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/chargers/:id/change-configuration', async (req, res) => {
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

app.post('/api/chargers/:id/get-configuration', async (req, res) => {
  try {
    const { key } = req.body;
    const response = await sendCommandToCharger(req.params.id, 'GetConfiguration', key ? { key: [key] } : {});
    res.json({ success: true, response });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Health check endpoint for Digital Ocean App Platform
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/csms.html'));
});

// Create HTTP server
const server = createServer(app);

// WebSocket server setup
let wss;
if (USE_SAME_PORT) {
  // Attach WebSocket server to HTTP server (for App Platform)
  // Use verifyClient to check path starts with /ocpp
  wss = new WebSocketServer({
    server,
    verifyClient: (info) => {
      // Verify that the path starts with /ocpp
      const path = info.req.url || '';
      if (!path.startsWith('/ocpp')) {
        return false;
      }
      return true;
    }
  });
  console.log('📡 WebSocket server attached to HTTP server on /ocpp path');
} else {
  // Separate WebSocket server on different port
  wss = new WebSocketServer({ host: HOST, port: OCPP_PORT });
  console.log(`📡 WebSocket server on separate port: ${OCPP_PORT}`);
}

wss.on('connection', (ws, req) => {
  // Extract charge point ID from URL
  // When using same port, req.url will be '/ocpp/CHARGE_POINT_ID'
  // When using separate port, req.url will be '/CHARGE_POINT_ID'
  const pathParts = req.url.split('/').filter(p => p);
  // If path starts with 'ocpp', the charge point ID is the next part
  const chargePointId = pathParts[0] === 'ocpp'
    ? (pathParts[1] || 'unknown')
    : (pathParts[0] || 'unknown');

  if (chargePointId === 'unknown') {
    console.warn(`⚠️  Warning: Could not extract charge point ID from URL: ${req.url}`);
  }

  ws.connectedAt = new Date();
  clients.set(chargePointId, ws);
  console.log(`\n🔗 New charging station connected: ${chargePointId} (from ${req.url})\n`);

  ws.on('message', async (data) => {
    try {
      const [messageType, messageId, commandOrResponse, payload] = JSON.parse(data.toString());

      if (messageType === 3) {
        if (pendingRequests.has(messageId)) {
          const { resolve, command } = pendingRequests.get(messageId);
          pendingRequests.delete(messageId);
          console.log(`✅ [${chargePointId}] ${command} Response:`, commandOrResponse);
          resolve(commandOrResponse);
        }
        return;
      }

      const command = commandOrResponse;
      console.log(`📥 [${chargePointId}] Received: ${command}`);

      let response;

      if (command === 'BootNotification') {
        response = { currentTime: new Date().toISOString(), interval: 10, status: 'Accepted' };
      } else if (command === 'Heartbeat') {
        response = { currentTime: new Date().toISOString() };
      } else if (command === 'Authorize') {
        response = { idTagInfo: { status: 'Accepted' } };
      } else if (command === 'StartTransaction') {
        response = { transactionId: Math.floor(Math.random() * 100000), idTagInfo: { status: 'Accepted' } };
      } else if (command === 'StopTransaction') {
        response = { idTagInfo: { status: 'Accepted' } };
      } else {
        response = {};
      }

      ws.send(JSON.stringify([3, messageId, response]));
    } catch (error) {
      console.error(`⚠️  Error from ${chargePointId}:`, error.message);
    }
  });

  ws.on('close', () => {
    console.log(`\n❌ Charging station disconnected: ${chargePointId}\n`);
    clients.delete(chargePointId);
  });
});

// Start HTTP server
server.listen(PORT, HOST, () => {
  console.log('Available endpoints:');
  console.log('  GET  /health (health check)');
  console.log('  GET  /api/chargers');
  console.log('  POST /api/chargers/:id/remote-start');
  console.log('  POST /api/chargers/:id/remote-stop');
  console.log('  POST /api/chargers/:id/unlock');
  console.log('  POST /api/chargers/:id/reset');
  console.log('  POST /api/chargers/:id/change-configuration');
  console.log('  POST /api/chargers/:id/get-configuration');
  if (USE_SAME_PORT) {
    console.log(`  WS   /ocpp/:chargePointId (WebSocket on same port)`);
  }
});

process.on('SIGINT', () => {
  console.log('\n\n👋 Shutting down CSMS Server...');
  wss.close();
  process.exit(0);
});
