// Loads the shared <peek-*> components used across the settings panes
// (form helpers in settings.js, Devices panel, shell). Kept as an external
// module file rather than inline <script type="module"> so settings.html can
// run under a strict `script-src 'self'` CSP — this page holds the sync API
// key and renders device labels the server supplies, so no 'unsafe-inline'.
import 'peek://app/components/peek-card.js';
import 'peek://app/components/peek-input.js';
import 'peek://app/components/peek-button.js';
import 'peek://app/components/peek-select.js';
import 'peek://app/components/peek-switch.js';
import 'peek://app/components/peek-dialog.js';
