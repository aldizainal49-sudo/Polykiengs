// ============================================================
// POLYKIENGS - Standalone Wallet Scanner Script
// Run: npm run scan
// ============================================================

import { WalletScanner } from '../modules/walletScanner';
import { Database } from '../utils/database';
import { logger } from '../utils/logger';

async function main() {
  logger.info('🔍 POLYKIENGS - Standalone Wallet Scan');
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const db = new Database('./data/polykiengs.db');
  const scanner = new WalletScanner(db);

  const result = await scanner.scanAllWallets();

  logger.info('');
  logger.info('═══════════════════════════════════════');
  logger.info('  SCAN RESULTS');
  logger.info('═══════════════════════════════════════');
  logger.info(`  Wallets Scanned:  ${result.totalWalletsScanned}`);
  logger.info(`  Trades Analyzed:  ${result.totalTradesAnalyzed}`);
  logger.info(`  Top Traders:      ${result.topTraders.length}`);
  logger.info(`  Duration:         ${(result.scanDuration / 1000).toFixed(1)}s`);
  logger.info('');

  for (const trader of result.topTraders) {
    logger.info(`  🏆 #${trader.rank} | ${trader.wallet.address}`);
    logger.info(`     Win Rate: ${(trader.wallet.winRate * 100).toFixed(1)}% | ROI: ${(trader.wallet.roi * 100).toFixed(1)}%`);
    logger.info(`     Trades: ${trader.wallet.totalTrades} | Edge Score: ${(trader.wallet.edgeScore * 100).toFixed(1)}%`);
    logger.info(`     Pattern: ${trader.patterns.sizingPattern} | Timing: ${trader.patterns.timingPattern}`);
    logger.info(`     Skill-based: ${trader.isSkillBased ? 'YES' : 'NO'}`);
    logger.info('');
  }

  db.close();
}

main().catch(console.error);
