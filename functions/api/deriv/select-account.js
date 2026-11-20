import { createDerivSelectAccountHandler } from '../../../lib/cloudflare-deriv-accounts.js';

export const onRequestPost = createDerivSelectAccountHandler();
