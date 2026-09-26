# Deploying on DigitalOcean (step by step)

These steps take about 30 minutes. You need a domain you control (for example `yourstore.com`) so the app can
have an HTTPS address like `ship.yourstore.com`.

## 1. Create the droplet

- **Region:** Bangalore (BLR1)
- **Image:** Ubuntu 24.04 (LTS) x64
- **Plan:** Basic → Regular → **$6/mo (1 vCPU, 1 GB RAM, 25 GB SSD)**. You can resize later if needed.
- **Authentication:** a password is simplest; an SSH key is more secure.
- Create it, then copy the droplet's **public IPv4 address**.

Optional: under *Networking → Reserved IPs*, assign a reserved IP to the droplet. It's free while it is
attached to a droplet, and the IP then stays the same even if you rebuild the droplet. If you do this, use the
reserved IP in the steps below, and give it (not the droplet's own IP) to India Post.

## 2. Point a subdomain at it

At your domain provider (GoDaddy, Hostinger, Cloudflare, …), add a DNS record:

| Type | Name | Value |
| --- | --- | --- |
| A | `ship` | the droplet (or reserved) IP |

If you use Cloudflare, set this record to **DNS only** (grey cloud) so the HTTPS certificate can be issued.

## 3. Upload the app and run the setup script

From your computer, in the folder that contains `indiapost-shopify-app.zip`:

```bash
scp indiapost-shopify-app.zip root@<droplet-ip>:/root/
ssh root@<droplet-ip>
```

Then, on the server:

```bash
apt-get update && apt-get install -y unzip
unzip -o indiapost-shopify-app.zip
cd indiapost-shopify-app
sudo bash deploy/setup.sh ship.yourstore.com
```

The script installs Node.js 22 and Caddy (a web server that sets up HTTPS certificates automatically). It then
installs the app as a service that restarts on its own, and turns on the firewall. At the end it prints:

- the server's **public IP**, which you give to India Post for whitelisting
- your **India Post webhook URL**, which you also send to India Post

## 4. Create the Shopify app and add its keys

1. In the Shopify Partner Dashboard (or Dev Dashboard), create an app and copy its **Client ID** and
   **Client secret**.
2. On the server:
   ```bash
   sudo nano /etc/indiapost-app.env      # fill SHOPIFY_API_KEY and SHOPIFY_API_SECRET, save
   sudo systemctl restart indiapost-app
   ```
3. Open `https://ship.yourstore.com/health` in a browser. It should show `{"ok":true}`.

## 5. Push the Shopify configuration (from your computer)

In the unzipped app folder on your computer:

1. Edit `shopify.app.toml`:
   - `client_id` = your Client ID
   - replace every `https://your-app.example.com` with `https://ship.yourstore.com`
2. Run:
   ```bash
   npm install -g @shopify/cli
   npm install
   shopify app deploy
   ```
3. Install the app on your store from the Partner Dashboard, open it, and fill in **Settings**.

## Updating the app later

Upload the new zip, unzip it over the old folder, and run the same command again:

```bash
cd indiapost-shopify-app && sudo bash deploy/setup.sh ship.yourstore.com
```

Your settings (`/etc/indiapost-app.env`), the database and the saved labels (`/var/lib/indiapost-app`) are kept.

## Useful commands

| What | Command |
| --- | --- |
| Is it running? | `sudo systemctl status indiapost-app` |
| Live logs | `sudo journalctl -u indiapost-app -f` |
| Restart | `sudo systemctl restart indiapost-app` |
| Back up data | `sudo tar czf backup.tgz /var/lib/indiapost-app /etc/indiapost-app.env` |

You can also turn on DigitalOcean's weekly droplet **Backups** for about 20% of the droplet price.
