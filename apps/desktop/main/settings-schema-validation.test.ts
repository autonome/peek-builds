/**
 * Tests for settings-schema.json validation.
 *
 * Runs under Electron's Node host (via `yarn test:unit`).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  validateSettingsSchema,
  logValidationIssues,
  type ValidationResult,
  type ValidationIssue,
} from './settings-schema-validation.js';

// ─── helpers ────────────────────────────────────────────────────────

function findIssue(
  result: ValidationResult,
  predicate: (i: ValidationIssue) => boolean
): ValidationIssue | undefined {
  return result.issues.find(predicate);
}

// ─── valid schemas ──────────────────────────────────────────────────

describe('validateSettingsSchema — valid inputs', () => {
  it('accepts a wrapper schema with prefs and defaults', () => {
    const schema = {
      prefs: {
        type: 'object',
        properties: {
          greeting: { type: 'string', default: 'hi' },
          count: { type: 'number', default: 3 },
        },
      },
      storageKeys: { PREFS: 'prefs' },
      defaults: {
        prefs: { greeting: 'hi', count: 3 },
      },
    };
    const result = validateSettingsSchema(schema);
    assert.strictEqual(result.errors, 0, JSON.stringify(result.issues));
    assert.strictEqual(result.warnings, 0, JSON.stringify(result.issues));
  });

  it('accepts a bare JSON Schema at the top level', () => {
    const schema = {
      type: 'object',
      properties: {
        scripts: { type: 'array', default: [] },
      },
    };
    const result = validateSettingsSchema(schema);
    assert.strictEqual(result.errors, 0, JSON.stringify(result.issues));
    assert.strictEqual(result.warnings, 0, JSON.stringify(result.issues));
  });

  it('accepts a wrapper with labels', () => {
    const schema = {
      labels: { prefs: { greeting: 'Greeting' } },
      prefs: { type: 'object', properties: {} },
      defaults: { prefs: {} },
      storageKeys: {},
    };
    const result = validateSettingsSchema(schema);
    assert.strictEqual(result.errors, 0);
    assert.strictEqual(result.warnings, 0);
  });

  it('never throws on arbitrary inputs', () => {
    assert.doesNotThrow(() => validateSettingsSchema(null));
    assert.doesNotThrow(() => validateSettingsSchema(undefined));
    assert.doesNotThrow(() => validateSettingsSchema(42));
    assert.doesNotThrow(() => validateSettingsSchema('not-an-object'));
    assert.doesNotThrow(() => validateSettingsSchema([]));
    // Deeply nested garbage.
    assert.doesNotThrow(() =>
      validateSettingsSchema({
        prefs: { type: 'object', properties: { a: { type: {} } } },
      })
    );
  });
});

// ─── missing type ───────────────────────────────────────────────────

describe('validateSettingsSchema — missing fields', () => {
  it('warns when prefs schema is missing `type`', () => {
    const schema = {
      prefs: {
        properties: {
          greeting: { type: 'string' },
        },
      },
    };
    const result = validateSettingsSchema(schema);
    const missing = findIssue(
      result,
      (i) => i.severity === 'warning' && i.path === 'prefs' && i.message.includes('missing `type`')
    );
    assert.ok(missing, `expected missing-type warning, got: ${JSON.stringify(result.issues)}`);
  });

  it('warns when a bare top-level schema is missing `type`', () => {
    const schema = {
      properties: { foo: { type: 'string' } },
    };
    const result = validateSettingsSchema(schema);
    const missing = findIssue(
      result,
      (i) => i.severity === 'warning' && i.message.includes('missing `type`')
    );
    assert.ok(missing);
  });
});

// ─── unknown fields ─────────────────────────────────────────────────

describe('validateSettingsSchema — unknown fields', () => {
  it('warns on unknown top-level wrapper field', () => {
    const schema = {
      prefs: { type: 'object', properties: {} },
      bogusField: { foo: 1 },
    };
    const result = validateSettingsSchema(schema);
    const unknown = findIssue(
      result,
      (i) => i.severity === 'warning' && i.path === 'bogusField'
    );
    assert.ok(unknown, `expected unknown-field warning, got: ${JSON.stringify(result.issues)}`);
  });

  it('warns on unknown field inside a schema object', () => {
    const schema = {
      prefs: {
        type: 'object',
        properties: {
          x: { type: 'string', bogusKey: 'oh no' },
        },
      },
    };
    const result = validateSettingsSchema(schema);
    const unknown = findIssue(
      result,
      (i) =>
        i.severity === 'warning' &&
        i.path === 'prefs.properties.x.bogusKey' &&
        i.message.includes('unknown field')
    );
    assert.ok(unknown, `expected unknown-field warning, got: ${JSON.stringify(result.issues)}`);
  });
});

// ─── invalid property type ──────────────────────────────────────────

describe('validateSettingsSchema — invalid types', () => {
  it('errors on unknown JSON Schema type', () => {
    const schema = {
      prefs: {
        type: 'object',
        properties: {
          broken: { type: 'banana' },
        },
      },
    };
    const result = validateSettingsSchema(schema);
    const typeErr = findIssue(
      result,
      (i) =>
        i.severity === 'error' &&
        i.path === 'prefs.properties.broken.type' &&
        i.message.includes('unknown JSON Schema type')
    );
    assert.ok(typeErr, `expected type error, got: ${JSON.stringify(result.issues)}`);
    assert.ok(result.errors >= 1);
  });

  it('errors when type is not a string', () => {
    const schema = {
      prefs: {
        type: 'object',
        properties: {
          broken: { type: 42 },
        },
      },
    };
    const result = validateSettingsSchema(schema);
    const typeErr = findIssue(
      result,
      (i) => i.severity === 'error' && i.path === 'prefs.properties.broken.type'
    );
    assert.ok(typeErr, JSON.stringify(result.issues));
  });

  it('warns when top-level type is not object', () => {
    const schema = {
      prefs: { type: 'string' },
    };
    const result = validateSettingsSchema(schema);
    const warn = findIssue(
      result,
      (i) =>
        i.severity === 'warning' &&
        i.path === 'prefs.type' &&
        i.message.includes('expected "object" at top level')
    );
    assert.ok(warn, JSON.stringify(result.issues));
  });
});

// ─── defaults type mismatch ─────────────────────────────────────────

describe('validateSettingsSchema — defaults', () => {
  it('warns when a default value type does not match its schema', () => {
    const schema = {
      prefs: {
        type: 'object',
        properties: {
          greeting: { type: 'string' },
          count: { type: 'number' },
        },
      },
      defaults: {
        prefs: {
          greeting: 42, // wrong: should be string
          count: 'oops', // wrong: should be number
        },
      },
    };
    const result = validateSettingsSchema(schema);

    const greetingMismatch = findIssue(
      result,
      (i) =>
        i.severity === 'warning' &&
        i.path === 'defaults.prefs.greeting' &&
        i.message.includes('default is number')
    );
    assert.ok(greetingMismatch, JSON.stringify(result.issues));

    const countMismatch = findIssue(
      result,
      (i) =>
        i.severity === 'warning' &&
        i.path === 'defaults.prefs.count' &&
        i.message.includes('default is string')
    );
    assert.ok(countMismatch, JSON.stringify(result.issues));
  });

  it('warns when a property-level default does not match its type', () => {
    const schema = {
      prefs: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean', default: 'yes' }, // wrong: should be boolean
        },
      },
    };
    const result = validateSettingsSchema(schema);
    const warn = findIssue(
      result,
      (i) =>
        i.severity === 'warning' &&
        i.path === 'prefs.properties.enabled.default' &&
        i.message.includes('default value is string')
    );
    assert.ok(warn, JSON.stringify(result.issues));
  });

  it('accepts integer defaults when schema type is number', () => {
    const schema = {
      prefs: {
        type: 'object',
        properties: { n: { type: 'number', default: 3 } },
      },
      defaults: { prefs: { n: 3 } },
    };
    const result = validateSettingsSchema(schema);
    assert.strictEqual(result.errors, 0);
    assert.strictEqual(result.warnings, 0);
  });
});

// ─── storageKeys ────────────────────────────────────────────────────

describe('validateSettingsSchema — storageKeys', () => {
  it('errors when storageKeys is not an object', () => {
    const schema = {
      prefs: { type: 'object' },
      storageKeys: 'oops',
    };
    const result = validateSettingsSchema(schema);
    const err = findIssue(
      result,
      (i) => i.severity === 'error' && i.path === 'storageKeys'
    );
    assert.ok(err, JSON.stringify(result.issues));
  });

  it('errors when a storageKeys entry is not a string', () => {
    const schema = {
      prefs: { type: 'object' },
      storageKeys: { PREFS: 42 },
    };
    const result = validateSettingsSchema(schema);
    const err = findIssue(
      result,
      (i) => i.severity === 'error' && i.path === 'storageKeys.PREFS'
    );
    assert.ok(err, JSON.stringify(result.issues));
  });
});

// ─── logValidationIssues ────────────────────────────────────────────

describe('logValidationIssues', () => {
  it('does not throw on empty results', () => {
    assert.doesNotThrow(() =>
      logValidationIssues('ext-id', { issues: [], errors: 0, warnings: 0 })
    );
  });

  it('writes errors to console.error and warnings to console.warn', () => {
    const origErr = console.error;
    const origWarn = console.warn;
    const errCalls: unknown[][] = [];
    const warnCalls: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errCalls.push(args);
    };
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args);
    };
    try {
      logValidationIssues('my-ext', {
        errors: 1,
        warnings: 1,
        issues: [
          { severity: 'error', path: 'foo', message: 'bad' },
          { severity: 'warning', path: 'bar', message: 'iffy' },
        ],
      });
    } finally {
      console.error = origErr;
      console.warn = origWarn;
    }
    assert.strictEqual(errCalls.length, 1);
    assert.strictEqual(warnCalls.length, 1);
    assert.ok(
      typeof errCalls[0][0] === 'string' && errCalls[0][0].includes('[schema-validation] my-ext:'),
      `got: ${errCalls[0][0]}`
    );
    assert.ok(
      typeof warnCalls[0][0] === 'string' && warnCalls[0][0].includes('[schema-validation] my-ext:')
    );
  });
});
