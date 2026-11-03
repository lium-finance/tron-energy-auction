import type { VenueAdapter } from "../collectors/adapter.js";
import { VENUES } from "../collectors/index.js";
import type { Quote } from "../core/types.js";

/**
 * Every gated venue, whatever the environment says: the default when no gate set was wired. The set the environment
 * opens is Config.collectOnly (collectOnlyVenues in src/index/config.ts).
 */
export function allGatedVenues(venues: readonly VenueAdapter[] = VENUES): ReadonlySet<string> {
  return new Set(venues.filter((v) => v.publishGate).map((v) => v.venue));
}

/** The quotes a print may count and the public files may carry: all but the collect-only venues'. */
export function publishable<Q extends Pick<Quote, "venue">>(quotes: readonly Q[], collectOnly: ReadonlySet<string>): Q[] {
  return quotes.filter((q) => !collectOnly.has(q.venue));
}
