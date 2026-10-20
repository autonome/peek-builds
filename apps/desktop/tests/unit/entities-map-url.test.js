/**
 * Map URL extractor — a saved map link becomes a place.
 *
 * The module is pure: no network, no DOM, no `window.app`, so it imports straight into
 * `node --test` the way `name-validator.test.js` imports the validator.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = join(__dirname, '..', '..', 'features', 'entities', 'extractors', 'map-url.js');

const { extractMapUrlEntities, isMapShortLink } = await import(modulePath);
const { validateEntityType } = await import(
  join(__dirname, '..', '..', 'features', 'entities', 'name-validator.js')
);

const PLACES = [
  {
    label: 'Google Maps place: name and coordinates',
    url: 'https://www.google.com/maps/place/Rijksmuseum/@52.3600,4.8852,17z/data=!3m1!4b1',
    name: 'Rijksmuseum',
    latitude: 52.36,
    longitude: 4.8852,
    mapProvider: 'google',
  },
  {
    label: 'Google Maps place: a + in the name is a space',
    url: 'https://www.google.com/maps/place/Oude+Kerk/@52.3745,4.8979,17z',
    name: 'Oude Kerk',
    latitude: 52.3745,
    longitude: 4.8979,
    mapProvider: 'google',
  },
  {
    label: 'Google Maps place: %20 in the name is a space',
    url: 'https://www.google.com/maps/place/Van%20Gogh%20Museum/@52.3584,4.8811,17z',
    name: 'Van Gogh Museum',
    latitude: 52.3584,
    longitude: 4.8811,
    mapProvider: 'google',
  },
  {
    label: 'Google Maps search path',
    url: 'https://www.google.com/maps/search/Anne+Frank+House/@52.3752,4.8840,17z',
    name: 'Anne Frank House',
    latitude: 52.3752,
    longitude: 4.884,
    mapProvider: 'google',
  },
  {
    label: 'Google Maps search with a query parameter',
    url: 'https://www.google.com/maps/search/?api=1&query=Concertgebouw',
    name: 'Concertgebouw',
    latitude: undefined,
    longitude: undefined,
    mapProvider: 'google',
  },
  {
    label: 'Google Maps q parameter',
    url: 'https://www.google.com/maps?q=Anne+Frank+House',
    name: 'Anne Frank House',
    latitude: undefined,
    longitude: undefined,
    mapProvider: 'google',
  },
  {
    label: 'Google Maps coordinates alone are named "Location <lat>, <lng>"',
    url: 'https://www.google.com/maps/@52.3731,4.8922,15z',
    name: 'Location 52.37, 4.89',
    latitude: 52.3731,
    longitude: 4.8922,
    mapProvider: 'google',
  },
  {
    label: 'Google Maps q parameter holding coordinates',
    url: 'https://maps.google.com/maps?q=52.3731,4.8922',
    name: 'Location 52.37, 4.89',
    latitude: 52.3731,
    longitude: 4.8922,
    mapProvider: 'google',
  },
  {
    label: 'Google Maps on a country domain',
    url: 'https://www.google.co.uk/maps/place/British+Museum/@51.5194,-0.1270,17z',
    name: 'British Museum',
    latitude: 51.5194,
    longitude: -0.127,
    mapProvider: 'google',
  },
  {
    label: 'a negative latitude',
    url: 'https://www.google.com/maps/place/Sydney+Opera+House/@-33.8568,151.2153,17z',
    name: 'Sydney Opera House',
    latitude: -33.8568,
    longitude: 151.2153,
    mapProvider: 'google',
  },
  {
    label: 'a negative longitude',
    url: 'https://www.google.com/maps/place/Statue+of+Liberty/@40.6892,-74.0445,17z',
    name: 'Statue of Liberty',
    latitude: 40.6892,
    longitude: -74.0445,
    mapProvider: 'google',
  },
  {
    label: 'Apple Maps with a query and a coordinate pair',
    url: 'https://maps.apple.com/?q=Rijksmuseum&ll=52.3600,4.8852',
    name: 'Rijksmuseum',
    latitude: 52.36,
    longitude: 4.8852,
    mapProvider: 'apple',
  },
  {
    label: 'Apple Maps with an address and no query',
    url: 'https://maps.apple.com/?address=Museumstraat+1,+1071+XX+Amsterdam',
    name: 'Museumstraat 1, 1071 XX Amsterdam',
    address: 'Museumstraat 1, 1071 XX Amsterdam',
    latitude: undefined,
    longitude: undefined,
    mapProvider: 'apple',
  },
  {
    label: 'Apple Maps with coordinates alone',
    url: 'https://maps.apple.com/?ll=-22.9519,-43.2105',
    name: 'Location -22.95, -43.21',
    latitude: -22.9519,
    longitude: -43.2105,
    mapProvider: 'apple',
  },
  {
    label: 'OpenStreetMap marker query',
    url: 'https://www.openstreetmap.org/?mlat=52.3731&mlon=4.8922#map=17/52.3731/4.8922',
    name: 'Location 52.37, 4.89',
    latitude: 52.3731,
    longitude: 4.8922,
    mapProvider: 'openstreetmap',
  },
  {
    label: 'OpenStreetMap map hash alone, both coordinates negative',
    url: 'https://www.openstreetmap.org/#map=15/-22.9519/-43.2105',
    name: 'Location -22.95, -43.21',
    latitude: -22.9519,
    longitude: -43.2105,
    mapProvider: 'openstreetmap',
  },
  {
    label: 'Bing Maps centre point',
    url: 'https://www.bing.com/maps?cp=52.3731~4.8922&lvl=15',
    name: 'Location 52.37, 4.89',
    latitude: 52.3731,
    longitude: 4.8922,
    mapProvider: 'bing',
  },
  {
    label: 'Bing Maps query',
    url: 'https://www.bing.com/maps?q=Rijksmuseum&cp=52.3600~4.8852',
    name: 'Rijksmuseum',
    latitude: 52.36,
    longitude: 4.8852,
    mapProvider: 'bing',
  },
];

const NO_PLACE = [
  ['a non-map Google URL', 'https://www.google.com/search?q=rijksmuseum'],
  ['a Google URL whose path only starts like /maps', 'https://www.google.com/mapsearch?q=rijksmuseum'],
  ['Google Maps with neither a name nor coordinates', 'https://www.google.com/maps'],
  ['an unrelated URL', 'https://example.com/articles/amsterdam'],
  ['a Bing URL outside /maps', 'https://www.bing.com/search?q=rijksmuseum'],
  ['an OpenStreetMap page with no coordinates', 'https://www.openstreetmap.org/about'],
  ['Apple Maps with no place parameters', 'https://maps.apple.com/'],
  ['an unexpanded short link', 'https://maps.app.goo.gl/abc123'],
  ['a non-URL string', 'not a url at all'],
  ['an empty string', ''],
  ['a non-string', 42],
  ['nothing', undefined],
];

describe('extractMapUrlEntities', () => {
  for (const place of PLACES) {
    it(place.label, () => {
      const entities = extractMapUrlEntities(place.url);
      assert.equal(entities.length, 1, `expected one place from ${place.url}`);

      const [entity] = entities;
      assert.equal(entity.name, place.name);
      assert.equal(entity.entityType, 'place');
      assert.equal(entity.confidence, 0.9);
      assert.equal(entity.extractor, 'map-url');
      assert.equal(entity.attributes.latitude, place.latitude);
      assert.equal(entity.attributes.longitude, place.longitude);
      assert.equal(entity.attributes.address, place.address);
      assert.equal(entity.attributes.mapProvider, place.mapProvider);
      assert.equal(entity.attributes.mapUrl, place.url);
    });
  }

  for (const [label, url] of NO_PLACE) {
    it(`${label} yields no place`, () => {
      assert.deepEqual(extractMapUrlEntities(url), []);
    });
  }

  it('drops coordinates outside the valid range but keeps the name', () => {
    const [entity] = extractMapUrlEntities('https://www.google.com/maps/place/Nowhere/@952.0,4.0,17z');
    assert.equal(entity.name, 'Nowhere');
    assert.equal(entity.attributes.latitude, undefined);
    assert.equal(entity.attributes.longitude, undefined);
  });

  for (const [label, url, name] of [
    ['an OpenStreetMap URL with coordinates only', 'https://www.openstreetmap.org/?mlat=52.3731&mlon=4.8922', 'Location 52.37, 4.89'],
    ['a Bing URL with coordinates only', 'https://www.bing.com/maps?cp=52.3731~4.8922&lvl=15', 'Location 52.37, 4.89'],
  ]) {
    it(`${label} gives a storable place keeping full coordinates`, () => {
      const [entity] = extractMapUrlEntities(url);
      assert.equal(entity.name, name);
      assert.equal(entity.attributes.latitude, 52.3731);
      assert.equal(entity.attributes.longitude, 4.8922);
      // The name must not read as all-numeric/punctuation, which the entity matcher drops.
      assert.ok(/[A-Za-z]/.test(entity.name));
      assert.equal(validateEntityType(entity.name, entity.entityType).valid, true);
    });
  }

  it('reads the place from the expanded URL it is given, not from a short link', () => {
    const expanded = 'https://www.google.com/maps/place/Rijksmuseum/@52.3600,4.8852,17z';
    const [entity] = extractMapUrlEntities(expanded);
    assert.equal(entity.attributes.mapUrl, expanded);
  });
});

describe('isMapShortLink', () => {
  const shortLinks = [
    'https://maps.app.goo.gl/abc123',
    'https://goo.gl/maps/abc123',
  ];
  const fullLinks = [
    'https://www.google.com/maps/place/Rijksmuseum/@52.3600,4.8852,17z',
    'https://maps.apple.com/?q=Rijksmuseum',
    'https://www.openstreetmap.org/#map=15/52.3731/4.8922',
    'https://www.bing.com/maps?cp=52.3731~4.8922',
    'https://goo.gl/abc123',
    'https://example.com/maps/abc',
    'not a url at all',
    '',
  ];

  for (const url of shortLinks) {
    it(`${url} is a short link`, () => {
      assert.equal(isMapShortLink(url), true);
    });
  }

  for (const url of fullLinks) {
    it(`${url || '(empty)'} is not a short link`, () => {
      assert.equal(isMapShortLink(url), false);
    });
  }
});
