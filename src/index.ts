import './config/env';
import type { Server } from 'node:http';
import { Bot } from './bot';
import { ConfigError, loadConfig } from './config';
import { createApp, startApiServer } from './api/server';
import { openDatabase } from './database/db';
import { JupiterClient } from './jupiter';
import { WalletVault } from './wallet';
import { errorMessage, redactMessage } from './utils/async';
import { logger } from './utils/logger';

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.fatal(error.message);
      process.exit(1);
    }
    throw error;
  }

  if (!cfg.trading.dryRun) {
    logger.warn('LIVE TRADING ENABLED – real SOL will be spent. Use a dedicated wallet with a small balance.');
  } else {
    logger.info('Paper trading mode (DRY_RUN=true) – no transactions will be sent.');
  }

  const db = openDatabase(cfg.database.path);
  const wallet = new WalletVault({
    filePath: cfg.wallet.vaultPath ?? './data/wallet.enc.json',
    unlockTimeoutMs: cfg.wallet.unlockTimeoutMs,
  });
  const jupiter = new JupiterClient({ apiKey: cfg.jupiter?.apiKey });
  const bot = new Bot(cfg, db);
  await bot.start();

  let server: Server | null = null;
  if (cfg.api.enabled) {
    if (!cfg.api.apiKey && cfg.api.host !== '127.0.0.1' && cfg.api.host !== 'localhost') {
      logger.warn('API is exposed on a non-local interface without API_KEY – anyone can read your bot data.');
    }
    server = await startApiServer(createApp({
      repo: bot.repo, bot, apiKey: cfg.api.apiKey, wallet, jupiter,
      allowedHosts: cfg.api.allowedHosts, allowedOrigins: cfg.api.allowedOrigins,
    }), cfg.api.host, cfg.api.port);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    bot.pause();
    logger.info({ signal }, 'Shutting down…');
    const force = setTimeout(() => {
      wallet.lock();
      process.exit(1);
    }, cfg.trading.txConfirmTimeoutMs + 15_000);
    force.unref();
    try {
      const serverClosed = server
        ? new Promise<void>((resolve) => server!.close(() => resolve()))
        : Promise.resolve();
      await bot.stop();
      wallet.lock();
      await serverClosed;
      db.close();
    } catch (error) {
      logger.error({ err: errorMessage(error) }, 'Error during shutdown');
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

process.on('unhandledRejection', (reason) => {
  logger.error({ err: errorMessage(reason) }, 'Unhandled promise rejection');
});
process.on('uncaughtException', (error) => {
  logger.fatal({ err: errorMessage(error), stack: error.stack ? redactMessage(error.stack) : undefined }, 'Uncaught exception');
  process.exit(1);
});

main().catch((error) => {
  logger.fatal({ err: errorMessage(error) }, 'Fatal startup error');
  process.exit(1);
});
