# Digital Ocean Deployment Guide

This guide will help you deploy your CSMS server to Digital Ocean with WebSocket
support.

## Prerequisites

- A Digital Ocean account
- A Droplet (Ubuntu 20.04 or 22.04 recommended)
- SSH access to your Droplet
- A domain name (optional but recommended)

## Step 1: Set Up Your Digital Ocean Droplet

1. Create a new Droplet in Digital Ocean
2. Choose Ubuntu 20.04 or 22.04
3. Select a size (minimum 1GB RAM recommended)
4. Add your SSH key
5. Note your Droplet's IP address

## Step 2: Configure Firewall

On your Digital Ocean Droplet, open the required ports:

```bash
# Allow HTTP (port 3000)
sudo ufw allow 3000/tcp

# Allow WebSocket (port 9220)
sudo ufw allow 9220/tcp

# If using a reverse proxy with HTTPS, also allow:
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Enable firewall
sudo ufw enable
```

## Step 3: Install Node.js

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 18.x (or latest LTS)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Verify installation
node --version
npm --version
```

## Step 4: Install PM2 (Process Manager)

```bash
sudo npm install -g pm2
```

## Step 5: Deploy Your Application

### Option A: Using Git

```bash
# Clone your repository
cd ~
git clone <your-repo-url> csms-server
cd csms-server

# Install dependencies
npm install

# Copy environment file (if needed)
cp .env.example .env
# Edit .env with your settings
nano .env
```

### Option B: Using SCP (from your local machine)

```bash
# From your local machine
scp -r /Users/a/Desktop/csms-server user@your-droplet-ip:~/
ssh user@your-droplet-ip
cd ~/csms-server
npm install
```

## Step 6: Start the Application with PM2

```bash
# Start the application
pm2 start ecosystem.config.js

# Save PM2 configuration
pm2 save

# Set up PM2 to start on boot
pm2 startup
# Follow the instructions it provides
```

## Step 7: Configure Chargers to Connect

Your chargers need to connect to your Digital Ocean server. Update your charger
configuration:

**WebSocket URL:** `ws://YOUR_DROPLET_IP:9220/CHARGE_POINT_ID`

For example:

- If your Droplet IP is `123.45.67.89`
- And your charger ID is `CHARGER_001`
- The WebSocket URL would be: `ws://123.45.67.89:9220/CHARGER_001`

## Step 8: Access Your Dashboard

Open your browser and navigate to:

- `http://YOUR_DROPLET_IP:3000`

## Optional: Set Up Reverse Proxy with Nginx

For production, it's recommended to use Nginx as a reverse proxy:

### Install Nginx

```bash
sudo apt install nginx
```

### Configure Nginx for HTTP API

Create `/etc/nginx/sites-available/csms`:

```nginx
server {
    listen 80;
    server_name your-domain.com;  # or your Droplet IP

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

### Configure Nginx for WebSocket (OCPP)

Add to the same file or create a separate config:

```nginx
# WebSocket proxy for OCPP
server {
    listen 9220;
    server_name your-domain.com;  # or your Droplet IP

    location / {
        proxy_pass http://localhost:9220;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 86400;
    }
}
```

### Enable and Test

```bash
# Enable the site
sudo ln -s /etc/nginx/sites-available/csms /etc/nginx/sites-enabled/

# Test configuration
sudo nginx -t

# Restart Nginx
sudo systemctl restart nginx
```

## Optional: Set Up SSL with Let's Encrypt

For HTTPS and WSS (secure WebSocket):

```bash
# Install Certbot
sudo apt install certbot python3-certbot-nginx

# Get SSL certificate
sudo certbot --nginx -d your-domain.com

# Auto-renewal is set up automatically
```

**Note:** For WSS (secure WebSocket), update your charger configuration to use:

- `wss://your-domain.com:9220/CHARGE_POINT_ID`

## Monitoring

### Check PM2 Status

```bash
pm2 status
pm2 logs csms-server
pm2 monit
```

### Check Application Logs

```bash
# PM2 logs
pm2 logs csms-server

# Or application logs
tail -f ~/csms-server/logs/combined.log
```

## Troubleshooting

### WebSocket Connection Issues

1. **Check firewall:** Ensure port 9220 is open

   ```bash
   sudo ufw status
   ```

2. **Check if server is listening:**

   ```bash
   sudo netstat -tlnp | grep 9220
   ```

3. **Check PM2 logs:**

   ```bash
   pm2 logs csms-server
   ```

4. **Test WebSocket connection:**
   ```bash
   # From your local machine
   wscat -c ws://YOUR_DROPLET_IP:9220/TEST_CHARGER
   ```

### Port Already in Use

If you get "port already in use" error:

```bash
# Find process using the port
sudo lsof -i :9220
sudo lsof -i :3000

# Kill the process if needed
sudo kill -9 <PID>
```

### Restart Application

```bash
pm2 restart csms-server
# or
pm2 reload csms-server  # Zero-downtime reload
```

## Security Considerations

1. **Use a firewall** - Only open necessary ports
2. **Use HTTPS/WSS** - For production, always use SSL
3. **Keep system updated** - Regularly update your server
4. **Use environment variables** - Never commit secrets
5. **Consider VPN** - For extra security, use a VPN for charger connections

## Charger Configuration Example

When configuring your charger, use:

```
Central System URL: ws://YOUR_DROPLET_IP:9220/CHARGE_POINT_ID
```

Or with domain and SSL:

```
Central System URL: wss://your-domain.com:9220/CHARGE_POINT_ID
```

## Support

For issues, check:

- PM2 logs: `pm2 logs csms-server`
- Nginx logs: `sudo tail -f /var/log/nginx/error.log`
- System logs: `sudo journalctl -u nginx`
