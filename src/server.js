import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import createRoutes from './routes/index.js';
import setupWebSocket from './websocket/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3020;
const OCPP_PORT = process.env.OCPP_PORT || 9220;
const HOST = process.env.HOST || '0.0.0.0';
const USE_SAME_PORT = process.env.USE_SAME_PORT === 'true' || process.env.OCPP_PORT === undefined;

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const serverUrl = process.env.SERVER_URL || `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
const wsUrl = USE_SAME_PORT
  ? (process.env.WS_URL || `ws://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`)
  : (process.env.WS_URL || `ws://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${OCPP_PORT}`);

console.log('🚀 CSMS Server starting...');
console.log(`📊 Dashboard: ${serverUrl}`);
console.log(`🔌 OCPP WebSocket: ${wsUrl}${USE_SAME_PORT ? ' (on same port as HTTP)' : ''}`);
console.log(`🌐 Listening on: ${HOST}`);
console.log('');

const server = createServer(app);
const { wss, clients, sendCommandToCharger, getConnectorStatus } = setupWebSocket(server, USE_SAME_PORT, HOST, OCPP_PORT);

const routes = createRoutes(clients, sendCommandToCharger, getConnectorStatus);
app.use(routes);

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
