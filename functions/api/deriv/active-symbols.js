import { createDerivActiveSymbolsHandler } from '../../../lib/cloudflare-deriv-active-symbols.js';

export const onRequestGet = createDerivActiveSymbolsHandler();
