// ============================================================
// POLYKIENGS - Configuration
// ============================================================

import dotenv from 'dotenv';
import { BotConfig } from '../types';

dotenv.config();

export const config: BotConfig = {
  // API Endpoints
  polymarketApiUrl: process.env.POLYMARKET_API_URL || 'https://clob.polymarket.com',
  polygonRpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
  
  // Wallet
  privateKey: process.env.PRIVATE_KEY || '',
  proxyWallet: process.env.PROXY_WALLET || '',
  
  // API Credentials (manual - from py-clob-client or Polymarket UI)
  polyApiKey: process.env.POLY_API_KEY || '',
  polyApiSecret: process.env.POLY_API_SECRET || '',
  polyPassphrase: process.env.POLY_PASSPHRASE || '',
  
  // Scanning - 14,000+ wallets
  maxWalletsToScan: parseInt(process.env.MAX_WALLETS || '14000'),
  scanBatchSize: parseInt(process.env.SCAN_BATCH_SIZE || '100'),
  scanIntervalMinutes: parseInt(process.env.SCAN_INTERVAL || '30'),
  
  // Trading
  initialBankroll: parseFloat(process.env.INITIAL_BANKROLL || '15'),
  maxBetFraction: parseFloat(process.env.MAX_BET_FRACTION || '0.25'), // Quarter-Kelly for safety
  minEdge: parseFloat(process.env.MIN_EDGE || '0.05'), // 5% minimum edge
  minConfidence: parseFloat(process.env.MIN_CONFIDENCE || '0.7'),
  maxConcurrentBets: parseInt(process.env.MAX_CONCURRENT_BETS || '5'),
  
  // Selection criteria
  minWinRate: parseFloat(process.env.MIN_WIN_RATE || '0.60'), // 60%+
  minTrades: parseInt(process.env.MIN_TRADES || '20'),
  topTradersCount: parseInt(process.env.TOP_TRADERS_COUNT || '7'), // Top 7 skilled traders
  
  // Learning
  learningRate: parseFloat(process.env.LEARNING_RATE || '0.01'),
  decayFactor: parseFloat(process.env.DECAY_FACTOR || '0.995'),
};

export function validateConfig(): boolean {
  const errors: string[] = [];
  
  if (!config.privateKey) {
    errors.push('PRIVATE_KEY is required');
  }
  if (!config.proxyWallet) {
    errors.push('PROXY_WALLET is required');
  }
  if (config.initialBankroll <= 0) {
    errors.push('INITIAL_BANKROLL must be positive');
  }
  if (config.minEdge < 0 || config.minEdge > 1) {
    errors.push('MIN_EDGE must be between 0 and 1');
  }
  
  if (errors.length > 0) {
    console.error('Configuration errors:');
    errors.forEach(e => console.error(`  - ${e}`));
    return false;
  }
  
  return true;
}
