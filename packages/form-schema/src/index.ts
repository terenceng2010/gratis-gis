/**
 * Minimal form-schema definitions. This is a placeholder shape that will be
 * expanded when we port the Survey123 Designer form-builder work.
 *
 * Design goals:
 *   - JSON-serializable (safe to store as jsonb on Item.data_json)
 *   - Stable, versioned: `schemaVersion` lets us evolve without breaking forms
 *   - Renderer-agnostic (no React types in here)
 */

export type FormSchemaVersion = 1;

export type FieldType =
  | 'text'
  | 'multiline'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'select-one'
  | 'select-many'
  | 'date'
  | 'datetime'
  | 'photo'
  | 'signature'
  | 'geopoint'
  | 'geotrace'
  | 'geoshape';

export interface FieldBase {
  id: string;          // stable key; becomes a column in the submission table
  label: string;
  description?: string;
  required?: boolean;
  visibleIf?: Expression; // logical visibility (e.g. show if field X = 'yes')
}

export interface Choice {
  value: string;
  label: string;
}

export type Field =
  | (FieldBase & { type: 'text'; placeholder?: string; maxLength?: number })
  | (FieldBase & { type: 'multiline'; placeholder?: string; maxLength?: number })
  | (FieldBase & { type: 'number'; min?: number; max?: number; step?: number })
  | (FieldBase & { type: 'integer'; min?: number; max?: number })
  | (FieldBase & { type: 'boolean' })
  | (FieldBase & { type: 'select-one'; choices: Choice[] })
  | (FieldBase & { type: 'select-many'; choices: Choice[] })
  | (FieldBase & { type: 'date' })
  | (FieldBase & { type: 'datetime' })
  | (FieldBase & { type: 'photo'; maxCount?: number })
  | (FieldBase & { type: 'signature' })
  | (FieldBase & { type: 'geopoint' })
  | (FieldBase & { type: 'geotrace' })
  | (FieldBase & { type: 'geoshape' });

export interface FormPage {
  id: string;
  title: string;
  fields: Field[];
}

export interface FormSchema {
  schemaVersion: FormSchemaVersion;
  id: string;          // matches the Item id the form is stored under
  title: string;
  description?: string;
  pages: FormPage[];
}

/**
 * Tiny expression language for visibility/validation. Kept intentionally
 * minimal so the renderer and server can evaluate without a full JS sandbox.
 * Example: { op: 'eq', left: { ref: 'age_group' }, right: { value: 'adult' } }
 */
export type Expression =
  | { op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'; left: Operand; right: Operand }
  | { op: 'and' | 'or'; operands: Expression[] }
  | { op: 'not'; operand: Expression };

export type Operand = { ref: string } | { value: string | number | boolean | null };
