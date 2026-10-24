import type { VenueAdapter } from "./adapter.js";
import { getblock } from "./getblock.js";
import { justlend, justlendNet } from "./justlend.js";
import { netts } from "./netts.js";
import { tronbid } from "./tronbid.js";
import { tronsave } from "./tronsave.js";

/** Every venue the hour job asks, in this order. The hourly print reads only 1h rows with 20M depth. */
export const VENUES: readonly VenueAdapter[] = [tronsave, tronbid, getblock, netts, justlend, justlendNet];
