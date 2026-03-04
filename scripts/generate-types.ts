#!/usr/bin/env tsx
/**
 * IDL → TypeScript Type Code Generator
 *
 * Generates TypeScript interface files from the Candid IDL factory functions in src/idl.ts.
 * Uses @dfinity/candid's Visitor pattern to traverse IDL type trees and produce TS code.
 *
 * This script establishes idl.ts as the SINGLE SOURCE OF TRUTH for canister interfaces.
 * The generated TS types are checked into git to allow compilation without running codegen.
 *
 * Usage:
 *   tsx scripts/generate-types.ts           Generate/overwrite type files
 *   tsx scripts/generate-types.ts --check   Dry-run: compare generated vs existing, exit 1 on diff
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/** ESM equivalent of __dirname */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { IDL } from '@dfinity/candid';
import {
  buildSignTypes,
  buildRegistryTypes,
  buildSignService,
  buildRegistryService,
} from '../src/idl';

// ========== Type Name Registry ==========

/**
 * Maps IDL type instances (by reference) to their desired TypeScript names.
 * Built by registering the output of buildSignTypes() / buildRegistryTypes().
 */
type TypeNameRegistry = Map<IDL.Type, string>;

/**
 * Build the shared type instances and the name registry.
 * Using shared instances ensures that the service methods reference the SAME
 * type objects as the registry, enabling reference-equality name lookups.
 */
function buildSharedContext() {
  // Build named types (shared across registry and service)
  const signTypes = buildSignTypes(IDL);
  const regTypes = buildRegistryTypes(IDL);

  // Build services using the SAME type instances
  const signService = buildSignService(IDL, signTypes) as unknown as IDL.ServiceClass;
  const regService = buildRegistryService(IDL, regTypes) as unknown as IDL.ServiceClass;

  // Register type names (by reference)
  const registry: TypeNameRegistry = new Map();
  registry.set(signTypes.SignEvent, 'SignEvent');
  registry.set(signTypes.SignParm, 'SignParm');
  registry.set(regTypes.Position, 'Position');
  registry.set(regTypes.AiProfile, 'AiProfile');
  registry.set(regTypes.UserProfile, 'UserProfile');
  registry.set(regTypes.RegisterResult, 'RegisterResult');
  registry.set(regTypes.TwoFARecord, 'TwoFARecord');

  return { signTypes, regTypes, signService, regService, registry };
}

// ========== IDL → TypeScript Visitor ==========

/**
 * Visitor that converts IDL types to TypeScript type strings.
 *
 * Context data (D) is the TypeNameRegistry, allowing named type references.
 * Return value (R) is the TypeScript type string.
 */
class TSTypeVisitor extends IDL.Visitor<TypeNameRegistry, string> {
  // --- Fallback ---

  visitType<T>(t: IDL.Type<T>, _data: TypeNameRegistry): string {
    // Unknown type — use display name as comment
    return `unknown /* ${t.name} */`;
  }

  // --- Primitive types ---

  visitBool(_t: IDL.BoolClass, _data: TypeNameRegistry): string {
    return 'boolean';
  }

  visitNull(_t: IDL.NullClass, _data: TypeNameRegistry): string {
    return 'null';
  }

  visitText(_t: IDL.TextClass, _data: TypeNameRegistry): string {
    return 'string';
  }

  visitInt(_t: IDL.IntClass, _data: TypeNameRegistry): string {
    return 'bigint';
  }

  visitNat(_t: IDL.NatClass, _data: TypeNameRegistry): string {
    return 'bigint';
  }

  visitFloat(_t: IDL.FloatClass, _data: TypeNameRegistry): string {
    return 'number';
  }

  /**
   * Fixed-width unsigned integers: Nat8/16/32 → number, Nat64 → bigint
   * Uses _bits property to determine the appropriate TS type.
   */
  visitFixedNat(t: IDL.FixedNatClass, _data: TypeNameRegistry): string {
    return (t as unknown as { _bits: number })._bits <= 32 ? 'number' : 'bigint';
  }

  /**
   * Fixed-width signed integers: Int8/16/32 → number, Int64 → bigint
   */
  visitFixedInt(t: IDL.FixedIntClass, _data: TypeNameRegistry): string {
    return (t as unknown as { _bits: number })._bits <= 32 ? 'number' : 'bigint';
  }

  visitPrincipal(_t: IDL.PrincipalClass, _data: TypeNameRegistry): string {
    return 'Principal';
  }

  // --- Constructed types ---

