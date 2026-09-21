// Loads the shared <peek-*> components used by the Devices panel
// (renderDevicesSettings() in settings.js). Kept as an external module file
// rather than inline <script type="module"> so settings.html can run under
// a strict `script-src 'self'` CSP — this page holds the sync API key and
// renders device labels the server supplies, so no 'unsafe-inline' here.
import 'peek://app/components/peek-card.js';
import 'peek://app/components/peek-input.js';
import 'peek://app/components/peek-button.js';
