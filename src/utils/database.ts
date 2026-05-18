// ============================================================
// POLYKIENGS - Database Utility (JSON file persistence)
// Upgradeable to SQLite/Postgres for production
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { TopTrader, ActiveBet, LearningState, BotState, CompletedTrade } from '../types';
import { logger } from './logger';

interface DatabaseStore {
  topTraders: TopTrader[];
  activeBets: ActiveBet[];
  completedTrades: CompletedTrade[];
  learningState: LearningState | null;
  botState: BotState | null;
  marketCache: Record<string, { data: any; cachedAt: number }>;
  scanHistory: { totalWallets: number; topTradersFound: number; durationMs: number; createdAt: number }[];
}

export class Database {
  private storePath: string;
  private store: DatabaseStore;

  constructor(dbPath: string = './data/polykiengs.json') {
    this.storePath = dbPath;
    this.store = this.loadFromDisk();
    logger.info('📦 Database initialized');
  }

  private loadFromDisk(): DatabaseStore {
    try {
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (fs.existsSync(this.storePath)) {
        const raw = fs.readFileSync(this.storePath, 'utf-8');
        return JSON.parse(raw);
      }
    } catch (err) {
      logger.warn('Could not load database, starting fresh');
    }
    return {
      topTraders: [],
      activeBets: [],
      completedTrades: [],
      learningState: null,
      botState: null,
      marketCache: {},
      scanHistory: [],
    };
  }

  private saveToDisk(): void {
    try {
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.storePath, JSON.stringify(this.store, null, 2));
    } catch (err) {
      logger.error('Failed to save database:', err);
    }
  }

  // ---- Top Traders ----

  saveTopTraders(traders: TopTrader[]): void {
    this.store.topTraders = traders;
    this.saveToDisk();
  }

  getTopTraders(): TopTrader[] {
    return this.store.topTraders;
  }

  // ---- Active Bets ----

  saveActiveBet(bet: ActiveBet): void {
    const idx = this.store.activeBets.findIndex(b => b.id === bet.id);
    if (idx >= 0) {
      this.store.activeBets[idx] = bet;
    } else {
      this.store.activeBets.push(bet);
    }
    this.saveToDisk();
  }

  getActiveBets(): ActiveBet[] {
    return this.store.activeBets;
  }

  removeActiveBet(id: string): void {
    this.store.activeBets = this.store.activeBets.filter(b => b.id !== id);
    this.saveToDisk();
  }

  // ---- Completed Trades ----

  saveCompletedTrade(trade: CompletedTrade): void {
    this.store.completedTrades.push(trade);
    // Keep only last 1000 trades in memory
    if (this.store.completedTrades.length > 1000) {
      this.store.completedTrades = this.store.completedTrades.slice(-1000);
    }
    this.saveToDisk();
  }

  getCompletedTrades(limit: number = 100): CompletedTrade[] {
    return this.store.completedTrades.slice(-limit);
  }

  getTradeStats(): { total: number; wins: number; totalProfit: number } {
    const trades = this.store.completedTrades;
    return {
      total: trades.length,
      wins: trades.filter(t => t.won).length,
      totalProfit: trades.reduce((s, t) => s + t.profit, 0),
    };
  }

  // ---- Learning State ----

  saveLearningState(state: LearningState): void {
    this.store.learningState = state;
    this.saveToDisk();
  }

  getLearningState(): LearningState | null {
    return this.store.learningState;
  }

  // ---- Bot State ----

  saveBotState(state: BotState): void {
    this.store.botState = state;
    this.saveToDisk();
  }

  getBotState(): BotState | null {
    return this.store.botState;
  }

  // ---- Market Cache ----

  cacheMarket(id: string, data: any): void {
    this.store.marketCache[id] = { data, cachedAt: Date.now() };
    this.saveToDisk();
  }

  getCachedMarketIds(): string[] {
    const oneHourAgo = Date.now() - 3600000;
    return Object.entries(this.store.marketCache)
      .filter(([, v]) => v.cachedAt > oneHourAgo)
      .map(([k]) => k);
  }

  // ---- Scan History ----

  saveScanResult(totalWallets: number, topTradersFound: number, durationMs: number): void {
    this.store.scanHistory.push({
      totalWallets,
      topTradersFound,
      durationMs,
      createdAt: Date.now(),
    });
    this.saveToDisk();
  }

  // ---- Cleanup ----

  close(): void {
    this.saveToDisk();
  }
}
