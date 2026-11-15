import { createDerivDisconnectHandler } from '../../../lib/cloudflare-deriv.js';

export const onRequestPost = createDerivDisconnectHandler();
