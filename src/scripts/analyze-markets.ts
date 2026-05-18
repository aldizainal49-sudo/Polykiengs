// ============================================================
// POLYKIENGS - Standalone Market Analysis Script
// Run: npm run analyze
// ============================================================

import { KellyCriterion } from '../modules/kellyCriterion';
import { MarketAnalyzer } from '../modules/marketAnalyzer';
import { Database } from '../utils/database';
import { logger } from '../utils/logger';
import { config } from '../config';

async function main() {
  logger.info('🔬 POLYKIENGS - Market Analysis');
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const db = new Database('./data/polykiengs.db');
  const kelly = new KellyCriterion(db);
  const analyzer = new MarketAnalyzer(kelly, db);

  // Load saved top traders
  const topTraders = db.getTopTraders();
  if (topTraders.length === 0) {
    logger.warn('⚠️ No top traders found. Run "npm run scan" first!');
    db.close();
    return;
  }

  logger.info(`  Using ${topTraders.length} top traders for analysis`);

  // Find opportunities
  const opportunities = await analyzer.findOpportunities(
    topTraders,
    config.initialBankroll,
    0
  );

  logger.info('');
  logger.info('═══════════════════════════════════════');
  logger.info('  MARKET OPPORTUNITIES');
  logger.info('═══════════════════════════════════════');

  if (opportunities.length === 0) {
    logger.info('  No opportunities meeting criteria at this time.');
  } else {
    for (const opp of opportunities) {
      logger.info(`  📊 Market: ${opp.market}`);
      logger.info(`     Side: ${opp.side} | Price: ${(opp.marketPrice * 100).toFixed(1)}c`);
      logger.info(`     Our Prob: ${(opp.probability * 100).toFixed(1)}% | Edge: ${(opp.edge * 100).toFixed(1)}%`);
      logger.info(`     Kelly: ${(opp.kellyFraction * 100).toFixed(2)}% | Size: $${opp.recommendedSize.toFixed(2)}`);
      logger.info(`     Confidence: ${(opp.confidence * 100).toFixed(1)}% | Traders: ${opp.sourceTraders.length}`);
      logger.info('');
    }
  }

  // Show Kelly learning stats
  const stats = kelly.getStats();
  logger.info('');
  logger.info('🧠 KELLY LEARNING STATUS:');
  logger.info(`  Total Trades: ${stats.totalTrades}`);
  logger.info(`  Win Rate: ${(stats.winRate * 100).toFixed(1)}%`);
  logger.info(`  Kelly Multiplier: ${stats.kellyMultiplier.toFixed(3)}x`);
  logger.info(`  Avg Edge: $${stats.avgEdge.toFixed(4)}`);
  logger.info(`  Best Category: ${stats.bestCategory}`);

  db.close();
}

main().catch(console.error);
