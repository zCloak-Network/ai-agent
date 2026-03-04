/**
 * Integration test for IDL codegen pipeline
 *
 * Verifies that the generated type files are in sync with the IDL definitions
 * by running the codegen script in --check mode.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('IDL codegen', () => {
  it('generated type files are in sync with IDL (check mode)', () => {
    // Run the codegen script in check mode — exits with code 0 if types are in sync
    const output = execSync('npx tsx scripts/generate-types.ts --check', {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 30000,
    });

    expect(output).toContain('OK');
    expect(output).toContain('in sync');
  });
});
