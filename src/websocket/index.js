import { WebSocketServer } from 'ws';

export default function setupWebSocket(server, USE_SAME_PORT, HOST, OCPP_PORT) {
  // Store connected chargers and pending requests
  const clients = new Map();
  const pendingRequests = new Map();
  // Store pending connections: ws -> { urlChargePointId, connectedAt, timeout }
  const pendingConnections = new Map();
  // Store connector status: chargePointId -> Map(connectorId -> status object)
  const connectorStatus = new Map();
  // Store active transactions: chargePointId -> Map(connectorId -> transactionId)
  const activeTransactions = new Map();
  let messageIdCounter = 1;
  const PENDING_CONNECTION_TIMEOUT = 30000; // 30 seconds

  // Helper function to register a device (move from pending to active)
  function registerDevice(ws, chargePointId) {
    // Clear pending connection timeout if exists
    const pending = pendingConnections.get(ws);
    if (pending && pending.timeout) {
      clearTimeout(pending.timeout);
    }
    pendingConnections.delete(ws);

    // Register the device
    ws.connectedAt = new Date();
    clients.set(chargePointId, ws);

    // Initialize connector status tracking for this charger
    if (!connectorStatus.has(chargePointId)) {
      connectorStatus.set(chargePointId, new Map());
    }
    if (!activeTransactions.has(chargePointId)) {
      activeTransactions.set(chargePointId, new Map());
    }

    console.log(`\n🔗 Charging station registered: ${chargePointId}\n`);
    return chargePointId;
  }

  // Helper function to get chargePointId from WebSocket (from clients or pending)
  function getChargePointId(ws) {
    // First check if registered
    for (const [chargePointId, registeredWs] of clients.entries()) {
      if (registeredWs === ws) {
        return chargePointId;
      }
    }
    // Then check pending connections
    const pending = pendingConnections.get(ws);
    return pending ? pending.urlChargePointId : null;
  }

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
    // Extract charge point ID from URL (may be 'unknown' if not in URL)
    // When using same port, req.url will be '/ocpp/CHARGE_POINT_ID'
    // When using separate port, req.url will be '/CHARGE_POINT_ID'
    const pathParts = req.url.split('/').filter(p => p);
    // If path starts with 'ocpp', the charge point ID is the next part
    const urlChargePointId = pathParts[0] === 'ocpp'
      ? (pathParts[1] || 'unknown')
      : (pathParts[0] || 'unknown');

    // Store as pending connection (not registered until BootNotification or Heartbeat)
    const timeout = setTimeout(() => {
      if (pendingConnections.has(ws)) {
        console.warn(`\n⚠️  Pending connection timeout: ${urlChargePointId} (from ${req.url}) - closing connection\n`);
        ws.close();
        pendingConnections.delete(ws);
      }
    }, PENDING_CONNECTION_TIMEOUT);

    pendingConnections.set(ws, {
      urlChargePointId,
      connectedAt: new Date(),
      timeout,
    });

    console.log(`\n⏳ New WebSocket connection (pending registration): ${urlChargePointId} (from ${req.url})\n`);

    ws.on('message', async (data) => {
      try {
        const [messageType, messageId, commandOrResponse, payload] = JSON.parse(data.toString());

        // Get chargePointId from either registered or pending state
        let chargePointId = getChargePointId(ws);
        // Check if connection is pending (not yet registered)
        const isPending = pendingConnections.has(ws);

        if (messageType === 3) {
          if (pendingRequests.has(messageId)) {
            const { resolve, command } = pendingRequests.get(messageId);
            pendingRequests.delete(messageId);
            // Get chargePointId again in case it was just registered
            chargePointId = getChargePointId(ws);
            console.log(`✅ [${chargePointId || 'unknown'}] ${command} Response:`, commandOrResponse);
            resolve(commandOrResponse);
          }
          return;
        }

        const command = commandOrResponse;
        
        // Handle registration on BootNotification or Heartbeat
        if (command === 'BootNotification') {
          // Extract chargePointId from BootNotification payload (authoritative source)
          const payloadChargePointId = payload?.chargePointSerialNumber || null;
          // Get URL-based ID from pending connection if available
          const pending = pendingConnections.get(ws);
          const urlChargePointId = pending?.urlChargePointId || null;
          const finalChargePointId = payloadChargePointId || urlChargePointId || chargePointId || 'unknown';
          
          // Register device if pending (not yet registered)
          if (isPending) {
            chargePointId = registerDevice(ws, finalChargePointId);
          } else if (chargePointId && chargePointId !== finalChargePointId) {
            // Device already registered with different ID - this shouldn't happen, but log it
            console.warn(`⚠️  BootNotification chargePointId mismatch: registered=${chargePointId}, payload=${finalChargePointId}`);
            chargePointId = getChargePointId(ws); // Use the registered one
          }
          
          console.log(`📥 [${chargePointId}] Received: ${command}`);
          const response = { currentTime: new Date().toISOString(), interval: 10, status: 'Accepted' };
          ws.send(JSON.stringify([3, messageId, response]));
          return;
        } else if (command === 'Heartbeat') {
          // Register device if not already registered (use URL-extracted ID since heartbeat has no identity)
          if (isPending) {
            const pending = pendingConnections.get(ws);
            const heartbeatChargePointId = pending?.urlChargePointId || 'unknown';
            if (heartbeatChargePointId !== 'unknown') {
              chargePointId = registerDevice(ws, heartbeatChargePointId);
            }
          }
          
          console.log(`📥 [${chargePointId || 'unknown'}] Received: ${command}`);
          const response = { currentTime: new Date().toISOString() };
          ws.send(JSON.stringify([3, messageId, response]));
          return;
        }

        // For other commands, device must be registered
        if (isPending) {
          console.warn(`⚠️  Received ${command} from unregistered connection, ignoring`);
          return;
        }
        
        // Ensure we have a valid chargePointId for registered connections
        chargePointId = getChargePointId(ws);
        if (!chargePointId) {
          console.warn(`⚠️  Cannot determine chargePointId for ${command}, ignoring`);
          return;
        }

        console.log(`📥 [${chargePointId}] Received: ${command}`);

        let response;

        if (command === 'Authorize') {
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
        const errorChargePointId = getChargePointId(ws) || 'unknown';
        console.error(`⚠️  Error from ${errorChargePointId}:`, error.message);
      }
    });

    ws.on('close', () => {
      // Get chargePointId from either registered or pending state
      let chargePointId = getChargePointId(ws);
      
      // Clean up pending connection if exists
      const pending = pendingConnections.get(ws);
      if (pending) {
        if (pending.timeout) {
          clearTimeout(pending.timeout);
        }
        pendingConnections.delete(ws);
        if (!chargePointId) {
          chargePointId = pending.urlChargePointId;
        }
      }
      
      // Clean up registered connection if exists
      if (chargePointId && clients.has(chargePointId)) {
        clients.delete(chargePointId);
        console.log(`\n❌ Charging station disconnected: ${chargePointId}\n`);
      } else if (chargePointId) {
        console.log(`\n❌ Pending connection closed: ${chargePointId}\n`);
      } else {
        console.log(`\n❌ Connection closed: unknown device\n`);
      }
      
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