  /**
   * Opt<T> → CandidOpt<T> (which is [] | [T])
   * Uses the CandidOpt helper type for readability.
   */
  visitOpt<T>(t: IDL.OptClass<T>, ty: IDL.Type<T>, data: TypeNameRegistry): string {
    const inner = this.resolveType(ty, data);
    return `CandidOpt<${inner}>`;
  }

  /**
   * Vec<T> → T[]
   */
  visitVec<T>(t: IDL.VecClass<T>, ty: IDL.Type<T>, data: TypeNameRegistry): string {
    const inner = this.resolveType(ty, data);
    // If the inner type contains spaces or |, wrap in parens for array syntax clarity
    if (inner.includes(' | ') || inner.includes('{')) {
      return `(${inner})[]`;
    }
    return `${inner}[]`;
  }

  /**
   * Record → { field: Type; ... }
   * If the record type is named (in the registry), returns the name instead.
   */
  visitRecord(
    t: IDL.RecordClass,
    fields: Array<[string, IDL.Type]>,
    data: TypeNameRegistry,
  ): string {
    // Check if this is a named type (by reference)
    const name = data.get(t);
    if (name) return name;

    // Generate inline record
    if (fields.length === 0) return 'Record<string, never>';

    const lines = fields.map(([fieldName, fieldType]) => {
      const tsType = this.resolveType(fieldType, data);
      return `  ${fieldName}: ${tsType};`;
    });
    return `{\n${lines.join('\n')}\n}`;
  }

  /**
   * Variant → { A: TypeA } | { B: TypeB } | ...
   * If the variant type is named (in the registry), returns the name instead.
   */
  visitVariant(
    t: IDL.VariantClass,
    fields: Array<[string, IDL.Type]>,
    data: TypeNameRegistry,
  ): string {
    // Check if this is a named type (by reference)
    const name = data.get(t);
    if (name) return name;

    // Generate inline variant (discriminated union)
    return fields.map(([variantName, variantType]) => {
      if (variantType instanceof IDL.NullClass) {
        return `{ ${variantName}: null }`;
      }
      const inner = this.resolveType(variantType, data);
      return `{ ${variantName}: ${inner} }`;
    }).join(' | ');
  }

  // --- Helper ---

  /**
   * Resolve an IDL type to its TypeScript string representation.
   * First checks if the type has a registered name; otherwise visits it.
   */
  private resolveType(type: IDL.Type, data: TypeNameRegistry): string {
    const name = data.get(type);
    if (name) return name;
    return type.accept(this, data);
  }
}

// ========== Code Generation Logic ==========

const visitor = new TSTypeVisitor();

/**
 * Generate a TypeScript interface definition for a named Record type.
 */
function generateInterface(
  name: string,
  recordType: IDL.RecordClass,
  registry: TypeNameRegistry,
): string {
  const fields = (recordType as unknown as { _fields: Array<[string, IDL.Type]> })._fields;
  const lines = fields.map(([fieldName, fieldType]) => {
    const tsType = resolveType(fieldType, registry);
    return `  ${fieldName}: ${tsType};`;
  });
  return `export interface ${name} {\n${lines.join('\n')}\n}`;
}

/**
 * Generate a TypeScript union type definition for a named Variant type.
 */
function generateVariantType(
  name: string,
  variantType: IDL.VariantClass,
  registry: TypeNameRegistry,
): string {
  const fields = (variantType as unknown as { _fields: Array<[string, IDL.Type]> })._fields;
  const variants = fields.map(([variantName, variantFieldType]) => {
    if (variantFieldType instanceof IDL.NullClass) {
      return `  | { ${variantName}: null }`;
    }
    const inner = resolveType(variantFieldType, registry);
    return `  | { ${variantName}: ${inner} }`;
  });
  return `export type ${name} =\n${variants.join('\n')};`;
}

/**
 * Resolve an IDL type to TS string, checking the name registry first.
 */
function resolveType(type: IDL.Type, registry: TypeNameRegistry): string {
  const name = registry.get(type);
  if (name) return name;
  return type.accept(visitor, registry);
}

/**
 * Generate a TypeScript service interface from an IDL.ServiceClass.
 */
