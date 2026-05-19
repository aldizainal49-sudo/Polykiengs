# 🚀 Tutorial Deploy Polykiengs ke VPS

## Persyaratan VPS
- **OS:** Ubuntu 20.04+ / Debian 11+
- **RAM:** Minimal 2GB (rekomendasi 4GB untuk scan 14000 wallets)
- **CPU:** 2 core+
- **Storage:** 10GB+
- **Node.js:** v18+

---

## Step 1: Setup VPS

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node -v   # harus v18+
npm -v

# Install git
sudo apt install -y git

# Install pm2 (process manager)
npm install -g pm2
```

---

## Step 2: Clone Repository

```bash
# Clone repo
cd ~
git clone https://github.com/aldizainal49-sudo/Polykiengs.git
cd Polykiengs

# Install dependencies
npm install
```

---

## Step 3: Konfigurasi .env

```bash
# Copy template
cp .env.example .env

# Edit file .env
nano .env
```

Isi `.env` dengan konfigurasi kamu:

```env
# Wallet & API Keys (WAJIB untuk trading)
PRIVATE_KEY=your_polygon_private_key_here
PROXY_WALLET=your_polymarket_proxy_wallet_address

# API Credentials dari Polymarket
POLY_API_KEY=your_api_key
POLY_API_SECRET=your_api_secret
POLY_PASSPHRASE=your_passphrase

# Scanning
MAX_WALLETS=14000
SCAN_BATCH_SIZE=100
SCAN_INTERVAL=30

# Trading
INITIAL_BANKROLL=15
MAX_BET_FRACTION=0.25
MIN_EDGE=0.02
MIN_CONFIDENCE=0.7
MAX_CONCURRENT_BETS=5

# Selection
MIN_WIN_RATE=0.60
MIN_TRADES=20
TOP_TRADERS_COUNT=7
```

Simpan: `Ctrl+X` → `Y` → `Enter`

---

## Step 4: Build & Test

```bash
# Build TypeScript
npm run build

# Test run (manual)
npm start
```

Kalau berhasil, kamu akan lihat:
```
🔍 Starting wallet scan - targeting 14000+ wallets...
📊 Collected XXXX unique wallet addresses
...
```

Tekan `Ctrl+C` untuk stop.

---

## Step 5: Deploy dengan PM2 (Auto-restart)

```bash
# Start dengan PM2
pm2 start npm --name "polykiengs" -- start

# Atau kalau pakai ts-node langsung:
pm2 start npx --name "polykiengs" -- ts-node src/index.ts

# Cek status
pm2 status

# Lihat logs
pm2 logs polykiengs

# Auto-start saat VPS reboot
pm2 startup
pm2 save
```

---

## Step 6: Monitor

```bash
# Lihat logs realtime
pm2 logs polykiengs --lines 50

# Cek resource usage
pm2 monit

# Restart kalau perlu
pm2 restart polykiengs

# Stop
pm2 stop polykiengs
```

---

## Update Code dari GitHub

```bash
cd ~/Polykiengs
git pull origin main
npm install
npm run build
pm2 restart polykiengs
```

---

## Troubleshooting

### Error: "PRIVATE_KEY is required"
→ Pastikan file `.env` sudah diisi dengan private key Polygon wallet kamu.

### Error: "Cannot find module"
→ Jalankan `npm install` lalu `npm run build` lagi.

### Bot stuck / tidak scan
→ Cek logs: `pm2 logs polykiengs --lines 100`
→ Restart: `pm2 restart polykiengs`

### Rate limited oleh Polymarket
→ Kurangi concurrency di code atau tambah delay.

### Memory error (heap out of memory)
→ Tambah memory limit:
```bash
pm2 start npm --name "polykiengs" -- start --node-args="--max-old-space-size=4096"
```

---

## Security Tips

- ⚠️ **JANGAN** commit `.env` ke GitHub (sudah ada di `.gitignore`)
- ⚠️ Gunakan wallet terpisah khusus bot (jangan wallet utama)
- ⚠️ Set firewall: `sudo ufw enable && sudo ufw allow ssh`
- ⚠️ Mulai dengan bankroll kecil ($15) untuk test dulu

---

## Rekomendasi VPS Provider

| Provider | Plan | Harga |
|----------|------|-------|
| DigitalOcean | 2GB/2CPU | $12/bulan |
| Vultr | 2GB/1CPU | $10/bulan |
| Hetzner | 4GB/2CPU | €4.5/bulan |
| Contabo | 4GB/4CPU | €5/bulan |

---

Selesai! Bot akan berjalan 24/7 dan scan wallets setiap 30 menit. 🎯
