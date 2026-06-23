/**
 * Real, deterministic fixtures captured from burrito.space's repo
 * (did:plc:7r5c5jhtphcpkg3y55xu2y64 on https://eurosky.social) on
 * 2026-06-23. Used to make atproto-verify tests offline + deterministic.
 *
 * - CAR proof: com.atproto.sync.getRecord?did=...&collection=app.bsky.actor.profile&rkey=self
 * - DID doc:   https://plc.directory/<did>
 * - getRecord: the independent com.atproto.repo.getRecord result (CID cross-check)
 *
 * secp256k1 (#atproto key prefix zQ3sh). Regenerate with tmp/capture.mjs +
 * tmp/genfix.mjs if you need to refresh. DO NOT hand-edit the base64.
 */

export const BURRITO_DID = 'did:plc:7r5c5jhtphcpkg3y55xu2y64';
export const BURRITO_PDS = 'https://eurosky.social';
export const BURRITO_COLLECTION = 'app.bsky.actor.profile';
export const BURRITO_RKEY = 'self';
export const BURRITO_RECORD_CID = "bafyreibqrrk6sxkwzf3zlvaptcvckrmsaverdcbta62dru6u4zncgxumf4";

/** The independent getRecord value (for cross-check of decoded value). */
export const BURRITO_GETRECORD = {
  "uri": "at://did:plc:7r5c5jhtphcpkg3y55xu2y64/app.bsky.actor.profile/self",
  "cid": "bafyreibqrrk6sxkwzf3zlvaptcvckrmsaverdcbta62dru6u4zncgxumf4",
  "value": {
    "$type": "app.bsky.actor.profile",
    "avatar": {
      "ref": {
        "$link": "bafkreie77ie2fhawer5havzziex2ob4qrodacbghyhbwp4krnqkcda45qq"
      },
      "size": 274178,
      "$type": "blob",
      "mimeType": "image/jpeg"
    },
    "banner": {
      "ref": {
        "$link": "bafkreiaob5f4usi22qa6qpgezrb5fat3lot5wxwuy3ilq2obuiauhk4r6a"
      },
      "size": 997824,
      "$type": "blob",
      "mimeType": "image/jpeg"
    },
    "pinnedPost": {
      "cid": "bafyreieqedfhpuz6pjrj4pymo6jxdsps6fl6kjyiw3ehh6t2qsj5ao5lue",
      "uri": "at://did:plc:7r5c5jhtphcpkg3y55xu2y64/app.bsky.feed.post/3mgrx4ptk7s2w"
    },
    "description": "peeking into the post-browser web\n\n~ https://metafluff.com\n~ https://webtransitions.org\n~ https://userandagents.org\n~ @intenttoship.dev\n\npast lives: Mozilla, Protocol Labs, Sub Pop Records",
    "displayName": "dietrich"
  }
} as {
  uri: string;
  cid: string;
  value: Record<string, unknown>;
};

/** The DID document as returned by plc.directory. */
export const BURRITO_DIDDOC = {
  "@context": [
    "https://www.w3.org/ns/did/v1",
    "https://w3id.org/security/multikey/v1",
    "https://w3id.org/security/suites/secp256k1-2019/v1"
  ],
  "id": "did:plc:7r5c5jhtphcpkg3y55xu2y64",
  "alsoKnownAs": [
    "at://burrito.space"
  ],
  "verificationMethod": [
    {
      "id": "did:plc:7r5c5jhtphcpkg3y55xu2y64#atproto",
      "type": "Multikey",
      "controller": "did:plc:7r5c5jhtphcpkg3y55xu2y64",
      "publicKeyMultibase": "zQ3shZRxeuk3KTEGgTADNgciroWw9odjiWwhwBmUEvRtomkxZ"
    }
  ],
  "service": [
    {
      "id": "#atproto_pds",
      "type": "AtprotoPersonalDataServer",
      "serviceEndpoint": "https://eurosky.social"
    }
  ]
};

/** base64 of the raw CARv1 proof bytes. */
const BURRITO_PROOF_CAR_B64 =
  "OqJlcm9vdHOB2CpYJQABcRIgBLWVyziJrVhS5BdVGv9GhqL3RdffgoNN0zRLwGcSVZZndmVyc2lvbgHgAQFxEiAEtZXLOImtWFLkF1Ua/0aGovdF19+Cg03TNEvAZxJVlqZjZGlkeCBkaWQ6cGxjOjdyNWM1amh0cGhjcGtnM3k1NXh1Mnk2NGNyZXZtM21veHAydHFidHUydWNzaWdYQBjRakyQD5wG5rwvmNNllZkDT4mbdrEzwJasAqP035XKNwTeInVRTyHGT4RbtKYbrKjEPLitPbctYMAtahMNisFkZGF0YdgqWCUAAXESIHcFOy3vlGQHCtMoApjqp+7WDaZSiIqD/QDZ8zWKqNq7ZHByZXb2Z3ZlcnNpb24D9gQBcRIgMIxV6V1WyXeV1A+YqiVFkgVJEYgzB7Q409TmWiNejC+mZSR0eXBldmFwcC5ic2t5LmFjdG9yLnByb2ZpbGVmYXZhdGFypGNyZWbYKlglAAFVEiCf+gminBYkenBXOUEvpweQi4YBBMfBw2fxUWwUIYOdhGRzaXplGgAELwJlJHR5cGVkYmxvYmhtaW1lVHlwZWppbWFnZS9qcGVnZmJhbm5lcqRjcmVm2CpYJQABVRIgDg9Lykka1AHoPMTMQ9KCe1un217UxtC4acGiAUOrkfBkc2l6ZRoADznAZSR0eXBlZGJsb2JobWltZVR5cGVqaW1hZ2UvanBlZ2pwaW5uZWRQb3N0omNjaWR4O2JhZnlyZWllcWVkZmhwdXo2cGpyajRweW1vNmp4ZHNwczZmbDZranlpdzNlaGg2dDJxc2o1YW81bHVlY3VyaXhGYXQ6Ly9kaWQ6cGxjOjdyNWM1amh0cGhjcGtnM3k1NXh1Mnk2NC9hcHAuYnNreS5mZWVkLnBvc3QvM21ncng0cHRrN3Myd2tkZXNjcmlwdGlvbni8cGVla2luZyBpbnRvIHRoZSBwb3N0LWJyb3dzZXIgd2ViCgp+IGh0dHBzOi8vbWV0YWZsdWZmLmNvbQp+IGh0dHBzOi8vd2VidHJhbnNpdGlvbnMub3JnCn4gaHR0cHM6Ly91c2VyYW5kYWdlbnRzLm9yZwp+IEBpbnRlbnR0b3NoaXAuZGV2CgpwYXN0IGxpdmVzOiBNb3ppbGxhLCBQcm90b2NvbCBMYWJzLCBTdWIgUG9wIFJlY29yZHNrZGlz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";

export function burritoProofCar(): Uint8Array {
  return new Uint8Array(Buffer.from(BURRITO_PROOF_CAR_B64, 'base64'));
}