function generateServiceInterface(
  name: string,
  service: IDL.ServiceClass,
  registry: TypeNameRegistry,
  resultTypes: Map<string, string>,
): string {
  const fields = (service as unknown as { _fields: Array<[string, IDL.FuncClass]> })._fields;
  const methods = fields.map(([methodName, funcClass]) => {
    // Map argument types
    const argTypes = funcClass.argTypes.map((t: IDL.Type) => resolveType(t, registry));
    const argStr = argTypes.join(', ');

    // Map return type (single or tuple)
    let retStr: string;
    if (funcClass.retTypes.length === 0) {
      retStr = 'void';
    } else if (funcClass.retTypes.length === 1) {
      retStr = resolveType(funcClass.retTypes[0], registry);
      // If this return type was registered as a named result type, use that name
      const resultName = resultTypes.get(methodName);
      if (resultName) retStr = resultName;
    } else {
      const retParts = funcClass.retTypes.map((t: IDL.Type) => resolveType(t, registry));
      retStr = `[${retParts.join(', ')}]`;
    }

    return `  ${methodName}: ActorMethod<[${argStr}], ${retStr}>;`;
  });

  return `export interface ${name} {\n${methods.join('\n')}\n}`;
}

/**
 * Detect inline Variant return types in service methods and extract them as named types.
 * Returns a map of method_name → ResultTypeName and an array of type definitions.
 */
function extractResultTypes(
  service: IDL.ServiceClass,
  registry: TypeNameRegistry,
  prefix: string,
): { resultMap: Map<string, string>; typeDefs: string[] } {
  const resultMap = new Map<string, string>();
  const typeDefs: string[] = [];
  const fields = (service as unknown as { _fields: Array<[string, IDL.FuncClass]> })._fields;

  for (const [methodName, funcClass] of fields) {
    if (funcClass.retTypes.length !== 1) continue;
    const retType = funcClass.retTypes[0];

    // Only extract inline Variant types (not already named in registry)
    if (registry.has(retType)) continue;
    if (!(retType instanceof IDL.VariantClass)) continue;

    // Generate a name: e.g. agent_sign → AgentSignResult
    const camelName = methodName
      .split('_')
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join('');
    const resultName = `${camelName}Result`;

    // Generate the type definition
    const variantFields = (retType as unknown as { _fields: Array<[string, IDL.Type]> })._fields;
    const variants = variantFields.map(([variantName, variantFieldType]) => {
      if (variantFieldType instanceof IDL.NullClass) {
        return `{ ${variantName}: null }`;
      }
      const inner = resolveType(variantFieldType, registry);
      return `{ ${variantName}: ${inner} }`;
    });
    const typeDef = `export type ${resultName} = ${variants.join(' | ')};`;
    typeDefs.push(typeDef);
    resultMap.set(methodName, resultName);
  }

  return { resultMap, typeDefs };
}

// ========== File Generation ==========

const HEADER_TEMPLATE = (source: string) => `/**
 * AUTO-GENERATED from idl.ts — DO NOT EDIT MANUALLY
 *
 * Run \`npm run generate-types\` to regenerate this file.
 * Source: ${source} in src/idl.ts
 * Generated: ${new Date().toISOString().replace(/\\.\\d{3}Z$/, 'Z')}
 *
 * These types are derived from the Candid IDL definitions and correspond to
 * the canister's runtime interface. Edit idl.ts to change type definitions.
 */`;

/**
 * Generate src/types/sign-event.ts
 */
function generateSignEventFile(
  signTypes: ReturnType<typeof buildSignTypes>,
  signService: IDL.ServiceClass,
  registry: TypeNameRegistry,
): string {
  // Extract named result types from service methods
  const { resultMap, typeDefs } = extractResultTypes(signService, registry, 'Sign');

  // Build file content
  const lines: string[] = [];

  lines.push(HEADER_TEMPLATE('signIdlFactory'));
  lines.push('');
  lines.push("import type { Principal } from '@dfinity/principal';");
  lines.push("import type { ActorMethod } from '@dfinity/agent';");
  lines.push('');

  // CandidOpt helper type
  lines.push('/** Candid opt type representation: [] means null, [T] means has value */');
  lines.push('export type CandidOpt<T> = [] | [T];');
  lines.push('');

  // SignEvent interface
  lines.push('/** SignEvent — sign event record returned by canister */');
  lines.push(generateInterface('SignEvent', signTypes.SignEvent as unknown as IDL.RecordClass, registry));
  lines.push('');

  // SignParm variant type
  lines.push('/** SignParm variant — signing parameter types (one-of union) */');
  lines.push(generateVariantType('SignParm', signTypes.SignParm as unknown as IDL.VariantClass, registry));
  lines.push('');

  // Result types extracted from methods
  for (const typeDef of typeDefs) {
    lines.push(`/** Return type for canister method */`);
    lines.push(typeDef);
    lines.push('');
  }

  // Add backward-compatible alias: SignResult = AgentSignResult
  if (resultMap.has('agent_sign')) {
    lines.push(`/** Backward-compatible alias for agent_sign return type */`);
    lines.push(`export type SignResult = ${resultMap.get('agent_sign')!};`);
    lines.push('');
  }

  // SignService interface
  lines.push('/** Signatures canister service interface — all callable canister methods */');
  lines.push(generateServiceInterface('SignService', signService, registry, resultMap));
  lines.push('');

  return lines.join('\n');
}

