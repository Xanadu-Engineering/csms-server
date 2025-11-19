# Digital Ocean App Platform Deployment Guide

This guide will help you deploy your CSMS server to Digital Ocean App Platform.

## Important: WebSocket Configuration

Digital Ocean App Platform typically only exposes one port per service. This deployment configures WebSocket to run on the same port as HTTP using the `/ocpp` path prefix.

**WebSocket URL format:** `ws://your-app-url/ocpp/CHARGE_POINT_ID`

## Step 1: Update app.yaml

1. Edit `app.yaml` and update:
   - `repo`: Your GitHub repository
   - `branch`: Your deployment branch (usually `main` or `dev`)
   - `region`: Your preferred region
   - `instance_size_slug`: Adjust based on your needs

## Step 2: Deploy via Digital Ocean CLI

### Install doctl

```bash
# macOS
brew install doctl

# Linux
cd ~
wget https://github.com/digitalocean/doctl/releases/download/v1.94.0/doctl-1.94.0-linux-amd64.tar.gz
tar xf doctl-1.94.0-linux-amd64.tar.gz
sudo mv doctl /usr/local/bin
```

### Authenticate

```bash
doctl auth init
```

### Deploy

```bash
# From your project directory
doctl apps create --spec app.yaml
```

Or deploy from GitHub:

```bash
# Create app from GitHub repo
doctl apps create --spec app.yaml --repo your-username/csms-server --branch main
```

## Step 3: Configure Environment Variables

In the Digital Ocean App Platform dashboard:

1. Go to your app → Settings → App-Level Environment Variables
2. Add or verify these variables:
   - `NODE_ENV`: `production`
   - `PORT`: `8080` (App Platform sets this automatically, but you can override)
   - `USE_SAME_PORT`: `true` (enables WebSocket on same port)
   - `HOST`: `0.0.0.0`

## Step 4: Health Check Configuration

The health check is configured in `app.yaml`:
- **Path**: `/health`
- **Initial Delay**: 10 seconds
- **Period**: 10 seconds
- **Timeout**: 5 seconds

The `/health` endpoint returns:
```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "uptime": 123.45
}
```

## Step 5: Configure Your Chargers

Once deployed, your app will have a URL like: `https://your-app-name.ondigitalocean.app`

**For HTTP/HTTPS:**
- Dashboard: `https://your-app-name.ondigitalocean.app`
- API: `https://your-app-name.ondigitalocean.app/api/chargers`

**For WebSocket (OCPP):**
- **If using HTTP (ws):** `ws://your-app-name.ondigitalocean.app/ocpp/CHARGE_POINT_ID`
- **If using HTTPS (wss):** `wss://your-app-name.ondigitalocean.app/ocpp/CHARGE_POINT_ID`

**Important:** Use `wss://` (secure WebSocket) if your app uses HTTPS.

### Example Charger Configuration

If your app URL is `https://csms-prod.ondigitalocean.app` and your charger ID is `CHARGER_001`:

```
Central System URL: wss://csms-prod.ondigitalocean.app/ocpp/CHARGER_001
```

## Step 6: Verify Deployment

1. **Check health endpoint:**
   ```bash
   curl https://your-app-name.ondigitalocean.app/health
   ```

2. **Check logs:**
   ```bash
   doctl apps logs <app-id>
   ```

3. **View in dashboard:**
   - Go to Digital Ocean App Platform
   - Click on your app
   - Check the "Runtime Logs" tab

## Troubleshooting

### Health Check Failing

1. **Check if server is starting:**
   ```bash
   doctl apps logs <app-id> --type run
   ```

2. **Verify PORT environment variable:**
   - App Platform sets `PORT` automatically
   - Make sure your code uses `process.env.PORT`

3. **Check health endpoint locally:**
   ```bash
   # Test locally first
   npm start
   curl http://localhost:3000/health
   ```

### WebSocket Connection Issues

1. **Verify WebSocket path:**
   - Must use `/ocpp/CHARGE_POINT_ID` format
   - Not `/CHARGE_POINT_ID` when using same port

2. **Check if using wss:// for HTTPS:**
   - If your app uses HTTPS, you MUST use `wss://`
   - `ws://` will not work over HTTPS

3. **Test WebSocket connection:**
   ```bash
   # Install wscat
   npm install -g wscat
   
   # Test connection
   wscat -c wss://your-app-name.ondigitalocean.app/ocpp/TEST_CHARGER
   ```

### Build Failures

1. **Check build logs:**
   ```bash
   doctl apps logs <app-id> --type build
   ```

2. **Verify Node.js version:**
   - App Platform uses the version specified in `package.json` or `app.yaml`
   - Ensure compatibility with Node.js 18+

3. **Check dependencies:**
   - Make sure all dependencies are in `package.json`
   - Run `npm install` locally to verify

### Port Configuration Issues

If you see port binding errors:

1. **Verify HOST is set to 0.0.0.0:**
   ```yaml
   envs:
     - key: HOST
       value: "0.0.0.0"
   ```

2. **Check PORT is being used:**
   - App Platform sets `PORT` automatically
   - Don't hardcode port numbers

## Alternative: Using Separate WebSocket Port

If you need a separate WebSocket port, you'll need to:

1. Create a separate service in `app.yaml` for WebSocket
2. Set `USE_SAME_PORT=false`
3. Configure `OCPP_PORT` environment variable

However, this requires App Platform to support multiple ports, which may not be available in all plans.

## Monitoring

### View Logs

```bash
# All logs
doctl apps logs <app-id>

# Runtime logs only
doctl apps logs <app-id> --type run

# Build logs
doctl apps logs <app-id> --type build

# Follow logs
doctl apps logs <app-id> --follow
```

### Check App Status

```bash
doctl apps get <app-id>
```

### View Metrics

In the Digital Ocean dashboard:
- Go to your app
- Click on "Metrics" tab
- View CPU, Memory, Request rates, etc.

## Updating Your App

### Via CLI

```bash
# Update app spec
doctl apps update <app-id> --spec app.yaml
```

### Via GitHub (Automatic)

If you configured GitHub integration:
1. Push to your configured branch
2. App Platform will automatically deploy

### Manual Deploy

```bash
# Create a new deployment
doctl apps create-deployment <app-id>
```

## Environment-Specific Configuration

You can create different `app.yaml` files for different environments:

- `app.prod.yaml` - Production
- `app.staging.yaml` - Staging
- `app.dev.yaml` - Development

Deploy with:
```bash
doctl apps create --spec app.prod.yaml
```

## Security Considerations

1. **Use HTTPS/WSS:** Always use secure connections in production
2. **Environment Variables:** Never commit secrets to git
3. **Health Checks:** Keep health check endpoint simple and fast
4. **Rate Limiting:** Consider adding rate limiting for production
5. **CORS:** Configure CORS if needed for your frontend

## Support

For issues:
- Check Digital Ocean App Platform documentation
- Review application logs
- Test locally first with `npm start`
- Verify environment variables are set correctly


