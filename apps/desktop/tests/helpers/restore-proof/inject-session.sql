-- Hand-staged multi-window session for the REAL (non-Playwright) cold-start test.
-- 5 https page-hosts (P1..P5, front) + 3 peek:// tiles (T1..T3, behind).
-- Target front->back on-screen order after restore: P1 P2 P3 P4 P5 T1 T2 T3.
-- zOrder descending = front-most first; exactly one focused=true (P1, hoisted to index 0).
-- Windows are mapped back from CGWindowList by their x-origin (all distinct, y=90 w=240 h=200).

CREATE TABLE IF NOT EXISTS feature_settings (
  id TEXT PRIMARY KEY,
  featureId TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  updatedAt INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_feature_settings_unique ON feature_settings(featureId, key);

INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
VALUES ('session-snapshot', 'session', 'snapshot',
'{"version":1,"createdAt":1752000000000,"reason":"before-quit","windows":[{"url":"https://example.com/","key":null,"title":"P1","bounds":{"x":90,"y":90,"width":240,"height":200},"source":"restore-test","params":{},"zOrder":800,"focused":true},{"url":"https://example.net/","key":null,"title":"P2","bounds":{"x":190,"y":90,"width":240,"height":200},"source":"restore-test","params":{},"zOrder":790,"focused":false},{"url":"https://example.org/","key":null,"title":"P3","bounds":{"x":290,"y":90,"width":240,"height":200},"source":"restore-test","params":{},"zOrder":780,"focused":false},{"url":"https://www.iana.org/","key":null,"title":"P4","bounds":{"x":390,"y":90,"width":240,"height":200},"source":"restore-test","params":{},"zOrder":770,"focused":false},{"url":"https://www.rfc-editor.org/","key":null,"title":"P5","bounds":{"x":490,"y":90,"width":240,"height":200},"source":"restore-test","params":{},"zOrder":760,"focused":false},{"url":"peek://tags/home.html","key":null,"title":"T1","bounds":{"x":590,"y":90,"width":240,"height":200},"source":"restore-test","params":{},"zOrder":750,"focused":false},{"url":"peek://groups/home.html","key":null,"title":"T2","bounds":{"x":690,"y":90,"width":240,"height":200},"source":"restore-test","params":{},"zOrder":740,"focused":false},{"url":"peek://search/home.html","key":null,"title":"T3","bounds":{"x":790,"y":90,"width":240,"height":200},"source":"restore-test","params":{},"zOrder":730,"focused":false}]}',
1752000000000);

INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
VALUES ('session-metadata', 'session', 'metadata',
'{"lastSaveReason":"before-quit","lastSaveAt":1752000000000,"windowCount":8,"cleanShutdown":true,"crashCount":0}',
1752000000000);