/**
 * Generate src/types/registry.ts
 */
function generateRegistryFile(
  regTypes: ReturnType<typeof buildRegistryTypes>,
  regService: IDL.ServiceClass,
  registry: TypeNameRegistry,
): string {
  // Extract named result types from service methods
  const { resultMap, typeDefs } = extractResultTypes(regService, registry, 'Registry');

  // Build file content
  const lines: string[] = [];

  lines.push(HEADER_TEMPLATE('registryIdlFactory'));
  lines.push('');
  lines.push("import type { Principal } from '@dfinity/principal';");
  lines.push("import type { ActorMethod } from '@dfinity/agent';");
  lines.push("import type { CandidOpt } from './sign-event.js';");
  lines.push('');

  // Position interface
  lines.push('/** Position record — position information in the registry canister */');
  lines.push(generateInterface('Position', regTypes.Position as unknown as IDL.RecordClass, registry));
  lines.push('');

  // AiProfile interface
  lines.push('/** AI profile record */');
  lines.push(generateInterface('AiProfile', regTypes.AiProfile as unknown as IDL.RecordClass, registry));
  lines.push('');

  // UserProfile interface
  lines.push('/** User profile record */');
  lines.push(generateInterface('UserProfile', regTypes.UserProfile as unknown as IDL.RecordClass, registry));
  lines.push('');

  // RegisterResult interface
  lines.push('/** Registration success result */');
  lines.push(generateInterface('RegisterResult', regTypes.RegisterResult as unknown as IDL.RecordClass, registry));
  lines.push('');

  // TwoFARecord interface
  lines.push('/** 2FA verification record — tracks a pending or completed 2FA request */');
  lines.push(generateInterface('TwoFARecord', regTypes.TwoFARecord as unknown as IDL.RecordClass, registry));
  lines.push('');

  // Result types extracted from methods
  for (const typeDef of typeDefs) {
    lines.push(`/** Return type for canister method */`);
    lines.push(typeDef);
    lines.push('');
  }

  // RegistryService interface
  lines.push('/** Registry canister service interface */');
  lines.push(generateServiceInterface('RegistryService', regService, registry, resultMap));
  lines.push('');

  return lines.join('\n');
}

// ========== Main ==========

function main(): void {
  const isCheck = process.argv.includes('--check');
  const { signTypes, regTypes, signService, regService, registry } = buildSharedContext();

  const srcDir = path.resolve(__dirname, '..', 'src', 'types');

  const files: Array<{ name: string; content: string; path: string }> = [
    {
      name: 'sign-event.ts',
      content: generateSignEventFile(signTypes, signService, registry),
      path: path.join(srcDir, 'sign-event.ts'),
    },
    {
      name: 'registry.ts',
      content: generateRegistryFile(regTypes, regService, registry),
      path: path.join(srcDir, 'registry.ts'),
    },
  ];

  if (isCheck) {
    // Dry-run mode: compare with existing files
    let allMatch = true;

    for (const file of files) {
      if (!fs.existsSync(file.path)) {
        console.error(`MISSING: ${file.name} does not exist`);
        allMatch = false;
        continue;
      }

      const existing = fs.readFileSync(file.path, 'utf-8');
      // Compare without the "Generated:" timestamp line (which changes every run)
      const stripTimestamp = (s: string) => s.replace(/^ \* Generated: .+$/m, '');
      if (stripTimestamp(existing) !== stripTimestamp(file.content)) {
        console.error(`OUT OF SYNC: ${file.name} differs from generated output`);
        console.error(`Run \`npm run generate-types\` to update.`);
        allMatch = false;
      } else {
        console.log(`OK: ${file.name} is up to date`);
      }
    }

    if (!allMatch) {
      process.exit(1);
    }
    console.log('\nAll type files are in sync with IDL definitions.');
    return;
  }

  // Write mode: generate and overwrite files
  for (const file of files) {
    fs.writeFileSync(file.path, file.content, 'utf-8');
    console.log(`Generated: ${file.path}`);
  }
  console.log('\nType generation complete. Run `tsc --noEmit` to verify.');
}

main();
