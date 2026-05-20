/**
 * Minimal validator for extension settings-schema.json files.
 *
 * These schemas follow a wrapper format with inner JSON Schema objects:
 *
 *   {
 *     "labels":      { ... },         // optional: UI labels
 *     "prefs":       { ... },         // JSON Schema for user preferences
 *     "item":        { ... },         // optional: JSON Schema for data items
 *     "storageKeys": { ... },         // optional: storage key mapping
 *     "defaults":    { ... }          // optional: default values
 *   }
 *
 * A few extensions use a "bare" format where the top-level is itself a
 * JSON Schema (with `type`, `properties`). Both shapes are accepted.
 *
 * The validator is deliberately permissive: it emits warnings/errors but
 * never rejects the schema. An invalid schema means the settings UI may
 * not render correctly, but the feature itself continues to work.
 */

export type ValidationSeverity = 'error' | 'warning';

export interface ValidationIssue {
  severity: ValidationSeverity;
  path: string;
  message: string;
}

export interface ValidationResult {
  issues: ValidationIssue[];
  errors: number;
  warnings: number;
}

// Fields recognized at the top level of a wrapper-style settings schema.
const KNOWN_WRAPPER_FIELDS = new Set([
  'labels',
  'prefs',
  'item',
  'storageKeys',
  'defaults',
  'required',
]);

// Fields recognized at the top level of a bare JSON Schema.
const KNOWN_SCHEMA_FIELDS = new Set([
  '$schema',
  '$id',
  'title',
  'description',
  'type',
  'properties',
  'defaults',
  'default',
  'required',
  'items',
  'enum',
  'enumLabels',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'additionalProperties',
  'label', // custom UI-facing field, seen in feeds
  'options', // custom UI-facing field, seen in feeds
]);

// Types accepted in a JSON Schema `type` field. We include `"select"` because
// one extension (feeds) uses it as a UI hint.
const VALID_JSON_SCHEMA_TYPES = new Set([
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
  'select',
]);

function jsType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Check whether an object looks like a JSON Schema (has `type` or `properties`).
 */
function looksLikeSchema(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return 'type' in obj || 'properties' in obj;
}

/**
 * Validate a single JSON Schema object (e.g. the `prefs` sub-schema).
 */
function validateSchemaObject(
  schema: unknown,
  path: string,
  issues: ValidationIssue[],
  requireObjectType = false
): void {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    issues.push({
      severity: 'error',
      path,
      message: `expected an object, got ${jsType(schema)}`,
    });
    return;
  }

  const obj = schema as Record<string, unknown>;

  if (!('type' in obj)) {
    issues.push({
      severity: 'warning',
      path,
      message: 'schema is missing `type`',
    });
  } else {
    const t = obj.type;
    if (typeof t !== 'string') {
      issues.push({
        severity: 'error',
        path: `${path}.type`,
        message: `expected string, got ${jsType(t)}`,
      });
    } else if (!VALID_JSON_SCHEMA_TYPES.has(t)) {
      issues.push({
        severity: 'error',
        path: `${path}.type`,
        message: `unknown JSON Schema type "${t}"`,
      });
    } else if (requireObjectType && t !== 'object') {
      issues.push({
        severity: 'warning',
        path: `${path}.type`,
        message: `expected "object" at top level, got "${t}"`,
      });
    }
  }

  // Validate properties map.
  if ('properties' in obj) {
    const props = obj.properties;
    if (!props || typeof props !== 'object' || Array.isArray(props)) {
      issues.push({
        severity: 'error',
        path: `${path}.properties`,
        message: `expected an object, got ${jsType(props)}`,
      });
    } else {
      for (const [propName, propSchema] of Object.entries(props as Record<string, unknown>)) {
        validateSchemaObject(propSchema, `${path}.properties.${propName}`, issues, false);
      }
    }
  }

  // `required` must be string[] if present.
  if ('required' in obj) {
    const req = obj.required;
    if (!Array.isArray(req)) {
      issues.push({
        severity: 'error',
        path: `${path}.required`,
        message: `expected array, got ${jsType(req)}`,
      });
    } else {
      for (let i = 0; i < req.length; i++) {
        if (typeof req[i] !== 'string') {
          issues.push({
            severity: 'error',
            path: `${path}.required[${i}]`,
            message: `expected string, got ${jsType(req[i])}`,
          });
        }
      }
    }
  }

  // Warn about unknown fields.
  for (const key of Object.keys(obj)) {
    if (!KNOWN_SCHEMA_FIELDS.has(key)) {
      issues.push({
        severity: 'warning',
        path: `${path}.${key}`,
        message: `unknown field "${key}"`,
      });
    }
  }

  // Validate `default` matches the declared type, when both are trivially comparable.
  if ('default' in obj && typeof obj.type === 'string') {
    const expected = obj.type;
    const actual = jsType(obj.default);
    if (!typesMatch(expected, actual)) {
      issues.push({
        severity: 'warning',
        path: `${path}.default`,
        message: `default value is ${actual}, expected ${expected}`,
      });
    }
  }
}

function typesMatch(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  if (expected === 'integer' && actual === 'number') return true;
  if (expected === 'number' && actual === 'number') return true;
  // `select` is a UI hint — values are typically string.
  if (expected === 'select' && actual === 'string') return true;
  return false;
}

/**
 * Walk a `defaults` block and spot-check types against the corresponding
 * sub-schema, when one exists. Only checks leaf primitive mismatches.
 */
