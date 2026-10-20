/**
 * Map URL extractor — reads a place straight out of a map link.
 *
 * A map page's HTML holds no structured place data, so the page extractors find almost
 * nothing on a saved map link. The URL itself, however, states the place outright: its
 * name, its coordinates, sometimes its address. This extractor parses that and nothing
 * else — no network, no DOM — so a map link becomes a place even offline or when the
 * page fetch fails.
 *
 * Recognised: Google Maps, Apple Maps, OpenStreetMap, Bing Maps. Anything else yields
 * no place. Short links are not parsed here; `isMapShortLink()` names the hosts whose
 * redirect a caller must follow first.
 */

const COORD_PAIR = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;
const CONFIDENCE = 0.9;

function parseUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Decode a name taken from a path segment or query value (`+` and percent-escapes). */
function decodeName(raw) {
  if (!raw) return '';
  let value = String(raw).replace(/\+/g, ' ');
  try {
    value = decodeURIComponent(value);
  } catch {
    // Malformed escape — keep the literal text rather than losing the name.
  }
  return value.replace(/\s+/g, ' ').trim();
}

function coords(latRaw, lngRaw) {
  const latitude = Number(latRaw);
  const longitude = Number(lngRaw);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude };
}

function coordsFromPair(value) {
  const match = COORD_PAIR.exec(value || '');
  return match ? coords(match[1], match[2]) : null;
}

function readGoogle(parsed) {
  const host = parsed.hostname;
  const isGoogleHost = /(^|\.)google(\.[a-z]{2,3}){1,2}$/.test(host);
  if (!isGoogleHost) return null;
  // A Google URL is only a map URL under /maps — google.com/search?q=… is not a place.
  const path = parsed.pathname;
  if (path !== '/maps' && !path.startsWith('/maps/')) return null;

  let place = null;
  const at = /\/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(path);
  if (at) place = coords(at[1], at[2]);

  const segment = /\/maps\/(?:place|search)\/([^/@?]+)/.exec(path);
  let name = segment ? decodeName(segment[1]) : '';

  if (!name) name = decodeName(parsed.searchParams.get('q') || parsed.searchParams.get('query') || '');

  return { name, place };
}

function readApple(parsed) {
  const host = parsed.hostname;
  if (host !== 'maps.apple.com' && !host.endsWith('.maps.apple.com')) return null;

  const place = coordsFromPair(parsed.searchParams.get('ll') || '');
  const address = decodeName(parsed.searchParams.get('address') || '');
  const name = decodeName(parsed.searchParams.get('q') || '') || address;

  return { name, place, address };
}

function readOpenStreetMap(parsed) {
  if (!/(^|\.)openstreetmap\.org$/.test(parsed.hostname)) return null;

  const mlat = parsed.searchParams.get('mlat');
  const mlon = parsed.searchParams.get('mlon');
  let place = mlat !== null && mlon !== null ? coords(mlat, mlon) : null;

  if (!place) {
    const hash = /[#&]map=\d+(?:\.\d+)?\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/.exec(parsed.hash);
    if (hash) place = coords(hash[1], hash[2]);
  }

  // OpenStreetMap URLs carry no place name, so a found place is named by its coordinates.
  return { name: '', place };
}

function readBing(parsed) {
  if (!/(^|\.)bing\.com$/.test(parsed.hostname)) return null;
  const path = parsed.pathname;
  if (path !== '/maps' && !path.startsWith('/maps/')) return null;

  const cp = /^(-?\d+(?:\.\d+)?)~(-?\d+(?:\.\d+)?)/.exec(parsed.searchParams.get('cp') || '');
  const place = cp ? coords(cp[1], cp[2]) : null;
  const name = decodeName(parsed.searchParams.get('q') || '');

  return { name, place };
}

const PROVIDERS = [
  ['google', readGoogle],
  ['apple', readApple],
  ['openstreetmap', readOpenStreetMap],
  ['bing', readBing],
];

/**
 * True for the short-link hosts whose redirect has to be followed before a place can be
 * read. The expansion itself is the caller's job — this module does no network.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isMapShortLink(url) {
  const parsed = parseUrl(url);
  if (!parsed) return false;
  if (parsed.hostname === 'maps.app.goo.gl') return true;
  return parsed.hostname === 'goo.gl' && parsed.pathname.startsWith('/maps');
}

/**
 * Read the place a map URL names.
 *
 * @param {string} url - A full map URL (a short link must be expanded first).
 * @returns {Array<Object>} Zero or one raw entity, in the shape the page extractors return.
 */
export function extractMapUrlEntities(url) {
  const parsed = parseUrl(url);
  if (!parsed) return [];

  for (const [mapProvider, read] of PROVIDERS) {
    const found = read(parsed);
    if (!found) continue;

    let name = found.name || '';
    let place = found.place || null;

    // A name that is itself a coordinate pair is coordinates, not a name.
    const pairInName = coordsFromPair(name);
    if (pairInName) {
      place = place || pairInName;
      name = '';
    }

    if (!name && place) name = `${place.latitude}, ${place.longitude}`;
    if (!name) return [];

    const attributes = {};
    if (place) {
      attributes.latitude = place.latitude;
      attributes.longitude = place.longitude;
    }
    if (found.address) attributes.address = found.address;
    attributes.mapProvider = mapProvider;
    attributes.mapUrl = url;

    return [{
      name,
      entityType: 'place',
      confidence: CONFIDENCE,
      extractor: 'map-url',
      attributes,
      sourceUrl: url,
    }];
  }

  return [];
}
