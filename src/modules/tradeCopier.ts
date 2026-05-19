// ============================================================
// POLYKIENGS - Trade Copier Module
// Copies high-probability moves from top 7 traders
// Uses proper Polymarket CLOB API authentication (EIP-712)
// ============================================================

import axios from 'axios';
import { JsonRpcProvider, Wallet, Contract, formatUnits } from 'ethers';
import { config } from '../config';
import { KellyBet, ActiveBet, BotState, TopTrader, TradeRecord } from '../types';
import { logger } from '../utils/logger';
import { Database } from '../utils/database';

// Polymarket CTF Exchange on Polygon
const CTF_EXCHANGE_ADDRESS = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
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

// EIP-712 Domain for Polymarket CLOB
const CLOB_DOMAIN = {
  name: 'ClobAuthDomain',
  version: '1',
  chainId: 137, // Polygon
};

// EIP-712 Types for API Key derivation
const CLOB_AUTH_TYPES = {
  ClobAuth: [
    { name: 'address', type: 'address' },
    { name: 'timestamp', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'message', type: 'string' },
  ],
};

export class TradeCopier {
  private provider: JsonRpcProvider;
  private wallet: Wallet;
  private db: Database;
  private apiUrl: string;
  private isExecuting: boolean = false;
  private apiKey: string = '';
  private apiSecret: string = '';
  private apiPassphrase: string = '';
  private hasApprovedUSDC: boolean = false;

  constructor(db: Database) {
    this.db = db;
    this.apiUrl = config.polymarketApiUrl;
    this.provider = new JsonRpcProvider(config.polygonRpcUrl);
    
    // Safety: don't initialize with zero-key
    if (!config.privateKey || config.privateKey === 'your_private_key_here') {
      logger.warn('⚠️ No valid private key configured. Trading disabled.');
      this.wallet = new Wallet('0x' + '1'.repeat(64), this.provider);
    } else {
      this.wallet = new Wallet(config.privateKey, this.provider);
    }
  }

  /**
   * Initialize: load API credentials and approve USDC
   * Must be called once before trading
   */
  async initialize(): Promise<boolean> {
    try {
      // Step 1: Load API credentials from config (manual) or derive
      if (config.polyApiKey && config.polyApiSecret && config.polyPassphrase) {
        // Use manually provided credentials
        this.apiKey = config.polyApiKey;
        this.apiSecret = config.polyApiSecret;
        this.apiPassphrase = config.polyPassphrase;
        logger.info('🔑 API credentials loaded from .env');
      } else {
        // Try to derive API key from wallet signature (EIP-712)
        const apiCreds = await this.deriveApiKey();
        if (!apiCreds) {
          logger.error('❌ No API credentials in .env and auto-derivation failed');
          logger.error('   Please add POLY_API_KEY, POLY_API_SECRET, POLY_PASSPHRASE to .env');
          logger.error('   Generate them using: pip install py-clob-client');
          logger.error('   python3 -c "from py_clob_client.client import ClobClient; c = ClobClient(\'https://clob.polymarket.com\', key=\'YOUR_KEY\', chain_id=137); print(c.derive_api_key())"');
          return false;
        }
        this.apiKey = apiCreds.apiKey;
        this.apiSecret = apiCreds.secret;
        this.apiPassphrase = apiCreds.passphrase;
        logger.info('🔑 API credentials derived from wallet signature');
      }

      // Step 2: Ensure USDC approval for CTF Exchange
      await this.ensureUSDCApproval();

      return true;
    } catch (error) {
      logger.error('Initialization failed:', error);
      return false;
    }
  }

  /**
   * Derive Polymarket API key using EIP-712 typed signature
   */
  private async deriveApiKey(): Promise<{ apiKey: string; secret: string; passphrase: string } | null> {
    try {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const nonce = 0;
      const message = 'This message attests that I control the given wallet';

      // EIP-712 typed data signature
      const signature = await this.wallet.signTypedData(
        CLOB_DOMAIN,
        CLOB_AUTH_TYPES,
        {
          address: this.wallet.address,
          timestamp,
          nonce,
          message,
        }
      );

      // Request API key from Polymarket
      const response = await axios.post(`${this.apiUrl}/auth/derive-api-key`, {
        message,
        timestamp,
        nonce,
        signature,
      }, {
        timeout: 30000,
        headers: { 'Content-Type': 'application/json' },
      });

      return {
        apiKey: response.data.apiKey,
        secret: response.data.secret,
        passphrase: response.data.passphrase,
      };
    } catch (error: any) {
      logger.error(`API key derivation failed: ${error.response?.data?.message || error.message}`);
      return null;
    }
  }

  /**
   * Ensure USDC is approved for CTF Exchange contract
   */
  private async ensureUSDCApproval(): Promise<void> {
    try {
      const usdc = new Contract(USDC_ADDRESS, USDC_ABI, this.wallet);
      const allowance = await usdc.allowance(this.wallet.address, CTF_EXCHANGE_ADDRESS);
      
      // If allowance is less than 1000 USDC, approve max
      const minAllowance = BigInt(1000 * 1e6); // 1000 USDC
      if (BigInt(allowance.toString()) < minAllowance) {
        logger.info('📝 Approving USDC for CTF Exchange...');
        const maxApproval = BigInt('115792089237316195423570985008687907853269984665640564039457584007913129639935');
        const tx = await usdc.approve(CTF_EXCHANGE_ADDRESS, maxApproval);
        await tx.wait();
        logger.info('✅ USDC approved');
      }
      
      this.hasApprovedUSDC = true;
    } catch (error) {
      logger.error('USDC approval failed:', error);
    }
  }

