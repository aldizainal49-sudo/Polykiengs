# POLYKIENGS

```
██████╗  ██████╗ ██╗  ██╗   ██╗██╗  ██╗██╗███████╗███╗   ██╗ ██████╗ ███████╗
██╔══██╗██╔═══██╗██║  ╚██╗ ██╔╝██║ ██╔╝██║██╔════╝████╗  ██║██╔════╝ ██╔════╝
██████╔╝██║   ██║██║   ╚████╔╝ █████╔╝ ██║█████╗  ██╔██╗ ██║██║  ███╗███████╗
██╔═══╝ ██║   ██║██║    ╚██╔╝  ██╔═██╗ ██║██╔══╝  ██║╚██╗██║██║   ██║╚════██║
██║     ╚██████╔╝███████╗██║   ██║  ██╗██║███████╗██║ ╚████║╚██████╔╝███████║
╚═╝      ╚═════╝ ╚══════╝╚═╝   ╚═╝  ╚═╝╚═╝╚══════╝╚═╝  ╚═══╝ ╚═════╝ ╚══════╝
```

**Advanced Polymarket Trading Bot with Self-Improving Kelly Criterion**

---

## Features

- **14,000+ Wallet Scanner** - Memindai lebih dari 14.000 dompet dalam hitungan menit
- **Pattern Detection** - Mendeteksi pola-pola pemenang dan menyilangkan referensi tingkat kemenangan
- **Kelly Criterion** - Semakin sering trading, semakin pintar (self-improving)
- **High-Probability Copy** - Menyalin hanya gerakan dengan probabilitas tinggi
- **Skill vs Luck Filter** - Mengidentifikasi 7 trader yang keunggulannya bukan keberuntungan
- **VPS Ready** - Berjalan 24/7, terus belajar dan beradaptasi

## How It Works

```
$15 → $2,000+ (realistic target with compound Kelly growth)

1. SCAN:     14,000+ wallets analyzed in minutes
2. FILTER:   Statistical tests separate SKILL from LUCK
3. SELECT:   Top 7 traders identified (99% confidence level)
4. ANALYZE:  Cross-reference win rates, bet size patterns
5. COPY:     Execute high-probability trades with Kelly sizing
6. LEARN:    Every trade makes the bot smarter
```

## Quick Start

### 1. Install

```bash
git clone https://github.com/your-repo/polykiengs.git
cd polykiengs
npm install
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env with your private key and settings
```

### 3. Run

```bash
# Build
npm run build

# Start bot
npm start

# Or run individual components:
npm run scan      # Scan wallets only
npm run analyze   # Analyze markets only
```

### 4. VPS Deployment

```bash
# Using PM2 for process management
npm install -g pm2
npm run build
pm2 start dist/index.js --name polykiengs
pm2 save
pm2 startup
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `INITIAL_BANKROLL` | 15 | Starting capital ($) |
| `MAX_WALLETS` | 14000 | Wallets to scan |
| `TOP_TRADERS_COUNT` | 7 | Top traders to follow |
| `MIN_WIN_RATE` | 0.60 | Minimum win rate (60%) |
| `MIN_EDGE` | 0.05 | Minimum edge to trade (5%) |
| `MAX_BET_FRACTION` | 0.25 | Max Kelly fraction (quarter-Kelly) |
| `SCAN_INTERVAL` | 30 | Minutes between scans |
| `MAX_CONCURRENT_BETS` | 5 | Max simultaneous bets |

## Architecture

```
src/
├── index.ts              # Main bot orchestrator
├── config/
│   └── index.ts          # Configuration management
├── types/
│   └── index.ts          # TypeScript interfaces
├── modules/
│   ├── walletScanner.ts  # 14K+ wallet scanning engine
│   ├── kellyCriterion.ts # Self-improving position sizing
│   ├── marketAnalyzer.ts # Market opportunity detection
│   └── tradeCopier.ts    # Trade execution engine
├── utils/
│   ├── database.ts       # SQLite persistence layer
│   └── logger.ts         # Logging system
└── scripts/
    ├── scan-wallets.ts   # Standalone scanner
    └── analyze-markets.ts # Standalone analyzer
```

## Kelly Criterion - Self-Improving

The bot starts with **Quarter-Kelly** (conservative) and automatically adjusts:

- **Winning trades** → Kelly multiplier increases (toward full Kelly)
- **Losing trades** → Kelly multiplier decreases (more conservative)
- **More data** → Better probability estimates
- **VPS runtime** → Continuous learning and adaptation

This means: **the longer it runs, the smarter it gets.**

## Risk Management

- Never bets more than 25% of bankroll on single trade
- Keeps 20% bankroll in reserve at all times
- Maximum 5 concurrent bets
- Minimum 5% edge required
- Minimum 70% confidence required
- Diversification factor for simultaneous bets
- No doubling up on same market

## Trader Selection (Skill vs Luck)

Uses statistical z-test with 99% confidence to ensure:
1. Win rate significantly above random (50%)
2. Consistent across time periods (not streaky luck)
3. Diverse market success (not lucky in just one market)
4. Minimum 20 resolved trades for sample size

---

**DISCLAIMER**: Trading involves risk. This bot is for educational purposes. Never trade more than you can afford to lose.
