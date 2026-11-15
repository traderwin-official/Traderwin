import { createDerivStatusHandler } from '../../../lib/cloudflare-deriv.js';

export const onRequestGet = createDerivStatusHandler();
