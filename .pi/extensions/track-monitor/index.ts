import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { installMonitor } from './runtime.mjs';

export default function trackMonitor(pi: ExtensionAPI) {
  installMonitor(pi);
}
