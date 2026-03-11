/**
 * SoundCloud OAuth service integration.
 *
 * To use: register an app at https://soundcloud.com/you/apps
 * and replace the placeholder CLIENT_ID below.
 */

import { createService } from './base.js';

export default createService({
  id: 'soundcloud',
  name: 'SoundCloud',
  icon: '\u266B',   // beamed eighth notes
  color: '#FF5500',
  oauth: {
    authUrl: 'https://soundcloud.com/connect',
    tokenUrl: 'https://api.soundcloud.com/oauth2/token',
    clientId: 'YOUR_SOUNDCLOUD_CLIENT_ID',
    scopes: '',
    extraParams: {
      display: 'popup',
    },
  },
});
