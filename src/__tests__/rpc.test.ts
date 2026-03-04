/**
 * Tests for rpc.ts — JSON-RPC protocol types and parsing
 *
 * These tests verify:
 * 1. Valid request parsing (file mode, inline mode, status)
 * 2. Error handling for invalid JSON and missing fields
 * 3. Response helper functions (success and error)
 */

import { describe, it, expect } from 'vitest';
import {
  parseRpcRequest,
  isErrorResponse,
  successResponse,
  errorResponse,
} from '../rpc.js';

describe('parseRpcRequest', () => {
  it('should parse valid encrypt request (file mode)', () => {
    const line = '{"id":1,"method":"encrypt","params":{"input_file":"/tmp/test.txt","output_file":"/tmp/test.enc"}}';
    const result = parseRpcRequest(line);
    expect(isErrorResponse(result)).toBe(false);
    if (!isErrorResponse(result)) {
      expect(result.id).toBe(1);
      expect(result.method).toBe('encrypt');
      expect(result.params?.input_file).toBe('/tmp/test.txt');
    }
  });

  it('should parse valid encrypt request (inline mode)', () => {
    const line = '{"id":"abc","method":"encrypt","params":{"data_base64":"SGVsbG8="}}';
    const result = parseRpcRequest(line);
    expect(isErrorResponse(result)).toBe(false);
    if (!isErrorResponse(result)) {
      expect(result.id).toBe('abc');
      expect(result.method).toBe('encrypt');
    }
  });

  it('should parse status request (no params)', () => {
    const line = '{"id":99,"method":"status"}';
    const result = parseRpcRequest(line);
    expect(isErrorResponse(result)).toBe(false);
    if (!isErrorResponse(result)) {
      expect(result.method).toBe('status');
      expect(result.params).toBeUndefined();
    }
  });

  it('should return error for invalid JSON', () => {
    const result = parseRpcRequest('this is not json');
    expect(isErrorResponse(result)).toBe(true);
    if (isErrorResponse(result)) {
      expect(result.error).toContain('Invalid JSON');
    }
  });

  it('should return error for missing method', () => {
    const result = parseRpcRequest('{"id":1}');
    expect(isErrorResponse(result)).toBe(true);
    if (isErrorResponse(result)) {
      expect(result.error).toContain("missing 'method'");
    }
  });

  it('should return error for non-object JSON', () => {
    const result = parseRpcRequest('"just a string"');
    expect(isErrorResponse(result)).toBe(true);
  });
});

describe('Response helpers', () => {
  it('should create success response', () => {
    const resp = successResponse(1, { status: 'ok' });
    expect(resp.id).toBe(1);
    expect(resp.result).toEqual({ status: 'ok' });
    expect(resp.error).toBeUndefined();
  });

  it('should create error response', () => {
    const resp = errorResponse(2, 'something went wrong');
    expect(resp.id).toBe(2);
    expect(resp.result).toBeUndefined();
    expect(resp.error).toBe('something went wrong');
  });

  it('should serialize success response without error field', () => {
    const resp = successResponse(1, 'ok');
    const json = JSON.parse(JSON.stringify(resp));
    expect(json.result).toBe('ok');
    expect(json.error).toBeUndefined();
  });
});
