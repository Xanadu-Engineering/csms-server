import { WebSocketServer } from 'ws';

export default function setupWebSocket(server, USE_SAME_PORT, HOST, OCPP_PORT) {
  // Store connected chargers and pending requests
  const clients = new Map();
  const pendingRequests = new Map();
  // Store connector status: chargePointId -> Map(connectorId -> status object)
  const connectorStatus = new Map();
  // Store active transactions: chargePointId -> Map(connectorId -> transactionId)
  const activeTransactions = new Map();
  let messageIdCounter = 1;

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
    // Initialize connector status tracking for this charger
    if (!connectorStatus.has(chargePointId)) {
      connectorStatus.set(chargePointId, new Map());
    }
    if (!activeTransactions.has(chargePointId)) {
      activeTransactions.set(chargePointId, new Map());
    }
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
          const transactionId = Math.floor(Math.random() * 100000);
          const connectorId = payload?.connectorId || 1;
          // Track active transaction
          activeTransactions.get(chargePointId)?.set(connectorId, transactionId);
          // Update connector status - CHARGING or PREPARING means plugged in
          const statusMap = connectorStatus.get(chargePointId);
          if (statusMap) {
            const currentStatus = statusMap.get(connectorId) || { state: 'Available' };
            statusMap.set(connectorId, {
              ...currentStatus,
              state: 'Charging',
              transactionId,
              pluggedIn: true, // CHARGING implies plugged in
              idTag: payload?.idTag || currentStatus.idTag,
            });
          }
          response = { transactionId, idTagInfo: { status: 'Accepted' } };
        } else if (command === 'StopTransaction') {
          // Clear active transaction
          const statusMap = connectorStatus.get(chargePointId);
          const txMap = activeTransactions.get(chargePointId);
          if (statusMap && txMap) {
            // Find connector by transactionId
            for (const [connectorId, transactionId] of txMap.entries()) {
              if (transactionId === payload?.transactionId) {
                txMap.delete(connectorId);
                const currentStatus = statusMap.get(connectorId) || {};
                statusMap.set(connectorId, {
                  ...currentStatus,
                  state: 'Available',
                  transactionId: null,
                  // pluggedIn state inferred from connector state - AVAILABLE without transaction = not plugged in
                  pluggedIn: false,
                });
                break;
              }
            }
          }
          response = { idTagInfo: { status: 'Accepted' } };
        } else if (command === 'StatusNotification') {
          // Track connector status from StatusNotification
          const connectorId = payload?.connectorId || 1;
          const state = payload?.status || 'Unknown';
          const statusMap = connectorStatus.get(chargePointId);
          if (statusMap) {
            const currentStatus = statusMap.get(connectorId) || {};
            const txMap = activeTransactions.get(chargePointId);
            const hasActiveTransaction = txMap?.has(connectorId);
            
            // Infer pluggedIn state from connector state
            // PREPARING, CHARGING, SUSPENDED_EV, FINISHING = plugged in
            // AVAILABLE without active transaction = not plugged in
            // AVAILABLE with active transaction = edge case, assume still plugged in until transaction stops
            const isPluggedIn = ['Preparing', 'Charging', 'SuspendedEV', 'Finishing'].includes(state) ||
              (state === 'Available' && hasActiveTransaction);
            
            statusMap.set(connectorId, {
              ...currentStatus,
              state,
              pluggedIn: isPluggedIn,
              errorCode: payload?.errorCode || currentStatus.errorCode,
              timestamp: payload?.timestamp || new Date().toISOString(),
              // Preserve transactionId if it exists
              transactionId: currentStatus.transactionId || (hasActiveTransaction ? txMap.get(connectorId) : null),
            });
          }
          response = {}; // StatusNotification doesn't require a response payload
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
      // Keep connector status and transactions in memory even after disconnect
      // They will be cleared when charger reconnects if needed
    });
  });

  // Helper function to get connector status for a charger
  function getConnectorStatus(chargePointId) {
    const statusMap = connectorStatus.get(chargePointId);
    if (!statusMap) {
      return [];
    }
    const connectors = [];
    statusMap.forEach((status, connectorId) => {
      connectors.push({
        connectorId,
        ...status,
      });
    });
    return connectors;
  }

  return {
    wss,
    clients,
    sendCommandToCharger,
    connectorStatus,
    getConnectorStatus,
  };
}

