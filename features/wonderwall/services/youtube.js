/**
 * YouTube (Google OAuth) service integration.
 *
 * To use: register a Google Cloud project, enable the YouTube Data API v3,
 * and create an OAuth 2.0 Client ID (Desktop app type). Replace the
 * placeholder CLIENT_ID below with your actual client ID.
 */

import { createService } from './base.js';

export default createService({
  id: 'youtube',
  name: 'YouTube',
  icon: '\u25B6',   // play button triangle
  color: '#FF0000',
  oauth: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    clientId: 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com',
    scopes: 'https://www.googleapis.com/auth/youtube.readonly',
    extraParams: {
      access_type: 'offline',
      prompt: 'consent',
    },
  },
});
