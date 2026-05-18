// ============================================================
// POLYKIENGS - Logger Utility
// Lightweight logger (upgradeable to Winston for production)
// ============================================================

import * as fs from 'fs';
import * as path from 'path';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

class Logger {
  private logDir: string = './logs';

  constructor() {
    try {
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }
    } catch {
      // Silently continue if logs dir can't be created
    }
  }

  private format(level: LogLevel, message: string): string {
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
  }

  private writeToFile(message: string): void {
    try {
      const logFile = path.join(this.logDir, 'combined.log');
      fs.appendFileSync(logFile, message + '\n');
    } catch {
      // Silent fail for file logging
    }
  }

  info(message: string, ...args: any[]): void {
    const formatted = this.format('info', message);
    console.log(formatted, ...args);
    this.writeToFile(formatted);
  }

  warn(message: string, ...args: any[]): void {
    const formatted = this.format('warn', message);
    console.warn(formatted, ...args);
    this.writeToFile(formatted);
  }

  error(message: string, ...args: any[]): void {
    const formatted = this.format('error', message);
    console.error(formatted, ...args);
    try {
      const errorFile = path.join(this.logDir, 'error.log');
      fs.appendFileSync(errorFile, formatted + ' ' + args.map(a => JSON.stringify(a)).join(' ') + '\n');
    } catch {
      // Silent fail
    }
  }

  debug(message: string, ...args: any[]): void {
    if (process.env.DEBUG === 'true') {
      const formatted = this.format('debug', message);
      console.debug(formatted, ...args);
    }
  }
}

export const logger = new Logger();
