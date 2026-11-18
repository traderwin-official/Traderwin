import { createBotLicenseHandler } from '../../../lib/cloudflare-bot-license.js';

export const onRequestPost = createBotLicenseHandler();
