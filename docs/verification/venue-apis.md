# Venue APIs: the first-day check (TronBid, GetBlock, NetTS)

Recorded 2026-10-22 between 14:00:25Z and 14:03:06Z from one machine. Read-only GET requests only, at most one
every 2 seconds per host, no account, no API key, no POST. Bodies quoted below are the first 600 bytes as
received (an empty block means an empty body). The question for each venue: does a public, keyless API return
a price for a given size and a depth or availability?

Short answer: none of the three does. TronSave (Task 9) stays the only venue whose answer can count toward the
hourly print's depth-aware total, so every hourly print is `no_index` until a second and third depth-aware venue
are found (`MIN_LIVE = 3`, src/core/print.ts). Under the rule chosen on 2026-10-22, TronBid's catalog and GetBlock's page tier
are published beside the print as `depth-unknown` rows.

## TronBid

### The availability endpoint first assumed

2026-10-22T14:00:25Z

```bash
curl -sS -m 20 -A "Mozilla/5.0" "https://tronbid.com/api/v2/quick-rent/availability?amount=20000000&duration=3600" | head -c 600
```

`HTTP/2 405` (method not allowed), empty body:

```
```

2026-10-22T14:02:37Z

```bash
curl -sS -m 20 -A "Mozilla/5.0" "https://tronbid.com/api/v2/quick-rent/availability?energy=20000000&hours=1" | head -c 600
```

`HTTP/2 405`, empty body:

```
```

### What the site says the endpoint is

2026-10-22T14:00:37Z: `curl -sS -m 20 -A "Mozilla/5.0" "https://tronbid.com/" | grep -o 'quick-rent/availability[^"]*' | head`
printed nothing: `https://tronbid.com/` answers `HTTP/2 308` to `https://tronbid.com/en` with a 22-byte body.

2026-10-22T14:00:43Z, following the redirect:

```bash
curl -sSL -m 20 -A "Mozilla/5.0" "https://tronbid.com/" | grep -o 'quick-rent/availability[^"]*'
```

`HTTP/2 200`, `text/html`, 371,812 bytes. First 600 bytes:

```
<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><link rel="preload" as="image" imageSrcSet="/_next/image?url=%2Ftronbid-logo.png&amp;w=16&amp;q=75 16w, /_next/image?url=%2Ftronbid-logo.png&amp;w=32&amp;q=75 32w, /_next/image?url=%2Ftronbid-logo.png&amp;w=48&amp;q=75 48w, /_next/image?url=%2Ftronbid-logo.png&amp;w=64&amp;q=75 64w, /_next/image?url=%2Ftronbid-logo.png&amp;w=96&amp;q=75 96w, /_next/image?url=%2Ftronbid-logo.png&amp;w=128&amp;q=75 128w, /_next/image?url=%2Ftronbid-logo.png&amp;w=256&amp;q=75 256w, /_n
```

The page's `quick-rent/availability` matches are not a script call but the site's own API documentation (section
"Recipient pool availability"). In summary: the endpoint is `POST /api/v2/quick-rent/availability`; it needs the
caller's Bearer API key; the body is `target_address` (a TRON address) and an optional `resource_type`; the docs
say not to send `energy_amount` or `duration_minutes`; it answers `available: true|false` with a reason
(`AVAILABLE`, `ALL_POOLS_BUSY`, `NO_ELIGIBLE_POOLS`). It is a per-recipient pool-occupancy check. It takes no
size and reports no volume or price.

### The Quick Rent page and its bundle

2026-10-22T14:01:13Z: `curl -sSL -m 20 -A "Mozilla/5.0" "https://tronbid.com/en/quick-rent"`: `HTTP/2 200`,
232,284 bytes. Its API documentation says every request carries a Bearer API key, which an administrator must
grant; prices come from `POST /quote` with `energy_amount` and `duration_minutes`, which must match an active
package. The packages are 65,000, 131,000, 196,500, 262,000, 524,000 and 1,048,000 units for 15 or 60 minutes,
and "the active catalog" is available with no auth.

2026-10-22T14:01:52Z, the page's component chunk:

```bash
curl -sS -m 20 -A "Mozilla/5.0" "https://tronbid.com/_next/static/chunks/69954-0d6520773302f92b.js" | grep -oE '"/api/[^"]+'
```

`HTTP/2 200`, 72,009 bytes. First 600 bytes:

