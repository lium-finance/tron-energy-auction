import type { VenueAdapter } from "./adapter.js";
import { getblock } from "./getblock.js";
import { itrx } from "./itrx.js";
import { justlend, justlendNet } from "./justlend.js";
import { netts } from "./netts.js";
import { tokengoodies } from "./tokengoodies.js";
import { tronenergyMarket } from "./tronenergy-market.js";
import { tronpulse } from "./tronpulse.js";
import { tronbid } from "./tronbid.js";
import { tronsave } from "./tronsave.js";
import { tronzap } from "./tronzap.js";

/**
 * Every venue the hour job asks, in this order. The hourly print reads only 1h rows with 20M depth.
 * Venues with a `publishGate` (iTRX, TRON Energy Market, TokenGoodies) are collected and stored but never counted or
 * published until their PUBLISH_<VENUE> is on (src/index/gate.ts).
 */
export const VENUES: readonly VenueAdapter[] = [tronsave, tronbid, getblock, netts, justlend, justlendNet, itrx, tronenergyMarket, tronzap, tronpulse, tokengoodies];
