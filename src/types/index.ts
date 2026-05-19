// ============================================================
// POLYKIENGS - Type Definitions
// ============================================================

export interface WalletProfile {
  address: string;
  totalTrades: number;
  winRate: number;
  avgBetSize: number;
  profitLoss: number;
  roi: number;
  marketsTraded: number;
  lastActive: number;
  streak: number;
  kellyScore: number;
  consistency: number; // 0-1, how consistent the wins are
  edgeScore: number; // Composite score: is this skill or luck?
}

export interface TradeRecord {
  id: string;
  wallet: string;
  market: string;
  marketSlug: string;
  outcome: string;
  side: 'YES' | 'NO';
  amount: number;
  price: number;
  timestamp: number;
  resolved: boolean;
  won: boolean | null;
}

export interface MarketData {
  id: string;
  slug: string;
  question: string;
  outcomes: string[];
  outcomePrices: number[];
  volume: number;
  liquidity: number;
  endDate: string;
  active: boolean;
  category: string;
}

export interface TopTrader {
  wallet: WalletProfile;
  trades: TradeRecord[];
  patterns: TraderPattern;
  isSkillBased: boolean; // Statistical test: edge is NOT luck
  rank: number;
}

export interface TraderPattern {
  preferredMarketTypes: string[];
  avgHoldTime: number;
  entryPriceRange: [number, number]; // typically buys between these prices
  sizingPattern: 'fixed' | 'proportional' | 'kelly' | 'irregular';
  timingPattern: 'early' | 'late' | 'mixed';
  winRateByCategory: Record<string, number>;
}

export interface KellyBet {
  market: string;
  side: 'YES' | 'NO';
  probability: number; // our estimated true probability
  marketPrice: number; // current market price
  edge: number; // probability - marketPrice
  kellyFraction: number; // optimal fraction of bankroll
  recommendedSize: number; // in USD
  confidence: number; // 0-1
  sourceTraders: string[]; // wallets that triggered this
}

export interface BotConfig {
  // API
  polymarketApiUrl: string;
  polygonRpcUrl: string;
  
  // Wallet
  privateKey: string;
  proxyWallet: string;
  
  // API Credentials (manual)
  polyApiKey: string;
  polyApiSecret: string;
  polyPassphrase: string;
  
  // Scanning
  maxWalletsToScan: number;
  scanBatchSize: number;
  scanIntervalMinutes: number;
  
  // Trading
  initialBankroll: number;
  maxBetFraction: number; // max Kelly fraction (safety cap)
  minEdge: number; // minimum edge to trade (e.g., 0.05 = 5%)
  minConfidence: number;
  maxConcurrentBets: number;
  
  // Selection
  minWinRate: number;
  minTrades: number;
  topTradersCount: number;
  
  // Learning
  learningRate: number;
  decayFactor: number;
}

export interface BotState {
  bankroll: number;
  activeBets: ActiveBet[];
  totalTrades: number;
  wins: number;
  losses: number;
  totalProfit: number;
  startedAt: number;
  lastScanAt: number;
  topTraders: TopTrader[];
  cycleCount: number;
}

export interface ActiveBet {
  id: string;
  market: string;
  side: 'YES' | 'NO';
  amount: number;
  entryPrice: number;
  timestamp: number;
  kellyFraction: number;
  sourceTraders: string[];
}

export interface ScanResult {
  totalWalletsScanned: number;
  totalTradesAnalyzed: number;
  topTraders: TopTrader[];
  scanDuration: number;
  timestamp: number;
}

export interface LearningState {
  tradeHistory: CompletedTrade[];
  winRateEstimate: number;
  avgEdge: number;
  kellyMultiplier: number; // Adjusts over time (starts conservative)
  marketCategoryPerformance: Record<string, CategoryPerformance>;
}

export interface CompletedTrade {
  id: string;
  market: string;
  side: 'YES' | 'NO';
  amount: number;
  entryPrice: number;
  exitPrice: number;
  won: boolean;
  profit: number;
  timestamp: number;
  kellyFractionUsed: number;
}

export interface CategoryPerformance {
  trades: number;
  wins: number;
  avgProfit: number;
  bestTraders: string[];
}
