import '../config/env';
import pino, { type Logger } from 'pino';
import { redactMessage } from './async';

function prettyAvailable(): boolean {
  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

function createRootLogger(): Logger {
  const level = process.env.LOG_LEVEL ?? 'info';
  const wantPretty = !['false', '0', 'no', 'off'].includes((process.env.LOG_PRETTY ?? 'true').toLowerCase());
  const isTest = process.env.VITEST !== undefined;

  return pino({
    level: isTest ? process.env.LOG_LEVEL ?? 'silent' : level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    // Never log secrets even if someone passes the whole config object to a log call.
    redact: {
      paths: ['privateKey', '*.privateKey', 'wallet.privateKey', 'apiKey', '*.apiKey', 'telegramBotToken', '*.telegramBotToken', 'passphrase', '*.passphrase', 'password', '*.password', 'secretKey', '*.secretKey', 'jupiter.apiKey', 'headers.authorization', 'headers["x-api-key"]'],
      censor: '[redacted]',
    },
    hooks: {
      logMethod(args, method) {
        method.apply(this, args.map((arg) => typeof arg === 'string' ? redactMessage(arg) : arg) as Parameters<typeof method>);
      },
    },
    transport:
      wantPretty && !isTest && prettyAvailable()
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' } }
        : undefined,
  });
}

export const logger: Logger = createRootLogger();

export function getLogger(component: string): Logger {
  return logger.child({ component });
}