```
(self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([[69954,81669,88879,94653],{10211:(e,t,n)=>{"use strict";n.d(t,{Cf:()=>d,Es:()=>p,HM:()=>c,L3:()=>x,c7:()=>m,lG:()=>l,rr:()=>h});var r=n(17803),a=n(16827),i=n(86913),s=n(87644);let l=i.bL;i.l9;let o=i.ZL,c=i.bm,u=a.forwardRef((e,t)=>{let{className:n,...a}=e;return(0,r.jsx)(i.hJ,{ref:t,className:(0,s.cn)("fixed inset-0 z-[100] bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",n),...a})});u.displayName=i.hJ.displayName;let d=a.forwardRef((e,t)=>{let{className:
```

The API paths it calls: `/api/me/balance`, `/api/public/quick-rent/skus?resource_type=bandwidth`,
`/api/public/telegram/quick-rent-prices/link-token`, `/api/v2/quick-rent/orders`, `/api/v2/quick-rent/orders/`,
`/api/v2/quick-rent/quote`. The site's own quote call is
`fetch("/api/v2/quick-rent/quote",{method:"POST",...,body:JSON.stringify({energy_amount,duration_minutes,resource_type})})`,
a POST for a fixed package. It was not called (POST is outside this check).

### The one keyless endpoint: the package catalog

2026-10-22T14:02:01Z

```bash
curl -sS -m 20 -A "Mozilla/5.0" "https://tronbid.com/api/public/quick-rent/skus?resource_type=energy" | head -c 600
```

`HTTP/2 200`, `application/json`, `cache-control: no-store, max-age=0`, 894 bytes. First 600 bytes:

```
{"skus":[{"energy_amount":"65000","duration_minutes":15,"price_trx":"1.630000"},{"energy_amount":"65000","duration_minutes":60,"price_trx":"1.700000"},{"energy_amount":"131000","duration_minutes":15,"price_trx":"3.290000"},{"energy_amount":"131000","duration_minutes":60,"price_trx":"3.420000"},{"energy_amount":"262000","duration_minutes":15,"price_trx":"6.570000"},{"energy_amount":"262000","duration_minutes":60,"price_trx":"6.830000"},{"energy_amount":"524000","duration_minutes":15,"price_trx":"13.250000"},{"energy_amount":"524000","duration_minutes":60,"price_trx":"13.780000"},{"energy_amount
```

The whole body is `test/fixtures/tronbid-skus-energy.json` (12 packages, `totalCount: 12`). The 60-minute
packages work out to 26.06 to 26.30 sun per unit (65,000 units for 1.70 TRX is 26.15). The catalog gives a price
for fixed packages up to 1,048,000 units. It does not take a size, and it says nothing about depth or availability.

**Outcome:** no public size API. The only size-aware call (`POST /quote`) needs a key and only takes catalog
packages. The availability check needs a key and takes no size.

**Collector (decided 2026-10-22):** the print rule is unchanged. The ladder is published with the
`no_index` flag and includes TronBid's packages. `src/collectors/tronbid.ts` makes one GET to the keyless catalog
for one row, `{ size: 20,000,000, term: 1h }`, using the same convention as GetBlock's row. It takes the 60-minute
energy package with the largest unit count and prices it as `price_trx × 1,000,000 / energy_amount` sun per unit
(from the fixture: 1,048,000 units at 27.55 TRX, which is 26.29 sun per unit). Depth is null, so the row is
`depth-unknown`, and the row's reason names the package that was priced. Only 60-minute rows are validated, so a
malformed 15-minute row is ignored. These are schema failures: a missing or non-positive field on a 60-minute
row, a catalog with no 60-minute package, and a row whose `resource_type` is present and is not `energy`.

## GetBlock

2026-10-22T14:00:28Z

```bash
curl -sSL -m 20 -A "Mozilla/5.0" "https://getblock.io/tron-energy" | sed 's/<[^>]*>/ /g' | tr -s ' \n' | grep -oE "[0-9]+k [0-9.]+ TRX [0-9.]+ TRX" | head
```

`HTTP/2 307`, then `HTTP/2 200`, `text/html`, 167,450 bytes. The command printed:

```
65k 1.95 TRX 6.5 TRX
131k 3.93 TRX 13.1 TRX
270k 8.1 TRX 27 TRX
540k 16.2 TRX 54 TRX
```

First 600 bytes of the page:

```
<!DOCTYPE html><html  lang="en" style="overflow-x: clip" data-capo=""><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tron Energy — Rent TRON Energy and Save up to 70% on Fees | GetBlock.io</title>
<link rel="preconnect" href="https://storage.getblock.io" crossorigin>
<link rel="preconnect" href="https://images.prismic.io" crossorigin>
<style data-hid="5eb434d">.reveal-pending [data-reveal-root] > *{opacity:0}</style>
<script data-hid="3bdd3bd">document.documentElement.classList.add('reveal-pending');setTimeout(function(){if(!document.
```

