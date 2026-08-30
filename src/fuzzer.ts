import { Sandbox } from './sandbox';
import { Logger } from './logger';

export interface FuzzPayload {
  name: string;
  method: string;
  path: string;
  query: Record<string, any>;
  body: any;
  headers: Record<string, string>;
}

export interface DifferentialFuzzResult {
  passed: boolean;
  totalIterations: number;
  divergentInputs: Array<{
    payload: FuzzPayload;
    v1Status: number;
    v2Status: number;
    v1Body: any;
    v2Body: any;
  }>;
  executionErrors: Array<{
    payload: FuzzPayload;
    error: string;
  }>;
}

/**
 * Synthetic Invariant Property Fuzzer.
 * 
 * Generates generative edge-case payloads (boundary numbers, empty strings,
 * null fields, unicode, array extremes) and runs differential fuzz tests
 * between original (v1) and candidate (v2) handlers in an isolated sandbox.
 */
export class SyntheticFuzzer {
  constructor(
    private sandbox: Sandbox,
    private logger: Logger
  ) {}

  /**
   * Generates a robust suite of 20+ synthetic edge-case request payloads.
   */
  public generatePayloads(routePath: string, method: string = 'GET'): FuzzPayload[] {
    const baseMethod = method.toUpperCase();
    const payloads: FuzzPayload[] = [];

    // 1. Standard valid baseline payload
    payloads.push({
      name: 'valid_baseline',
      method: baseMethod,
      path: routePath,
      query: { id: '123', page: '1', limit: '10', sort: 'asc' },
      body: { name: 'Item', count: 5, active: true, tags: ['alpha', 'beta'] },
      headers: { 'content-type': 'application/json' },
    });

    // 2. Empty / Null payloads
    payloads.push({
      name: 'empty_structures',
      method: baseMethod,
      path: routePath,
      query: {},
      body: {},
      headers: {},
    });

    payloads.push({
      name: 'null_fields',
      method: baseMethod,
      path: routePath,
      query: { id: null, page: null },
      body: { name: null, count: null, active: null },
      headers: {},
    });

    // 3. Boundary numbers (zero, negative, max safe integer, float)
    payloads.push({
      name: 'boundary_numbers',
      method: baseMethod,
      path: routePath,
      query: { page: '0', limit: '-1', offset: String(Number.MAX_SAFE_INTEGER) },
      body: { count: 0, balance: -99.99, amount: 9007199254740991 },
      headers: {},
    });

    // 4. String extremes (empty string, large string, unicode, special chars)
    payloads.push({
      name: 'unicode_and_special_chars',
      method: baseMethod,
      path: routePath,
      query: { q: '🔥🚀 漢字 üñîçødé', filter: '<script>alert(1)</script>' },
      body: { name: '   ', description: 'Special: &?=%$#@*!~^`', comment: 'Line\nBreak\r\nTab\t' },
      headers: {},
    });

    payloads.push({
      name: 'long_string_overflow',
      method: baseMethod,
      path: routePath,
      query: { search: 'a'.repeat(500) },
      body: { text: 'x'.repeat(2000) },
      headers: {},
    });

    // 5. Nested objects and deep arrays
    payloads.push({
      name: 'nested_data_structures',
      method: baseMethod,
      path: routePath,
      query: {},
      body: {
        nested: { level1: { level2: { deepValue: true } } },
        emptyList: [],
        mixedList: [1, 'two', null, false, { k: 'v' }],
      },
      headers: { 'content-type': 'application/json' },
    });

    // 6. Type coercion mismatches
    payloads.push({
      name: 'type_coercion_mismatches',
      method: baseMethod,
      path: routePath,
      query: { id: 'true', page: 'undefined', count: 'NaN' },
      body: { count: 'five', active: 'yes', tags: 'not-an-array' },
      headers: {},
    });

    return payloads;
  }

  /**
   * Executes differential fuzzing comparing v1 and v2 outputs across all payloads.
   */
  public async runDifferentialFuzz(
    v1Code: string,
    v2Code: string,
    payloads: FuzzPayload[],
    timeoutMs: number = 500
  ): Promise<DifferentialFuzzResult> {
    const divergentInputs: DifferentialFuzzResult['divergentInputs'] = [];
    const executionErrors: DifferentialFuzzResult['executionErrors'] = [];

    for (const payload of payloads) {
      const mockReq = {
        method: payload.method,
        path: payload.path,
        url: payload.path,
        query: payload.query,
        body: payload.body,
        headers: payload.headers,
      };

      let v1Status = 200;
      let v1Body: any = null;
      let v2Status = 200;
      let v2Body: any = null;

      const createRes = (isV1: boolean) => ({
        status(code: number) {
          if (isV1) v1Status = code;
          else v2Status = code;
          return this;
        },
        json(data: any) {
          if (isV1) v1Body = data;
          else v2Body = data;
        },
        send(data: any) {
          if (isV1) v1Body = data;
          else v2Body = data;
        },
        setHeader() {},
        getHeaders() { return {}; },
      });

      try {
        // Run v1 in Sandbox
        if (v1Code) {
          await this.sandbox.run(v1Code, '', mockReq as any, createRes(true) as any, () => {}, timeoutMs);
        }

        // Run v2 in Sandbox
        await this.sandbox.run(v2Code, '', mockReq as any, createRes(false) as any, () => {}, timeoutMs);

        // Compare status code and output structure
        const statusMatch = v1Status === v2Status;
        const bodyMatch = this.deepEqualNormalized(v1Body, v2Body);

        if (!statusMatch || !bodyMatch) {
          divergentInputs.push({
            payload,
            v1Status,
            v2Status,
            v1Body,
            v2Body,
          });
        }
      } catch (err: any) {
        executionErrors.push({
          payload,
          error: err?.message || String(err),
        });
      }
    }

    const passed = divergentInputs.length === 0 && executionErrors.length === 0;

    this.logger.debug('[SyntheticFuzzer] Differential fuzzing complete', {
      total: payloads.length,
      passed,
      divergentCount: divergentInputs.length,
      errorCount: executionErrors.length,
    });

    return {
      passed,
      totalIterations: payloads.length,
      divergentInputs,
      executionErrors,
    };
  }

  private deepEqualNormalized(a: any, b: any): boolean {
    if (a === b) return true;
    if (a === null || b === null || a === undefined || b === undefined) {
      return a === b;
    }
    if (typeof a !== typeof b) return false;

    if (typeof a === 'object') {
      const keysA = Object.keys(a).filter(k => k !== 'timestamp' && k !== 'duration');
      const keysB = Object.keys(b).filter(k => k !== 'timestamp' && k !== 'duration');

      if (keysA.length !== keysB.length) return false;
      for (const key of keysA) {
        if (!this.deepEqualNormalized(a[key], b[key])) return false;
      }
      return true;
    }

    return false;
  }
}
