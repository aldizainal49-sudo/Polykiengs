// ============================================================
// POLYKIENGS - Trade Copier Module
// Copies high-probability moves from top 7 traders
// ============================================================

import axios from 'axios';
import { JsonRpcProvider, Wallet, Contract, formatUnits } from 'ethers';
import { config } from '../config';
import { KellyBet, ActiveBet, BotState, TopTrader, TradeRecord } from '../types';
import { logger } from '../utils/logger';
import { Database } from '../utils/database';

// Polymarket CTF Exchange ABI (simplified)
const CTF_EXCHANGE_ABI = [
  'function fillOrder((uint256 salt, address maker, address taker, uint256 tokenId, uint256 makerAmount, uint256 takerAmount, uint256 expiration, uint256 nonce, uint256 feeRateBps, uint8 side, uint8 signatureType, bytes signature) order, uint256 fillAmount) external',
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function getOrderStatus(bytes32 orderHash) view returns (bool, uint256)',
];

// USDC on Polygon
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const USDC_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

export class TradeCopier {
  private provider: JsonRpcProvider;
  private wallet: Wallet;
  private db: Database;
  private apiUrl: string;
  private isExecuting: boolean = false;

  constructor(db: Database) {
    this.db = db;
    this.apiUrl = config.polymarketApiUrl;
    this.provider = new JsonRpcProvider(config.polygonRpcUrl);
    this.wallet = new Wallet(config.privateKey || '0x' + '0'.repeat(64), this.provider);
  }

  /**
   * Execute a Kelly-optimized trade
   */
  async executeTrade(bet: KellyBet, state: BotState): Promise<ActiveBet | null> {
    if (this.isExecuting) {
      logger.warn('⚠️ Trade execution already in progress, skipping');
      return null;
    }

    this.isExecuting = true;

    try {
      logger.info(`\n💰 EXECUTING TRADE:`);
      logger.info(`  Market: ${bet.market}`);
      logger.info(`  Side: ${bet.side}`);
      logger.info(`  Size: $${bet.recommendedSize.toFixed(2)}`);
      logger.info(`  Edge: ${(bet.edge * 100).toFixed(1)}%`);
      logger.info(`  Kelly Fraction: ${(bet.kellyFraction * 100).toFixed(2)}%`);
      logger.info(`  Confidence: ${(bet.confidence * 100).toFixed(1)}%`);
      logger.info(`  Source Traders: ${bet.sourceTraders.length}`);

      // Safety checks
      if (!this.safetyCheck(bet, state)) {
        logger.warn('  ❌ Safety check failed, skipping trade');
        return null;
      }

      // Execute via Polymarket CLOB API
      const orderId = await this.placeOrder(bet);
      
      if (!orderId) {
        logger.error('  ❌ Order placement failed');
        return null;
      }

      const activeBet: ActiveBet = {
        id: orderId,
        market: bet.market,
        side: bet.side,
        amount: bet.recommendedSize,
        entryPrice: bet.marketPrice,
        timestamp: Date.now(),
        kellyFraction: bet.kellyFraction,
        sourceTraders: bet.sourceTraders,
      };

      // Save to database
      this.db.saveActiveBet(activeBet);

      logger.info(`  ✅ Trade executed! Order ID: ${orderId}`);
      return activeBet;
    } catch (error) {
      logger.error(`  ❌ Trade execution error:`, error);
      return null;
    } finally {
      this.isExecuting = false;
    }
  }

