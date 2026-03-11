/**
 * Reddit OAuth service integration.
 *
 * To use: create an app at https://www.reddit.com/prefs/apps
 * (type: "installed app"), then replace the placeholder CLIENT_ID.
 *
 * Reddit uses a slightly different OAuth flow: duration=permanent for
 * refresh tokens, and the token endpoint requires Basic auth header
 * instead of client_secret in the body. The base service handles the
 * code exchange, and the extraParams here configure the auth request.
 */

import { createService } from './base.js';

export default createService({
  id: 'reddit',
  name: 'Reddit',
  icon: '\u2B24',   // filled circle
  color: '#FF4500',
  oauth: {
    authUrl: 'https://www.reddit.com/api/v1/authorize',
    tokenUrl: 'https://www.reddit.com/api/v1/access_token',
    clientId: 'YOUR_REDDIT_CLIENT_ID',
    scopes: 'identity read',
    extraParams: {
      duration: 'permanent',
    },
  },
});
