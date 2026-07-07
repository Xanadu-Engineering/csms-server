# CSMS Server

Lightweight CSMS dashboard and OCPP 1.6 WebSocket server for monitoring and
controlling connected chargers.

## Features

- Live list of connected chargers.
- Per-connector state, plug status, and active transaction visibility.
- Remote OCPP commands:
  - `RemoteStartTransaction`
  - `RemoteStopTransaction`
  - `UnlockConnector`
  - `Reset`
  - `ChangeConfiguration`
  - `GetConfiguration`
- Automatic WebSocket liveness checks to remove stale charger sessions after
  unclean disconnects.

## Requirements

- Node.js 18+
- npm

## Run locally

```bash
npm install
npm start
```

By default the HTTP dashboard runs on `http://localhost:3020`.

## Configuration

Environment variables:

- `PORT` - HTTP port for the dashboard and, when `USE_SAME_PORT=true`, OCPP
  WebSocket traffic.
- `HOST` - bind address. Defaults to `0.0.0.0`.
- `USE_SAME_PORT` - set to `true` to expose OCPP on `/ocpp/:chargePointId`
  through the same HTTP server.
- `OCPP_PORT` - separate WebSocket port when `USE_SAME_PORT=false`.
- `WS_URL` - optional public WebSocket base URL shown in logs.
- `WS_PING_INTERVAL_MS` - heartbeat interval used to detect stale charger
  sockets. Defaults to `15000`.

## API

- `GET /api/chargers` - list connected chargers
- `GET /api/chargers/:id` - get charger details
- `GET /api/chargers/:id/connectors` - list connector state for a charger
- `GET /api/chargers/:id/connectors/:connectorId` - get one connector
- `POST /api/chargers/:id/remote-start` - start charging on a connector
- `POST /api/chargers/:id/remote-stop` - stop an active transaction
- `POST /api/chargers/:id/unlock` - unlock a connector
- `POST /api/chargers/:id/reset` - send a reset command
- `POST /api/chargers/:id/change-configuration` - update configuration
- `POST /api/chargers/:id/get-configuration` - fetch configuration

`POST /api/chargers/:id/remote-stop` accepts either:

- `transactionId`
- `connectorId`

If neither is provided and exactly one active transaction exists, the server
will stop that transaction automatically.

## Notes

- Connector state remains available after disconnect so the dashboard can show
  the most recent charger status when the charger reconnects.
- The control panel resolves remote stop requests from live connector state, so
  users do not need to manually copy transaction IDs from the dashboard.
