# Quick Start: Digital Ocean App Platform Deployment

## What Changed

1. ✅ **Health Check Endpoint** - Added `/health` endpoint required by App Platform
2. ✅ **WebSocket on Same Port** - WebSocket now works on the same port as HTTP (App Platform requirement)
3. ✅ **Configuration Files** - Added `app.yaml` for App Platform deployment

## Quick Deploy Steps

### 1. Update app.yaml

Edit `app.yaml` and change:
- `repo`: Your GitHub repository name
- `branch`: Your deployment branch

### 2. Deploy

```bash
# Install doctl (if not installed)
brew install doctl  # macOS
# or download from: https://github.com/digitalocean/doctl/releases

# Authenticate
doctl auth init

# Deploy
doctl apps create --spec app.yaml
```

### 3. Configure Chargers

After deployment, your app will have a URL like: `https://your-app.ondigitalocean.app`

**WebSocket URL format:**
```
wss://your-app.ondigitalocean.app/ocpp/CHARGE_POINT_ID
```

**Example:**
- App URL: `https://csms-prod.ondigitalocean.app`
- Charger ID: `CHARGER_001`
- WebSocket URL: `wss://csms-prod.ondigitalocean.app/ocpp/CHARGER_001`

### 4. Verify

```bash
# Check health
curl https://your-app.ondigitalocean.app/health

# Check logs
doctl apps logs <app-id>
```

## Important Notes

- **Use `wss://` (not `ws://`)** if your app uses HTTPS
- **WebSocket path is `/ocpp/CHARGE_POINT_ID`** (not just `/CHARGE_POINT_ID`)
- **Health check** must return 200 OK on `/health` endpoint

## Troubleshooting

If health check fails:
1. Check logs: `doctl apps logs <app-id> --type run`
2. Verify `/health` endpoint works locally: `curl http://localhost:3000/health`
3. Make sure `PORT` environment variable is set (App Platform sets this automatically)

For more details, see `APP_PLATFORM_DEPLOY.md`


