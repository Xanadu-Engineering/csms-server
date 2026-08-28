import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';

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
  // Protocol-neutral charging sessions, retained for the dashboard after stop/disconnect.
  const sessions = new Map();
  const chargerMetadata = new Map();
  const STATE_FILE = process.env.CSMS_STATE_FILE === ':memory:'
    ? null
    : path.resolve(process.env.CSMS_STATE_FILE || 'data/csms-state.json');
  let persistTimer = null;
  let messageIdCounter = 1;
  const PENDING_CONNECTION_TIMEOUT = 30000; // 30 seconds
  const WS_PING_INTERVAL_MS = Number(process.env.WS_PING_INTERVAL_MS || 15000);
  const REQUIRED_PROTOCOLS = (process.env.OCPP_PROTOCOLS || 'ocpp2.0.1,ocpp1.6,ocpp1.6j')
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);
  const REQUIRE_PROTOCOL = process.env.REQUIRE_OCPP_PROTOCOL !== 'false';
  const AUTH_KEY = process.env.OCPP_AUTH_KEY || '';
  const AUTH_HEADER = (process.env.OCPP_AUTH_HEADER || 'authentication-key').toLowerCase();
  const AUTH_IN_BOOT = process.env.OCPP_AUTH_IN_BOOT !== 'false';
  const AUTH_FIELD = process.env.OCPP_AUTH_FIELD || 'authenticationKey';
  const AUTH_BASIC = process.env.OCPP_AUTH_BASIC !== 'false';
  const DATA_TRANSFER_BALANCE_FIELD = process.env.OCPP_DATA_TRANSFER_BALANCE_FIELD || 'custom_balance';
  const CUSTOM_BALANCE = parseCustomBalance(process.env.OCPP_CUSTOM_BALANCE);

  function parseCustomBalance(configuredBalance) {
    if (configuredBalance === undefined) {
      return 1000000;
    }
    if (['', 'false', 'none', 'off'].includes(configuredBalance.trim().toLowerCase())) {
      return null;
    }

    const balance = Number(configuredBalance);
    if (!Number.isFinite(balance) || balance < 0) {
      throw new Error('OCPP_CUSTOM_BALANCE must be a non-negative number or "off"');
    }
    return balance;
  }

  function createDataTransferResponse(protocol) {
    const response = { status: 'Accepted' };
    if (CUSTOM_BALANCE === null) {
      return response;
    }

    const data = { [DATA_TRANSFER_BALANCE_FIELD]: CUSTOM_BALANCE };
    return {
      ...response,
      // OCPP 1.6 restricts DataTransfer.conf data to a string. OCPP 2.0.1
      // permits arbitrary JSON data, which is more convenient for vendor extensions.
      data: protocol === 'ocpp2.0.1' ? data : JSON.stringify(data),
    };
  }

  function persistState() {
    if (!STATE_FILE) return;
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      const snapshot = {
        version: 1,
        savedAt: new Date().toISOString(),
        chargers: Object.fromEntries(chargerMetadata),
        connectors: Object.fromEntries(
          Array.from(connectorStatus.entries()).map(([chargerId, statuses]) => [
            chargerId,
            Array.from(statuses.entries()).map(([connectorId, status]) => ({
              connectorId,
              ...status,
            })),
          ]),
        ),
        sessions: Array.from(sessions.values()),
      };
      const temporaryFile = `${STATE_FILE}.tmp`;
      fs.writeFileSync(temporaryFile, JSON.stringify(snapshot, null, 2));
      fs.renameSync(temporaryFile, STATE_FILE);
    } catch (error) {
      console.error(`⚠️  Unable to persist CSMS state: ${error.message}`);
    }
  }

  function schedulePersist() {
    if (!STATE_FILE || persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistState();
    }, 200);
  }

  function restoreState() {
    if (!STATE_FILE || !fs.existsSync(STATE_FILE)) return;
    try {
      const snapshot = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      Object.entries(snapshot.chargers || {}).forEach(([chargerId, metadata]) => {
        chargerMetadata.set(chargerId, { ...metadata, connected: false });
      });
      Object.entries(snapshot.connectors || {}).forEach(([chargerId, connectors]) => {
        connectorStatus.set(
          chargerId,
          new Map((connectors || []).map(({ connectorId, ...status }) => [Number(connectorId), status])),
        );
      });
      for (const session of snapshot.sessions || []) {
        const key = sessionKey(session.chargerId, session.transactionId);
        sessions.set(key, session);
        if (session.status === 'Active') {
          if (!activeTransactions.has(session.chargerId)) {
            activeTransactions.set(session.chargerId, new Map());
          }
          activeTransactions.get(session.chargerId).set(session.connectorId, session.transactionId);
        }
      }
      console.log(`♻️  Restored ${chargerMetadata.size} charger(s) and ${sessions.size} session(s) from ${STATE_FILE}`);
    } catch (error) {
      console.error(`⚠️  Unable to restore CSMS state: ${error.message}`);
    }
  }

  function sessionKey(chargePointId, transactionId) {
    return `${chargePointId}:${String(transactionId)}`;
  }

  restoreState();

  function startSession(chargePointId, connectorId, transactionId, details = {}) {
    if (transactionId === undefined || transactionId === null) return;
    const key = sessionKey(chargePointId, transactionId);
    const existing = sessions.get(key) || {};
    sessions.set(key, {
      ...existing,
      id: String(transactionId),
      transactionId,
      chargerId: chargePointId,
      connectorId,
      protocol: clients.get(chargePointId)?.protocol || 'unknown',
      status: 'Active',
      idTag: details.idTag || existing.idTag || null,
      startedAt: existing.startedAt || details.startedAt || new Date().toISOString(),
      endedAt: null,
      meterStartWh: details.meterStartWh ?? existing.meterStartWh ?? null,
      energyWh: existing.energyWh || 0,
      lastUpdatedAt: new Date().toISOString(),
    });
    schedulePersist();
  }

  function updateSession(chargePointId, connectorId, transactionId, telemetry = {}) {
    if (transactionId === undefined || transactionId === null) return;
    const key = sessionKey(chargePointId, transactionId);
    if (!sessions.has(key)) {
      startSession(chargePointId, connectorId, transactionId);
    }
    const current = sessions.get(key);
    const meterWh = telemetry.meterWh ?? current.meterWh;
    const meterStartWh = current.meterStartWh ?? meterWh;
    const meterValueHistory = [...(current.meterValueHistory || [])];
    if (telemetry.meterValues?.length) {
      const reading = {
        timestamp: telemetry.lastMeterValueAt || new Date().toISOString(),
        sampledValue: telemetry.meterValues,
      };
      const previous = meterValueHistory[meterValueHistory.length - 1];
      if (
        !previous
        || previous.timestamp !== reading.timestamp
        || JSON.stringify(previous.sampledValue) !== JSON.stringify(reading.sampledValue)
      ) {
        meterValueHistory.push(reading);
      }
    }
    sessions.set(key, {
      ...current,
      ...telemetry,
      meterWh,
      meterStartWh,
      energyWh: meterWh != null && meterStartWh != null
        ? Math.max(0, meterWh - meterStartWh)
        : current.energyWh,
      meterValueHistory: meterValueHistory.slice(-120),
      lastUpdatedAt: telemetry.lastMeterValueAt || new Date().toISOString(),
    });
    schedulePersist();
  }

  function endSession(chargePointId, connectorId, transactionId, details = {}) {
    if (transactionId === undefined || transactionId === null) return;
    updateSession(chargePointId, connectorId, transactionId, details);
    const key = sessionKey(chargePointId, transactionId);
    const current = sessions.get(key);
    sessions.set(key, {
      ...current,
      status: 'Completed',
      powerW: 0,
      currentA: 0,
      stopReason: details.stopReason || current.stopReason || null,
      endedAt: details.endedAt || new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
    });
    schedulePersist();
  }

  // Helper function to register a device (move from pending to active)
  function registerDevice(ws, chargePointId) {
    // Clear pending connection timeout if exists
    const pending = pendingConnections.get(ws);
    if (pending && pending.timeout) {
      clearTimeout(pending.timeout);
    }
    pendingConnections.delete(ws);

    const existingWs = clients.get(chargePointId);
    if (existingWs && existingWs !== ws) {
      unregisterConnection(existingWs, 'replaced by a newer session');
      existingWs.terminate();
    }

    // Register the device
    ws.connectedAt = new Date();
    ws.lastHeartbeatAt = null;
    ws.ocppProtocol = ws.protocol || 'unknown';
    clients.set(chargePointId, ws);
    const now = new Date().toISOString();
    chargerMetadata.set(chargePointId, {
      ...(chargerMetadata.get(chargePointId) || {}),
      id: chargePointId,
      connected: true,
      connectedAt: ws.connectedAt.toISOString(),
      lastConnectedAt: now,
      protocol: ws.protocol || 'unknown',
      lastDisconnectedAt: null,
    });

    // Initialize connector status tracking for this charger
    if (!connectorStatus.has(chargePointId)) {
      connectorStatus.set(chargePointId, new Map());
    }
    if (!activeTransactions.has(chargePointId)) {
      activeTransactions.set(chargePointId, new Map());
    }

    console.log(`\n🔗 Charging station registered: ${chargePointId}\n`);
    schedulePersist();
    return chargePointId;
  }

  function unregisterConnection(ws, reason = 'Connection closed') {
    // Get chargePointId from either registered or pending state before cleanup.
    let chargePointId = getChargePointId(ws);

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

    if (chargePointId && clients.get(chargePointId) === ws) {
      clients.delete(chargePointId);
      chargerMetadata.set(chargePointId, {
        ...(chargerMetadata.get(chargePointId) || {}),
        connected: false,
        lastDisconnectedAt: new Date().toISOString(),
      });
      schedulePersist();
      console.log(`\n❌ Charging station disconnected: ${chargePointId} (${reason})\n`);
      return;
    }

    if (chargePointId) {
      console.log(`\n❌ Pending connection closed: ${chargePointId} (${reason})\n`);
      return;
    }

    console.log(`\n❌ Connection closed: unknown device (${reason})\n`);
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
      const isOcpp201 = ws.protocol === 'ocpp2.0.1';
      let wireCommand = command;
      let wirePayload = payload;

      if (isOcpp201) {
        if (command === 'RemoteStartTransaction') {
          wireCommand = 'RequestStartTransaction';
          wirePayload = {
            idToken: { idToken: payload.idTag, type: 'Central' },
            evseId: payload.connectorId,
            remoteStartId: Number(msgId),
          };
        } else if (command === 'RemoteStopTransaction') {
          wireCommand = 'RequestStopTransaction';
        } else if (command === 'UnlockConnector') {
          wirePayload = { evseId: payload.connectorId, connectorId: payload.connectorId };
        } else if (command === 'Reset') {
          wirePayload = { type: payload.type === 'Hard' ? 'Immediate' : 'OnIdle' };
        } else if (command === 'ChangeConfiguration') {
          wireCommand = 'SetVariables';
          wirePayload = {
            setVariableData: [{
              attributeValue: String(payload.value),
              component: { name: 'OCPPCommCtrlr' },
              variable: { name: payload.key },
            }],
          };
        } else if (command === 'GetConfiguration') {
          wireCommand = 'GetVariables';
          const keys = payload.key?.length ? payload.key : ['HeartbeatInterval'];
          wirePayload = {
            getVariableData: keys.map((key) => ({
              component: { name: 'OCPPCommCtrlr' },
              variable: { name: key },
            })),
          };
        }
      }

      const message = JSON.stringify([2, msgId, wireCommand, wirePayload]);

      console.log(`📤 [${chargePointId}] Sending: ${wireCommand}`);

      pendingRequests.set(msgId, { resolve, reject, chargePointId, command: wireCommand });
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
  function parseBasicAuth(authHeader) {
    if (!authHeader || !authHeader.startsWith('Basic ')) {
      return null;
    }
    const encoded = authHeader.slice('Basic '.length);
    try {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const [username, password] = decoded.split(':');
      return { username, password };
    } catch {
      return null;
    }
  }

  function hasValidAuthHeader(req) {
    if (!AUTH_KEY) {
      return true;
    }
    const headers = req.headers || {};
    const directKey = headers[AUTH_HEADER] || headers[`x-${AUTH_HEADER}`];
    if (typeof directKey === 'string' && directKey === AUTH_KEY) {
      return true;
    }
    if (AUTH_BASIC) {
      const basic = parseBasicAuth(headers.authorization);
      if (basic && basic.password === AUTH_KEY) {
        return true;
      }
    }
    return false;
  }

  function pickProtocol(protocols) {
    if (!REQUIRE_PROTOCOL) {
      for (const p of REQUIRED_PROTOCOLS) {
        if (protocols.has(p)) {
          return p;
        }
      }
      return protocols.values().next().value || null;
    }
    for (const p of REQUIRED_PROTOCOLS) {
      if (protocols.has(p)) {
        return p;
      }
    }
    return false;
  }

  function verifyClient(info) {
    const path = info.req.url || '';
    if (USE_SAME_PORT && !path.startsWith('/ocpp')) {
      return false;
    }
    if (REQUIRE_PROTOCOL) {
      const header = info.req.headers['sec-websocket-protocol'] || '';
      const offered = header
        .split(',')
        .map(p => p.trim())
        .filter(Boolean);
      const hasRequired = offered.some(p => REQUIRED_PROTOCOLS.includes(p));
      if (!hasRequired) {
        return false;
      }
    }
    if (AUTH_KEY && !AUTH_IN_BOOT) {
      return hasValidAuthHeader(info.req);
    }
    return true;
  }

  if (USE_SAME_PORT) {
    // Attach WebSocket server to HTTP server (for App Platform)
    // Use verifyClient to check path starts with /ocpp
    wss = new WebSocketServer({
      server,
      verifyClient,
      handleProtocols: pickProtocol,
    });
    console.log('📡 WebSocket server attached to HTTP server on /ocpp path');
  } else {
    // Separate WebSocket server on different port
    wss = new WebSocketServer({
      host: HOST,
      port: OCPP_PORT,
      verifyClient,
      handleProtocols: pickProtocol,
    });
    console.log(`📡 WebSocket server on separate port: ${OCPP_PORT}`);
  }

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;

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

    const authOkFromHeaders = hasValidAuthHeader(req);
    pendingConnections.set(ws, {
      urlChargePointId,
      connectedAt: new Date(),
      timeout,
      authOk: authOkFromHeaders,
    });

    console.log(`\n⏳ New WebSocket connection (pending registration): ${urlChargePointId} (from ${req.url})\n`);

    ws.on('pong', () => {
      ws.isAlive = true;
    });

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
        if (messageType === 4) {
          if (pendingRequests.has(messageId)) {
            const { reject, command } = pendingRequests.get(messageId);
            pendingRequests.delete(messageId);
            reject(new Error(`${commandOrResponse || 'OCPP error'}: ${payload || 'Request rejected'}`));
          }
          return;
        }

        const command = commandOrResponse;

        // Handle registration on BootNotification or Heartbeat
        if (command === 'BootNotification') {
          if (AUTH_KEY && AUTH_IN_BOOT) {
            const pending = pendingConnections.get(ws);
            const bootKey = payload?.[AUTH_FIELD] || null;
            const authed = pending?.authOk || (bootKey && bootKey === AUTH_KEY);
            if (!authed) {
              const response = { currentTime: new Date().toISOString(), interval: 10, status: 'Rejected' };
              ws.send(JSON.stringify([3, messageId, response]));
              ws.close();
              return;
            }
          }
          // Extract chargePointId from BootNotification payload (authoritative source)
          const payloadChargePointId =
            payload?.chargePointSerialNumber
            || payload?.chargingStation?.serialNumber
            || payload?.chargingStation?.modem?.iccid
            || null;
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

          ws.lastHeartbeatAt = new Date();
          chargerMetadata.set(chargePointId, {
            ...(chargerMetadata.get(chargePointId) || {}),
            lastHeartbeatAt: ws.lastHeartbeatAt.toISOString(),
          });
          schedulePersist();
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
          response = ws.protocol === 'ocpp2.0.1'
            ? { idTokenInfo: { status: 'Accepted' } }
            : { idTagInfo: { status: 'Accepted' } };
        } else if (command === 'DataTransfer') {
          response = createDataTransferResponse(ws.protocol);
          console.log(
            `🪙 [${chargePointId}] Accepted DataTransfer`
            + `${payload?.vendorId ? ` from ${payload.vendorId}` : ''}`
            + `${payload?.messageId ? ` (${payload.messageId})` : ''}`,
          );
        } else if (command === 'StartTransaction') {
          const transactionId = Math.floor(Math.random() * 100000);
          const connectorId = payload?.connectorId || 1;
          // Track active transaction
          activeTransactions.get(chargePointId)?.set(connectorId, transactionId);
          startSession(chargePointId, connectorId, transactionId, {
            idTag: payload?.idTag,
            startedAt: payload?.timestamp,
            meterStartWh: payload?.meterStart,
          });
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
              meterWh: payload?.meterStart ?? currentStatus.meterWh,
              meterStartWh: payload?.meterStart ?? currentStatus.meterStartWh,
              sessionEnergyWh: 0,
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
                endSession(chargePointId, connectorId, transactionId, {
                  meterWh: payload?.meterStop,
                  endedAt: payload?.timestamp,
                  stopReason: payload?.reason,
                });
                txMap.delete(connectorId);
                const currentStatus = statusMap.get(connectorId) || {};
                statusMap.set(connectorId, {
                  ...currentStatus,
                  state: 'Available',
                  transactionId: null,
                  // pluggedIn state inferred from connector state - AVAILABLE without transaction = not plugged in
                  pluggedIn: false,
                  powerW: 0,
                  currentA: 0,
                });
                break;
              }
            }
          }
          response = { idTagInfo: { status: 'Accepted' } };
        } else if (command === 'StatusNotification') {
          // Track connector status from StatusNotification
          const connectorId = payload?.connectorId || payload?.evseId || 1;
          const state = payload?.status || payload?.connectorStatus || 'Unknown';
          const statusMap = connectorStatus.get(chargePointId);
          if (statusMap) {
            const currentStatus = statusMap.get(connectorId) || {};
            const txMap = activeTransactions.get(chargePointId);
            const hasActiveTransaction = txMap?.has(connectorId);
            const displayState = ws.protocol === 'ocpp2.0.1' && hasActiveTransaction && state === 'Occupied'
              ? 'Charging'
              : state;

            // Infer pluggedIn state from connector state
            // PREPARING, CHARGING, SUSPENDED_EV, FINISHING = plugged in
            // AVAILABLE without active transaction = not plugged in
            // AVAILABLE with active transaction = edge case, assume still plugged in until transaction stops
            const isPluggedIn = ['Preparing', 'Charging', 'SuspendedEV', 'Finishing', 'Occupied'].includes(state) ||
              (state === 'Available' && hasActiveTransaction);



            statusMap.set(connectorId, {
              ...currentStatus,
              state: displayState,
              pluggedIn: isPluggedIn,
              errorCode: payload?.errorCode || currentStatus.errorCode,
              timestamp: payload?.timestamp || new Date().toISOString(),
              // Preserve transactionId if it exists
              transactionId: currentStatus.transactionId || (hasActiveTransaction ? txMap.get(connectorId) : null),
            });
            schedulePersist();
          }
          response = {}; // StatusNotification doesn't require a response payload
        } else if (command === 'MeterValues') {
          updateMeterTelemetry(chargePointId, payload?.connectorId || 1, payload);
          response = {};
        } else if (command === 'TransactionEvent') {
          const connectorId = payload?.evse?.connectorId || payload?.evse?.id || 1;
          const transactionId = payload?.transactionInfo?.transactionId || null;
          const eventType = payload?.eventType;
          const statusMap = connectorStatus.get(chargePointId);
          const txMap = activeTransactions.get(chargePointId);

          if (statusMap && txMap) {
            const currentStatus = statusMap.get(connectorId) || {};
            if (eventType === 'Ended') {
              endSession(chargePointId, connectorId, transactionId, {
                endedAt: payload?.timestamp,
                stopReason: payload?.triggerReason,
              });
              txMap.delete(connectorId);
              statusMap.set(connectorId, {
                ...currentStatus,
                state: payload?.transactionInfo?.chargingState || 'Available',
                transactionId: null,
                pluggedIn: false,
              });
            } else if (transactionId) {
              txMap.set(connectorId, transactionId);
              startSession(chargePointId, connectorId, transactionId, {
                idTag: payload?.idToken?.idToken,
                startedAt: payload?.timestamp,
              });
              statusMap.set(connectorId, {
                ...currentStatus,
                state: payload?.transactionInfo?.chargingState || 'Charging',
                transactionId,
                pluggedIn: true,
                idTag: payload?.idToken?.idToken || currentStatus.idTag,
                startedAt: currentStatus.startedAt || payload?.timestamp,
              });
            }
          }
          updateMeterTelemetry(chargePointId, connectorId, payload);
          response = payload?.idToken
            ? { idTokenInfo: { status: 'Accepted' } }
            : {};
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
      unregisterConnection(ws, 'socket closed');
    });
  });

  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        unregisterConnection(ws, 'heartbeat timeout');
        ws.terminate();
        return;
      }

      ws.isAlive = false;
      ws.ping();
    });
  }, WS_PING_INTERVAL_MS);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    persistState();
  });

  function updateMeterTelemetry(chargePointId, connectorId, payload) {
    const statusMap = connectorStatus.get(chargePointId);
    if (!statusMap) return;

    const meterValues = payload?.meterValue || [];
    const latest = meterValues[meterValues.length - 1];
    if (!latest) return;

    const telemetry = {};
    const samples = [];
    for (const sample of latest.sampledValue || []) {
      const value = Number(sample?.value);
      if (!Number.isFinite(value)) continue;
      const measurand = sample?.measurand || 'Energy.Active.Import.Register';
      const unit = sample?.unit || sample?.unitOfMeasure?.unit || '';
      samples.push({
        measurand,
        value,
        unit,
        context: sample?.context || null,
        location: sample?.location || null,
        phase: sample?.phase || null,
      });
      if (measurand === 'Energy.Active.Import.Register') telemetry.meterWh = unit === 'kWh' ? value * 1000 : value;
      if (measurand === 'Power.Active.Import') telemetry.powerW = unit === 'kW' ? value * 1000 : value;
      if (measurand === 'Voltage') telemetry.voltageV = value;
      if (measurand === 'Current.Import') telemetry.currentA = value;
      if (measurand === 'SoC') telemetry.soc = value;
    }

    const currentStatus = statusMap.get(connectorId) || {};
    const meterWh = telemetry.meterWh ?? currentStatus.meterWh;
    statusMap.set(connectorId, {
      ...currentStatus,
      ...telemetry,
      meterValues: samples,
      meterWh,
      sessionEnergyWh: meterWh != null
        ? Math.max(0, meterWh - (currentStatus.meterStartWh ?? meterWh))
        : currentStatus.sessionEnergyWh,
      meterStartWh: currentStatus.meterStartWh ?? meterWh,
      lastMeterValueAt: latest.timestamp || payload?.timestamp || new Date().toISOString(),
    });
    schedulePersist();
    const transactionId = payload?.transactionInfo?.transactionId
      || payload?.transactionId
      || activeTransactions.get(chargePointId)?.get(connectorId);
    updateSession(chargePointId, connectorId, transactionId, {
      ...telemetry,
      meterValues: samples,
      lastMeterValueAt: latest.timestamp || payload?.timestamp || new Date().toISOString(),
    });
  }

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

  function getSessions(filters = {}) {
    const limit = Math.max(1, Math.min(500, Number(filters.limit) || 100));
    return Array.from(sessions.values())
      .filter((session) => !filters.status || session.status.toLowerCase() === String(filters.status).toLowerCase())
      .filter((session) => !filters.chargerId || session.chargerId === filters.chargerId)
      .sort((left, right) => new Date(right.startedAt) - new Date(left.startedAt))
      .slice(0, limit);
  }

  function getChargers() {
    const ids = new Set([
      ...chargerMetadata.keys(),
      ...connectorStatus.keys(),
      ...clients.keys(),
      ...Array.from(sessions.values()).map((session) => session.chargerId),
    ]);
    return Array.from(ids)
      .map((id) => {
        const socket = clients.get(id);
        const metadata = chargerMetadata.get(id) || {};
        return {
          ...metadata,
          id,
          connected: Boolean(socket && socket.readyState === 1),
          connectedAt: socket?.connectedAt || metadata.connectedAt || metadata.lastConnectedAt || null,
          protocol: socket?.protocol || metadata.protocol || 'unknown',
          lastHeartbeatAt: socket?.lastHeartbeatAt || metadata.lastHeartbeatAt || null,
          connectors: getConnectorStatus(id),
        };
      })
      .sort((left, right) => {
        if (left.connected !== right.connected) return left.connected ? -1 : 1;
        return left.id.localeCompare(right.id);
      });
  }

  return {
    wss,
    clients,
    sendCommandToCharger,
    connectorStatus,
    getConnectorStatus,
    getSessions,
    getChargers,
    flushState: persistState,
  };
}
