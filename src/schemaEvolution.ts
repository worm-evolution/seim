import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger';

export interface SchemaField {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'json' | 'relation';
  isNullable?: boolean;
  defaultValue?: any;
  isUnique?: boolean;
  isIndexed?: boolean;
}

export interface TableSpec {
  tableName: string;
  description?: string;
  fields: Record<string, SchemaField>;
  createdAt: number;
}

/**
 * Additive Database Schema & ORM Evolution Engine.
 * 
 * Safely evolves database schemas for newly created full-stack features.
 * Strictly enforces additive, non-destructive migrations:
 * - Allowed: CREATE TABLE, ADD COLUMN (with nullable/defaults), CREATE INDEX
 * - Blocked: DROP TABLE, DROP COLUMN, ALTER COLUMN TYPE (prevents data loss & locks)
 * Auto-generates Prisma, Mongoose, and TypeScript interface definitions.
 */
export class SchemaEvolutionEngine {
  private tables: Map<string, TableSpec> = new Map();
  private outputDir: string;

  constructor(
    outputDir: string = './src/seim-generated/models',
    private logger: Logger
  ) {
    this.outputDir = path.resolve(outputDir);
  }

  /**
   * Validates raw DDL / SQL to guarantee zero destructive mutations.
   */
  public validateDdl(sql: string): { safe: boolean; reason?: string } {
    const normalized = sql.trim().toUpperCase();

    // Block destructive operations
    const destructivePatterns = [
      /\bDROP\s+TABLE\b/,
      /\bDROP\s+COLUMN\b/,
      /\bDROP\s+DATABASE\b/,
      /\bTRUNCATE\b/,
      /\bALTER\s+COLUMN\s+.*TYPE\b/,
      /\bDELETE\s+FROM\b/,
    ];

    for (const pattern of destructivePatterns) {
      if (pattern.test(normalized)) {
        return {
          safe: false,
          reason: `Blocked destructive SQL pattern: ${pattern.source}`,
        };
      }
    }

    // Require ADD COLUMN to be nullable or have a DEFAULT
    if (/\bADD\s+COLUMN\b/.test(normalized)) {
      const isNotnullWithoutDefault = /\bNOT\s+NULL\b/.test(normalized) && !/\bDEFAULT\b/.test(normalized);
      if (isNotnullWithoutDefault) {
        return {
          safe: false,
          reason: 'ADD COLUMN with NOT NULL must provide a DEFAULT value to avoid production locking.',
        };
      }
    }

    return { safe: true };
  }

  /**
   * Registers or updates a table specification additively.
   */
  public registerTable(tableName: string, fields: Record<string, SchemaField>, description?: string): TableSpec {
    assertIdentifier(tableName, 'table name');
    for (const [fieldName, fieldSpec] of Object.entries(fields)) {
      assertIdentifier(fieldName, 'field name');
      if (!fieldSpec || !['string', 'number', 'boolean', 'date', 'json', 'relation'].includes(fieldSpec.type)) throw new Error(`Invalid schema type for field ${fieldName}`);
    }
    const existing = this.tables.get(tableName);

    if (existing) {
      // Additive merge: add new fields without deleting existing ones
      for (const [fieldName, fieldSpec] of Object.entries(fields)) {
        if (!existing.fields[fieldName]) {
          existing.fields[fieldName] = fieldSpec;
          this.logger.info('[SchemaEvolution] Added new field to entity', { tableName, fieldName });
        }
      }
      return existing;
    }

    const newTable: TableSpec = {
      tableName,
      description,
      fields: {
        id: { name: 'id', type: 'string', isUnique: true, isIndexed: true },
        createdAt: { name: 'createdAt', type: 'date', defaultValue: 'now()' },
        updatedAt: { name: 'updatedAt', type: 'date', defaultValue: 'now()' },
        ...fields,
      },
      createdAt: Date.now(),
    };

    this.tables.set(tableName, newTable);
    this.logger.info('[SchemaEvolution] Registered new additive table specification', { tableName });
    return newTable;
  }

