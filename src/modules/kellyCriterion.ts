// ============================================================
// POLYKIENGS - Kelly Criterion Module
// Self-improving position sizing that gets smarter over time
// ============================================================

import { config } from '../config';
import { KellyBet, LearningState, CompletedTrade, BotState, TopTrader } from '../types';
import { logger } from '../utils/logger';
import { Database } from '../utils/database';

export class KellyCriterion {
  private learningState: LearningState;
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.learningState = this.loadLearningState();
  }

  /**
   * Calculate optimal bet size using Kelly Criterion
   * Kelly formula: f* = (bp - q) / b
   * where:
   *   f* = fraction of bankroll to bet
   *   b  = odds received on the bet (net odds)
   *   p  = probability of winning
   *   q  = probability of losing (1 - p)
   */
  calculateKellyBet(
    estimatedProbability: number,
    marketPrice: number,
    bankroll: number,
    sourceTraders: string[]
  ): KellyBet | null {
    // Edge = our probability - market price
    const edge = estimatedProbability - marketPrice;

    // Only bet when we have significant edge
    if (edge < config.minEdge) {
      return null;
    }

    // Net odds: if we pay `marketPrice`, we receive 1 if we win
    // So net odds b = (1 - marketPrice) / marketPrice
    const b = (1 - marketPrice) / marketPrice;
    const p = estimatedProbability;
    const q = 1 - p;

    // Full Kelly fraction
    let kellyFraction = (b * p - q) / b;

    // Apply safety: use fraction Kelly (quarter or half)
    kellyFraction = kellyFraction * this.learningState.kellyMultiplier;

    // Cap at max bet fraction
    kellyFraction = Math.min(kellyFraction, config.maxBetFraction);

    // Don't bet negative or tiny amounts
    if (kellyFraction <= 0.001) {
      return null;
    }

    const recommendedSize = bankroll * kellyFraction;

    // Confidence based on trader agreement and historical accuracy
    const confidence = this.calculateConfidence(estimatedProbability, sourceTraders);

    if (confidence < 0.3) {
      return null; // Relaxed from config.minConfidence (0.7) since we often have 1-2 traders
    }

    return {
      market: '', // filled by caller
      side: estimatedProbability > 0.5 ? 'YES' : 'NO',
      probability: estimatedProbability,
      marketPrice,
      edge,
      kellyFraction,
      recommendedSize: Math.round(recommendedSize * 100) / 100,
      confidence,
      sourceTraders,
    };
  }

  /**
   * Calculate aggregate probability from multiple top traders' positions
   * Weighted by each trader's historical accuracy
   */
  aggregateProbability(
    traders: TopTrader[],
    marketId: string,
    currentPrice: number
  ): { probability: number; confidence: number; side: 'YES' | 'NO' } | null {
    let weightedSum = 0;
    let totalWeight = 0;
    let yesVotes = 0;
    let noVotes = 0;

    for (const trader of traders) {
      // Find this trader's position in this market (match by market ID or any recent trades)
      const relevantTrades = trader.trades.filter(
        t => t.market === marketId
      );

      if (relevantTrades.length === 0) continue;

      // Weight by trader's edge score and consistency
      const weight = trader.wallet.edgeScore * trader.wallet.consistency;
      
      // Get their latest position
      const latestTrade = relevantTrades[relevantTrades.length - 1];
      
      if (latestTrade.side === 'YES') {
        yesVotes++;
        // Their implied probability = price they paid (adjusted for their edge)
        const impliedProb = Math.min(0.99, latestTrade.price + (trader.wallet.winRate - 0.5) * 0.3);
        weightedSum += impliedProb * weight;
      } else {
        noVotes++;
        // NO side: trader bought NO token at `latestTrade.price`
        // This implies they believe YES probability = 1 - price_they_paid
        const impliedYesProb = Math.max(0.01, (1 - latestTrade.price) - (trader.wallet.winRate - 0.5) * 0.3);
        weightedSum += impliedYesProb * weight;
      }
      
      totalWeight += weight;
    }

    if (totalWeight === 0 || (yesVotes + noVotes) < 1) {
      return null; // Need at least 1 trader with a position
    }

    const aggregatedProb = weightedSum / totalWeight;
    const side = yesVotes > noVotes ? 'YES' : 'NO';
    const probability = side === 'YES' ? aggregatedProb : (1 - aggregatedProb);
    
    // Confidence increases with more traders agreeing
    const agreement = Math.max(yesVotes, noVotes) / (yesVotes + noVotes);
    const confidence = agreement * Math.min(1, (yesVotes + noVotes) / config.topTradersCount);

    return { probability, confidence, side };
  }

  /**
   * LEARNING: Update Kelly multiplier based on trade results
   * The bot gets smarter the more it trades
   */
  recordTradeResult(trade: CompletedTrade): void {
    this.learningState.tradeHistory.push(trade);
    
    // Update running stats
    const totalTrades = this.learningState.tradeHistory.length;
    const wins = this.learningState.tradeHistory.filter(t => t.won).length;
    this.learningState.winRateEstimate = wins / totalTrades;
    
    // Update average edge
    const recentTrades = this.learningState.tradeHistory.slice(-50);
    const avgProfit = recentTrades.reduce((s, t) => s + t.profit, 0) / recentTrades.length;
    this.learningState.avgEdge = avgProfit;

    // Adaptive Kelly multiplier
    // If we're winning: gradually increase toward full Kelly
    // If we're losing: reduce exposure
    if (trade.won) {
      this.learningState.kellyMultiplier = Math.min(
        1.0, // Never exceed full Kelly
        this.learningState.kellyMultiplier + config.learningRate
      );
    } else {
      this.learningState.kellyMultiplier = Math.max(
        0.1, // Never go below 10% Kelly
        this.learningState.kellyMultiplier * config.decayFactor
      );
    }

    // Update category performance
    this.updateCategoryPerformance(trade);

    // Persist learning state
    this.saveLearningState();

    logger.info(
      `📚 Learning updated: Kelly multiplier = ${this.learningState.kellyMultiplier.toFixed(3)} | ` +
      `Win rate = ${(this.learningState.winRateEstimate * 100).toFixed(1)}% | ` +
      `Avg edge = $${this.learningState.avgEdge.toFixed(2)}`
    );
  }

  /**
   * Get optimal bankroll allocation across multiple bets
   * Simultaneous Kelly: reduce individual bets when multiple active
   */
  optimizePortfolio(bets: KellyBet[], bankroll: number, activeBetsCount: number): KellyBet[] {
    if (bets.length === 0) return [];

    // Reduce Kelly fraction for simultaneous bets
    const diversificationFactor = 1 / Math.sqrt(activeBetsCount + bets.length);
    
    return bets
      .sort((a, b) => b.edge * b.confidence - a.edge * a.confidence) // Best opportunities first
      .slice(0, config.maxConcurrentBets - activeBetsCount) // Don't exceed max
      .map(bet => ({
        ...bet,
        kellyFraction: bet.kellyFraction * diversificationFactor,
        recommendedSize: Math.round(bankroll * bet.kellyFraction * diversificationFactor * 100) / 100,
      }))
      .filter(bet => bet.recommendedSize >= 0.50); // Minimum bet size
  }

  /**
   * Get current learning statistics
   */
  getStats(): {
    totalTrades: number;
    winRate: number;
    kellyMultiplier: number;
    avgEdge: number;
    bestCategory: string;
  } {
    const categories = Object.entries(this.learningState.marketCategoryPerformance);
    const bestCategory = categories.length > 0
      ? categories.sort((a, b) => b[1].avgProfit - a[1].avgProfit)[0][0]
      : 'none';

    return {
      totalTrades: this.learningState.tradeHistory.length,
      winRate: this.learningState.winRateEstimate,
      kellyMultiplier: this.learningState.kellyMultiplier,
      avgEdge: this.learningState.avgEdge,
      bestCategory,
    };
  }

  // ---- Private helpers ----

  private calculateConfidence(probability: number, sourceTraders: string[]): number {
    // More source traders = higher confidence
    const traderConfidence = Math.min(1, sourceTraders.length / config.topTradersCount);
    
    // Stronger probability signals = higher confidence
    const signalStrength = Math.abs(probability - 0.5) * 2;
    
    // Historical performance boost
    const historicalBoost = this.learningState.winRateEstimate > 0.6 ? 0.1 : 0;
    
    return Math.min(1, traderConfidence * 0.4 + signalStrength * 0.4 + historicalBoost + 0.2);
  }

  private updateCategoryPerformance(trade: CompletedTrade): void {
    const category = 'general'; // Would extract from market data
    const perf = this.learningState.marketCategoryPerformance[category] || {
      trades: 0,
      wins: 0,
      avgProfit: 0,
      bestTraders: [],
    };

    perf.trades++;
    if (trade.won) perf.wins++;
    perf.avgProfit = (perf.avgProfit * (perf.trades - 1) + trade.profit) / perf.trades;
    
    this.learningState.marketCategoryPerformance[category] = perf;
  }

  private loadLearningState(): LearningState {
    const saved = this.db.getLearningState();
    if (saved) return saved;
    
    // Default: start conservative (quarter Kelly)
    return {
      tradeHistory: [],
      winRateEstimate: 0.5,
      avgEdge: 0,
      kellyMultiplier: 0.25, // Start at quarter Kelly
      marketCategoryPerformance: {},
    };
  }

  private saveLearningState(): void {
    this.db.saveLearningState(this.learningState);
  }
}
