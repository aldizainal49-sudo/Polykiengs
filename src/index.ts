// ============================================================
//
//   ██████╗  ██████╗ ██╗  ██╗   ██╗██╗  ██╗██╗███████╗███╗   ██╗ ██████╗ ███████╗
//   ██╔══██╗██╔═══██╗██║  ╚██╗ ██╔╝██║ ██╔╝██║██╔════╝████╗  ██║██╔════╝ ██╔════╝
//   ██████╔╝██║   ██║██║   ╚████╔╝ █████╔╝ ██║█████╗  ██╔██╗ ██║██║  ███╗███████╗
//   ██╔═══╝ ██║   ██║██║    ╚██╔╝  ██╔═██╗ ██║██╔══╝  ██║╚██╗██║██║   ██║╚════██║
//   ██║     ╚██████╔╝███████╗██║   ██║  ██╗██║███████╗██║ ╚████║╚██████╔╝███████║
//   ╚═╝      ╚═════╝ ╚══════╝╚═╝   ╚═╝  ╚═╝╚═╝╚══════╝╚═╝  ╚═══╝ ╚═════╝ ╚══════╝
//
//   Polymarket Trading Bot with Kelly Criterion
//   Scans 14,000+ wallets | Detects winning patterns | Copies high-probability moves
//
// ============================================================

import { config, validateConfig } from './config';
import { WalletScanner } from './modules/walletScanner';
import { KellyCriterion } from './modules/kellyCriterion';
import { MarketAnalyzer } from './modules/marketAnalyzer';
import { TradeCopier } from './modules/tradeCopier';
import { Database } from './utils/database';
import { logger } from './utils/logger';
import { BotState, TopTrader, KellyBet, CompletedTrade } from './types';

class Polykiengs {
  private db: Database;
  private scanner: WalletScanner;
  private kelly: KellyCriterion;
  private analyzer: MarketAnalyzer;
  private copier: TradeCopier;
  private state: BotState;
  private isRunning: boolean = false;
  private cycleInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Initialize database
    this.db = new Database('./data/polykiengs.db');

    // Initialize modules
    this.scanner = new WalletScanner(this.db);
    this.kelly = new KellyCriterion(this.db);
    this.analyzer = new MarketAnalyzer(this.kelly, this.db);
    this.copier = new TradeCopier(this.db);

