import './config/env';
import type { Server } from 'node:http';
import { Bot } from './bot';
import { ConfigError, loadConfig } from './config';
import { createApp, startApiServer } from './api/server';
import { openDatabase } from './database/db';
import { errorMessage } from './utils/async';
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
  const bot = new Bot(cfg, db);
  await bot.start();

  let server: Server | null = null;
  if (cfg.api.enabled) {
    if (!cfg.api.apiKey && cfg.api.host !== '127.0.0.1' && cfg.api.host !== 'localhost') {
      logger.warn('API is exposed on a non-local interface without API_KEY – anyone can read your bot data.');
    }
    server = await startApiServer(createApp({ repo: bot.repo, bot, apiKey: cfg.api.apiKey }), cfg.api.host, cfg.api.port);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down…');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    try {
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      await bot.stop();
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
  logger.fatal({ err: errorMessage(error), stack: error.stack }, 'Uncaught exception');
  process.exit(1);
});

main().catch((error) => {
  logger.fatal({ err: errorMessage(error) }, 'Fatal startup error');
  process.exit(1);
});
