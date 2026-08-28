# CSMS Server

Lightweight CSMS dashboard and OCPP WebSocket server for monitoring and
controlling connected chargers, with protocol negotiation that prefers OCPP
2.0.1 and also accepts OCPP 1.6 subprotocols.

## Features

- Live list of connected chargers.
- Per-connector state, plug status, and active transaction visibility.
- Live energy, power, voltage, current, state-of-charge, and heartbeat data on
  the dashboard.
- Dashboard home showing available chargers, with global Sessions and Events
  navigation. Opening a charger provides charger-level stats, live connector
  components, controls, filtered sessions, meter values, and its activity
  timeline.
- Protocol-neutral active and completed session tracking for OCPP 1.6 and
  OCPP 2.0.1 transactions.
- Per-connector charger meter values and a bounded history of the latest 120
  OCPP meter readings for each charging session.
- Durable recovery of known chargers, connector state, active/completed
  sessions, and meter history across CSMS restarts.
- Browser refresh recovery for the selected charger and active dashboard view;
  restored chargers remain visibly offline until their OCPP socket reconnects.
- Native OCPP 2.0.1 `TransactionEvent` telemetry with backward-compatible OCPP
  1.6 `MeterValues` handling.
- Remote OCPP commands:
  - `RemoteStartTransaction`
  - `RemoteStopTransaction`
  - `UnlockConnector`
  - `Reset`
  - `ChangeConfiguration`
  - `GetConfiguration`
  - `InstallCertificate`
  - Protocol-aware translation to OCPP 2.0.1 `RequestStartTransaction`,
    `RequestStopTransaction`, `SetVariables`, and `GetVariables`.
- Automatic WebSocket liveness checks to remove stale charger sessions after
  unclean disconnects.
- Certificate installation UI backed by PEM files stored in `csms-server/cert`.

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
- `OCPP_PROTOCOLS` - comma-separated subprotocol priority list. Defaults to
  `ocpp2.0.1,ocpp1.6,ocpp1.6j`.
- `CSMS_STATE_FILE` - durable state snapshot path. Defaults to
  `data/csms-state.json`; set to `:memory:` to disable persistence.
- `OCPP_CUSTOM_BALANCE` - mock balance returned to proprietary charger
  `DataTransfer` requests. Defaults to `1000000`; set to `off` to accept the
  request without returning balance data.
- `OCPP_DATA_TRANSFER_BALANCE_FIELD` - vendor-specific balance property name
  used in the `DataTransfer` response. Defaults to `custom_balance`.

The mock balance is a vendor extension, not a standard OCPP authorization
field. OCPP 1.6 receives it as a JSON-encoded string while OCPP 2.0.1 receives
it as a JSON object. Confirm the field name and response shape against the
charging-station vendor's integration specification.

## API

- `GET /api/chargers` - list connected chargers
- `GET /api/chargers/:id` - get charger details
- `GET /api/chargers/:id/connectors` - list connector state for a charger
- `GET /api/chargers/:id/connectors/:connectorId` - get one connector
- `GET /api/sessions` - list active and completed charging sessions; optional
  `status`, `chargerId`, and `limit` query filters are supported
- `POST /api/chargers/:id/remote-start` - start charging on a connector
- `POST /api/chargers/:id/remote-stop` - stop an active transaction
- `POST /api/chargers/:id/unlock` - unlock a connector
- `POST /api/chargers/:id/reset` - send a reset command
- `POST /api/chargers/:id/change-configuration` - update configuration
- `POST /api/chargers/:id/get-configuration` - fetch configuration
- `POST /api/chargers/:id/install-certificate` - send OCPP 2.0.1
  `InstallCertificate`
- `GET /api/certificates` - list certificate files available from `cert/`

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
- `InstallCertificate` reads PEM/CRT/CER files from `csms-server/cert` and
  defaults to installing `chain.pem` as `CSMSRootCertificate` when available.