    // Load or initialize state
    this.state = this.loadState();
  }

  /**
   * MAIN: Start the Polykiengs bot
   */
  async start(): Promise<void> {
    logger.info('');
    logger.info('═══════════════════════════════════════════════════════════');
    logger.info('  🚀 POLYKIENGS - Starting...');
    logger.info('═══════════════════════════════════════════════════════════');
    logger.info('');

    // Validate configuration
    if (!validateConfig()) {
      logger.error('❌ Invalid configuration. Check your .env file.');
      process.exit(1);
    }

    this.isRunning = true;
    logger.info(`💰 Starting bankroll: $${this.state.bankroll.toFixed(2)}`);
    logger.info(`📊 Total trades so far: ${this.state.totalTrades}`);
    logger.info(`🎯 Win rate: ${this.state.totalTrades > 0 ? ((this.state.wins / this.state.totalTrades) * 100).toFixed(1) : 0}%`);
    logger.info(`📈 Total profit: $${this.state.totalProfit.toFixed(2)}`);
    logger.info('');

    // Phase 1: Initial wallet scan
    await this.runWalletScan();

    // Phase 2: Start main trading loop
    this.startTradingLoop();

    // Graceful shutdown
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());

    logger.info('');
    logger.info('═══════════════════════════════════════════════════════════');
    logger.info('  ✅ POLYKIENGS is LIVE and running');
    logger.info(`  📡 Monitoring ${config.topTradersCount} top traders`);
    logger.info(`  ⏰ Scan interval: ${config.scanIntervalMinutes} minutes`);
    logger.info('═══════════════════════════════════════════════════════════');
    logger.info('');
  }

  /**
   * Run wallet scan cycle
   */
  private async runWalletScan(): Promise<void> {
    try {
      logger.info('');
      logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      logger.info('  🔍 WALLET SCAN CYCLE');
      logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      const scanResult = await this.scanner.scanAllWallets();
      
      this.state.topTraders = scanResult.topTraders;
      this.state.lastScanAt = Date.now();
      
      // Log top traders found
      logger.info('');
      logger.info('🏆 TOP TRADERS IDENTIFIED:');
      for (const trader of scanResult.topTraders) {
        logger.info(
          `  #${trader.rank} | ${trader.wallet.address.slice(0, 10)}... | ` +
          `Win Rate: ${(trader.wallet.winRate * 100).toFixed(1)}% | ` +
          `ROI: ${(trader.wallet.roi * 100).toFixed(1)}% | ` +
          `Trades: ${trader.wallet.totalTrades} | ` +
          `Edge: ${(trader.wallet.edgeScore * 100).toFixed(1)}% | ` +
          `Pattern: ${trader.patterns.sizingPattern}`
        );
      }
      logger.info('');

      this.saveState();
    } catch (error) {
      logger.error('Wallet scan failed:', error);
    }
  }

  /**
   * Main trading loop - runs continuously
   */
  private startTradingLoop(): void {
    // Immediate first analysis
    this.tradingCycle();

    // Then run every scan interval
    this.cycleInterval = setInterval(async () => {
      this.state.cycleCount++;
      
      // Re-scan wallets periodically
      if (this.state.cycleCount % 3 === 0) { // Every 3rd cycle
        await this.runWalletScan();
      }

      await this.tradingCycle();
    }, config.scanIntervalMinutes * 60 * 1000);
  }

  /**
   * Single trading cycle
   */
  private async tradingCycle(): Promise<void> {
    if (!this.isRunning || this.state.topTraders.length === 0) return;

    try {
      logger.info('');
      logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      logger.info(`  📊 TRADING CYCLE #${this.state.cycleCount}`);
      logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      // Step 1: Check status of active bets
      await this.checkActiveBets();

      // Step 2: Monitor real-time trades from top traders
      const newTrades = await this.analyzer.monitorRealtime(this.state.topTraders);
      
      if (newTrades.length > 0) {
        logger.info(`  🔔 ${newTrades.length} new trades detected from top traders`);
        
        // Step 3: Generate copy signals
        const copySignals = await this.copier.copyTraderMoves(
          this.state.topTraders,
          newTrades,
          this.state
        );

        // Step 4: Also run full market analysis
        const opportunities = await this.analyzer.findOpportunities(
          this.state.topTraders,
          this.state.bankroll,
          this.state.activeBets.length
        );

        // Combine signals
        const allSignals = [...copySignals, ...opportunities];

        // Step 5: Execute best trades
        await this.executeSignals(allSignals);
      } else {
        // No new trades - just analyze market opportunities
        const opportunities = await this.analyzer.findOpportunities(
          this.state.topTraders,
          this.state.bankroll,
          this.state.activeBets.length
        );

        if (opportunities.length > 0) {
          await this.executeSignals(opportunities);
        } else {
          logger.info('  ⏳ No opportunities meeting criteria. Waiting...');
        }
      }

      // Step 6: Update and display stats
      this.displayStats();
      this.saveState();

    } catch (error) {
      logger.error('Trading cycle error:', error);
    }
  }

  /**
   * Execute trading signals
   */
  private async executeSignals(signals: KellyBet[]): Promise<void> {
    // Sort by edge * confidence (best opportunities first)
    const sorted = signals.sort((a, b) => 
      (b.edge * b.confidence) - (a.edge * a.confidence)
    );

    for (const signal of sorted) {
      // Check if we can still trade
      if (this.state.activeBets.length >= config.maxConcurrentBets) {
        logger.info('  🛑 Max concurrent bets reached. Pausing execution.');
        break;
      }

      const activeBet = await this.copier.executeTrade(signal, this.state);
      if (activeBet) {
        this.state.activeBets.push(activeBet);
        this.state.bankroll -= activeBet.amount;
        this.state.totalTrades++;
        logger.info(`  📈 Bankroll: $${this.state.bankroll.toFixed(2)} (after bet)`);
      }
    }
  }

  /**
   * Check and resolve active bets
   */
  private async checkActiveBets(): Promise<void> {
    if (this.state.activeBets.length === 0) return;

    const { resolved, stillActive } = await this.copier.checkActiveBets(this.state.activeBets);
    
    for (const bet of resolved) {
      // Determine win/loss (simplified - would check actual resolution)
      const won = Math.random() > 0.4; // Placeholder until real resolution check
      const profit = won ? bet.amount * (1 / bet.entryPrice - 1) : -bet.amount;

      // Update state
      if (won) {
        this.state.wins++;
        this.state.bankroll += bet.amount + profit;
      }
      this.state.totalProfit += profit;

      // Record for Kelly learning
      const completedTrade: CompletedTrade = {
        id: bet.id,
        market: bet.market,
        side: bet.side,
        amount: bet.amount,
        entryPrice: bet.entryPrice,
        exitPrice: won ? 1 : 0,
        won,
        profit,
        timestamp: Date.now(),
        kellyFractionUsed: bet.kellyFraction,
      };

      this.kelly.recordTradeResult(completedTrade);
      this.db.saveCompletedTrade(completedTrade);
      this.db.removeActiveBet(bet.id);

      logger.info(
        `  ${won ? '✅ WIN' : '❌ LOSS'} | Market: ${bet.market.slice(0, 15)}... | ` +
        `P/L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}`
      );
    }

    this.state.activeBets = stillActive;
    this.state.losses = this.state.totalTrades - this.state.wins;
  }

  /**
   * Display current bot statistics
   */
  private displayStats(): void {
    const kellyStats = this.kelly.getStats();
    const runtime = (Date.now() - this.state.startedAt) / (1000 * 60 * 60); // hours

    logger.info('');
    logger.info('┌─────────────────────────────────────────┐');
    logger.info('│         POLYKIENGS STATUS                │');
    logger.info('├─────────────────────────────────────────┤');
    logger.info(`│  💰 Bankroll:     $${this.state.bankroll.toFixed(2).padStart(10)}`);
    logger.info(`│  📈 Total P/L:    $${this.state.totalProfit.toFixed(2).padStart(10)}`);
    logger.info(`│  🎯 Win Rate:     ${this.state.totalTrades > 0 ? ((this.state.wins / this.state.totalTrades) * 100).toFixed(1) : '0.0'}%`);
    logger.info(`│  📊 Trades:       ${this.state.totalTrades} (${this.state.wins}W / ${this.state.losses}L)`);
    logger.info(`│  🔥 Active Bets:  ${this.state.activeBets.length}/${config.maxConcurrentBets}`);
    logger.info(`│  🧠 Kelly Multi:  ${kellyStats.kellyMultiplier.toFixed(3)}x`);
    logger.info(`│  ⏱️  Runtime:      ${runtime.toFixed(1)}h`);
    logger.info(`│  🔄 Cycle:        #${this.state.cycleCount}`);
    logger.info('└─────────────────────────────────────────┘');
    logger.info('');
  }

  /**
   * Load bot state from database
   */
  private loadState(): BotState {
    const saved = this.db.getBotState();
    if (saved) return saved;

    return {
      bankroll: config.initialBankroll,
      activeBets: [],
      totalTrades: 0,
      wins: 0,
      losses: 0,
      totalProfit: 0,
      startedAt: Date.now(),
      lastScanAt: 0,
      topTraders: [],
      cycleCount: 0,
    };
  }

  /**
   * Save bot state to database
   */
  private saveState(): void {
    this.db.saveBotState(this.state);
  }

  /**
   * Graceful shutdown
   */
  private shutdown(): void {
    logger.info('');
    logger.info('🛑 Shutting down Polykiengs...');
    this.isRunning = false;
    
    if (this.cycleInterval) {
      clearInterval(this.cycleInterval);
    }

    this.saveState();
    this.db.close();
    
    logger.info('💾 State saved. Goodbye!');
    process.exit(0);
  }
}

// ============================================================
// ENTRY POINT
// ============================================================

async function main() {
  try {
    const bot = new Polykiengs();
    await bot.start();
  } catch (error) {
    logger.error('Fatal error:', error);
    process.exit(1);
  }
}

main();
