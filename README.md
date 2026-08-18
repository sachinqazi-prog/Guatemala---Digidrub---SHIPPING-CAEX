# CAEX Shopify Middleware

Bridges Shopify's Carrier Service API with CAEX Logistics (Guatemala) SOAP API.

## What it does

1. Shopify sends a JSON rate request when a customer is at checkout
2. This server translates it to SOAP and calls CAEX `ObtenerTarifaEnvio` three times (one per service type)
3. Returns up to 3 shipping options to Shopify: Express, Standard, Economy
4. Falls back to a flat rate if CAEX has no rate for the route (so checkout never breaks)

## Architecture

```
Shopify checkout  ──POST /shopify/rates──▶  This server  ──SOAP──▶  CAEX
                                                  │
                                                  ▼
                                     poblados.json (address lookup)
```

## Setup

### 1. Install

```bash
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env` and fill in your CAEX credentials. For testing, the defaults already have SEARS credentials.

### 3. Fetch the poblados data (one-time)

```bash
npm run fetch-poblados
```

This calls CAEX 22 times (one per Guatemalan department) and writes all poblados to `data/poblados.json`. Takes about 10 seconds. Re-run monthly or when CAEX adds coverage.

### 4. Start the server

```bash
npm start
```

You should see:
```
[INFO] Loaded 5000+ poblados across 22 departments
[INFO] CAEX middleware listening on port 3000
```

### 5. Test it

In a second terminal:

```bash
npm run test-rate
```

You should get back up to 3 rate options. Expected output:

```json
{
  "rates": [
    {
      "service_name": "CAEX Express",
      "service_code": "CAEX_1",
      "total_price": 8000,
      "description": "Next business day",
      "currency": "GTQ"
    },
    ...
  ]
}
```

Prices are in **cents** — Shopify's convention. Divide by 100 to display.

## Endpoints

- `GET /health` — health check
- `POST /shopify/rates` — Shopify's carrier service callback (production use)
- `POST /test/rates` — same as above, for local testing

## Configuration

All behavior is controlled by environment variables. See `.env.example`.

Key vars:

| Variable | Purpose |
|---|---|
| `CAEX_URL` | Endpoint. Switch to production URL when ready. |
| `CAEX_ORIGEN_POBLADO` | Where you ship from. Change once you have Guatemala City's code. |
| `CAEX_DEFAULT_PIEZA` | Piece code. `2` = PAQUETES (safe default). |
| `BACKUP_RATE_GTQ` | Flat fallback rate when CAEX fails. |
| `CACHE_TTL_SECONDS` | Rate cache duration. Default 30 min. |

## Deploying to Render

See Phase 3 instructions in the Claude conversation.

TL;DR:
1. Push this repo to GitHub
2. Create a new Web Service on Render
3. Connect the repo
4. Add env vars in Render dashboard (copy from `.env`)
5. Deploy

## Troubleshooting

**"No poblados data file"** — run `npm run fetch-poblados` first.

**All rates come back as backup** — check logs. Common causes:
- Origin poblado code is wrong (test it in Postman first)
- Destination city can't be fuzzy-matched (check city name in logs)
- CAEX doesn't have a rate for that route (try `CodigoPieza=208`/PRODUCTO A)

**Rate request times out** — CAEX is slow. Increase `timeout` in `src/caex.js` but stay under 8s (Shopify cuts us off at 10s).
