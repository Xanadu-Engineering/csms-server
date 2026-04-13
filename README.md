# CSMS Server - Charging Station Management System

Dashboard interface for monitoring and controlling OCPP charging stations.

## Features

- 📊 Live statistics of connected chargers
- 📡 Real-time charger list (auto-refresh every 5 seconds)
- 🔍 Detailed charger information
- 🎮 Remote control capabilities:
  - Start/Stop charging transactions
  - Unlock connectors
  - Reset chargers
  - Manage configuration
- 📋 Response log for all commands

## Installation

```bash
npm install
cp .env.example .env
```

## Usage

```bash
npm start
```

Open your browser to [http://localhost:3000](http://localhost:3000)

**Prerequisites:** Make sure the Central System is running on port 9221.

## API Endpoints

The CSMS server provides a proxy to the Central System HTTP API:

- `GET /api/chargers` - List all connected chargers
- `GET /api/chargers/:id` - Get charger details
- `POST /api/chargers/:id/remote-start` - Start charging
- `POST /api/chargers/:id/remote-stop` - Stop charging
- `POST /api/chargers/:id/unlock` - Unlock connector
- `POST /api/chargers/:id/reset` - Reset charger
- `POST /api/chargers/:id/change-configuration` - Change configuration
- `POST /api/chargers/:id/get-configuration` - Get configuration

## Configuration

The server connects to the Central System API at `http://localhost:9221/api` by
default.

To change this, edit `src/server.js`:

```javascript
const CENTRAL_SYSTEM_API = "http://localhost:9221/api"
```

## Technology Stack

- **Express** - Web server
- **Axios** - HTTP client for API calls
- **Pure JavaScript** - No frontend framework, lightweight UI
