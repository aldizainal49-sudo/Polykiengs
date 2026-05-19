// ============================================================
// Minimal Node.js type declarations for sandbox compilation
// These are replaced by @types/node after npm install
// ============================================================

declare namespace NodeJS {
  interface Timeout {}
  interface ProcessEnv {
    [key: string]: string | undefined;
  }
  interface Process {
    env: ProcessEnv;
    exit(code?: number): never;
    on(event: string, listener: (...args: any[]) => void): void;
  }
}

declare var process: NodeJS.Process;
declare var console: {
  log(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
  debug(...args: any[]): void;
};
declare function setInterval(callback: (...args: any[]) => void, ms: number): NodeJS.Timeout;
declare function clearInterval(handle: NodeJS.Timeout): void;
declare function setTimeout(callback: (...args: any[]) => void, ms: number): NodeJS.Timeout;

declare module 'fs' {
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function readFileSync(path: string, encoding: string): string;
  export function writeFileSync(path: string, data: string): void;
  export function appendFileSync(path: string, data: string): void;
}

declare module 'path' {
  export function dirname(p: string): string;
  export function join(...paths: string[]): string;
}

declare module 'crypto' {
  interface Hmac {
    update(data: string): Hmac;
    digest(encoding: string): string;
  }
  export function createHmac(algorithm: string, key: Buffer): Hmac;
}

declare function require(module: string): any;

declare class Buffer {
  static from(data: string, encoding?: string): Buffer;
  toString(encoding?: string): string;
}
