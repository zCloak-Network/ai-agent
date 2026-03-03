/**
 * Common utility type definitions
 *
 * Contains public types for command line arguments, PoW results, MANIFEST, etc.
 */

/** Command line argument parsing result */
export interface ParsedArgs {
  /** Positional arguments (arguments not starting with --) */
  _args: string[];
  /** Named arguments (--key=value or --flag) */
  [key: string]: string | boolean | string[];
}

/** PoW computation result */
export interface PowResult {
  /** Found nonce value */
  nonce: number;
  /** Hash that satisfies the condition */
  hash: string;
  /** Computation time (milliseconds) */
  timeMs: number;
}

/** AutoPoW return result (includes base) */
export interface AutoPowResult {
  /** Found nonce value */
  nonce: number;
  /** Hash that satisfies the condition */
  hash: string;
  /** PoW base string */
  base: string;
}

/** MANIFEST generation options */
export interface ManifestOptions {
  /** Version number, default "1.0.0" */
  version?: string;
}

/** MANIFEST generation result */
export interface ManifestResult {
  /** MANIFEST.sha256 file path */
  manifestPath: string;
  /** SHA256 hash of the MANIFEST file itself */
  manifestHash: string;
  /** MANIFEST file size (bytes) */
  manifestSize: number;
  /** Number of files included */
  fileCount: number;
}