The table (section "Transparent Pricing", saved as `test/fixtures/getblock-page.html`) is server-rendered with the
columns Energy Volume, 1h Rental, Burn TRX, Your Savings. The page calls these "Indicative prices for a 1-hour
rental" and notes "*Prices are accurate at page load time. Final cost is calculated at checkout." Every tier is
30 sun per unit (1.95 TRX for 65,000 units). Every rental price is exactly 30% of the Burn column (65k: 6.5 TRX
burn, that is 100 sun per unit, the current energy fee), and the savings are 70% on every row. So the page price
looks like a fixed fraction of the burn price, not a market quote. GetBlock's API needs an account, and the page
lists sizes of 10M+ a day as enterprise pricing. Largest listed tier: 540,000 units.

**Outcome:** no keyless size API. `src/collectors/getblock.ts` fetches the page with `expect: "html"`. It strips
scripts, styles and tags, requires the "1h Rental" header, and requires exactly one whole 65k row (volume, rental,
burn, savings, percentage) whose rental plus savings equals the burn to within 0.01 TRX. It returns 30 sun per
unit as `depth-unknown`, and the reason names the 65,000-unit 1-hour tier. A `depth-unknown` row never counts toward the
hourly print.

## NetTS

2026-10-22T14:00:27Z (no key; there is no `NETTS_API_KEY`)

```bash
curl -sS -m 20 "https://netts.io/apiv2/prices" | head -c 600
```

`HTTP/2 401`, `application/json`, 57 bytes (saved as `test/fixtures/netts-prices-nokey.json`):

```
{"detail":{"code":-1,"msg":"Invalid or missing API key"}}
```

2026-10-22T14:02:53Z: the endpoint's documentation, `https://doc.netts.io/api/v2/endpoints/prices.html`
(`HTTP/2 200`). It says `GET /apiv2/prices` is **deprecated** in favour of `GET /apiv2/pricing`, and both
`X-API-KEY` and `X-Real-IP` (an IP on the account's whitelist) are required. It quotes per-period prices in sun
for fixed bands (under 200k, 131k, over 200k). The docs also warn that orders of 300,000 units and above may be
filled at a higher price than quoted.

2026-10-22T14:03:06Z: `https://doc.netts.io/api/v2/endpoints/order1h.md` (`HTTP/2 200`, read only; the order
endpoint itself was not called). It gives the `amount` range for one order as "minimum: 61000, maximum: 3000000"
and says "**Maximum energy amount**: 3,000,000 units per order".

**Outcome:** no keyless API. Prices need a key and a whitelisted IP, and one 1-hour order is capped at 3,000,000
units, so NetTS can never show 20,000,000 of depth. No keyed answer has been recorded, so no parser is written.
`src/collectors/netts.ts` returns `missing` and makes no request: `requires NETTS_API_KEY; one order is capped at
3,000,000 units` without a key, and `no recorded keyed response to parse (2026-10-22); one order is capped at
3,000,000 units` with one.

## Summary

| venue | size API | key needed | maximum size | enters the hourly print | fixture |
| --- | --- | --- | --- | --- | --- |
| TronBid | no (keyless catalog of fixed packages only; `POST /quote` and `POST /availability` need a Bearer key) | yes, for anything size-aware | 1,048,000 units per package | no, published beside it as `depth-unknown` (largest 60-minute package, 26.29 sun/unit) | `test/fixtures/tronbid-skus-energy.json` |
| GetBlock | no (public page tiers; API needs an account) | yes, for the API | 540,000 units per listed tier | no, published beside it as `depth-unknown` (65k tier, 30 sun/unit) | `test/fixtures/getblock-page.html` |
| NetTS | no keyless API (`/apiv2/prices` needs `X-API-KEY` and a whitelisted `X-Real-IP`) | yes | 3,000,000 units per 1-hour order | no (`missing`; never 20M of depth) | `test/fixtures/netts-prices-nokey.json` (the 401, not parsed) |

The hourly print's depth-aware count can therefore be at most 1 (TronSave) from today's venue list. With
`MIN_LIVE = 3`, every print is `no_index` until two more venues that report 20,000,000 units of depth are found.
Decided on 2026-10-22: keep the print rule, publish the ladder with the `no_index` flag, and include
TronBid's packages.
