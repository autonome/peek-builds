/**
 * Service registry for Wonderwall.
 *
 * Import all service modules here. The home UI iterates this array
 * to render service cards and drive connect/disconnect flows.
 *
 * To add a new service:
 * 1. Create services/myservice.js using createService() from base.js
 * 2. Import it here and add to the array
 */

import youtube from './youtube.js';
import soundcloud from './soundcloud.js';
import reddit from './reddit.js';

const services = [youtube, soundcloud, reddit];

export default services;
