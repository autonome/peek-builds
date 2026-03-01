import { describe, it, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = join(__dirname, '..', '..', 'extensions', 'entities', 'name-validator.js');

// Dynamic import since the module uses ESM exports
const { classifyNamePattern, isLikelyPersonName, validateEntityType, loadNameDatabaseSync } = await import(modulePath);

// Load the name database synchronously before tests
const namesPath = join(__dirname, '..', '..', 'extensions', 'entities', 'data', 'names.json');
const namesData = JSON.parse(readFileSync(namesPath, 'utf-8'));
loadNameDatabaseSync(namesData);

// ---------------------------------------------------------------------------
// classifyNamePattern
// ---------------------------------------------------------------------------
describe('classifyNamePattern', () => {

  describe('edge cases', () => {
    it('returns unknown for empty string', () => {
      const r = classifyNamePattern('');
      assert.equal(r.likelyType, 'unknown');
      assert.equal(r.confidence, 0);
    });

    it('returns unknown for null', () => {
      const r = classifyNamePattern(null);
      assert.equal(r.likelyType, 'unknown');
      assert.equal(r.confidence, 0);
    });

    it('returns unknown for undefined', () => {
      const r = classifyNamePattern(undefined);
      assert.equal(r.likelyType, 'unknown');
      assert.equal(r.confidence, 0);
    });

    it('returns unknown for non-string input', () => {
      const r = classifyNamePattern(42);
      assert.equal(r.likelyType, 'unknown');
    });
  });

  describe('URL and path-like names', () => {
    it('detects https URL', () => {
      const r = classifyNamePattern('https://example.com');
      assert.equal(r.likelyType, 'not_entity');
      assert.ok(r.confidence >= 0.9);
    });

    it('detects http URL', () => {
      const r = classifyNamePattern('http://example.com/page');
      assert.equal(r.likelyType, 'not_entity');
    });

    it('detects www prefix', () => {
      const r = classifyNamePattern('www.example.com');
      assert.equal(r.likelyType, 'not_entity');
    });

    it('detects file path with slashes', () => {
      const r = classifyNamePattern('path/to/file.html');
      assert.equal(r.likelyType, 'not_entity');
    });

    it('detects .com domain', () => {
      const r = classifyNamePattern('example.com');
      assert.equal(r.likelyType, 'not_entity');
    });

    it('detects .org domain', () => {
      const r = classifyNamePattern('mozilla.org');
      assert.equal(r.likelyType, 'not_entity');
    });
  });

  describe('organization suffixes', () => {
    it('detects "Inc" suffix', () => {
      const r = classifyNamePattern('Apple Inc');
      assert.equal(r.likelyType, 'organization');
      assert.equal(r.confidence, 0.9);
    });

    it('detects "LLC" suffix', () => {
      const r = classifyNamePattern('Google LLC');
      assert.equal(r.likelyType, 'organization');
      assert.equal(r.confidence, 0.9);
    });

    it('detects "Foundation" suffix', () => {
      const r = classifyNamePattern('Mozilla Foundation');
      assert.equal(r.likelyType, 'organization');
      assert.equal(r.confidence, 0.9);
    });

    it('detects "Ltd" suffix', () => {
      const r = classifyNamePattern('Acme Ltd');
      assert.equal(r.likelyType, 'organization');
    });

    it('detects "University" anywhere', () => {
      const r = classifyNamePattern('Stanford University Press');
      assert.equal(r.likelyType, 'organization');
    });

    it('detects "Corp" suffix', () => {
      const r = classifyNamePattern('Mega Corp');
      assert.equal(r.likelyType, 'organization');
    });
  });

  describe('honorifics', () => {
    it('detects "Dr." prefix', () => {
      const r = classifyNamePattern('Dr. Jane Doe');
      assert.equal(r.likelyType, 'person');
      assert.equal(r.confidence, 0.85);
    });

    it('detects "Prof." prefix', () => {
      const r = classifyNamePattern('Prof. Smith');
      assert.equal(r.likelyType, 'person');
      assert.equal(r.confidence, 0.85);
    });

    it('detects "Mr" prefix without dot', () => {
      const r = classifyNamePattern('Mr Johnson');
      assert.equal(r.likelyType, 'person');
    });

    it('detects "Mrs." prefix', () => {
      const r = classifyNamePattern('Mrs. Williams');
      assert.equal(r.likelyType, 'person');
    });

    it('detects "Sir" prefix', () => {
      const r = classifyNamePattern('Sir Isaac Newton');
      assert.equal(r.likelyType, 'person');
    });

    it('detects "Senator" prefix', () => {
      const r = classifyNamePattern('Sen. Warren');
      assert.equal(r.likelyType, 'person');
    });
  });

  describe('"The X" pattern', () => {
    it('detects "The New York Times"', () => {
      const r = classifyNamePattern('The New York Times');
      assert.equal(r.likelyType, 'organization');
      assert.equal(r.confidence, 0.7);
    });

    it('detects "The Guardian"', () => {
      const r = classifyNamePattern('The Guardian');
      assert.equal(r.likelyType, 'organization');
    });

    // "The" alone (single word) should not match — needs at least 2 words
    it('does not match bare "The"', () => {
      const r = classifyNamePattern('The');
      assert.notEqual(r.likelyType, 'organization');
    });
  });

  describe('CamelCase brands (single word)', () => {
    it('detects "IndieWeb"', () => {
      const r = classifyNamePattern('IndieWeb');
      assert.equal(r.likelyType, 'organization');
      assert.equal(r.confidence, 0.8);
      assert.ok(r.reason.includes('CamelCase'));
    });

    it('detects "YouTube"', () => {
      const r = classifyNamePattern('YouTube');
      assert.equal(r.likelyType, 'organization');
    });

    it('detects "GitHub"', () => {
      const r = classifyNamePattern('GitHub');
      assert.equal(r.likelyType, 'organization');
    });

    it('detects "WordPress"', () => {
      const r = classifyNamePattern('WordPress');
      assert.equal(r.likelyType, 'organization');
    });

    it('detects "TikTok"', () => {
      const r = classifyNamePattern('TikTok');
      assert.equal(r.likelyType, 'organization');
    });

    it('detects "LinkedIn"', () => {
      const r = classifyNamePattern('LinkedIn');
      assert.equal(r.likelyType, 'organization');
    });
  });

  describe('ALL_CAPS abbreviations', () => {
    it('detects "NASA"', () => {
      const r = classifyNamePattern('NASA');
      assert.equal(r.likelyType, 'organization');
      assert.equal(r.confidence, 0.6);
    });

    it('detects "FBI"', () => {
      const r = classifyNamePattern('FBI');
      assert.equal(r.likelyType, 'organization');
    });

    it('detects "UNESCO"', () => {
      const r = classifyNamePattern('UNESCO');
      assert.equal(r.likelyType, 'organization');
    });
  });

  describe('leading CamelCase in multi-word', () => {
    it('detects "IndieWeb Movement"', () => {
      const r = classifyNamePattern('IndieWeb Movement');
      assert.equal(r.likelyType, 'organization');
      assert.equal(r.confidence, 0.7);
    });
  });

  describe('two-word title case (ambiguous)', () => {
    it('returns ambiguous for "John Smith"', () => {
      const r = classifyNamePattern('John Smith');
      assert.equal(r.likelyType, 'ambiguous');
      assert.equal(r.confidence, 0.5);
    });

    it('returns ambiguous for "Jane Doe"', () => {
      const r = classifyNamePattern('Jane Doe');
      assert.equal(r.likelyType, 'ambiguous');
    });
  });

  describe('single word ambiguous', () => {
    it('returns ambiguous for single title-case word', () => {
      const r = classifyNamePattern('Apple');
      assert.equal(r.likelyType, 'ambiguous');
      assert.equal(r.confidence, 0.4);
    });
  });

  describe('"&" and "and" patterns', () => {
    // Note: \b&\b in the regex does not match because & is not a word character,
    // so "Ben & Jerry" falls through to "unknown". This is a quirk of the regex.
    it('does not detect bare ampersand (regex limitation)', () => {
      const r = classifyNamePattern('Ben & Jerry');
      assert.equal(r.likelyType, 'unknown');
    });

    it('detects "and" conjunction', () => {
      const r = classifyNamePattern('Simon and Garfunkel');
      assert.equal(r.likelyType, 'organization');
    });
  });

  describe('no strong pattern', () => {
    it('returns unknown for multi-word non-matching name', () => {
      const r = classifyNamePattern('something random here');
      assert.equal(r.likelyType, 'unknown');
      assert.equal(r.confidence, 0.3);
    });
  });
});

// ---------------------------------------------------------------------------
// isLikelyPersonName
// ---------------------------------------------------------------------------
describe('isLikelyPersonName', () => {

  describe('edge cases', () => {
    it('returns not-likely for empty string', () => {
      const r = isLikelyPersonName('');
      assert.equal(r.likely, false);
      assert.equal(r.confidence, 0);
    });

    it('returns not-likely for null', () => {
      const r = isLikelyPersonName(null);
      assert.equal(r.likely, false);
    });

    it('returns not-likely for undefined', () => {
      const r = isLikelyPersonName(undefined);
      assert.equal(r.likely, false);
    });
  });

  describe('known first + surname', () => {
    it('recognizes "John Smith" as likely person (both in DB)', () => {
      const r = isLikelyPersonName('John Smith');
      assert.equal(r.likely, true);
      assert.equal(r.confidence, 0.9);
      assert.ok(r.reason.includes('first name') && r.reason.includes('surname'));
    });
  });

  describe('known first name only', () => {
    it('recognizes "James Xyzzyplugh" (first name known, surname not)', () => {
      const r = isLikelyPersonName('James Xyzzyplugh');
      assert.equal(r.likely, true);
      assert.equal(r.confidence, 0.7);
    });
  });

  describe('known surname only', () => {
    it('recognizes "Zxqwkj Smith" (surname known, first not)', () => {
      const r = isLikelyPersonName('Zxqwkj Smith');
      assert.equal(r.likely, true);
      assert.equal(r.confidence, 0.5);
    });
  });

  describe('mononyms (single known first name)', () => {
    it('recognizes single known first name', () => {
      const r = isLikelyPersonName('Mary');
      assert.equal(r.likely, true);
      assert.equal(r.confidence, 0.5);
      assert.ok(r.reason.includes('single word'));
    });
  });

  describe('unknown single word', () => {
    it('rejects unknown single word', () => {
      const r = isLikelyPersonName('Xyzzy');
      assert.equal(r.likely, false);
    });

    it('rejects brand name', () => {
      const r = isLikelyPersonName('IndieWeb');
      assert.equal(r.likely, false);
    });
  });

  describe('honorific handling', () => {
    it('recognizes honorific + known first name', () => {
      // "Jane" is not in the names DB, so this hits the generic honorific branch (0.75)
      // Use a name that IS in the DB for the 0.9 path
      const r1 = isLikelyPersonName('Dr. Mary Johnson');
      assert.equal(r1.likely, true);
      assert.equal(r1.confidence, 0.9);
      assert.ok(r1.reason.includes('honorific') && r1.reason.includes('known first name'));

      // "Dr. Jane Doe" still recognized as person via honorific alone
      const r2 = isLikelyPersonName('Dr. Jane Doe');
      assert.equal(r2.likely, true);
      assert.equal(r2.confidence, 0.75);
      assert.ok(r2.reason.includes('honorific'));
    });

    it('recognizes honorific + unknown name', () => {
      const r = isLikelyPersonName('Dr. Xyzzy');
      assert.equal(r.likely, true);
      assert.equal(r.confidence, 0.75);
      assert.ok(r.reason.includes('honorific'));
    });
  });

  describe('international names', () => {
    it('recognizes "Hayao Miyazaki" as likely person (both in DB)', () => {
      const r = isLikelyPersonName('Hayao Miyazaki');
      assert.equal(r.likely, true);
      assert.ok(r.confidence >= 0.7);
    });

    it('recognizes "Joe Hisaishi" as likely person (first name in DB)', () => {
      const r = isLikelyPersonName('Joe Hisaishi');
      assert.equal(r.likely, true);
      assert.ok(r.confidence >= 0.7);
    });

    it('recognizes "Akira Kurosawa" as likely person (both in DB)', () => {
      const r = isLikelyPersonName('Akira Kurosawa');
      assert.equal(r.likely, true);
      assert.ok(r.confidence >= 0.7);
    });

    it('recognizes "Chimamanda Adichie" as likely person', () => {
      const r = isLikelyPersonName('Chimamanda Adichie');
      assert.equal(r.likely, true);
      assert.ok(r.confidence >= 0.5);
    });

    it('recognizes "Sachin Patel" as likely person', () => {
      const r = isLikelyPersonName('Sachin Patel');
      assert.equal(r.likely, true);
      assert.ok(r.confidence >= 0.7);
    });
  });

  describe('two-word title case without DB match', () => {
    it('returns not-likely with moderate confidence', () => {
      const r = isLikelyPersonName('Zxqwkj Plugh');
      assert.equal(r.likely, false);
      assert.equal(r.confidence, 0.4);
    });
  });

  describe('multi-word no match', () => {
    it('returns not-likely for completely unknown multi-word', () => {
      const r = isLikelyPersonName('something random here');
      assert.equal(r.likely, false);
      assert.equal(r.confidence, 0.2);
    });
  });
});

// ---------------------------------------------------------------------------
// validateEntityType
// ---------------------------------------------------------------------------
describe('validateEntityType', () => {

  describe('edge cases', () => {
    it('returns invalid for empty name', () => {
      const r = validateEntityType('', 'person');
      assert.equal(r.valid, false);
    });

    it('returns invalid for null name', () => {
      const r = validateEntityType(null, 'person');
      assert.equal(r.valid, false);
    });

    it('returns invalid for missing type', () => {
      const r = validateEntityType('John Smith', '');
      assert.equal(r.valid, false);
    });

    it('returns invalid for null type', () => {
      const r = validateEntityType('John Smith', null);
      assert.equal(r.valid, false);
    });

    it('returns invalid for undefined type', () => {
      const r = validateEntityType('John Smith', undefined);
      assert.equal(r.valid, false);
    });
  });

  describe('URL/path rejection', () => {
    it('rejects URL as person', () => {
      const r = validateEntityType('https://example.com', 'person');
      assert.equal(r.valid, false);
      assert.ok(r.reason.includes('URL'));
    });

    it('rejects URL as organization', () => {
      const r = validateEntityType('https://example.com', 'organization');
      assert.equal(r.valid, false);
    });

    it('rejects path as person', () => {
      const r = validateEntityType('path/to/file.html', 'person');
      assert.equal(r.valid, false);
    });
  });

  describe('person claims — invalid', () => {
    it('rejects CamelCase brand as person', () => {
      const r = validateEntityType('IndieWeb', 'person');
      assert.equal(r.valid, false);
      assert.equal(r.suggestedType, 'organization');
    });

    it('rejects org suffix as person', () => {
      const r = validateEntityType('Apple Inc', 'person');
      assert.equal(r.valid, false);
      assert.equal(r.suggestedType, 'organization');
    });

    it('rejects "The X" pattern as person', () => {
      const r = validateEntityType('The New York Times', 'person');
      assert.equal(r.valid, false);
      assert.equal(r.suggestedType, 'organization');
    });

    it('rejects ALL_CAPS as person', () => {
      const r = validateEntityType('NASA', 'person');
      assert.equal(r.valid, false);
      assert.equal(r.suggestedType, 'organization');
    });

    it('rejects leading CamelCase multi-word as person', () => {
      const r = validateEntityType('IndieWeb Movement', 'person');
      assert.equal(r.valid, false);
      assert.equal(r.suggestedType, 'organization');
    });

    it('rejects unknown single-word as person', () => {
      const r = validateEntityType('Xyzzy', 'person');
      assert.equal(r.valid, false);
      assert.ok(r.reason.includes('single-word'));
    });
  });

  describe('person claims — valid', () => {
    it('accepts "John Smith" as person', () => {
      const r = validateEntityType('John Smith', 'person');
      assert.equal(r.valid, true);
    });

    it('accepts "Dr. Jane Doe" as person', () => {
      const r = validateEntityType('Dr. Jane Doe', 'person');
      assert.equal(r.valid, true);
    });

    it('accepts known mononym as person', () => {
      const r = validateEntityType('Mary', 'person');
      assert.equal(r.valid, true);
    });

    it('accepts multi-word with known first name as person', () => {
      const r = validateEntityType('James Unknownlast', 'person');
      assert.equal(r.valid, true);
    });
  });

  describe('organization claims — valid', () => {
    it('accepts "Google LLC" as organization', () => {
      const r = validateEntityType('Google LLC', 'organization');
      assert.equal(r.valid, true);
    });

    it('accepts "The New York Times" as organization', () => {
      const r = validateEntityType('The New York Times', 'organization');
      assert.equal(r.valid, true);
    });

    it('accepts "NASA" as organization', () => {
      const r = validateEntityType('NASA', 'organization');
      assert.equal(r.valid, true);
    });

    it('accepts "IndieWeb" as organization', () => {
      const r = validateEntityType('IndieWeb', 'organization');
      assert.equal(r.valid, true);
    });
  });

  describe('organization claims — invalid', () => {
    it('rejects honorific name as organization', () => {
      const r = validateEntityType('Dr. Jane Doe', 'organization');
      assert.equal(r.valid, false);
      assert.equal(r.suggestedType, 'person');
    });

    it('rejects "Prof. Smith" as organization', () => {
      const r = validateEntityType('Prof. Smith', 'organization');
      assert.equal(r.valid, false);
      assert.equal(r.suggestedType, 'person');
    });
  });

  describe('other claimed types', () => {
    it('accepts event type with minimal validation', () => {
      const r = validateEntityType('Summer Conference', 'event');
      assert.equal(r.valid, true);
    });

    it('accepts place type with minimal validation', () => {
      const r = validateEntityType('Central Park', 'place');
      assert.equal(r.valid, true);
    });

    it('still rejects URL for other types', () => {
      const r = validateEntityType('https://example.com', 'event');
      assert.equal(r.valid, false);
    });
  });
});
