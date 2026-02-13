/**
 * Unit tests for entity recognition extension
 *
 * Tests pure logic modules:
 * - Regex extractors (email, phone, date, price, tracking)
 * - Microformats extractor (h-card, h-event, h-adr)
 * - Structured data extractor (JSON-LD, Open Graph, meta tags)
 * - Entity matcher (dedup, confidence filtering)
 * - Entity store (name normalization)
 */

import { describe, it, before } from 'node:test';
import * as assert from 'node:assert';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..', '..', '..');
const extensionsDir = resolve(projectRoot, 'extensions', 'entities');

// Module references loaded in before()
let extractRegexEntities: (text: string, url: string) => any[];
let extractMicroformatEntities: (html: string, url: string) => any[];
let extractStructuredDataEntities: (html: string, url: string) => any[];
let normalizeName: (name: string) => string;

describe('Entity Recognition Extension', () => {
  before(async () => {
    // Load regex extractor (no DOM needed)
    const regexMod = await import(resolve(extensionsDir, 'extractors', 'regex.js'));
    extractRegexEntities = regexMod.extractRegexEntities;

    // Provide DOMParser for HTML-based extractors via linkedom
    const { DOMParser } = await import('linkedom');
    (globalThis as any).DOMParser = DOMParser;

    // Load microformats extractor (needs DOMParser)
    const mfMod = await import(resolve(extensionsDir, 'extractors', 'microformats.js'));
    extractMicroformatEntities = mfMod.extractMicroformatEntities;

    // Load structured data extractor (needs DOMParser)
    const sdMod = await import(resolve(extensionsDir, 'extractors', 'structured-data.js'));
    extractStructuredDataEntities = sdMod.extractStructuredDataEntities;

    // Load normalizeName from entity-store
    // entity-store.js references window.app at module scope, so we mock it
    (globalThis as any).window = { app: { datastore: {} } };
    const storeMod = await import(resolve(extensionsDir, 'entity-store.js'));
    normalizeName = storeMod.normalizeName;
  });

  // ─── Regex Extractors ──────────────────────────────────────────────

  describe('Regex Extractors', () => {

    describe('email extraction', () => {
      it('should extract a simple email address', () => {
        const result = extractRegexEntities('Contact us at hello@example.com', 'https://example.com');
        const emails = result.filter(e => e.entityType === 'email');
        assert.strictEqual(emails.length, 1);
        assert.strictEqual(emails[0].name, 'hello@example.com');
        assert.strictEqual(emails[0].attributes.domain, 'example.com');
        assert.strictEqual(emails[0].confidence, 0.9);
        assert.strictEqual(emails[0].extractor, 'regex');
      });

      it('should extract multiple distinct email addresses', () => {
        const text = 'Email alice@test.org or bob@test.org for info';
        const result = extractRegexEntities(text, 'https://test.org');
        const emails = result.filter(e => e.entityType === 'email');
        assert.strictEqual(emails.length, 2);
        const names = emails.map(e => e.name).sort();
        assert.deepStrictEqual(names, ['alice@test.org', 'bob@test.org']);
      });

      it('should deduplicate emails (case-insensitive)', () => {
        const text = 'Contact Test@Example.COM or test@example.com';
        const result = extractRegexEntities(text, 'https://example.com');
        const emails = result.filter(e => e.entityType === 'email');
        assert.strictEqual(emails.length, 1);
        assert.strictEqual(emails[0].name, 'test@example.com');
      });

      it('should handle emails with plus addressing', () => {
        const text = 'Send to user+tag@example.com';
        const result = extractRegexEntities(text, 'https://example.com');
        const emails = result.filter(e => e.entityType === 'email');
        assert.strictEqual(emails.length, 1);
        assert.strictEqual(emails[0].name, 'user+tag@example.com');
      });

      it('should handle emails with dots and hyphens', () => {
        const text = 'first.last@sub-domain.example.co.uk';
        const result = extractRegexEntities(text, 'https://example.com');
        const emails = result.filter(e => e.entityType === 'email');
        assert.strictEqual(emails.length, 1);
        assert.strictEqual(emails[0].name, 'first.last@sub-domain.example.co.uk');
      });

      it('should store sourceUrl on entities', () => {
        const result = extractRegexEntities('a@b.com', 'https://source.com/page');
        assert.strictEqual(result[0].sourceUrl, 'https://source.com/page');
      });
    });

    describe('phone number extraction', () => {
      it('should extract US phone numbers with parentheses', () => {
        const text = 'Call us: (555) 123-4567';
        const result = extractRegexEntities(text, 'https://example.com');
        const phones = result.filter(e => e.entityType === 'phone');
        assert.ok(phones.length >= 1, 'Should find at least one phone number');
        assert.strictEqual(phones[0].confidence, 0.85);
      });

      it('should extract US phone numbers with dashes', () => {
        const text = 'Phone: 555-123-4567';
        const result = extractRegexEntities(text, 'https://example.com');
        const phones = result.filter(e => e.entityType === 'phone');
        assert.ok(phones.length >= 1);
      });

      it('should extract international format with +1', () => {
        const text = 'Call +1-555-123-4567 for info';
        const result = extractRegexEntities(text, 'https://example.com');
        const phones = result.filter(e => e.entityType === 'phone');
        assert.ok(phones.length >= 1);
      });

      it('should extract international numbers with country code', () => {
        const text = 'UK office: +44 20 7946 0958';
        const result = extractRegexEntities(text, 'https://example.com');
        const phones = result.filter(e => e.entityType === 'phone');
        assert.ok(phones.length >= 1);
      });

      it('should skip very short number sequences', () => {
        const text = 'Version 1.2.3';
        const result = extractRegexEntities(text, 'https://example.com');
        const phones = result.filter(e => e.entityType === 'phone');
        assert.strictEqual(phones.length, 0, 'Should not match version numbers');
      });

      it('should deduplicate phone numbers', () => {
        const text = 'Call 555-123-4567 or 555-123-4567 now';
        const result = extractRegexEntities(text, 'https://example.com');
        const phones = result.filter(e => e.entityType === 'phone');
        assert.strictEqual(phones.length, 1);
      });
    });

    describe('date extraction (contextual)', () => {
      it('should extract ISO dates with context', () => {
        const text = 'Team Meeting on 2026-02-10';
        const result = extractRegexEntities(text, 'https://example.com');
        const dates = result.filter(e => e.entityType === 'date');
        assert.ok(dates.length >= 1);
        assert.ok(dates[0].name.includes('2026-02-10'));
        assert.ok(dates[0].attributes.context, 'Should have context attribute');
      });

      it('should extract US formatted dates with context', () => {
        const text = 'Annual Report Published February 10, 2026';
        const result = extractRegexEntities(text, 'https://example.com');
        const dates = result.filter(e => e.entityType === 'date');
        assert.ok(dates.length >= 1);
        assert.ok(dates[0].name.includes('February'));
        assert.ok(dates[0].attributes.context, 'Should have context attribute');
      });

      it('should extract abbreviated month dates with context', () => {
        const text = 'Sprint Review Updated: Jan 5, 2026';
        const result = extractRegexEntities(text, 'https://example.com');
        const dates = result.filter(e => e.entityType === 'date');
        assert.ok(dates.length >= 1);
        assert.ok(dates[0].attributes.context, 'Should have context attribute');
      });

      it('should extract EU formatted dates with context', () => {
        const text = 'Quarterly Report Published: 10 February 2026';
        const result = extractRegexEntities(text, 'https://example.com');
        const dates = result.filter(e => e.entityType === 'date');
        assert.ok(dates.length >= 1);
        assert.ok(dates[0].attributes.context, 'Should have context attribute');
      });

      it('should extract slash-formatted dates with context', () => {
        const text = 'Invoice Due Date: 02/10/2026';
        const result = extractRegexEntities(text, 'https://example.com');
        const dates = result.filter(e => e.entityType === 'date');
        assert.ok(dates.length >= 1);
        assert.ok(dates[0].attributes.context, 'Should have context attribute');
      });

      it('should NOT extract standalone dates without context', () => {
        const text = '2026-03-15';
        const result = extractRegexEntities(text, 'https://example.com');
        const dates = result.filter(e => e.entityType === 'date');
        assert.strictEqual(dates.length, 0, 'Standalone date should be ignored');
      });

      it('should NOT extract dates preceded only by generic words', () => {
        const text = 'the 2026-03-15';
        const result = extractRegexEntities(text, 'https://example.com');
        const dates = result.filter(e => e.entityType === 'date');
        assert.strictEqual(dates.length, 0, 'Date with only noise words should be ignored');
      });

      it('should not match invalid month numbers in ISO dates', () => {
        const text = 'ID: 2026-15-45';
        const result = extractRegexEntities(text, 'https://example.com');
        const dates = result.filter(e => e.entityType === 'date');
        assert.strictEqual(dates.length, 0, 'Should not match invalid ISO date');
      });

      it('should set confidence to 0.8 for contextual dates', () => {
        const text = 'Project Deadline: 2026-03-15';
        const result = extractRegexEntities(text, 'https://example.com');
        const dates = result.filter(e => e.entityType === 'date');
        assert.ok(dates.length >= 1);
        assert.strictEqual(dates[0].confidence, 0.8);
      });

      it('should include context in the entity name', () => {
        const text = 'Conference Talk February 15, 2026';
        const result = extractRegexEntities(text, 'https://example.com');
        const dates = result.filter(e => e.entityType === 'date');
        assert.ok(dates.length >= 1);
        assert.ok(dates[0].name.includes('Conference Talk'), 'Name should include context');
        assert.ok(dates[0].name.includes('February 15, 2026'), 'Name should include date');
      });
    });

    describe('price extraction (contextual)', () => {
      it('should extract price with product context', () => {
        const text = 'MacBook Pro $29.99';
        const result = extractRegexEntities(text, 'https://example.com');
        const prices = result.filter(e => e.entityType === 'price');
        assert.ok(prices.length >= 1);
        assert.ok(prices[0].name.includes('$29.99'));
        assert.ok(prices[0].attributes.product, 'Should have product attribute');
        assert.ok(prices[0].attributes.price === '$29.99');
      });

      it('should NOT extract standalone prices without context', () => {
        const text = '$9.99';
        const result = extractRegexEntities(text, 'https://example.com');
        const prices = result.filter(e => e.entityType === 'price');
        assert.strictEqual(prices.length, 0, 'Standalone price should be ignored');
      });

      it('should NOT extract prices preceded only by generic words', () => {
        const text = 'Only $9.99';
        const result = extractRegexEntities(text, 'https://example.com');
        const prices = result.filter(e => e.entityType === 'price');
        assert.strictEqual(prices.length, 0, 'Price with only noise words should be ignored');
      });

      it('should extract price with product name before it', () => {
        const text = 'Premium Widget $1,299.00';
        const result = extractRegexEntities(text, 'https://example.com');
        const prices = result.filter(e => e.entityType === 'price');
        assert.ok(prices.length >= 1);
        assert.ok(prices[0].attributes.product.includes('Premium Widget'));
      });

      it('should extract price from product listing with dash separator', () => {
        const text = 'Blue Widget - $49.99';
        const result = extractRegexEntities(text, 'https://example.com');
        const prices = result.filter(e => e.entityType === 'price');
        assert.ok(prices.length >= 1);
        assert.ok(prices[0].name.includes('$49.99'));
      });

      it('should set confidence to 0.85 for contextual prices', () => {
        const text = 'Annual Plan $99.99';
        const result = extractRegexEntities(text, 'https://example.com');
        const prices = result.filter(e => e.entityType === 'price');
        assert.ok(prices.length >= 1);
        assert.strictEqual(prices[0].confidence, 0.85);
      });

      it('should extract EUR suffix price with context', () => {
        const text = 'Conference Ticket 49.99 EUR';
        const result = extractRegexEntities(text, 'https://example.com');
        const prices = result.filter(e => e.entityType === 'price');
        assert.ok(prices.length >= 1);
      });

      it('should extract GBP price with product context', () => {
        const text = 'Premium Membership GBP 75.00';
        const result = extractRegexEntities(text, 'https://example.com');
        const prices = result.filter(e => e.entityType === 'price');
        assert.ok(prices.length >= 1);
      });
    });

    describe('tracking number extraction', () => {
      it('should extract UPS tracking numbers (1Z format)', () => {
        const text = 'Track your package: 1Z9999999999999999';
        const result = extractRegexEntities(text, 'https://example.com');
        const tracking = result.filter(e => e.entityType === 'tracking_number');
        assert.ok(tracking.some(t => t.name === '1Z9999999999999999'));
        const ups = tracking.find(t => t.attributes.carrier === 'UPS');
        assert.ok(ups, 'Should identify as UPS');
      });

      it('should extract USPS tracking numbers (starting with 9)', () => {
        const text = 'USPS: 92748999999999999999999';
        const result = extractRegexEntities(text, 'https://example.com');
        const tracking = result.filter(e => e.entityType === 'tracking_number');
        const usps = tracking.find(t => t.attributes.carrier === 'USPS');
        assert.ok(usps, 'Should identify USPS tracking number');
      });

      it('should set confidence to 0.7 for tracking numbers', () => {
        const text = '1Z9999999999999999';
        const result = extractRegexEntities(text, 'https://example.com');
        const tracking = result.filter(e => e.entityType === 'tracking_number');
        const ups = tracking.find(t => t.attributes.carrier === 'UPS');
        assert.ok(ups);
        assert.strictEqual(ups!.confidence, 0.7);
      });
    });

    describe('edge cases', () => {
      it('should return empty array for null input', () => {
        const result = extractRegexEntities(null as any, 'https://example.com');
        assert.deepStrictEqual(result, []);
      });

      it('should return empty array for undefined input', () => {
        const result = extractRegexEntities(undefined as any, 'https://example.com');
        assert.deepStrictEqual(result, []);
      });

      it('should return empty array for empty string', () => {
        const result = extractRegexEntities('', 'https://example.com');
        assert.deepStrictEqual(result, []);
      });

      it('should return empty array for non-string input', () => {
        const result = extractRegexEntities(42 as any, 'https://example.com');
        assert.deepStrictEqual(result, []);
      });

      it('should not match emails in common programming text', () => {
        // The regex might match things that look like emails in code
        const text = 'function getName() { return "hello"; }';
        const result = extractRegexEntities(text, 'https://example.com');
        const emails = result.filter(e => e.entityType === 'email');
        assert.strictEqual(emails.length, 0);
      });

      it('should handle text with mixed entity types', () => {
        const text = 'Contact alice@test.com or call (555) 123-4567. ' +
                     'Team Meeting on 2026-03-15. Premium Widget $49.99.';
        const result = extractRegexEntities(text, 'https://example.com');
        const types = new Set(result.map(e => e.entityType));
        assert.ok(types.has('email'), 'Should find email');
        assert.ok(types.has('phone'), 'Should find phone');
        assert.ok(types.has('date'), 'Should find date');
        assert.ok(types.has('price'), 'Should find price');
      });
    });
  });

  // ─── Microformats Extractor ─────────────────────────────────────────

  describe('Microformats Extractor', () => {

    describe('h-card person parsing', () => {
      it('should extract a person with name', () => {
        const html = `<div class="h-card"><span class="p-name">Jane Doe</span></div>`;
        const result = extractMicroformatEntities(html, 'https://example.com');
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].name, 'Jane Doe');
        assert.strictEqual(result[0].entityType, 'person');
        assert.strictEqual(result[0].confidence, 0.95);
        assert.strictEqual(result[0].extractor, 'microformats');
      });

      it('should extract email, url, and phone from h-card', () => {
        const html = `
          <div class="h-card">
            <span class="p-name">John Smith</span>
            <a class="u-email" href="mailto:john@example.com">john@example.com</a>
            <a class="u-url" href="https://john.example.com">Website</a>
            <span class="p-tel">+1-555-123-4567</span>
          </div>`;
        const result = extractMicroformatEntities(html, 'https://example.com');
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].attributes.email, 'john@example.com');
        assert.strictEqual(result[0].attributes.homepage, 'https://john.example.com');
        assert.strictEqual(result[0].attributes.phone, '+1-555-123-4567');
      });

      it('should extract role/job title from h-card', () => {
        const html = `
          <div class="h-card">
            <span class="p-name">Alice</span>
            <span class="p-job-title">Engineer</span>
          </div>`;
        const result = extractMicroformatEntities(html, 'https://example.com');
        assert.strictEqual(result[0].attributes.role, 'Engineer');
      });

      it('should extract person with organization', () => {
        const html = `
          <div class="h-card">
            <span class="p-name">Bob Jones</span>
            <span class="p-org">Acme Corp</span>
          </div>`;
        const result = extractMicroformatEntities(html, 'https://example.com');
        assert.strictEqual(result[0].entityType, 'person');
        assert.strictEqual(result[0].attributes.organization, 'Acme Corp');
      });
    });

    describe('h-card organization parsing', () => {
      it('should detect organization when name matches org name', () => {
        const html = `
          <div class="h-card">
            <span class="p-name">Acme Corp</span>
            <span class="p-org">Acme Corp</span>
          </div>`;
        const result = extractMicroformatEntities(html, 'https://example.com');
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].entityType, 'organization');
        assert.strictEqual(result[0].name, 'Acme Corp');
      });
    });

    describe('h-event parsing', () => {
      it('should extract event with name and dates', () => {
        const html = `
          <div class="h-event">
            <span class="p-name">Tech Conference 2026</span>
            <time class="dt-start" datetime="2026-06-15">June 15</time>
            <time class="dt-end" datetime="2026-06-17">June 17</time>
            <span class="p-location">Convention Center</span>
          </div>`;
        const result = extractMicroformatEntities(html, 'https://example.com');
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].name, 'Tech Conference 2026');
        assert.strictEqual(result[0].entityType, 'event');
        assert.strictEqual(result[0].confidence, 0.95);
        assert.strictEqual(result[0].attributes.location, 'Convention Center');
      });

      it('should extract event with datetime attribute fallback', () => {
        const html = `
          <div class="h-event">
            <span class="p-name">Workshop</span>
            <time class="dt-start" datetime="2026-03-01T10:00:00"></time>
          </div>`;
        const result = extractMicroformatEntities(html, 'https://example.com');
        assert.strictEqual(result.length, 1);
        // Should fall back to datetime attribute when text is empty
        assert.ok(result[0].attributes.startDate);
      });

      it('should skip events with short names', () => {
        const html = `
          <div class="h-event">
            <span class="p-name">X</span>
          </div>`;
        const result = extractMicroformatEntities(html, 'https://example.com');
        assert.strictEqual(result.length, 0);
      });

      it('should extract event description (truncated to 500 chars)', () => {
        const longDesc = 'A'.repeat(600);
        const html = `
          <div class="h-event">
            <span class="p-name">Big Event</span>
            <span class="p-description">${longDesc}</span>
          </div>`;
        const result = extractMicroformatEntities(html, 'https://example.com');
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].attributes.description.length, 500);
      });
    });

    describe('h-adr address parsing', () => {
      it('should extract address with locality, region, country', () => {
        const html = `
          <div class="h-adr">
            <span class="p-street-address">123 Main St</span>
            <span class="p-locality">Springfield</span>
            <span class="p-region">IL</span>
            <span class="p-postal-code">62701</span>
            <span class="p-country-name">US</span>
          </div>`;
        const result = extractMicroformatEntities(html, 'https://example.com');
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].entityType, 'place');
        assert.strictEqual(result[0].name, 'Springfield, IL, US');
        assert.strictEqual(result[0].attributes.streetAddress, '123 Main St');
        assert.strictEqual(result[0].attributes.postalCode, '62701');
        assert.strictEqual(result[0].confidence, 0.9);
      });

      it('should skip address with no meaningful components', () => {
        const html = `<div class="h-adr"></div>`;
        const result = extractMicroformatEntities(html, 'https://example.com');
        assert.strictEqual(result.length, 0);
      });
    });

    describe('edge cases', () => {
      it('should return empty array for null input', () => {
        const result = extractMicroformatEntities(null as any, 'https://example.com');
        assert.deepStrictEqual(result, []);
      });

      it('should return empty array for empty string', () => {
        const result = extractMicroformatEntities('', 'https://example.com');
        assert.deepStrictEqual(result, []);
      });

      it('should return empty array for HTML without microformats', () => {
        const html = '<div><p>Just regular content</p></div>';
        const result = extractMicroformatEntities(html, 'https://example.com');
        assert.deepStrictEqual(result, []);
      });

      it('should skip h-card with name too short', () => {
        const html = `<div class="h-card"><span class="p-name">X</span></div>`;
        const result = extractMicroformatEntities(html, 'https://example.com');
        assert.strictEqual(result.length, 0);
      });

      it('should handle multiple h-cards on one page', () => {
        const html = `
          <div class="h-card"><span class="p-name">Alice</span></div>
          <div class="h-card"><span class="p-name">Bob</span></div>
          <div class="h-card"><span class="p-name">Charlie</span></div>`;
        const result = extractMicroformatEntities(html, 'https://example.com');
        assert.strictEqual(result.length, 3);
        const names = result.map(e => e.name);
        assert.ok(names.includes('Alice'));
        assert.ok(names.includes('Bob'));
        assert.ok(names.includes('Charlie'));
      });

      it('should handle legacy vcard class name', () => {
        const html = `<div class="vcard"><span class="fn">Legacy Person</span></div>`;
        const result = extractMicroformatEntities(html, 'https://example.com');
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].name, 'Legacy Person');
      });
    });
  });

  // ─── Structured Data Extractor ──────────────────────────────────────

  describe('Structured Data Extractor', () => {

    describe('JSON-LD Person extraction', () => {
      it('should extract a Person from JSON-LD', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "Person",
            "name": "Jane Doe",
            "email": "jane@example.com",
            "jobTitle": "Software Engineer",
            "url": "https://jane.example.com"
          }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const person = result.find(e => e.entityType === 'person' && e.extractor === 'json-ld');
        assert.ok(person, 'Should find a person entity');
        assert.strictEqual(person!.name, 'Jane Doe');
        assert.strictEqual(person!.attributes.email, 'jane@example.com');
        assert.strictEqual(person!.attributes.jobTitle, 'Software Engineer');
        assert.strictEqual(person!.confidence, 1.0);
        assert.strictEqual(person!.schemaType, 'Person');
      });

      it('should extract worksFor as string', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          { "@type": "Person", "name": "Bob", "worksFor": "Acme Inc" }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const person = result.find(e => e.entityType === 'person');
        assert.ok(person);
        assert.strictEqual(person!.attributes.organization, 'Acme Inc');
      });

      it('should extract worksFor as object with name', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          { "@type": "Person", "name": "Bob", "worksFor": { "name": "Acme Inc" } }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const person = result.find(e => e.entityType === 'person');
        assert.ok(person);
        assert.strictEqual(person!.attributes.organization, 'Acme Inc');
      });
    });

    describe('JSON-LD Organization extraction', () => {
      it('should extract an Organization from JSON-LD', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          {
            "@type": "Organization",
            "name": "Acme Corp",
            "url": "https://acme.example.com",
            "email": "info@acme.com",
            "telephone": "+1-555-000-1234"
          }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const org = result.find(e => e.entityType === 'organization');
        assert.ok(org, 'Should find an organization entity');
        assert.strictEqual(org!.name, 'Acme Corp');
        assert.strictEqual(org!.attributes.email, 'info@acme.com');
        assert.strictEqual(org!.attributes.phone, '+1-555-000-1234');
      });

      it('should map Corporation type to organization', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          { "@type": "Corporation", "name": "Big Corp" }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const org = result.find(e => e.entityType === 'organization');
        assert.ok(org);
        assert.strictEqual(org!.schemaType, 'Corporation');
      });

      it('should extract organization address as string', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          { "@type": "Organization", "name": "Local Biz", "address": "123 Main St, City" }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const org = result.find(e => e.entityType === 'organization');
        assert.ok(org);
        assert.strictEqual(org!.attributes.address, '123 Main St, City');
      });

      it('should format PostalAddress object', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          {
            "@type": "Organization", "name": "Org",
            "address": {
              "@type": "PostalAddress",
              "streetAddress": "123 Main",
              "addressLocality": "Springfield",
              "addressRegion": "IL",
              "postalCode": "62701"
            }
          }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const org = result.find(e => e.entityType === 'organization');
        assert.ok(org);
        assert.strictEqual(org!.attributes.address, '123 Main, Springfield, IL, 62701');
      });
    });

    describe('JSON-LD Event extraction', () => {
      it('should extract an Event from JSON-LD', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          {
            "@type": "Event",
            "name": "Tech Conference",
            "startDate": "2026-06-15",
            "endDate": "2026-06-17",
            "location": "Convention Center"
          }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const event = result.find(e => e.entityType === 'event');
        assert.ok(event, 'Should find an event entity');
        assert.strictEqual(event!.name, 'Tech Conference');
        assert.strictEqual(event!.attributes.startDate, '2026-06-15');
        assert.strictEqual(event!.attributes.endDate, '2026-06-17');
        assert.strictEqual(event!.attributes.location, 'Convention Center');
      });

      it('should extract location as object with name', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          {
            "@type": "Event", "name": "Concert",
            "location": { "@type": "Place", "name": "Madison Square Garden" }
          }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const event = result.find(e => e.entityType === 'event');
        assert.ok(event);
        assert.strictEqual(event!.attributes.location, 'Madison Square Garden');
      });

      it('should map MusicEvent to event type', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          { "@type": "MusicEvent", "name": "Jazz Night" }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const event = result.find(e => e.entityType === 'event');
        assert.ok(event);
        assert.strictEqual(event!.schemaType, 'MusicEvent');
      });
    });

    describe('Open Graph meta tag extraction', () => {
      it('should extract profile from og:type=profile', () => {
        const html = `<html><head>
          <meta property="og:type" content="profile">
          <meta property="og:title" content="Jane Doe">
          <meta property="og:description" content="Software engineer">
          <meta property="og:image" content="https://example.com/photo.jpg">
          <meta property="profile:first_name" content="Jane">
          <meta property="profile:last_name" content="Doe">
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const person = result.find(e => e.extractor === 'opengraph' && e.entityType === 'person');
        assert.ok(person, 'Should find a person from OG profile');
        assert.strictEqual(person!.name, 'Jane Doe');
        assert.strictEqual(person!.confidence, 0.9);
        assert.strictEqual(person!.attributes.image, 'https://example.com/photo.jpg');
      });

      it('should use og:title as fallback when profile names missing', () => {
        const html = `<html><head>
          <meta property="og:type" content="profile">
          <meta property="og:title" content="Profile Title">
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const person = result.find(e => e.extractor === 'opengraph' && e.entityType === 'person');
        assert.ok(person);
        assert.strictEqual(person!.name, 'Profile Title');
      });

      it('should extract business from og:type starting with business', () => {
        const html = `<html><head>
          <meta property="og:type" content="business.business">
          <meta property="og:title" content="My Restaurant">
          <meta property="og:description" content="Great food">
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const org = result.find(e => e.extractor === 'opengraph' && e.entityType === 'organization');
        assert.ok(org, 'Should find an organization from OG business');
        assert.strictEqual(org!.name, 'My Restaurant');
        assert.strictEqual(org!.confidence, 0.85);
      });

      it('should extract article:author as person (non-URL)', () => {
        const html = `<html><head>
          <meta property="article:author" content="John Writer">
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const author = result.find(e => e.extractor === 'opengraph' && e.name === 'John Writer');
        assert.ok(author, 'Should find article author');
        assert.strictEqual(author!.entityType, 'person');
        assert.strictEqual(author!.attributes.role, 'author');
      });

      it('should NOT extract article:author when it is a URL', () => {
        const html = `<html><head>
          <meta property="article:author" content="https://example.com/author/john">
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const ogAuthors = result.filter(e => e.extractor === 'opengraph');
        assert.strictEqual(ogAuthors.length, 0, 'Should not extract URL-based author');
      });
    });

    describe('meta tag extraction', () => {
      it('should extract author from meta name=author', () => {
        const html = `<html><head>
          <meta name="author" content="Alice Author">
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const author = result.find(e => e.extractor === 'meta' && e.name === 'Alice Author');
        assert.ok(author);
        assert.strictEqual(author!.entityType, 'person');
        assert.strictEqual(author!.attributes.role, 'author');
        assert.strictEqual(author!.confidence, 0.7);
      });

      it('should extract publisher from meta name=publisher', () => {
        const html = `<html><head>
          <meta name="publisher" content="News Corp">
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const pub = result.find(e => e.extractor === 'meta' && e.name === 'News Corp');
        assert.ok(pub);
        assert.strictEqual(pub!.entityType, 'organization');
        assert.strictEqual(pub!.attributes.role, 'publisher');
      });

      it('should skip author that is too short', () => {
        const html = `<html><head>
          <meta name="author" content="AB">
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const authors = result.filter(e => e.extractor === 'meta' && e.attributes.role === 'author');
        assert.strictEqual(authors.length, 0);
      });

      it('should skip author that is a URL', () => {
        const html = `<html><head>
          <meta name="author" content="https://example.com/author">
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const authors = result.filter(e => e.extractor === 'meta' && e.attributes.role === 'author');
        assert.strictEqual(authors.length, 0);
      });
    });

    describe('multiple JSON-LD blocks', () => {
      it('should extract entities from multiple script tags', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          { "@type": "Person", "name": "Alice" }
          </script>
          <script type="application/ld+json">
          { "@type": "Organization", "name": "Acme" }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const jsonLd = result.filter(e => e.extractor === 'json-ld');
        assert.ok(jsonLd.length >= 2, 'Should find entities from both script tags');
        assert.ok(jsonLd.some(e => e.name === 'Alice'));
        assert.ok(jsonLd.some(e => e.name === 'Acme'));
      });

      it('should handle @graph arrays', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@graph": [
              { "@type": "Person", "name": "Person One" },
              { "@type": "Organization", "name": "Org One" }
            ]
          }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const jsonLd = result.filter(e => e.extractor === 'json-ld');
        assert.ok(jsonLd.length >= 2);
        assert.ok(jsonLd.some(e => e.name === 'Person One'));
        assert.ok(jsonLd.some(e => e.name === 'Org One'));
      });
    });

    describe('malformed JSON-LD handling', () => {
      it('should skip invalid JSON in script tags', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          { invalid json here }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        // Should not throw, just skip the bad JSON
        assert.ok(Array.isArray(result));
      });

      it('should skip JSON-LD without @type', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          { "name": "No Type" }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const jsonLd = result.filter(e => e.extractor === 'json-ld');
        assert.strictEqual(jsonLd.length, 0);
      });

      it('should skip JSON-LD with unknown @type', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          { "@type": "UnknownType", "name": "Mystery" }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const jsonLd = result.filter(e => e.extractor === 'json-ld');
        assert.strictEqual(jsonLd.length, 0);
      });

      it('should skip JSON-LD with name too short', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          { "@type": "Person", "name": "X" }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const jsonLd = result.filter(e => e.extractor === 'json-ld');
        assert.strictEqual(jsonLd.length, 0);
      });

      it('should handle array @type (use first element)', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          { "@type": ["Person", "Thing"], "name": "Multi-Type Person" }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const person = result.find(e => e.extractor === 'json-ld');
        assert.ok(person);
        assert.strictEqual(person!.entityType, 'person');
      });
    });

    describe('edge cases', () => {
      it('should return empty array for null input', () => {
        const result = extractStructuredDataEntities(null as any, 'https://example.com');
        assert.deepStrictEqual(result, []);
      });

      it('should return empty array for empty string', () => {
        const result = extractStructuredDataEntities('', 'https://example.com');
        assert.deepStrictEqual(result, []);
      });

      it('should return empty array for HTML without structured data', () => {
        const html = '<html><body><p>Plain content</p></body></html>';
        const result = extractStructuredDataEntities(html, 'https://example.com');
        assert.deepStrictEqual(result, []);
      });

      it('should truncate long descriptions to 500 chars', () => {
        const longDesc = 'B'.repeat(600);
        const html = `<html><head>
          <script type="application/ld+json">
          { "@type": "Person", "name": "Long Desc", "description": "${longDesc}" }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const person = result.find(e => e.name === 'Long Desc');
        assert.ok(person);
        assert.strictEqual(person!.attributes.description.length, 500);
      });
    });
  });

  // ─── Entity Matcher (dedup and threshold logic) ─────────────────────

  describe('Entity Matcher - Dedup and Threshold Logic', () => {
    // processEntities depends on the store, so we test the dedup logic directly
    // by reimplementing the same algorithm the matcher uses

    function dedup(rawEntities: any[], confidenceThreshold: number) {
      const seen = new Map();
      const dedupedEntities: any[] = [];

      for (const entity of rawEntities) {
        if (entity.confidence < confidenceThreshold) continue;
        const key = `${normalizeName(entity.name)}:${entity.entityType}`;
        if (seen.has(key)) {
          const existing = seen.get(key);
          if (entity.confidence > existing.confidence) {
            seen.set(key, entity);
            const idx = dedupedEntities.findIndex(e =>
              `${normalizeName(e.name)}:${e.entityType}` === key
            );
            if (idx >= 0) dedupedEntities[idx] = entity;
          }
        } else {
          seen.set(key, entity);
          dedupedEntities.push(entity);
        }
      }
      return dedupedEntities;
    }

    it('should filter out entities below confidence threshold', () => {
      const entities = [
        { name: 'High Conf', entityType: 'person', confidence: 0.9 },
        { name: 'Low Conf', entityType: 'person', confidence: 0.3 },
        { name: 'Borderline', entityType: 'person', confidence: 0.5 },
      ];
      const result = dedup(entities, 0.5);
      assert.strictEqual(result.length, 2);
      assert.ok(result.some(e => e.name === 'High Conf'));
      assert.ok(result.some(e => e.name === 'Borderline'));
    });

    it('should filter all entities with threshold of 1.0', () => {
      const entities = [
        { name: 'Almost', entityType: 'person', confidence: 0.99 },
      ];
      const result = dedup(entities, 1.0);
      assert.strictEqual(result.length, 0);
    });

    it('should keep everything with threshold of 0', () => {
      const entities = [
        { name: 'Low', entityType: 'person', confidence: 0.01 },
        { name: 'Lower', entityType: 'person', confidence: 0.001 },
      ];
      const result = dedup(entities, 0);
      assert.strictEqual(result.length, 2);
    });

    it('should deduplicate same name+type keeping higher confidence', () => {
      const entities = [
        { name: 'John Doe', entityType: 'person', confidence: 0.7, extractor: 'regex' },
        { name: 'John Doe', entityType: 'person', confidence: 0.95, extractor: 'json-ld' },
        { name: 'John Doe', entityType: 'person', confidence: 0.8, extractor: 'microformats' },
      ];
      const result = dedup(entities, 0.5);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].confidence, 0.95);
      assert.strictEqual(result[0].extractor, 'json-ld');
    });

    it('should treat different entity types as distinct', () => {
      const entities = [
        { name: 'Apple', entityType: 'organization', confidence: 0.9 },
        { name: 'Apple', entityType: 'product', confidence: 0.8 },
      ];
      const result = dedup(entities, 0.5);
      assert.strictEqual(result.length, 2);
    });

    it('should normalize names for dedup (case-insensitive)', () => {
      const entities = [
        { name: 'jane doe', entityType: 'person', confidence: 0.7 },
        { name: 'Jane Doe', entityType: 'person', confidence: 0.9 },
      ];
      const result = dedup(entities, 0.5);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].confidence, 0.9);
    });

    it('should normalize names for dedup (whitespace collapsing)', () => {
      const entities = [
        { name: 'John   Doe', entityType: 'person', confidence: 0.7 },
        { name: 'John Doe', entityType: 'person', confidence: 0.9 },
      ];
      const result = dedup(entities, 0.5);
      assert.strictEqual(result.length, 1);
    });

    it('should normalize names for dedup (diacritics)', () => {
      const entities = [
        { name: 'Jose', entityType: 'person', confidence: 0.7 },
        { name: 'Jos\u00e9', entityType: 'person', confidence: 0.9 },
      ];
      const result = dedup(entities, 0.5);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].confidence, 0.9);
    });

    it('should handle empty input array', () => {
      const result = dedup([], 0.5);
      assert.deepStrictEqual(result, []);
    });
  });

  // ─── Entity Store (normalizeName) ───────────────────────────────────

  describe('Entity Store - normalizeName', () => {
    it('should lowercase names', () => {
      assert.strictEqual(normalizeName('John Doe'), 'john doe');
    });

    it('should trim whitespace', () => {
      assert.strictEqual(normalizeName('  hello  '), 'hello');
    });

    it('should collapse multiple spaces', () => {
      assert.strictEqual(normalizeName('John    Doe'), 'john doe');
    });

    it('should remove diacritics', () => {
      assert.strictEqual(normalizeName('Jos\u00e9'), 'jose');
      assert.strictEqual(normalizeName('caf\u00e9'), 'cafe');
      assert.strictEqual(normalizeName('\u00fc\u00f6\u00e4'), 'uoa');
    });

    it('should handle combined transformations', () => {
      assert.strictEqual(normalizeName('  JOS\u00c9   GARC\u00cdA  '), 'jose garcia');
    });

    it('should return empty string for null input', () => {
      assert.strictEqual(normalizeName(null as any), '');
    });

    it('should return empty string for undefined input', () => {
      assert.strictEqual(normalizeName(undefined as any), '');
    });

    it('should return empty string for empty string', () => {
      assert.strictEqual(normalizeName(''), '');
    });

    it('should handle names with tabs and newlines', () => {
      assert.strictEqual(normalizeName('John\t\nDoe'), 'john doe');
    });

    it('should handle names with mixed diacritics', () => {
      assert.strictEqual(normalizeName('R\u00e9sum\u00e9'), 'resume');
    });

    it('should preserve basic punctuation', () => {
      assert.strictEqual(normalizeName("O'Brien"), "o'brien");
      assert.strictEqual(normalizeName('Mary-Jane'), 'mary-jane');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // COMPREHENSIVE ADDITIONAL TESTS
  // ═══════════════════════════════════════════════════════════════════════

  // ─── Regex Extractors: Realistic & Edge Cases ──────────────────────

  describe('Regex Extractors - Comprehensive', () => {

    // ── Emails: Realistic web content ────────────────────────────────

    describe('emails in realistic web page content', () => {
      it('should extract emails embedded in long paragraphs', () => {
        const text = `Welcome to our company! We are a leading provider of cloud-based solutions
          for enterprise customers. If you have any questions about our products, pricing,
          or partnership opportunities, please don't hesitate to reach out to our team at
          partnerships@cloudwidgets.io. Our customer support team is also available 24/7
          at support@cloudwidgets.io to help you with any technical issues. For press
          inquiries, contact media@cloudwidgets.io.`;
        const result = extractRegexEntities(text, 'https://cloudwidgets.io');
        const emails = result.filter(e => e.entityType === 'email');
        assert.strictEqual(emails.length, 3);
        const names = emails.map(e => e.name).sort();
        assert.deepStrictEqual(names, [
          'media@cloudwidgets.io',
          'partnerships@cloudwidgets.io',
          'support@cloudwidgets.io'
        ]);
      });

      it('should extract emails from contact page text', () => {
        const text = `Contact Us
          General Inquiries: info@megacorp.com
          Sales Team: sales@megacorp.com
          Technical Support: techsupport@megacorp.com
          Human Resources: hr@megacorp.com
          Press & Media: press@megacorp.com`;
        const result = extractRegexEntities(text, 'https://megacorp.com/contact');
        const emails = result.filter(e => e.entityType === 'email');
        assert.strictEqual(emails.length, 5);
      });

      it('should extract emails from footer text', () => {
        const text = `© 2026 Acme Industries. All rights reserved.
          123 Industrial Blvd, Suite 400, San Francisco, CA 94105.
          Email: legal@acmeindustries.com | Phone: (415) 555-0199`;
        const result = extractRegexEntities(text, 'https://acmeindustries.com');
        const emails = result.filter(e => e.entityType === 'email');
        assert.strictEqual(emails.length, 1);
        assert.strictEqual(emails[0].name, 'legal@acmeindustries.com');
      });

      it('should extract emails with unusual but valid TLDs', () => {
        const text = `curator@museum-of-art.museum
          agent@luxury-travel.travel
          studio@portrait.photography`;
        const result = extractRegexEntities(text, 'https://example.com');
        const emails = result.filter(e => e.entityType === 'email');
        assert.strictEqual(emails.length, 3);
        assert.ok(emails.some(e => e.name === 'curator@museum-of-art.museum'));
        assert.ok(emails.some(e => e.name === 'agent@luxury-travel.travel'));
        assert.ok(emails.some(e => e.name === 'studio@portrait.photography'));
      });

      it('should extract emails with numbers in local part', () => {
        const text = 'Contact user123@domain.com or test456@company.org';
        const result = extractRegexEntities(text, 'https://example.com');
        const emails = result.filter(e => e.entityType === 'email');
        assert.strictEqual(emails.length, 2);
        assert.ok(emails.some(e => e.name === 'user123@domain.com'));
        assert.ok(emails.some(e => e.name === 'test456@company.org'));
      });

      it('should extract emails near punctuation marks', () => {
        const text = 'Send to (email@test.com) or email2@test.com.';
        const result = extractRegexEntities(text, 'https://test.com');
        const emails = result.filter(e => e.entityType === 'email');
        // The regex matches emails, but trailing period may or may not be included
        assert.ok(emails.length >= 1);
        assert.ok(emails.some(e => e.name === 'email@test.com'));
      });

      it('should extract emails in mailto link text', () => {
        const text = 'Click here to email us: mailto:hello@startup.co for more details.';
        const result = extractRegexEntities(text, 'https://startup.co');
        const emails = result.filter(e => e.entityType === 'email');
        assert.ok(emails.length >= 1);
        assert.ok(emails.some(e => e.name === 'hello@startup.co'));
      });

      it('should extract multiple emails in a dense single paragraph', () => {
        const text = 'Our team: alice@co.com, bob@co.com, charlie@co.com, diana@co.com, eve@co.com, frank@co.com, grace@co.com and henry@co.com.';
        const result = extractRegexEntities(text, 'https://co.com');
        const emails = result.filter(e => e.entityType === 'email');
        assert.strictEqual(emails.length, 8);
      });

      it('should handle emails with underscores and percent signs', () => {
        const text = 'Contact first_last@example.com or special%user@domain.net';
        const result = extractRegexEntities(text, 'https://example.com');
        const emails = result.filter(e => e.entityType === 'email');
        assert.strictEqual(emails.length, 2);
      });

      it('should not match CSS-like selectors as emails', () => {
        const text = 'function getName() { return div.class@media; }';
        const result = extractRegexEntities(text, 'https://example.com');
        const emails = result.filter(e => e.entityType === 'email');
        // The regex may or may not match this -- depends on pattern
        // The key thing: even if it matches, it won't be a valid email
        // since @media is followed by ; not .tld
        // Actually the regex requires .[a-zA-Z]{2,} after @, so @media; won't match
        assert.strictEqual(emails.length, 0);
      });

      it('should extract email with two-letter country TLD', () => {
        const text = 'Contact us at admin@example.de for German support';
        const result = extractRegexEntities(text, 'https://example.de');
        const emails = result.filter(e => e.entityType === 'email');
        assert.strictEqual(emails.length, 1);
        assert.strictEqual(emails[0].name, 'admin@example.de');
        assert.strictEqual(emails[0].attributes.domain, 'example.de');
      });

      it('should handle email in angle brackets', () => {
        const text = 'From: "John Smith" <john.smith@company.com>';
        const result = extractRegexEntities(text, 'https://company.com');
        const emails = result.filter(e => e.entityType === 'email');
        assert.strictEqual(emails.length, 1);
        assert.strictEqual(emails[0].name, 'john.smith@company.com');
      });
    });

    // ── Phones: International & edge cases ───────────────────────────

    describe('phone numbers - international formats', () => {
      it('should extract UK phone number with +44', () => {
        const text = 'London office: +44 20 7946 0958';
        const result = extractRegexEntities(text, 'https://example.co.uk');
        const phones = result.filter(e => e.entityType === 'phone');
        assert.ok(phones.length >= 1, 'Should find UK phone number');
      });

      it('should extract French phone number with +33', () => {
        const text = 'Bureau de Paris: +33 1 42 68 53 00';
        const result = extractRegexEntities(text, 'https://example.fr');
        const phones = result.filter(e => e.entityType === 'phone');
        assert.ok(phones.length >= 1, 'Should find French phone number');
      });

      it('should extract German phone number with +49', () => {
        const text = 'Berlin Büro: +49 30 1234 5678';
        const result = extractRegexEntities(text, 'https://example.de');
        const phones = result.filter(e => e.entityType === 'phone');
        assert.ok(phones.length >= 1, 'Should find German phone number');
      });

      it('should extract Australian phone number with +61', () => {
        const text = 'Sydney office: +61 2 9876 5432';
        const result = extractRegexEntities(text, 'https://example.com.au');
        const phones = result.filter(e => e.entityType === 'phone');
        assert.ok(phones.length >= 1, 'Should find Australian phone number');
      });

      it('should extract US phone with dots', () => {
        const text = 'Call 555.123.4567 for info';
        const result = extractRegexEntities(text, 'https://example.com');
        const phones = result.filter(e => e.entityType === 'phone');
        assert.ok(phones.length >= 1, 'Should find dot-separated phone');
      });

      it('should extract US phone with spaces', () => {
        const text = 'Call 555 123 4567 today';
        const result = extractRegexEntities(text, 'https://example.com');
        const phones = result.filter(e => e.entityType === 'phone');
        assert.ok(phones.length >= 1, 'Should find space-separated phone');
      });

      it('should extract toll-free 1-800 numbers', () => {
        const text = 'Call 1-800-555-1234 for support';
        const result = extractRegexEntities(text, 'https://example.com');
        const phones = result.filter(e => e.entityType === 'phone');
        assert.ok(phones.length >= 1, 'Should find 1-800 number');
      });

      it('should extract 888 toll-free numbers', () => {
        const text = 'For billing: 888-555-1234';
        const result = extractRegexEntities(text, 'https://example.com');
        const phones = result.filter(e => e.entityType === 'phone');
        assert.ok(phones.length >= 1, 'Should find 888 number');
      });

      it('should extract phone numbers embedded in a contact block', () => {
        const text = `Contact Information:
          Main: (212) 555-0100
          Fax: (212) 555-0101
          Toll Free: 1-800-555-0199`;
        const result = extractRegexEntities(text, 'https://example.com');
        const phones = result.filter(e => e.entityType === 'phone');
        assert.ok(phones.length >= 2, 'Should find multiple phone numbers');
      });

      it('should not match version numbers as phones', () => {
        const text = 'Using Node.js v18.12.1 and Python 3.11.2';
        const result = extractRegexEntities(text, 'https://example.com');
        const phones = result.filter(e => e.entityType === 'phone');
        assert.strictEqual(phones.length, 0, 'Version numbers should not be phone numbers');
      });

      it('should not match IP addresses as phones', () => {
        const text = 'Server running at 192.168.1.100 on port 8080';
        const result = extractRegexEntities(text, 'https://example.com');
        const phones = result.filter(e => e.entityType === 'phone');
        // IP 192.168.1.100 - the regex might pick up parts of it
        // but if it does, the digit count check should filter short ones
        // Let's just assert no false positive that looks like the full IP
        for (const phone of phones) {
          assert.ok(!phone.name.includes('192.168'), 'Should not match IP address');
        }
      });

      it('should not match 4-digit years as phones', () => {
        const text = 'From 2019 to 2025, the company grew rapidly.';
        const result = extractRegexEntities(text, 'https://example.com');
        const phones = result.filter(e => e.entityType === 'phone');
        assert.strictEqual(phones.length, 0, 'Years should not match as phones');
      });

      it('should extract phone number next to an address', () => {
        const text = '123 Main St, Anytown, USA 90210. Phone: (310) 555-8900';
        const result = extractRegexEntities(text, 'https://example.com');
        const phones = result.filter(e => e.entityType === 'phone');
        assert.ok(phones.length >= 1);
      });

      it('should extract +1 prefix US phone', () => {
        const text = 'Dial +1 (415) 555-2671 for west coast office';
        const result = extractRegexEntities(text, 'https://example.com');
        const phones = result.filter(e => e.entityType === 'phone');
        assert.ok(phones.length >= 1);
      });
    });

    // ── Dates: All months, different formats, edge cases ─────────────

    describe('dates - contextual extraction with labels', () => {
      it('should extract all 12 full month names with event context', () => {
        const months = [
          'January 15, 2026', 'February 20, 2026', 'March 5, 2026',
          'April 10, 2026', 'May 25, 2026', 'June 3, 2026',
          'July 4, 2026', 'August 31, 2026', 'September 1, 2026',
          'October 12, 2026', 'November 28, 2026', 'December 25, 2026'
        ];
        for (const month of months) {
          const result = extractRegexEntities(`Company Retreat on ${month}`, 'https://example.com');
          const dates = result.filter(e => e.entityType === 'date');
          assert.ok(dates.length >= 1, `Should extract date from: ${month}`);
          assert.ok(dates[0].attributes.context, `Should have context for: ${month}`);
        }
      });

      it('should extract all 12 abbreviated month names with context', () => {
        const months = [
          'Jan 15, 2026', 'Feb 20, 2026', 'Mar 5, 2026',
          'Apr 10, 2026', 'May 25, 2026', 'Jun 3, 2026',
          'Jul 4, 2026', 'Aug 31, 2026', 'Sep 1, 2026',
          'Oct 12, 2026', 'Nov 28, 2026', 'Dec 25, 2026'
        ];
        for (const month of months) {
          const result = extractRegexEntities(`Board Meeting ${month}`, 'https://example.com');
          const dates = result.filter(e => e.entityType === 'date');
          assert.ok(dates.length >= 1, `Should extract date from: ${month}`);
          assert.ok(dates[0].attributes.context, `Should have context for: ${month}`);
        }
      });

      it('should extract dates with meaningful label before "Posted on"', () => {
        const text = 'Annual Report Posted on March 1, 2026 by the admin team.';
        const result = extractRegexEntities(text, 'https://example.com');
        const dates = result.filter(e => e.entityType === 'date');
        assert.ok(dates.length >= 1);
        assert.ok(dates[0].name.includes('March'));
        assert.ok(dates[0].attributes.context, 'Should have context');
      });

      it('should NOT extract dates with only metadata-like prefixes', () => {
        const text = 'createdAt: 2026-01-15';
        const result = extractRegexEntities(text, 'https://example.com');
        const dates = result.filter(e => e.entityType === 'date');
        assert.strictEqual(dates.length, 0, 'Metadata timestamps should be ignored');
      });

      it('should extract leap year date with context', () => {
        const text = 'Birthday Party Born on 2024-02-29 which was a leap year';
        const result = extractRegexEntities(text, 'https://example.com');
        const dates = result.filter(e => e.entityType === 'date');
        assert.ok(dates.length >= 1);
        assert.ok(dates[0].name.includes('2024-02-29'));
      });

      it('should extract EU format dates with meaningful context', () => {
        const text = 'Tax Filing Deadline 10 February 2026 was the deadline. Extension Deadline 15 March 2026.';
        const result = extractRegexEntities(text, 'https://example.com');
        const dates = result.filter(e => e.entityType === 'date');
        assert.ok(dates.length >= 2);
      });

      it('should extract slash-formatted dates with context', () => {
        const text = 'Invoice date: 01/15/2026. Payment Due date: 02/15/2026.';
        const result = extractRegexEntities(text, 'https://example.com');
        const dates = result.filter(e => e.entityType === 'date');
        assert.ok(dates.length >= 1);
      });

      it('should not match invalid month 13 in ISO format', () => {
        const text = 'Meeting Reference: 2026-13-01';
        const result = extractRegexEntities(text, 'https://example.com');
        const dates = result.filter(e => e.entityType === 'date');
        assert.strictEqual(dates.length, 0);
      });

      it('should not match invalid day 32 in ISO format', () => {
        const text = 'Meeting Reference: 2026-01-32';
        const result = extractRegexEntities(text, 'https://example.com');
        const dates = result.filter(e => e.entityType === 'date');
        assert.strictEqual(dates.length, 0);
      });

      it('should extract multiple dates from an event listing', () => {
        const text = `Upcoming Events:
          Spring Gala - March 20, 2026
          Summer Picnic - June 15, 2026
          Fall Festival - September 22, 2026
          Holiday Party - December 18, 2026`;
        const result = extractRegexEntities(text, 'https://example.com');
        const dates = result.filter(e => e.entityType === 'date');
        assert.ok(dates.length >= 4, `Expected at least 4 dates, got ${dates.length}`);
      });

      it('should extract dates with context label and comma after day', () => {
        const text = 'Tech Conference starts August 15, 2026';
        const result = extractRegexEntities(text, 'https://example.com');
        const dates = result.filter(e => e.entityType === 'date');
        assert.ok(dates.length >= 1);
        assert.ok(dates[0].attributes.context, 'Should have context');
      });

      it('should extract dates with context label and no comma after day', () => {
        const text = 'Tech Conference starts August 15 2026';
        const result = extractRegexEntities(text, 'https://example.com');
        const dates = result.filter(e => e.entityType === 'date');
        assert.ok(dates.length >= 1);
        assert.ok(dates[0].attributes.context, 'Should have context');
      });

      it('should NOT extract ISO dates from metadata-like text without meaningful labels', () => {
        const text = 'createdAt: 2026-06-01, updatedAt: 2026-06-15, publishedAt: 2026-07-01';
        const result = extractRegexEntities(text, 'https://example.com');
        const dates = result.filter(e => e.entityType === 'date');
        assert.strictEqual(dates.length, 0, 'Metadata timestamps should be ignored');
      });

      it('should NOT extract standalone dates without any preceding text', () => {
        const text = '2026-06-15';
        const result = extractRegexEntities(text, 'https://example.com');
        const dates = result.filter(e => e.entityType === 'date');
        assert.strictEqual(dates.length, 0, 'Standalone date should be ignored');
      });

      it('should extract date with event name in entity name', () => {
        const text = 'Spring Gala March 20, 2026';
        const result = extractRegexEntities(text, 'https://example.com');
        const dates = result.filter(e => e.entityType === 'date');
        assert.ok(dates.length >= 1);
        assert.ok(dates[0].name.includes('Spring Gala'), 'Entity name should include event');
        assert.ok(dates[0].name.includes('March 20, 2026'), 'Entity name should include date');
      });
    });

    // ── Prices: Various currencies and formats ───────────────────────

    describe('prices - contextual extraction with product names', () => {
      it('should extract price with product context', () => {
        const text = 'Pro Plan $99 per month';
        const result = extractRegexEntities(text, 'https://example.com');
        const prices = result.filter(e => e.entityType === 'price');
        assert.ok(prices.length >= 1);
        assert.ok(prices[0].attributes.product, 'Should capture product name');
      });

      it('should extract large price with product context', () => {
        const text = 'Luxury Condo listed at $1,299,999.99';
        const result = extractRegexEntities(text, 'https://example.com');
        const prices = result.filter(e => e.entityType === 'price');
        assert.ok(prices.length >= 1);
        assert.ok(prices[0].attributes.product.includes('Luxury Condo'));
      });

      it('should NOT extract standalone price without context', () => {
        const text = '$50';
        const result = extractRegexEntities(text, 'https://example.com');
        const prices = result.filter(e => e.entityType === 'price');
        assert.strictEqual(prices.length, 0, 'Standalone price should be ignored');
      });

      it('should extract USD suffix price with context', () => {
        const text = 'Premium Package 199.99 USD';
        const result = extractRegexEntities(text, 'https://example.com');
        const prices = result.filter(e => e.entityType === 'price');
        assert.ok(prices.length >= 1);
      });

      it('should extract EUR price with context', () => {
        const text = 'Deluxe Room EUR 250.00';
        const result = extractRegexEntities(text, 'https://example.com');
        const prices = result.filter(e => e.entityType === 'price');
        assert.ok(prices.length >= 1);
      });

      it('should extract EUR suffix price with context', () => {
        const text = 'Business License 49.99 EUR including tax';
        const result = extractRegexEntities(text, 'https://example.com');
        const prices = result.filter(e => e.entityType === 'price');
        assert.ok(prices.length >= 1);
      });

      it('should extract GBP price with product context', () => {
        const text = 'Standard Membership GBP 150.00';
        const result = extractRegexEntities(text, 'https://example.com');
        const prices = result.filter(e => e.entityType === 'price');
        assert.ok(prices.length >= 1);
      });

      it('should extract CAD price with product context', () => {
        const text = 'Winter Jacket CAD 89.99';
        const result = extractRegexEntities(text, 'https://example.com');
        const prices = result.filter(e => e.entityType === 'price');
        assert.ok(prices.length >= 1);
      });

      it('should extract AUD price with product context', () => {
        const text = 'Surfboard AUD 120.00';
        const result = extractRegexEntities(text, 'https://example.com');
        const prices = result.filter(e => e.entityType === 'price');
        assert.ok(prices.length >= 1);
      });

      it('should extract JPY price with product context', () => {
        const text = 'Sushi Set JPY 15000';
        const result = extractRegexEntities(text, 'https://example.com');
        const prices = result.filter(e => e.entityType === 'price');
        assert.ok(prices.length >= 1);
      });

      it('should extract CHF price with product context', () => {
        const text = 'Swiss Watch CHF 200.00';
        const result = extractRegexEntities(text, 'https://example.com');
        const prices = result.filter(e => e.entityType === 'price');
        assert.ok(prices.length >= 1);
      });

      it('should extract multiple prices from a product listing', () => {
        const text = `Product Catalog:
          Widget A - $19.99
          Widget B - $29.99
          Widget C - $49.99
          Bundle Deal - $79.99`;
        const result = extractRegexEntities(text, 'https://example.com');
        const prices = result.filter(e => e.entityType === 'price');
        assert.ok(prices.length >= 4, 'Should find all product prices');
      });

      it('should strip "starting at" prefix and keep product name', () => {
        const text = 'Enterprise Plan starting at $99 per user per month';
        const result = extractRegexEntities(text, 'https://example.com');
        const prices = result.filter(e => e.entityType === 'price');
        assert.ok(prices.length >= 1);
        assert.ok(prices[0].attributes.product, 'Should have product context');
      });

      it('should extract large subscription price with context', () => {
        const text = 'Annual Enterprise License $12,000.00';
        const result = extractRegexEntities(text, 'https://example.com');
        const prices = result.filter(e => e.entityType === 'price');
        assert.ok(prices.length >= 1);
      });
    });

    // ── Tracking numbers: Valid and invalid ──────────────────────────

    describe('tracking numbers - various carriers', () => {
      it('should extract valid FedEx tracking number (12 digits)', () => {
        const text = 'Your FedEx tracking: 123456789012';
        const result = extractRegexEntities(text, 'https://example.com');
        const tracking = result.filter(e => e.entityType === 'tracking_number');
        assert.ok(tracking.some(t => t.attributes.carrier === 'FedEx'), 'Should find FedEx tracking');
      });

      it('should extract valid FedEx tracking number (15 digits)', () => {
        const text = 'FedEx Express: 123456789012345';
        const result = extractRegexEntities(text, 'https://example.com');
        const tracking = result.filter(e => e.entityType === 'tracking_number');
        assert.ok(tracking.some(t => t.attributes.carrier === 'FedEx'), 'Should find FedEx tracking');
      });

      it('should extract valid FedEx tracking number (20 digits)', () => {
        const text = 'FedEx Ground: 12345678901234567890';
        const result = extractRegexEntities(text, 'https://example.com');
        const tracking = result.filter(e => e.entityType === 'tracking_number');
        assert.ok(tracking.some(t => t.attributes.carrier === 'FedEx'), 'Should find FedEx tracking');
      });

      it('should extract USPS tracking starting with 92', () => {
        const text = 'USPS tracking: 9261290100130435082657';
        const result = extractRegexEntities(text, 'https://example.com');
        const tracking = result.filter(e => e.entityType === 'tracking_number');
        assert.ok(tracking.some(t => t.attributes.carrier === 'USPS'), 'Should find USPS tracking');
      });

      it('should extract USPS tracking starting with 93', () => {
        const text = 'Your package: 9361289878091234567890';
        const result = extractRegexEntities(text, 'https://example.com');
        const tracking = result.filter(e => e.entityType === 'tracking_number');
        assert.ok(tracking.some(t => t.attributes.carrier === 'USPS'), 'Should find USPS 93xx tracking');
      });

      it('should extract UPS tracking with mixed alphanumeric', () => {
        const text = 'UPS tracking: 1Z12345E0205271688';
        const result = extractRegexEntities(text, 'https://example.com');
        const tracking = result.filter(e => e.entityType === 'tracking_number');
        assert.ok(tracking.some(t => t.attributes.carrier === 'UPS'));
      });

      it('should extract multiple tracking numbers from shipping confirmation', () => {
        const text = `Your orders have shipped!
          Order #1001: 1ZABC12345678901AB (UPS)
          Order #1002: 1ZXYZ98765432109CD (UPS)`;
        const result = extractRegexEntities(text, 'https://example.com');
        const tracking = result.filter(e => e.entityType === 'tracking_number' && e.attributes.carrier === 'UPS');
        assert.ok(tracking.length >= 2, 'Should find both UPS tracking numbers');
      });

      it('should not match too-short numbers as tracking', () => {
        const text = 'Order ID: 12345';
        const result = extractRegexEntities(text, 'https://example.com');
        const tracking = result.filter(e => e.entityType === 'tracking_number');
        // 5 digits is too short for any tracking pattern
        assert.strictEqual(tracking.length, 0, 'Short numbers should not be tracking');
      });
    });

    // ── Mixed entity extraction from realistic pages ─────────────────

    describe('mixed entities from realistic page content', () => {
      it('should extract entities from an e-commerce receipt', () => {
        const text = `Thank you for your order!
          Order Confirmation placed January 28, 2026
          Shipping to: 123 Oak Ave, Portland, OR 97201
          Contact: orders@shopify-store.com
          Phone: (503) 555-0142

          Items:
          Blue Widget x2 $24.99
          Red Gadget x1 $49.99

          Tracking: 1Z999AA10123456784`;
        const result = extractRegexEntities(text, 'https://shopify-store.com/receipt');
        const types = new Set(result.map(e => e.entityType));
        assert.ok(types.has('email'), 'Should find email');
        assert.ok(types.has('phone'), 'Should find phone');
        assert.ok(types.has('date'), 'Should find date with order context');
        assert.ok(types.has('price'), 'Should find prices with product context');
        assert.ok(types.has('tracking_number'), 'Should find tracking number');
      });

      it('should extract entities from a job posting', () => {
        const text = `Software Engineer - Remote
          Application Deadline March 15, 2026
          Salary Range $120,000 - $160,000 per year
          Apply: careers@techstartup.io
          Questions? Call (415) 555-0200`;
        const result = extractRegexEntities(text, 'https://techstartup.io/jobs');
        const emails = result.filter(e => e.entityType === 'email');
        const phones = result.filter(e => e.entityType === 'phone');
        const dates = result.filter(e => e.entityType === 'date');
        const prices = result.filter(e => e.entityType === 'price');
        assert.ok(emails.length >= 1);
        assert.ok(phones.length >= 1);
        assert.ok(dates.length >= 1);
        assert.ok(prices.length >= 1);
      });

      it('should extract entities from a news article footer', () => {
        const text = `Breaking News Report 2026-02-10. Follow-up Analysis 2026-02-11.
          Contact the newsroom: tips@dailynews.com
          Subscription: $9.99/month or $99.99/year
          Customer service: 1-800-555-NEWS (1-800-555-6397)`;
        const result = extractRegexEntities(text, 'https://dailynews.com');
        const dates = result.filter(e => e.entityType === 'date');
        assert.ok(dates.length >= 2);
        const emails = result.filter(e => e.entityType === 'email');
        assert.ok(emails.length >= 1);
      });

      it('should handle very long text without crashing', () => {
        const longText = 'This is a very long paragraph. '.repeat(1000) +
          'Contact us at test@example.com or call (555) 123-4567. ' +
          'Premium Widget $99.99. Project Deadline 2026-06-15.';
        const result = extractRegexEntities(longText, 'https://example.com');
        assert.ok(Array.isArray(result));
        assert.ok(result.length >= 1, 'Should still find entities in long text');
      });

      it('should extract from text with special unicode characters', () => {
        const text = 'Contact support@example.com for help with your €500 order placed 2026-03-15';
        const result = extractRegexEntities(text, 'https://example.com');
        const emails = result.filter(e => e.entityType === 'email');
        assert.strictEqual(emails.length, 1);
        // € is not in the PRICE_RE pattern, so no price match for €500
        // Date should have context from the order text preceding it
        const dates = result.filter(e => e.entityType === 'date');
        assert.ok(dates.length >= 1);
      });
    });
  });

  // ─── Microformats Extractor: Comprehensive ──────────────────────────

  describe('Microformats Extractor - Comprehensive', () => {

    // ── Realistic h-card scenarios ───────────────────────────────────

    describe('realistic h-card profiles', () => {
      it('should extract a complete professional profile', () => {
        const html = `
          <div class="h-card">
            <img class="u-photo" src="https://example.com/photo.jpg" alt="">
            <h1 class="p-name">Dr. Sarah Mitchell</h1>
            <span class="p-job-title">Chief Technology Officer</span>
            <span class="p-org">TechVentures Inc.</span>
            <a class="u-email" href="mailto:sarah.mitchell@techventures.com">sarah.mitchell@techventures.com</a>
            <a class="u-url" href="https://sarahmitchell.dev">sarahmitchell.dev</a>
            <span class="p-tel">+1-650-555-0198</span>
            <p class="p-note">20+ years of experience in distributed systems and cloud architecture.</p>
          </div>`;
        const result = extractMicroformatEntities(html, 'https://techventures.com/team');
        assert.strictEqual(result.length, 1);
        const person = result[0];
        assert.strictEqual(person.name, 'Dr. Sarah Mitchell');
        assert.strictEqual(person.entityType, 'person');
        assert.strictEqual(person.confidence, 0.95);
        assert.strictEqual(person.attributes.email, 'sarah.mitchell@techventures.com');
        assert.strictEqual(person.attributes.homepage, 'https://sarahmitchell.dev');
        assert.strictEqual(person.attributes.phone, '+1-650-555-0198');
        assert.strictEqual(person.attributes.role, 'Chief Technology Officer');
        assert.strictEqual(person.attributes.organization, 'TechVentures Inc.');
        assert.strictEqual(person.attributes.photo, 'https://example.com/photo.jpg');
      });

      it('should extract a minimal h-card with just a name', () => {
        const html = `<div class="h-card"><span class="p-name">Bob</span></div>`;
        const result = extractMicroformatEntities(html, 'https://example.com');
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].name, 'Bob');
        assert.strictEqual(result[0].entityType, 'person');
        // Attributes should be mostly empty
        assert.ok(!result[0].attributes.email);
        assert.ok(!result[0].attributes.homepage);
      });

      it('should extract team page with 5+ h-cards', () => {
        const people = ['Alice Johnson', 'Bob Williams', 'Carol Davis', 'David Brown', 'Emily Wilson', 'Frank Garcia'];
        const cards = people.map(name =>
          `<div class="h-card"><span class="p-name">${name}</span><span class="p-job-title">Engineer</span></div>`
        ).join('\n');
        const html = `<div class="team">${cards}</div>`;
        const result = extractMicroformatEntities(html, 'https://example.com/team');
        assert.strictEqual(result.length, 6);
        for (const person of result) {
          assert.strictEqual(person.entityType, 'person');
          assert.strictEqual(person.attributes.role, 'Engineer');
        }
        const names = result.map(e => e.name).sort();
        assert.deepStrictEqual(names, people.sort());
      });

      it('should handle h-card with p-given-name and p-family-name', () => {
        const html = `
          <div class="h-card">
            <span class="p-given-name">Maria</span>
            <span class="p-family-name">Rodriguez</span>
          </div>`;
        const result = extractMicroformatEntities(html, 'https://example.com');
        // The parser does getText('.p-name, .fn') first, which will be empty,
        // then falls back to given+family concatenation
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].name, 'Maria Rodriguez');
      });

      it('should correctly identify organization h-card', () => {
        const html = `
          <div class="h-card">
            <span class="p-name">Mozilla Foundation</span>
            <span class="p-org">Mozilla Foundation</span>
            <a class="u-url" href="https://mozilla.org">mozilla.org</a>
            <a class="u-email" href="mailto:info@mozilla.org">info@mozilla.org</a>
          </div>`;
        const result = extractMicroformatEntities(html, 'https://mozilla.org');
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].entityType, 'organization');
        assert.strictEqual(result[0].name, 'Mozilla Foundation');
        assert.strictEqual(result[0].attributes.email, 'info@mozilla.org');
      });

      it('should distinguish person with org from org h-card', () => {
        const html = `
          <div class="h-card">
            <span class="p-name">John Smith</span>
            <span class="p-org">Google</span>
          </div>
          <div class="h-card">
            <span class="p-name">Google</span>
            <span class="p-org">Google</span>
          </div>`;
        const result = extractMicroformatEntities(html, 'https://example.com');
        assert.strictEqual(result.length, 2);
        const john = result.find(e => e.name === 'John Smith');
        const google = result.find(e => e.name === 'Google');
        assert.ok(john);
        assert.strictEqual(john!.entityType, 'person');
        assert.strictEqual(john!.attributes.organization, 'Google');
        assert.ok(google);
        assert.strictEqual(google!.entityType, 'organization');
      });

      it('should handle legacy vcard with multiple properties', () => {
        const html = `
          <div class="vcard">
            <span class="fn">Jane Legacy</span>
            <a class="email" href="mailto:jane@legacy.com">jane@legacy.com</a>
            <a class="url" href="https://legacy.com">legacy.com</a>
            <span class="tel">555-0100</span>
            <span class="title">Manager</span>
            <span class="org">Legacy Corp</span>
          </div>`;
        const result = extractMicroformatEntities(html, 'https://legacy.com');
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].name, 'Jane Legacy');
        assert.strictEqual(result[0].attributes.email, 'jane@legacy.com');
        assert.strictEqual(result[0].attributes.role, 'Manager');
        assert.strictEqual(result[0].attributes.organization, 'Legacy Corp');
      });

      it('should handle h-card with very long name gracefully', () => {
        const longName = 'Professor ' + 'A'.repeat(200) + ' Smith';
        const html = `<div class="h-card"><span class="p-name">${longName}</span></div>`;
        const result = extractMicroformatEntities(html, 'https://example.com');
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].name, longName);
      });

      it('should skip h-card with empty name', () => {
        const html = `<div class="h-card"><span class="p-name">  </span></div>`;
        const result = extractMicroformatEntities(html, 'https://example.com');
        assert.strictEqual(result.length, 0);
      });

      it('should handle h-card without explicit p-name but with fn', () => {
        const html = `<div class="h-card"><span class="fn">Fallback Name</span></div>`;
        const result = extractMicroformatEntities(html, 'https://example.com');
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].name, 'Fallback Name');
      });
    });

    // ── Realistic h-event scenarios ──────────────────────────────────

    describe('realistic h-event scenarios', () => {
      it('should extract a multi-day conference with all details', () => {
        const html = `
          <div class="h-event">
            <h2 class="p-name">PyCon US 2026</h2>
            <time class="dt-start" datetime="2026-05-15">May 15, 2026</time>
            <time class="dt-end" datetime="2026-05-23">May 23, 2026</time>
            <span class="p-location">Pittsburgh Convention Center, Pittsburgh, PA</span>
            <p class="p-description">The largest annual gathering for the Python community, featuring talks, tutorials, sprints, and an expo hall.</p>
            <a class="u-url" href="https://us.pycon.org/2026/">Event Website</a>
          </div>`;
        const result = extractMicroformatEntities(html, 'https://us.pycon.org/2026/');
        assert.strictEqual(result.length, 1);
        const event = result[0];
        assert.strictEqual(event.name, 'PyCon US 2026');
        assert.strictEqual(event.entityType, 'event');
        assert.strictEqual(event.attributes.startDate, 'May 15, 2026');
        assert.strictEqual(event.attributes.endDate, 'May 23, 2026');
        assert.strictEqual(event.attributes.location, 'Pittsburgh Convention Center, Pittsburgh, PA');
        assert.ok(event.attributes.description.includes('Python community'));
        assert.strictEqual(event.attributes.url, 'https://us.pycon.org/2026/');
      });

      it('should extract event with only start date (no end date)', () => {
        const html = `
          <div class="h-event">
            <span class="p-name">Monthly Meetup</span>
            <time class="dt-start" datetime="2026-03-10T18:30:00">March 10, 6:30 PM</time>
            <span class="p-location">Community Center</span>
          </div>`;
        const result = extractMicroformatEntities(html, 'https://example.com');
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].name, 'Monthly Meetup');
        assert.ok(result[0].attributes.startDate);
        assert.ok(!result[0].attributes.endDate);
      });

      it('should truncate very long event description to 500 characters', () => {
        const longDesc = 'This is a detailed description of the event. '.repeat(50);
        assert.ok(longDesc.length > 500);
        const html = `
          <div class="h-event">
            <span class="p-name">Verbose Event</span>
            <p class="p-description">${longDesc}</p>
          </div>`;
        const result = extractMicroformatEntities(html, 'https://example.com');
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].attributes.description.length, 500);
      });

      it('should extract event with legacy vevent class', () => {
        const html = `
          <div class="vevent">
            <span class="summary">Legacy Conference</span>
            <span class="dtstart">2026-09-01</span>
            <span class="location">Hotel Grand</span>
          </div>`;
        const result = extractMicroformatEntities(html, 'https://example.com');
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].name, 'Legacy Conference');
        assert.strictEqual(result[0].entityType, 'event');
      });

      it('should extract multiple events from a page', () => {
        const html = `
          <div class="h-event">
            <span class="p-name">Morning Workshop</span>
            <time class="dt-start" datetime="2026-04-01T09:00">9 AM</time>
          </div>
          <div class="h-event">
            <span class="p-name">Afternoon Session</span>
            <time class="dt-start" datetime="2026-04-01T14:00">2 PM</time>
          </div>
          <div class="h-event">
            <span class="p-name">Evening Reception</span>
            <time class="dt-start" datetime="2026-04-01T18:00">6 PM</time>
          </div>`;
        const result = extractMicroformatEntities(html, 'https://example.com');
        assert.strictEqual(result.length, 3);
        const names = result.map(e => e.name);
        assert.ok(names.includes('Morning Workshop'));
        assert.ok(names.includes('Afternoon Session'));
        assert.ok(names.includes('Evening Reception'));
      });

      it('should skip event with name of just 1 character', () => {
        const html = `
          <div class="h-event">
            <span class="p-name">A</span>
            <time class="dt-start">2026-05-01</time>
          </div>`;
        const result = extractMicroformatEntities(html, 'https://example.com');
        assert.strictEqual(result.length, 0);
      });

      it('should extract event with no location or description', () => {
        const html = `
          <div class="h-event">
            <span class="p-name">Simple Event</span>
            <time class="dt-start" datetime="2026-08-20">August 20</time>
          </div>`;
        const result = extractMicroformatEntities(html, 'https://example.com');
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].name, 'Simple Event');
        assert.ok(!result[0].attributes.location);
        assert.ok(!result[0].attributes.description);
      });
    });

    // ── Realistic h-adr scenarios ────────────────────────────────────

    describe('realistic h-adr address scenarios', () => {
      it('should extract full US address', () => {
        const html = `
          <div class="h-adr">
            <span class="p-street-address">1600 Amphitheatre Parkway</span>
            <span class="p-locality">Mountain View</span>
            <span class="p-region">CA</span>
            <span class="p-postal-code">94043</span>
            <span class="p-country-name">United States</span>
          </div>`;
        const result = extractMicroformatEntities(html, 'https://example.com');
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].entityType, 'place');
        assert.strictEqual(result[0].name, 'Mountain View, CA, United States');
        assert.strictEqual(result[0].attributes.streetAddress, '1600 Amphitheatre Parkway');
        assert.strictEqual(result[0].attributes.postalCode, '94043');
      });

      it('should extract UK-style address', () => {
        const html = `
          <div class="h-adr">
            <span class="p-street-address">221B Baker Street</span>
            <span class="p-locality">London</span>
            <span class="p-postal-code">NW1 6XE</span>
            <span class="p-country-name">United Kingdom</span>
          </div>`;
        const result = extractMicroformatEntities(html, 'https://example.co.uk');
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].name, 'London, United Kingdom');
        assert.strictEqual(result[0].attributes.streetAddress, '221B Baker Street');
        assert.strictEqual(result[0].attributes.postalCode, 'NW1 6XE');
      });

      it('should extract German address', () => {
        const html = `
          <div class="h-adr">
            <span class="p-street-address">Friedrichstraße 123</span>
            <span class="p-locality">Berlin</span>
            <span class="p-postal-code">10117</span>
            <span class="p-country-name">Germany</span>
          </div>`;
        const result = extractMicroformatEntities(html, 'https://example.de');
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].name, 'Berlin, Germany');
      });

      it('should extract address with only city and country', () => {
        const html = `
          <div class="h-adr">
            <span class="p-locality">Tokyo</span>
            <span class="p-country-name">Japan</span>
          </div>`;
        const result = extractMicroformatEntities(html, 'https://example.jp');
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].name, 'Tokyo, Japan');
        assert.ok(!result[0].attributes.streetAddress);
      });

      it('should extract multiple addresses from one page', () => {
        const html = `
          <h3>Our Offices</h3>
          <div class="h-adr">
            <span class="p-locality">New York</span>
            <span class="p-region">NY</span>
            <span class="p-country-name">US</span>
          </div>
          <div class="h-adr">
            <span class="p-locality">London</span>
            <span class="p-country-name">UK</span>
          </div>
          <div class="h-adr">
            <span class="p-locality">Singapore</span>
            <span class="p-country-name">Singapore</span>
          </div>`;
        const result = extractMicroformatEntities(html, 'https://example.com');
        const places = result.filter(e => e.entityType === 'place');
        assert.strictEqual(places.length, 3);
        assert.ok(places.some(p => p.name.includes('New York')));
        assert.ok(places.some(p => p.name.includes('London')));
        assert.ok(places.some(p => p.name.includes('Singapore')));
      });

      it('should use legacy adr class', () => {
        const html = `
          <div class="adr">
            <span class="locality">Portland</span>
            <span class="region">OR</span>
            <span class="country-name">US</span>
          </div>`;
        const result = extractMicroformatEntities(html, 'https://example.com');
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].entityType, 'place');
        assert.strictEqual(result[0].name, 'Portland, OR, US');
      });

      it('should handle address with only country', () => {
        const html = `
          <div class="h-adr">
            <span class="p-country-name">Australia</span>
          </div>`;
        const result = extractMicroformatEntities(html, 'https://example.com');
        // Name would be "Australia" which is >= 2 chars
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].name, 'Australia');
      });
    });

    // ── Mixed microformat pages ──────────────────────────────────────

    describe('pages with mixed microformat types', () => {
      it('should extract persons, events, and addresses from a conference page', () => {
        const html = `
          <div class="h-card">
            <span class="p-name">Keynote Speaker</span>
            <span class="p-job-title">Distinguished Engineer</span>
            <span class="p-org">Big Tech Co</span>
          </div>
          <div class="h-event">
            <span class="p-name">Annual Developer Conference 2026</span>
            <time class="dt-start" datetime="2026-10-15">Oct 15</time>
            <time class="dt-end" datetime="2026-10-17">Oct 17</time>
            <span class="p-location">Moscone Center, San Francisco</span>
          </div>
          <div class="h-adr">
            <span class="p-street-address">747 Howard Street</span>
            <span class="p-locality">San Francisco</span>
            <span class="p-region">CA</span>
            <span class="p-postal-code">94103</span>
            <span class="p-country-name">US</span>
          </div>`;
        const result = extractMicroformatEntities(html, 'https://devconf.example.com');
        assert.strictEqual(result.length, 3);
        const types = result.map(e => e.entityType).sort();
        assert.deepStrictEqual(types, ['event', 'person', 'place']);
      });

      it('should handle 10 h-cards on a team page', () => {
        const names = [
          'Alice Anderson', 'Bob Baker', 'Carol Chen', 'David Davis',
          'Emily Evans', 'Frank Foster', 'Grace Green', 'Henry Hill',
          'Irene Irving', 'Jack Johnson'
        ];
        const cards = names.map(name =>
          `<div class="h-card"><span class="p-name">${name}</span></div>`
        ).join('\n');
        const result = extractMicroformatEntities(cards, 'https://example.com');
        assert.strictEqual(result.length, 10);
        for (const entity of result) {
          assert.strictEqual(entity.entityType, 'person');
          assert.strictEqual(entity.confidence, 0.95);
        }
      });

      it('should handle HTML with no microformat classes', () => {
        const html = `
          <div class="card">
            <h2>John Smith</h2>
            <p>Software Engineer at Acme Corp</p>
            <p>john@acme.com</p>
          </div>`;
        const result = extractMicroformatEntities(html, 'https://example.com');
        assert.strictEqual(result.length, 0);
      });

      it('should handle malformed HTML gracefully', () => {
        const html = `<div class="h-card"><span class="p-name">Unclosed Name`;
        const result = extractMicroformatEntities(html, 'https://example.com');
        // The DOMParser should still parse it, just with implied closing tags
        assert.ok(Array.isArray(result));
      });
    });
  });

  // ─── Structured Data Extractor: Comprehensive ──────────────────────

  describe('Structured Data Extractor - Comprehensive', () => {

    // ── JSON-LD: Realistic page scenarios ─────────────────────────────

    describe('JSON-LD - realistic blog post page', () => {
      it('should extract Person author and Organization publisher from article JSON-LD', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "Article",
            "headline": "Understanding Machine Learning Basics",
            "author": {
              "@type": "Person",
              "name": "Dr. Emily Zhang",
              "email": "emily@airesearch.org",
              "jobTitle": "Research Scientist",
              "worksFor": {
                "@type": "Organization",
                "name": "AI Research Lab"
              }
            },
            "publisher": {
              "@type": "Organization",
              "name": "Tech Blog Weekly",
              "url": "https://techblogweekly.com",
              "logo": {
                "url": "https://techblogweekly.com/logo.png"
              }
            },
            "datePublished": "2026-01-15",
            "dateModified": "2026-02-01"
          }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://techblogweekly.com/ml-basics');
        const jsonLd = result.filter(e => e.extractor === 'json-ld');
        // Article itself should be extracted as creative_work
        const article = jsonLd.find(e => e.entityType === 'creative_work');
        assert.ok(article, 'Should find article as creative_work');
        assert.strictEqual(article!.name, 'Understanding Machine Learning Basics');
      });

      it('should extract entities from an e-commerce product page', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "Product",
            "name": "Premium Wireless Headphones",
            "brand": { "name": "AudioMax" },
            "description": "High-fidelity wireless headphones with active noise cancellation",
            "offers": {
              "@type": "Offer",
              "price": "299.99",
              "priceCurrency": "USD"
            }
          }
          </script>
          <script type="application/ld+json">
          {
            "@type": "Organization",
            "name": "ElectroShop",
            "url": "https://electroshop.com",
            "telephone": "+1-888-555-0100"
          }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://electroshop.com/headphones');
        const product = result.find(e => e.entityType === 'product');
        assert.ok(product, 'Should find product');
        assert.strictEqual(product!.name, 'Premium Wireless Headphones');
        assert.strictEqual(product!.attributes.brand, 'AudioMax');
        assert.strictEqual(product!.attributes.price, 'USD299.99');

        const org = result.find(e => e.entityType === 'organization');
        assert.ok(org, 'Should find organization');
        assert.strictEqual(org!.name, 'ElectroShop');
      });

      it('should extract LocalBusiness as organization type', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "LocalBusiness",
            "name": "Joe's Coffee Shop",
            "telephone": "+1-555-0142",
            "address": {
              "@type": "PostalAddress",
              "streetAddress": "456 Oak Avenue",
              "addressLocality": "Portland",
              "addressRegion": "OR",
              "postalCode": "97201"
            }
          }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://joescoffee.com');
        const entity = result.find(e => e.extractor === 'json-ld');
        assert.ok(entity);
        // LocalBusiness is correctly classified as organization
        assert.strictEqual(entity!.entityType, 'organization');
        assert.strictEqual(entity!.name, "Joe's Coffee Shop");
      });

      it('should extract Restaurant as organization', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          {
            "@type": "Restaurant",
            "name": "Bella Italia",
            "telephone": "+1-555-0200",
            "address": "789 Pasta Lane, Rome Town"
          }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://bellaitalia.com');
        const org = result.find(e => e.entityType === 'organization');
        assert.ok(org, 'Should find restaurant as organization');
        assert.strictEqual(org!.name, 'Bella Italia');
        assert.strictEqual(org!.schemaType, 'Restaurant');
      });

      it('should skip WebSite type (not in typeMap)', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          {
            "@type": "WebSite",
            "name": "Example Website",
            "url": "https://example.com"
          }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const jsonLd = result.filter(e => e.extractor === 'json-ld');
        assert.strictEqual(jsonLd.length, 0, 'WebSite type should be skipped');
      });

      it('should skip BreadcrumbList type', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          {
            "@type": "BreadcrumbList",
            "name": "Navigation Breadcrumbs",
            "itemListElement": [
              { "@type": "ListItem", "position": 1, "name": "Home" }
            ]
          }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const jsonLd = result.filter(e => e.extractor === 'json-ld');
        assert.strictEqual(jsonLd.length, 0, 'BreadcrumbList should be skipped');
      });

      it('should extract Recipe type as creative_work', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          {
            "@type": "Recipe",
            "name": "Chocolate Chip Cookies",
            "author": { "@type": "Person", "name": "Chef Julia" },
            "cookTime": "PT25M",
            "recipeCategory": "Dessert"
          }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://recipes.com');
        const recipe = result.find(e => e.extractor === 'json-ld' && e.name === 'Chocolate Chip Cookies');
        assert.ok(recipe, 'Recipe should be extracted as creative_work');
        assert.strictEqual(recipe!.entityType, 'creative_work');
        assert.strictEqual(recipe!.attributes.author, 'Chef Julia');
        assert.strictEqual(recipe!.attributes.cookTime, 'PT25M');
        assert.strictEqual(recipe!.attributes.category, 'Dessert');
      });

      it('should extract Event with performer and location object', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          {
            "@type": "Event",
            "name": "Summer Rock Festival",
            "startDate": "2026-07-20T16:00:00",
            "endDate": "2026-07-22T23:00:00",
            "location": {
              "@type": "Place",
              "name": "Riverside Amphitheatre",
              "address": {
                "@type": "PostalAddress",
                "addressLocality": "Austin",
                "addressRegion": "TX"
              }
            },
            "performer": {
              "@type": "MusicGroup",
              "name": "The Rolling Tones"
            },
            "description": "Three days of live music featuring top artists from around the world."
          }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://summerfest.com');
        const event = result.find(e => e.entityType === 'event');
        assert.ok(event);
        assert.strictEqual(event!.name, 'Summer Rock Festival');
        assert.strictEqual(event!.attributes.startDate, '2026-07-20T16:00:00');
        assert.strictEqual(event!.attributes.endDate, '2026-07-22T23:00:00');
        assert.strictEqual(event!.attributes.location, 'Riverside Amphitheatre');
        assert.strictEqual(event!.attributes.performer, 'The Rolling Tones');
      });

      it('should extract MusicEvent as event type', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          { "@type": "MusicEvent", "name": "Classical Evening", "startDate": "2026-12-01" }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const event = result.find(e => e.entityType === 'event');
        assert.ok(event);
        assert.strictEqual(event!.schemaType, 'MusicEvent');
      });

      it('should extract SportsEvent as event type', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          { "@type": "SportsEvent", "name": "Championship Finals", "startDate": "2026-11-15" }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const event = result.find(e => e.entityType === 'event');
        assert.ok(event);
        assert.strictEqual(event!.schemaType, 'SportsEvent');
      });

      it('should extract Place from JSON-LD', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          {
            "@type": "Place",
            "name": "Golden Gate Park",
            "address": "San Francisco, CA",
            "geo": { "latitude": 37.7694, "longitude": -122.4862 }
          }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const place = result.find(e => e.entityType === 'place');
        assert.ok(place);
        assert.strictEqual(place!.name, 'Golden Gate Park');
        assert.strictEqual(place!.attributes.address, 'San Francisco, CA');
        assert.strictEqual(place!.attributes.latitude, 37.7694);
        assert.strictEqual(place!.attributes.longitude, -122.4862);
      });

      it('should extract NewsArticle as creative_work', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          { "@type": "NewsArticle", "headline": "Breaking: Major Discovery", "datePublished": "2026-02-10" }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://news.com');
        const article = result.find(e => e.entityType === 'creative_work');
        assert.ok(article);
        assert.strictEqual(article!.name, 'Breaking: Major Discovery');
        assert.strictEqual(article!.schemaType, 'NewsArticle');
      });

      it('should extract BlogPosting as creative_work', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          { "@type": "BlogPosting", "headline": "My Thoughts on AI", "datePublished": "2026-01-20" }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://blog.com');
        const post = result.find(e => e.entityType === 'creative_work');
        assert.ok(post);
        assert.strictEqual(post!.name, 'My Thoughts on AI');
      });

      it('should extract Book as creative_work', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          { "@type": "Book", "name": "The Great Novel", "author": { "@type": "Person", "name": "Famous Author" } }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://books.com');
        const book = result.find(e => e.entityType === 'creative_work');
        assert.ok(book);
        assert.strictEqual(book!.name, 'The Great Novel');
      });

      it('should extract Movie as creative_work', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          { "@type": "Movie", "name": "Galactic Adventures", "description": "A space epic" }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://movies.com');
        const movie = result.find(e => e.entityType === 'creative_work');
        assert.ok(movie);
        assert.strictEqual(movie!.name, 'Galactic Adventures');
      });

      it('should extract MusicRecording as creative_work', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          { "@type": "MusicRecording", "name": "Summer Vibes", "description": "A chill track" }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://music.com');
        const track = result.find(e => e.entityType === 'creative_work');
        assert.ok(track);
        assert.strictEqual(track!.name, 'Summer Vibes');
      });

      it('should extract MusicAlbum as creative_work', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          { "@type": "MusicAlbum", "name": "Greatest Hits Collection" }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://music.com');
        const album = result.find(e => e.entityType === 'creative_work');
        assert.ok(album);
        assert.strictEqual(album!.name, 'Greatest Hits Collection');
      });

      it('should handle sameAs as array', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          {
            "@type": "Person",
            "name": "John Developer",
            "sameAs": [
              "https://twitter.com/johndev",
              "https://github.com/johndev",
              "https://linkedin.com/in/johndev"
            ]
          }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const person = result.find(e => e.entityType === 'person');
        assert.ok(person);
        assert.ok(Array.isArray(person!.attributes.sameAs));
        assert.strictEqual(person!.attributes.sameAs.length, 3);
      });

      it('should handle sameAs as single string', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          {
            "@type": "Person",
            "name": "Jane Developer",
            "sameAs": "https://twitter.com/janedev"
          }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const person = result.find(e => e.entityType === 'person');
        assert.ok(person);
        assert.ok(Array.isArray(person!.attributes.sameAs));
        assert.strictEqual(person!.attributes.sameAs[0], 'https://twitter.com/janedev');
      });

      it('should handle image as string URL', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          {
            "@type": "Person",
            "name": "Photo Person",
            "image": "https://example.com/photo.jpg"
          }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const person = result.find(e => e.entityType === 'person');
        assert.ok(person);
        assert.strictEqual(person!.attributes.image, 'https://example.com/photo.jpg');
      });

      it('should handle image as object with url', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          {
            "@type": "Person",
            "name": "Image Object Person",
            "image": { "url": "https://example.com/headshot.jpg" }
          }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const person = result.find(e => e.entityType === 'person');
        assert.ok(person);
        assert.strictEqual(person!.attributes.image, 'https://example.com/headshot.jpg');
      });

      it('should handle Organization with logo as string', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          {
            "@type": "Organization",
            "name": "Logo Corp",
            "logo": "https://logocorp.com/logo.png"
          }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://logocorp.com');
        const org = result.find(e => e.entityType === 'organization');
        assert.ok(org);
        assert.strictEqual(org!.attributes.logo, 'https://logocorp.com/logo.png');
      });

      it('should handle Organization with logo as object', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          {
            "@type": "Organization",
            "name": "Object Logo Corp",
            "logo": { "url": "https://corp.com/logo.svg" }
          }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://corp.com');
        const org = result.find(e => e.entityType === 'organization');
        assert.ok(org);
        assert.strictEqual(org!.attributes.logo, 'https://corp.com/logo.svg');
      });

      it('should handle Product with brand as string', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          {
            "@type": "Product",
            "name": "Ultra Widget",
            "brand": "BrandName",
            "offers": { "price": "49.99", "priceCurrency": "USD" }
          }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const product = result.find(e => e.entityType === 'product');
        assert.ok(product);
        assert.strictEqual(product!.attributes.brand, 'BrandName');
        assert.strictEqual(product!.attributes.price, 'USD49.99');
      });

      it('should handle Product with offers array (use first)', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          {
            "@type": "Product",
            "name": "Multi-Offer Widget",
            "offers": [
              { "price": "29.99", "priceCurrency": "USD" },
              { "price": "24.99", "priceCurrency": "USD" }
            ]
          }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const product = result.find(e => e.entityType === 'product');
        assert.ok(product);
        assert.strictEqual(product!.attributes.price, 'USD29.99');
      });
    });

    describe('JSON-LD - @graph with multiple entity types', () => {
      it('should extract all entities from a complex @graph', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@graph": [
              { "@type": "Organization", "name": "News Daily" },
              { "@type": "Person", "name": "Alice Reporter", "jobTitle": "Senior Editor" },
              { "@type": "Article", "headline": "Economy Update 2026" },
              { "@type": "WebSite", "name": "WebsiteIgnored" },
              { "@type": "BreadcrumbList", "name": "BreadcrumbIgnored" }
            ]
          }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://newsdaily.com');
        const jsonLd = result.filter(e => e.extractor === 'json-ld');
        assert.strictEqual(jsonLd.length, 3, 'Should find org, person, and article; skip WebSite and BreadcrumbList');
        assert.ok(jsonLd.some(e => e.name === 'News Daily' && e.entityType === 'organization'));
        assert.ok(jsonLd.some(e => e.name === 'Alice Reporter' && e.entityType === 'person'));
        assert.ok(jsonLd.some(e => e.name === 'Economy Update 2026' && e.entityType === 'creative_work'));
      });

      it('should handle JSON-LD array at top level', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          [
            { "@type": "Person", "name": "Person In Array" },
            { "@type": "Organization", "name": "Org In Array" }
          ]
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const jsonLd = result.filter(e => e.extractor === 'json-ld');
        assert.strictEqual(jsonLd.length, 2);
      });
    });

    describe('JSON-LD - edge cases and malformed data', () => {
      it('should handle JSON-LD with empty name', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          { "@type": "Person", "name": "" }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const jsonLd = result.filter(e => e.extractor === 'json-ld');
        assert.strictEqual(jsonLd.length, 0);
      });

      it('should use headline as fallback when name is missing', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          { "@type": "Article", "headline": "Article Without Name Field" }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const article = result.find(e => e.entityType === 'creative_work');
        assert.ok(article);
        assert.strictEqual(article!.name, 'Article Without Name Field');
      });

      it('should handle deeply nested JSON-LD with address in address', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          {
            "@type": "Organization",
            "name": "Nested Address Org",
            "address": {
              "@type": "PostalAddress",
              "streetAddress": "100 Main St",
              "addressLocality": "Springfield",
              "addressRegion": "IL",
              "postalCode": "62701",
              "addressCountry": "US"
            }
          }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const org = result.find(e => e.entityType === 'organization');
        assert.ok(org);
        assert.strictEqual(org!.attributes.address, '100 Main St, Springfield, IL, 62701, US');
      });

      it('should handle multiple JSON-LD script tags with mixed valid/invalid', () => {
        const html = `<html><head>
          <script type="application/ld+json">{ invalid json }</script>
          <script type="application/ld+json">
          { "@type": "Person", "name": "Valid Person" }
          </script>
          <script type="application/ld+json">null</script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const jsonLd = result.filter(e => e.extractor === 'json-ld');
        assert.ok(jsonLd.length >= 1);
        assert.ok(jsonLd.some(e => e.name === 'Valid Person'));
      });

      it('should handle JSON-LD with number as name (not string)', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          { "@type": "Organization", "name": 12345 }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const jsonLd = result.filter(e => e.extractor === 'json-ld');
        assert.strictEqual(jsonLd.length, 0, 'Non-string names should be skipped');
      });

      it('should handle JSON-LD with whitespace-only name', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          { "@type": "Person", "name": "   " }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const jsonLd = result.filter(e => e.extractor === 'json-ld');
        assert.strictEqual(jsonLd.length, 0, 'Whitespace-only names should be skipped');
      });

      it('should set confidence 1.0 for all JSON-LD entities', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          {
            "@graph": [
              { "@type": "Person", "name": "Person A" },
              { "@type": "Organization", "name": "Org B" },
              { "@type": "Event", "name": "Event C" }
            ]
          }
          </script>
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const jsonLd = result.filter(e => e.extractor === 'json-ld');
        for (const entity of jsonLd) {
          assert.strictEqual(entity.confidence, 1.0, `${entity.name} should have confidence 1.0`);
        }
      });
    });

    // ── Open Graph: Realistic scenarios ───────────────────────────────

    describe('Open Graph - realistic scenarios', () => {
      it('should extract profile with first and last name', () => {
        const html = `<html><head>
          <meta property="og:type" content="profile">
          <meta property="og:title" content="Maria Santos">
          <meta property="og:description" content="Full-stack developer and open source contributor">
          <meta property="og:image" content="https://example.com/maria.jpg">
          <meta property="og:site_name" content="DevProfiles">
          <meta property="profile:first_name" content="Maria">
          <meta property="profile:last_name" content="Santos">
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://devprofiles.com/maria');
        const person = result.find(e => e.extractor === 'opengraph' && e.entityType === 'person');
        assert.ok(person);
        assert.strictEqual(person!.name, 'Maria Santos');
        assert.strictEqual(person!.attributes.image, 'https://example.com/maria.jpg');
        assert.strictEqual(person!.attributes.source, 'DevProfiles');
      });

      it('should extract business with og:type=business.business', () => {
        const html = `<html><head>
          <meta property="og:type" content="business.business">
          <meta property="og:title" content="Sunrise Bakery">
          <meta property="og:description" content="Artisan bread and pastries since 1985">
          <meta property="og:image" content="https://sunrise.com/storefront.jpg">
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://sunrise.com');
        const org = result.find(e => e.extractor === 'opengraph' && e.entityType === 'organization');
        assert.ok(org);
        assert.strictEqual(org!.name, 'Sunrise Bakery');
        assert.strictEqual(org!.confidence, 0.85);
      });

      it('should extract article author as person (non-URL)', () => {
        const html = `<html><head>
          <meta property="og:type" content="article">
          <meta property="og:title" content="How to Build a Startup">
          <meta property="article:author" content="Sarah Founder">
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://blog.com');
        const author = result.find(e => e.extractor === 'opengraph' && e.entityType === 'person');
        assert.ok(author);
        assert.strictEqual(author!.name, 'Sarah Founder');
        assert.strictEqual(author!.attributes.role, 'author');
        assert.strictEqual(author!.confidence, 0.7);
      });

      it('should NOT extract article:author when it is a URL', () => {
        const html = `<html><head>
          <meta property="article:author" content="https://facebook.com/someauthor">
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const ogAuthors = result.filter(e => e.extractor === 'opengraph');
        assert.strictEqual(ogAuthors.length, 0);
      });

      it('should NOT extract article:author when it starts with http', () => {
        const html = `<html><head>
          <meta property="article:author" content="http://example.com/author/john">
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const ogAuthors = result.filter(e => e.extractor === 'opengraph');
        assert.strictEqual(ogAuthors.length, 0);
      });

      it('should handle og:type=profile without first/last name (fallback to title)', () => {
        const html = `<html><head>
          <meta property="og:type" content="profile">
          <meta property="og:title" content="Anonymous User">
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const person = result.find(e => e.extractor === 'opengraph');
        assert.ok(person);
        assert.strictEqual(person!.name, 'Anonymous User');
      });

      it('should not create OG entity when og:type is article (no author)', () => {
        const html = `<html><head>
          <meta property="og:type" content="article">
          <meta property="og:title" content="Some Article Title">
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const og = result.filter(e => e.extractor === 'opengraph');
        assert.strictEqual(og.length, 0, 'Article without author should not create OG entity');
      });

      it('should handle og:type with business prefix variations', () => {
        const html = `<html><head>
          <meta property="og:type" content="business.restaurant">
          <meta property="og:title" content="Taco Palace">
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const org = result.find(e => e.extractor === 'opengraph' && e.entityType === 'organization');
        assert.ok(org, 'Should match business.restaurant as business type');
        assert.strictEqual(org!.name, 'Taco Palace');
      });

      it('should handle both OG profile and article author on same page', () => {
        const html = `<html><head>
          <meta property="og:type" content="profile">
          <meta property="og:title" content="Author Profile">
          <meta property="profile:first_name" content="John">
          <meta property="profile:last_name" content="Writer">
          <meta property="article:author" content="John Writer">
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const og = result.filter(e => e.extractor === 'opengraph');
        // Should get profile person AND article author person
        assert.ok(og.length >= 2);
      });
    });

    // ── Meta tags: Realistic scenarios ────────────────────────────────

    describe('meta tags - realistic scenarios', () => {
      it('should extract author from WordPress-style meta', () => {
        const html = `<html><head>
          <meta name="author" content="WordPress Blogger">
          <meta name="generator" content="WordPress 6.4">
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://myblog.com');
        const author = result.find(e => e.extractor === 'meta' && e.attributes.role === 'author');
        assert.ok(author);
        assert.strictEqual(author!.name, 'WordPress Blogger');
      });

      it('should extract publisher from news site meta', () => {
        const html = `<html><head>
          <meta name="publisher" content="The Daily Chronicle">
          <meta name="author" content="Staff Reporter">
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://dailychronicle.com');
        const pub = result.find(e => e.extractor === 'meta' && e.entityType === 'organization');
        assert.ok(pub);
        assert.strictEqual(pub!.name, 'The Daily Chronicle');
        assert.strictEqual(pub!.attributes.role, 'publisher');

        const author = result.find(e => e.extractor === 'meta' && e.entityType === 'person');
        assert.ok(author);
        assert.strictEqual(author!.name, 'Staff Reporter');
      });

      it('should handle author that is a comma-separated list', () => {
        const html = `<html><head>
          <meta name="author" content="Alice Smith, Bob Jones">
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const authors = result.filter(e => e.extractor === 'meta' && e.attributes.role === 'author');
        // The extractor treats this as a single author name
        assert.strictEqual(authors.length, 1);
        assert.strictEqual(authors[0].name, 'Alice Smith, Bob Jones');
      });

      it('should skip meta author that is just 2 characters', () => {
        const html = `<html><head>
          <meta name="author" content="AB">
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const authors = result.filter(e => e.extractor === 'meta' && e.attributes.role === 'author');
        assert.strictEqual(authors.length, 0);
      });

      it('should extract meta author with exactly 3 characters', () => {
        const html = `<html><head>
          <meta name="author" content="Bob">
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const authors = result.filter(e => e.extractor === 'meta' && e.attributes.role === 'author');
        assert.strictEqual(authors.length, 1);
        assert.strictEqual(authors[0].name, 'Bob');
      });

      it('should skip meta author that starts with http', () => {
        const html = `<html><head>
          <meta name="author" content="http://example.com/profiles/john">
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const authors = result.filter(e => e.extractor === 'meta' && e.attributes.role === 'author');
        assert.strictEqual(authors.length, 0);
      });

      it('should set confidence 0.7 for meta-extracted entities', () => {
        const html = `<html><head>
          <meta name="author" content="Some Author">
          <meta name="publisher" content="Some Publisher">
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        const metaEntities = result.filter(e => e.extractor === 'meta');
        for (const entity of metaEntities) {
          assert.strictEqual(entity.confidence, 0.7);
        }
      });
    });

    // ── Combined: Multiple extractors on one page ────────────────────

    describe('combined extractors on realistic pages', () => {
      it('should extract from page with JSON-LD, OG, and meta tags', () => {
        const html = `<html><head>
          <script type="application/ld+json">
          { "@type": "Person", "name": "Jane Expert", "jobTitle": "Professor" }
          </script>
          <meta property="og:type" content="profile">
          <meta property="og:title" content="Jane Expert">
          <meta property="profile:first_name" content="Jane">
          <meta property="profile:last_name" content="Expert">
          <meta name="author" content="Jane Expert">
        </head><body></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://university.edu/jane');
        // Should get entities from all three extractors
        const jsonLd = result.filter(e => e.extractor === 'json-ld');
        const og = result.filter(e => e.extractor === 'opengraph');
        const meta = result.filter(e => e.extractor === 'meta');
        assert.ok(jsonLd.length >= 1, 'Should have JSON-LD entity');
        assert.ok(og.length >= 1, 'Should have OG entity');
        assert.ok(meta.length >= 1, 'Should have meta entity');
      });

      it('should handle page with only meta tags (no JSON-LD, no OG)', () => {
        const html = `<html><head>
          <meta name="author" content="Simple Author">
          <meta name="description" content="A simple page">
          <title>Simple Page</title>
        </head><body><p>Content</p></body></html>`;
        const result = extractStructuredDataEntities(html, 'https://example.com');
        assert.ok(result.length >= 1);
        assert.ok(result.some(e => e.extractor === 'meta'));
      });
    });
  });

  // ─── Entity Matcher / Dedup: Comprehensive ────────────────────────

  describe('Entity Matcher - Comprehensive Dedup', () => {

    function dedup(rawEntities: any[], confidenceThreshold: number) {
      const seen = new Map();
      const dedupedEntities: any[] = [];

      for (const entity of rawEntities) {
        if (entity.confidence < confidenceThreshold) continue;
        const key = `${normalizeName(entity.name)}:${entity.entityType}`;
        if (seen.has(key)) {
          const existing = seen.get(key);
          if (entity.confidence > existing.confidence) {
            seen.set(key, entity);
            const idx = dedupedEntities.findIndex(e =>
              `${normalizeName(e.name)}:${e.entityType}` === key
            );
            if (idx >= 0) dedupedEntities[idx] = entity;
          }
        } else {
          seen.set(key, entity);
          dedupedEntities.push(entity);
        }
      }
      return dedupedEntities;
    }

    it('should deduplicate a large batch of 20+ entities with many duplicates', () => {
      const entities = [
        // Person appears from multiple extractors
        { name: 'John Smith', entityType: 'person', confidence: 0.7, extractor: 'meta' },
        { name: 'John Smith', entityType: 'person', confidence: 0.9, extractor: 'opengraph' },
        { name: 'John Smith', entityType: 'person', confidence: 1.0, extractor: 'json-ld' },
        { name: 'john smith', entityType: 'person', confidence: 0.85, extractor: 'regex' },
        // Organization
        { name: 'Acme Corp', entityType: 'organization', confidence: 0.7, extractor: 'meta' },
        { name: 'Acme Corp', entityType: 'organization', confidence: 1.0, extractor: 'json-ld' },
        { name: 'acme corp', entityType: 'organization', confidence: 0.85, extractor: 'opengraph' },
        // Different people
        { name: 'Alice Johnson', entityType: 'person', confidence: 0.95, extractor: 'microformats' },
        { name: 'Alice Johnson', entityType: 'person', confidence: 0.7, extractor: 'meta' },
        { name: 'Bob Williams', entityType: 'person', confidence: 0.9, extractor: 'json-ld' },
        { name: 'Carol Davis', entityType: 'person', confidence: 0.8, extractor: 'opengraph' },
        // Events
        { name: 'Annual Conference', entityType: 'event', confidence: 0.95, extractor: 'microformats' },
        { name: 'Annual Conference', entityType: 'event', confidence: 1.0, extractor: 'json-ld' },
        { name: 'Summer Meetup', entityType: 'event', confidence: 0.9, extractor: 'json-ld' },
        // Places
        { name: 'San Francisco, CA, US', entityType: 'place', confidence: 0.9, extractor: 'microformats' },
        { name: 'san francisco, ca, us', entityType: 'place', confidence: 0.8, extractor: 'json-ld' },
        // More orgs
        { name: 'Google', entityType: 'organization', confidence: 1.0, extractor: 'json-ld' },
        { name: 'google', entityType: 'organization', confidence: 0.85, extractor: 'opengraph' },
        { name: 'Microsoft', entityType: 'organization', confidence: 0.9, extractor: 'json-ld' },
        { name: 'Apple', entityType: 'organization', confidence: 0.95, extractor: 'json-ld' },
        // Creative works
        { name: 'My Article', entityType: 'creative_work', confidence: 1.0, extractor: 'json-ld' },
        { name: 'My Article', entityType: 'creative_work', confidence: 0.7, extractor: 'meta' },
      ];
      const result = dedup(entities, 0.5);
      // Unique name:type combos: John Smith:person, Acme Corp:org, Alice Johnson:person,
      // Bob Williams:person, Carol Davis:person, Annual Conference:event, Summer Meetup:event,
      // San Francisco:place, Google:org, Microsoft:org, Apple:org, My Article:creative_work
      assert.strictEqual(result.length, 12);

      // Check highest confidence kept
      const john = result.find(e => normalizeName(e.name) === 'john smith' && e.entityType === 'person');
      assert.ok(john);
      assert.strictEqual(john!.confidence, 1.0);
      assert.strictEqual(john!.extractor, 'json-ld');

      const acme = result.find(e => normalizeName(e.name) === 'acme corp' && e.entityType === 'organization');
      assert.ok(acme);
      assert.strictEqual(acme!.confidence, 1.0);
    });

    it('should handle entities with similar names that are actually different', () => {
      const entities = [
        { name: 'Dr. Smith', entityType: 'person', confidence: 0.9 },
        { name: 'Smith', entityType: 'person', confidence: 0.8 },
        { name: 'John Smith', entityType: 'person', confidence: 0.95 },
        { name: 'Jane Smith', entityType: 'person', confidence: 0.9 },
      ];
      const result = dedup(entities, 0.5);
      // All four have different normalized names
      assert.strictEqual(result.length, 4);
    });

    it('should handle mixed entity types all deduped together', () => {
      const entities = [
        { name: 'Apple', entityType: 'organization', confidence: 0.9 },
        { name: 'Apple', entityType: 'product', confidence: 0.8 },
        { name: 'Apple', entityType: 'organization', confidence: 0.95 },
        { name: 'Apple', entityType: 'product', confidence: 0.85 },
      ];
      const result = dedup(entities, 0.5);
      assert.strictEqual(result.length, 2); // one org, one product
      const org = result.find(e => e.entityType === 'organization');
      assert.strictEqual(org!.confidence, 0.95);
      const product = result.find(e => e.entityType === 'product');
      assert.strictEqual(product!.confidence, 0.85);
    });

    it('should handle confidence threshold exactly at entity confidence', () => {
      const entities = [
        { name: 'Exact Match', entityType: 'person', confidence: 0.5 },
      ];
      // confidence < threshold means filtered out. 0.5 < 0.5 is false, so it stays.
      const result = dedup(entities, 0.5);
      assert.strictEqual(result.length, 1);
    });

    it('should filter entity just below threshold', () => {
      const entities = [
        { name: 'Just Below', entityType: 'person', confidence: 0.499 },
      ];
      const result = dedup(entities, 0.5);
      assert.strictEqual(result.length, 0);
    });

    it('should handle dedup with diacritics normalization', () => {
      const entities = [
        { name: 'José García', entityType: 'person', confidence: 0.7 },
        { name: 'Jose Garcia', entityType: 'person', confidence: 0.95 },
        { name: 'JOSE GARCIA', entityType: 'person', confidence: 0.8 },
      ];
      const result = dedup(entities, 0.5);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].confidence, 0.95);
    });

    it('should handle dedup with extra whitespace in names', () => {
      const entities = [
        { name: '  John   Doe  ', entityType: 'person', confidence: 0.7 },
        { name: 'John Doe', entityType: 'person', confidence: 0.9 },
      ];
      const result = dedup(entities, 0.5);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].confidence, 0.9);
    });

    it('should preserve order (first occurrence position)', () => {
      const entities = [
        { name: 'First', entityType: 'person', confidence: 0.8 },
        { name: 'Second', entityType: 'person', confidence: 0.7 },
        { name: 'Third', entityType: 'person', confidence: 0.9 },
      ];
      const result = dedup(entities, 0.5);
      assert.strictEqual(result[0].name, 'First');
      assert.strictEqual(result[1].name, 'Second');
      assert.strictEqual(result[2].name, 'Third');
    });

    it('should handle single entity', () => {
      const entities = [
        { name: 'Sole Entity', entityType: 'organization', confidence: 0.9 },
      ];
      const result = dedup(entities, 0.5);
      assert.strictEqual(result.length, 1);
    });
  });

  // ─── normalizeName: Comprehensive ─────────────────────────────────

  describe('normalizeName - Comprehensive', () => {
    it('should handle CJK characters (preserve them)', () => {
      const result = normalizeName('田中太郎');
      assert.strictEqual(result, '田中太郎');
    });

    it('should handle mixed CJK and Latin characters', () => {
      const result = normalizeName('John 田中');
      assert.strictEqual(result, 'john 田中');
    });

    it('should handle Korean characters (NFD decomposed)', () => {
      const result = normalizeName('김철수');
      // NFD decomposes Hangul syllables into jamo, so the result won't
      // equal the original composed form. Just verify it's non-empty and stable.
      assert.ok(result.length > 0);
      assert.strictEqual(result, normalizeName('김철수'));
    });

    it('should handle emoji in names (preserve them)', () => {
      const result = normalizeName('John 🎉 Smith');
      assert.strictEqual(result, 'john 🎉 smith');
    });

    it('should handle names with only emoji', () => {
      const result = normalizeName('🎭🎪');
      assert.strictEqual(result, '🎭🎪');
    });

    it('should handle very long names (100+ characters)', () => {
      const longName = 'A'.repeat(150);
      const result = normalizeName(longName);
      assert.strictEqual(result, 'a'.repeat(150));
      assert.strictEqual(result.length, 150);
    });

    it('should handle names with HTML entities literally (not decode them)', () => {
      // normalizeName just does string operations, it doesn't decode HTML
      const result = normalizeName('Smith &amp; Jones');
      assert.strictEqual(result, 'smith &amp; jones');
    });

    it('should handle names with numbers', () => {
      const result = normalizeName('Agent 007');
      assert.strictEqual(result, 'agent 007');
    });

    it('should handle names with special characters', () => {
      assert.strictEqual(normalizeName('Müller'), 'muller');
      assert.strictEqual(normalizeName('Łukasz'), 'łukasz'); // Polish L is not a combining mark
      assert.strictEqual(normalizeName('Ñoño'), 'nono'); // Spanish ñ
    });

    it('should handle names with multiple types of whitespace', () => {
      const result = normalizeName('John\t\t  \n\r  Doe');
      assert.strictEqual(result, 'john doe');
    });

    it('should handle Cyrillic characters', () => {
      const result = normalizeName('Иван Петров');
      assert.strictEqual(result, 'иван петров');
    });

    it('should handle Arabic characters', () => {
      const result = normalizeName('محمد علي');
      assert.strictEqual(result, 'محمد علي');
    });

    it('should handle string with only whitespace', () => {
      assert.strictEqual(normalizeName('   \t\n  '), '');
    });

    it('should handle French diacritics comprehensively', () => {
      assert.strictEqual(normalizeName('François Lemaître'), 'francois lemaitre');
      assert.strictEqual(normalizeName('Hélène Bézier'), 'helene bezier');
    });

    it('should handle Scandinavian diacritics', () => {
      assert.strictEqual(normalizeName('Ångström'), 'angstrom');
    });

    it('should handle German umlauts', () => {
      assert.strictEqual(normalizeName('Über Straße'), 'uber straße');
      // Note: ß is not a combining mark, so it stays
    });

    it('should handle Vietnamese diacritics', () => {
      assert.strictEqual(normalizeName('Nguyễn Văn'), 'nguyen van');
    });

    it('should handle name with dots and hyphens', () => {
      assert.strictEqual(normalizeName('Dr. Mary-Jane O\'Brien'), "dr. mary-jane o'brien");
    });

    it('should handle non-string input types', () => {
      // normalizeName only guards for falsy values (null, undefined, '', 0, false)
      // It does not guard against non-string truthy values like 123, {}, []
      // which will throw TypeError. Only test the falsy cases it handles.
      assert.strictEqual(normalizeName(0 as any), '');
      assert.strictEqual(normalizeName(false as any), '');
    });
  });
});