  /**
   * Generate authentication headers for Polymarket CLOB API
   * Uses proper HMAC-SHA256 signing with the API secret
   */
  private generateAuthHeaders(method: string, path: string, body: string = ''): Record<string, string> {
    const crypto = require('crypto');
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const message = timestamp + method.toUpperCase() + path + body;
    
    // HMAC-SHA256 signature using API secret (proper cryptographic signing)
    const hmacSignature = crypto
      .createHmac('sha256', Buffer.from(this.apiSecret, 'base64'))
      .update(message)
      .digest('base64');

    return {
      'POLY_ADDRESS': this.wallet.address,
      'POLY_SIGNATURE': hmacSignature,
      'POLY_TIMESTAMP': timestamp,
      'POLY_NONCE': '0',
      'POLY_API_KEY': this.apiKey,
      'POLY_PASSPHRASE': this.apiPassphrase,
      'Content-Type': 'application/json',
    };
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
        kellyFraction: 0, // Calculated below
        recommendedSize: 0, // Calculated below
        confidence: relevantTraders.length / config.topTradersCount,
        sourceTraders: traderAddresses,
      };

      // Calculate proper Kelly fraction and size
      if (signal.edge >= config.minEdge) {
        const b = (1 - signal.marketPrice) / signal.marketPrice;
        const p = signal.probability;
        const q = 1 - p;
        let kellyFraction = (b * p - q) / b;
        
        // Apply safety multiplier (quarter-Kelly default)
        kellyFraction = kellyFraction * 0.25;
        kellyFraction = Math.min(kellyFraction, config.maxBetFraction);
        
        if (kellyFraction > 0.001) {
          signal.kellyFraction = kellyFraction;
          signal.recommendedSize = Math.round(state.bankroll * kellyFraction * 100) / 100;
          
          if (signal.recommendedSize >= 0.50) {
            copySignals.push(signal);
          }
        }
      }
    }

    return copySignals;
  }

  /**
   * Check the status of active bets and get resolution data
   */
  async checkActiveBets(activeBets: ActiveBet[]): Promise<{
    resolved: ActiveBet[];
    stillActive: ActiveBet[];
    resolutionData: Map<string, { winningOutcome: string; resolvedAt: number }>;
  }> {
    const resolved: ActiveBet[] = [];
    const stillActive: ActiveBet[] = [];
    const resolutionData = new Map<string, { winningOutcome: string; resolvedAt: number }>();

    for (const bet of activeBets) {
      try {
        const response = await axios.get(`${this.apiUrl}/markets/${bet.market}`, {
          timeout: 10000,
        });
        
        const market = response.data;
        if (market.resolved || market.closed) {
          resolved.push(bet);
          
          // Determine winning outcome from market resolution
          // Polymarket returns outcome_prices where winning outcome = 1.0
          const outcomePrices = (market.outcomePrices || market.outcome_prices || [])
            .map((p: string | number) => parseFloat(String(p)));
          const outcomes = market.outcomes || ['Yes', 'No'];
          
          let winningOutcome = 'Unknown';
          if (outcomePrices.length >= 2) {
            // The outcome with price closest to 1.0 after resolution is the winner
            const winIndex = outcomePrices[0] > outcomePrices[1] ? 0 : 1;
            winningOutcome = outcomes[winIndex] || (winIndex === 0 ? 'Yes' : 'No');
          }
          
          resolutionData.set(bet.id, {
            winningOutcome,
            resolvedAt: market.resolved_at ? new Date(market.resolved_at).getTime() : Date.now(),
          });
        } else {
          stillActive.push(bet);
        }
      } catch {
        stillActive.push(bet); // Assume still active if can't check
      }
    }

    return { resolved, stillActive, resolutionData };
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
   * Place order on Polymarket CLOB with proper authentication
   */
  private async placeOrder(bet: KellyBet): Promise<string | null> {
    try {
      if (!this.apiKey) {
        logger.error('API key not initialized. Call initialize() first.');
        return null;
      }

      if (!this.hasApprovedUSDC) {
        logger.error('USDC not approved. Call initialize() first.');
        return null;
      }

      // Build order payload per Polymarket CLOB spec
      const orderPayload = {
        tokenID: bet.market, // Condition token ID
        price: bet.marketPrice.toFixed(2),
        size: bet.recommendedSize.toFixed(2),
        side: 'BUY', // Always BUY (tokenID determines YES/NO outcome)
        feeRateBps: '0',
        nonce: Date.now().toString(),
        expiration: '0', // No expiration (GTC)
        taker: '0x0000000000000000000000000000000000000000',
      };

      const body = JSON.stringify(orderPayload);
      const path = '/order';
      const headers = this.generateAuthHeaders('POST', path, body);

      // Submit to CLOB API
      const response = await axios.post(`${this.apiUrl}${path}`, orderPayload, {
        timeout: 30000,
        headers,
      });

      const orderId = response.data.orderID || response.data.id || response.data.order_id;
      
      if (orderId) {
        logger.info(`  📋 Order placed: ${orderId}`);
        return orderId;
      }

      logger.warn('  ⚠️ Order response missing ID:', response.data);
      return null;
    } catch (error: any) {
      const errMsg = error.response?.data?.message || error.response?.data?.error || error.message;
      logger.error(`Order placement failed: ${errMsg}`);
      
      // Log more details for debugging
      if (error.response?.status === 401) {
        logger.error('  🔒 Authentication error - API key may be expired. Re-deriving...');
        await this.deriveApiKey();
      } else if (error.response?.status === 400) {
        logger.error(`  📋 Bad request details: ${JSON.stringify(error.response?.data)}`);
      }
      
      return null;
    }
  }
}
