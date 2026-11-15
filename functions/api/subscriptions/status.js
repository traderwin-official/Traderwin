import { createSubscriptionStatusHandler } from '../../../lib/cloudflare-subscriptions.js';

export const onRequestGet = createSubscriptionStatusHandler();
