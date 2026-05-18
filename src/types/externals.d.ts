// ============================================================
// POLYKIENGS - External Module Declarations
// These satisfy TypeScript when node_modules aren't installed
// Remove this file after running `npm install`
// ============================================================

declare module 'dotenv' {
  export function config(options?: any): void;
}

declare module 'axios' {
  interface AxiosResponse<T = any> {
    data: T;
    status: number;
    statusText: string;
  }
  interface AxiosRequestConfig {
    params?: any;
    timeout?: number;
    headers?: Record<string, string>;
  }
  interface AxiosStatic {
    get<T = any>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>;
    post<T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>;
  }
  const axios: AxiosStatic;
  export default axios;
}

declare module 'ethers' {
  export class JsonRpcProvider {
    constructor(url: string);
  }
  export class Wallet {
    address: string;
    constructor(privateKey: string, provider?: JsonRpcProvider);
    signMessage(message: string): Promise<string>;
  }
  export class Contract {
    constructor(address: string, abi: any[], providerOrSigner: any);
    balanceOf(address: string): Promise<bigint>;
  }
  export function formatUnits(value: bigint, decimals: number): string;
}

declare module 'p-limit' {
  type LimitFunction = <T>(fn: () => Promise<T>) => Promise<T>;
  function pLimit(concurrency: number): LimitFunction;
  export default pLimit;
}
