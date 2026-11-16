import { createEmergencyControlHandler } from '../../../../lib/cloudflare-emergency-control.js';

export const onRequestGet = createEmergencyControlHandler('GET');
export const onRequestPost = createEmergencyControlHandler('POST');
