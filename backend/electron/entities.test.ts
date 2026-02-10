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

    describe('date extraction', () => {
      it('should extract ISO dates (YYYY-MM-DD)', () => {
        const text = 'Meeting on 2026-02-10';
        const result = extractRegexEntities(text, 'https://example.com');
        const dates = result.filter(e => e.entityType === 'date');
        assert.ok(dates.length >= 1);
        assert.ok(dates.some(d => d.name === '2026-02-10'));
      });

      it('should extract US formatted dates (Month DD, YYYY)', () => {
        const text = 'Published February 10, 2026';
        const result = extractRegexEntities(text, 'https://example.com');
        const dates = result.filter(e => e.entityType === 'date');
        assert.ok(dates.length >= 1);
        assert.ok(dates.some(d => d.name.includes('February')));
      });

      it('should extract abbreviated month dates (Feb 10, 2026)', () => {
        const text = 'Updated: Jan 5, 2026';
        const result = extractRegexEntities(text, 'https://example.com');
        const dates = result.filter(e => e.entityType === 'date');
        assert.ok(dates.length >= 1);
      });

      it('should extract EU formatted dates (DD Month YYYY)', () => {
        const text = 'Published: 10 February 2026';
        const result = extractRegexEntities(text, 'https://example.com');
        const dates = result.filter(e => e.entityType === 'date');
        assert.ok(dates.length >= 1);
      });

      it('should extract slash-formatted dates (MM/DD/YYYY)', () => {
        const text = 'Date: 02/10/2026';
        const result = extractRegexEntities(text, 'https://example.com');
        const dates = result.filter(e => e.entityType === 'date');
        assert.ok(dates.length >= 1);
      });

      it('should not match invalid month numbers in ISO dates', () => {
        const text = 'ID: 2026-15-45';
        const result = extractRegexEntities(text, 'https://example.com');
        const dates = result.filter(e => e.entityType === 'date');
        assert.strictEqual(dates.length, 0, 'Should not match invalid ISO date');
      });

      it('should set confidence to 0.8 for dates', () => {
        const text = 'Date: 2026-03-15';
        const result = extractRegexEntities(text, 'https://example.com');
        const dates = result.filter(e => e.entityType === 'date');
        assert.ok(dates.length >= 1);
        assert.strictEqual(dates[0].confidence, 0.8);
      });
    });

    describe('price extraction', () => {
      it('should extract USD prices with $ symbol', () => {
        const text = 'Price: $29.99';
        const result = extractRegexEntities(text, 'https://example.com');
        const prices = result.filter(e => e.entityType === 'price');
        assert.ok(prices.length >= 1);
        assert.ok(prices.some(p => p.name.includes('$29.99')));
      });

      it('should extract prices with thousands separators', () => {
        const text = 'Total: $1,299.00';
        const result = extractRegexEntities(text, 'https://example.com');
        const prices = result.filter(e => e.entityType === 'price');
        assert.ok(prices.length >= 1);
      });

      it('should extract EUR currency code prices', () => {
        const text = 'Cost: 49.99 EUR';
        const result = extractRegexEntities(text, 'https://example.com');
        const prices = result.filter(e => e.entityType === 'price');
        assert.ok(prices.length >= 1);
      });

      it('should extract EUR prefix prices', () => {
        const text = 'Price: EUR 150.00';
        const result = extractRegexEntities(text, 'https://example.com');
        const prices = result.filter(e => e.entityType === 'price');
        assert.ok(prices.length >= 1);
      });

      it('should extract GBP prices', () => {
        const text = 'Available for GBP 75.00';
        const result = extractRegexEntities(text, 'https://example.com');
        const prices = result.filter(e => e.entityType === 'price');
        assert.ok(prices.length >= 1);
      });

      it('should set confidence to 0.85 for prices', () => {
        const text = 'Only $9.99';
        const result = extractRegexEntities(text, 'https://example.com');
        const prices = result.filter(e => e.entityType === 'price');
        assert.ok(prices.length >= 1);
        assert.strictEqual(prices[0].confidence, 0.85);
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
                     'Meeting on 2026-03-15. Price: $49.99.';
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
});