function validateDefaultsAgainstSchema(
  defaults: unknown,
  schema: unknown,
  path: string,
  issues: ValidationIssue[]
): void {
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) return;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return;

  const defObj = defaults as Record<string, unknown>;
  const schemaObj = schema as Record<string, unknown>;
  const props = schemaObj.properties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) return;
  const propsObj = props as Record<string, unknown>;

  for (const [key, defVal] of Object.entries(defObj)) {
    const sub = propsObj[key];
    if (!sub || typeof sub !== 'object' || Array.isArray(sub)) continue;
    const subSchema = sub as Record<string, unknown>;
    const expected = typeof subSchema.type === 'string' ? subSchema.type : null;
    if (!expected) continue;
    const actual = jsType(defVal);
    if (!typesMatch(expected, actual)) {
      issues.push({
        severity: 'warning',
        path: `${path}.${key}`,
        message: `default is ${actual}, schema says ${expected}`,
      });
    }
    // Recurse into nested objects.
    if (expected === 'object' && subSchema.properties) {
      validateDefaultsAgainstSchema(defVal, subSchema, `${path}.${key}`, issues);
    }
  }
}

/**
 * Validate a loaded settings-schema.json object.
 *
 * Accepts either:
 *   - wrapper format: `{ prefs, item, defaults, storageKeys, labels }`
 *   - bare JSON Schema: `{ type, properties, ... }`
 */
export function validateSettingsSchema(schema: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    issues.push({
      severity: 'error',
      path: '',
      message: `settings-schema root must be an object, got ${jsType(schema)}`,
    });
    return summarize(issues);
  }

  const obj = schema as Record<string, unknown>;

  // Detect shape: bare JSON Schema (has top-level `type` or `properties`)
  // vs wrapper (has `prefs` / `item` / `storageKeys`).
  const isBare = ('type' in obj || 'properties' in obj) && !('prefs' in obj) && !('item' in obj);

  if (isBare) {
    validateSchemaObject(obj, '', issues, /* requireObjectType */ true);
    if ('defaults' in obj) {
      validateDefaultsAgainstSchema(obj.defaults, obj, 'defaults', issues);
    }
    return summarize(issues);
  }

  // Wrapper format. Walk known slots; warn on unknown top-level fields.
  for (const key of Object.keys(obj)) {
    if (!KNOWN_WRAPPER_FIELDS.has(key)) {
      issues.push({
        severity: 'warning',
        path: key,
        message: `unknown top-level field "${key}"`,
      });
    }
  }

  if ('prefs' in obj) {
    if (looksLikeSchema(obj.prefs)) {
      validateSchemaObject(obj.prefs, 'prefs', issues, /* requireObjectType */ true);
    } else if (obj.prefs && typeof obj.prefs === 'object' && !Array.isArray(obj.prefs)) {
      // A `prefs` that's an object but doesn't look like a schema is fine —
      // some extensions put raw field definitions here.
    } else {
      issues.push({
        severity: 'error',
        path: 'prefs',
        message: `expected an object, got ${jsType(obj.prefs)}`,
      });
    }
  }

  if ('item' in obj) {
    if (looksLikeSchema(obj.item)) {
      validateSchemaObject(obj.item, 'item', issues, /* requireObjectType */ true);
    } else if (!(obj.item && typeof obj.item === 'object' && !Array.isArray(obj.item))) {
      issues.push({
        severity: 'error',
        path: 'item',
        message: `expected an object, got ${jsType(obj.item)}`,
      });
    }
  }

  if ('defaults' in obj) {
    const defaults = obj.defaults;
    if (defaults && typeof defaults === 'object' && !Array.isArray(defaults)) {
      // `defaults` commonly mirrors `prefs` and `item`.
      const defObj = defaults as Record<string, unknown>;
      if ('prefs' in defObj && looksLikeSchema(obj.prefs)) {
        validateDefaultsAgainstSchema(defObj.prefs, obj.prefs, 'defaults.prefs', issues);
      }
      if ('item' in defObj && looksLikeSchema(obj.item)) {
        validateDefaultsAgainstSchema(defObj.item, obj.item, 'defaults.item', issues);
      }
    } else {
      issues.push({
        severity: 'error',
        path: 'defaults',
        message: `expected an object, got ${jsType(defaults)}`,
      });
    }
  }

  if ('storageKeys' in obj) {
    const sk = obj.storageKeys;
    if (!sk || typeof sk !== 'object' || Array.isArray(sk)) {
      issues.push({
        severity: 'error',
        path: 'storageKeys',
        message: `expected an object, got ${jsType(sk)}`,
      });
    } else {
      for (const [k, v] of Object.entries(sk as Record<string, unknown>)) {
        if (typeof v !== 'string') {
          issues.push({
            severity: 'error',
            path: `storageKeys.${k}`,
            message: `expected string, got ${jsType(v)}`,
          });
        }
      }
    }
  }

  return summarize(issues);
}

function summarize(issues: ValidationIssue[]): ValidationResult {
  let errors = 0;
  let warnings = 0;
  for (const i of issues) {
    if (i.severity === 'error') errors++;
    else warnings++;
  }
  return { issues, errors, warnings };
}

/**
 * Log validation issues with a consistent prefix. Never throws.
 */
export function logValidationIssues(extId: string, result: ValidationResult): void {
  if (result.issues.length === 0) return;
  const prefix = `[schema-validation] ${extId}:`;
  for (const issue of result.issues) {
    const where = issue.path ? ` (${issue.path})` : '';
    const msg = `${prefix} ${issue.severity}${where} ${issue.message}`;
    if (issue.severity === 'error') {
      console.error(msg);
    } else {
      console.warn(msg);
    }
  }
}