  /**
   * Auto-generates a clean TypeScript interface from the schema.
   */
  public generateTypeScriptInterface(tableName: string): string {
    const spec = this.tables.get(tableName);
    if (!spec) return '';

    const pascalName = tableName.charAt(0).toUpperCase() + tableName.slice(1);
    const lines: string[] = [
      `export interface ${pascalName} {`,
    ];

    for (const [name, f] of Object.entries(spec.fields)) {
      const tsType = this.mapToTsType(f.type);
      const opt = f.isNullable ? '?' : '';
      lines.push(`  ${name}${opt}: ${tsType};`);
    }

    lines.push('}');
    return lines.join('\n');
  }

  /**
   * Auto-generates a Prisma Model block.
   */
  public generatePrismaModel(tableName: string): string {
    const spec = this.tables.get(tableName);
    if (!spec) return '';

    const pascalName = tableName.charAt(0).toUpperCase() + tableName.slice(1);
    const lines: string[] = [
      `model ${pascalName} {`,
    ];

    for (const [name, f] of Object.entries(spec.fields)) {
      if (name === 'id') {
        lines.push('  id        String   @id @default(uuid())');
        continue;
      }
      const prismaType = this.mapToPrismaType(f.type);
      const opt = f.isNullable ? '?' : '';
      const def = f.defaultValue === 'now()' ? ' @default(now())' : '';
      lines.push(`  ${name.padEnd(10)} ${prismaType}${opt}${def}`);
    }

    lines.push('}');
    return lines.join('\n');
  }

  /**
   * Auto-generates a Mongoose Schema definition.
   */
  public generateMongooseSchema(tableName: string): string {
    const spec = this.tables.get(tableName);
    if (!spec) return '';

    const pascalName = tableName.charAt(0).toUpperCase() + tableName.slice(1);
    const lines: string[] = [
      `import { Schema, model } from 'mongoose';`,
      ``,
      `const ${pascalName}Schema = new Schema({`,
    ];

    for (const [name, f] of Object.entries(spec.fields)) {
      if (name === 'id') continue;
      const mongoType = this.mapToMongooseType(f.type);
      const req = !f.isNullable ? ', required: true' : '';
      const def = f.defaultValue === 'now()' ? ', default: Date.now' : '';
      lines.push(`  ${name}: { type: ${mongoType}${req}${def} },`);
    }

    lines.push(`}, { timestamps: true });`);
    lines.push(``);
    lines.push(`export const ${pascalName}Model = model('${pascalName}', ${pascalName}Schema);`);

    return lines.join('\n');
  }

  /**
   * Persists generated models to disk.
   */
  public async writeModelsToDisk(): Promise<void> {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }

    for (const tableName of this.tables.keys()) {
      const tsCode = this.generateTypeScriptInterface(tableName);
      const filePath = path.join(this.outputDir, `${tableName}.types.ts`);
      fs.writeFileSync(filePath, tsCode, 'utf8');
    }
  }

  private mapToTsType(t: SchemaField['type']): string {
    switch (t) {
      case 'string': return 'string';
      case 'number': return 'number';
      case 'boolean': return 'boolean';
      case 'date': return 'Date | string';
      case 'json': return 'Record<string, any>';
      case 'relation': return 'any';
      default: return 'any';
    }
  }

  private mapToPrismaType(t: SchemaField['type']): string {
    switch (t) {
      case 'string': return 'String';
      case 'number': return 'Int';
      case 'boolean': return 'Boolean';
      case 'date': return 'DateTime';
      case 'json': return 'Json';
      default: return 'String';
    }
  }

  private mapToMongooseType(t: SchemaField['type']): string {
    switch (t) {
      case 'string': return 'String';
      case 'number': return 'Number';
      case 'boolean': return 'Boolean';
      case 'date': return 'Date';
      case 'json': return 'Schema.Types.Mixed';
      default: return 'Schema.Types.Mixed';
    }
  }
}

function assertIdentifier(value: string, label: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value)) throw new Error(`Invalid ${label}; use 1-64 letters, numbers, and underscores, starting with a letter`);
}