  /**
   * Monitor and copy trades from top traders in real-time
   */
  async copyTraderMoves(
    traders: TopTrader[],
    newTrades: TradeRecord[],
    state: BotState
  ): Promise<KellyBet[]> {
    const copySignals: KellyBet[] = [];

    // Group new trades by market
    const tradesByMarket = new Map<string, TradeRecord[]>();
    for (const trade of newTrades) {
      const existing = tradesByMarket.get(trade.market) || [];
      existing.push(trade);
      tradesByMarket.set(trade.market, existing);
    }

    for (const [marketId, trades] of tradesByMarket) {
      // Check direction consensus
      const yesTrades = trades.filter(t => t.side === 'YES');
      const noTrades = trades.filter(t => t.side === 'NO');
      
      const dominantSide = yesTrades.length >= noTrades.length ? 'YES' : 'NO';
      const dominantTrades = dominantSide === 'YES' ? yesTrades : noTrades;
      
      if (dominantTrades.length < 2) continue; // Need 2+ traders agreeing

      // Calculate weighted average entry price
      const totalAmount = dominantTrades.reduce((s, t) => s + t.amount, 0);
      const weightedPrice = dominantTrades.reduce((s, t) => s + t.price * t.amount, 0) / totalAmount;

      // Map traders to their profiles for edge scores
      const traderAddresses = dominantTrades.map(t => t.wallet);
      const relevantTraders = traders.filter(t => traderAddresses.includes(t.wallet.address));
      
      // Calculate our probability estimate
      const avgWinRate = relevantTraders.reduce((s, t) => s + t.wallet.winRate, 0) / relevantTraders.length;
      const estimatedProb = weightedPrice + (avgWinRate - 0.5) * 0.2;

      // Construct a Kelly bet signal
      const signal: KellyBet = {
        market: marketId,
        side: dominantSide,
        probability: Math.min(0.95, Math.max(0.05, estimatedProb)),
        marketPrice: weightedPrice,
        edge: estimatedProb - weightedPrice,
        kellyFraction: 0, // Will be calculated
        recommendedSize: 0, // Will be calculated
        confidence: relevantTraders.length / config.topTradersCount,
        sourceTraders: traderAddresses,
      };

      if (signal.edge >= config.minEdge) {
        copySignals.push(signal);
      }
    }

    return copySignals;
  }

  /**
   * Check the status of active bets
   */
  async checkActiveBets(activeBets: ActiveBet[]): Promise<{
    resolved: ActiveBet[];
    stillActive: ActiveBet[];
  }> {
    const resolved: ActiveBet[] = [];
    const stillActive: ActiveBet[] = [];

    for (const bet of activeBets) {
      try {
        const response = await axios.get(`${this.apiUrl}/markets/${bet.market}`, {
          timeout: 10000,
        });
        
        const market = response.data;
        if (market.resolved || market.closed) {
          resolved.push(bet);
        } else {
          stillActive.push(bet);
        }
      } catch {
        stillActive.push(bet); // Assume still active if can't check
      }
    }

    return { resolved, stillActive };
  }

  /**
   * Get current USDC balance
   */
  async getBalance(): Promise<number> {
    try {
      const usdc = new Contract(USDC_ADDRESS, USDC_ABI, this.provider);
      const balance = await usdc.balanceOf(this.wallet.address);
      return parseFloat(formatUnits(balance, 6));
    } catch (error) {
      logger.error('Failed to get balance:', error);
      return 0;
    }
  }

  // ---- Private Methods ----

  /**
   * Safety checks before executing a trade
   */
  private safetyCheck(bet: KellyBet, state: BotState): boolean {
    // Check 1: Don't exceed max concurrent bets
    if (state.activeBets.length >= config.maxConcurrentBets) {
      logger.warn('  Max concurrent bets reached');
      return false;
    }

    // Check 2: Don't bet more than max fraction of bankroll
    if (bet.recommendedSize > state.bankroll * config.maxBetFraction) {
      logger.warn('  Bet exceeds max fraction of bankroll');
      return false;
    }

    // Check 3: Don't bet if it would deplete bankroll below safety threshold
    const totalExposure = state.activeBets.reduce((s, b) => s + b.amount, 0) + bet.recommendedSize;
    if (totalExposure > state.bankroll * 0.8) { // Keep 20% reserve
      logger.warn('  Total exposure would exceed 80% of bankroll');
      return false;
    }

    // Check 4: Don't double-up on same market
    const existingBet = state.activeBets.find(b => b.market === bet.market);
    if (existingBet) {
      logger.warn('  Already have active bet in this market');
      return false;
    }

    // Check 5: Minimum bet size
    if (bet.recommendedSize < 0.50) {
      logger.warn('  Bet size below minimum ($0.50)');
      return false;
    }

    return true;
  }

  /**
   * Place order on Polymarket CLOB
   */
  private async placeOrder(bet: KellyBet): Promise<string | null> {
    try {
      // Create order payload for Polymarket API
      const orderPayload = {
        market: bet.market,
        side: bet.side,
        size: bet.recommendedSize.toString(),
        price: bet.marketPrice.toString(),
        type: 'GTC', // Good-till-cancelled
      };

      // Sign the order
      const message = JSON.stringify(orderPayload);
      const signature = await this.wallet.signMessage(message);

      // Submit to CLOB API
      const response = await axios.post(`${this.apiUrl}/order`, {
        ...orderPayload,
        signature,
        owner: this.wallet.address,
      }, {
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json',
        },
      });

      return response.data.orderID || response.data.id || null;
    } catch (error: any) {
      logger.error(`Order placement failed: ${error.response?.data?.message || error.message}`);
      return null;
    }
  }
}
