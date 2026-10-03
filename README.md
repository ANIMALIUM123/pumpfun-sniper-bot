# pumpfun-sniper-bot

Automated token sniper bot for [Pump.fun](https://pump.fun) with real-time monitoring and smart trading.

It watches the Solana blockchain over WebSocket, detects every new Pump.fun coin the moment it is created, buys it instantly and exits quickly: it takes profit when the price goes up, or sells right away if the coin does not appreciate. It runs on **free RPC tiers** (Helius free, with the public Solana RPC as fallback), stores everything in **SQLite** and includes a small **REST API + dashboard**.

> 🇧🇷 **Português:** veja o [Guia rápido em português](#-guia-rápido-em-português) no final.

> ⚠️ **Risk warning.** Sniping new meme coins is extremely risky. Most new tokens go to zero, many are scams, and bots compete for the same coins. The bot starts in **paper-trading mode** (`DRY_RUN=true`) and spends nothing. Only use live mode with a **dedicated wallet** holding money you can afford to lose. This software comes with no warranty. You are responsible for how you use it.

---

## Features

| | |
|---|---|
| **Real-time indexer** | Subscribes to Pump.fun program logs (`logsSubscribe`) and decodes `CreateEvent`/`TradeEvent` directly from the logs. It extracts the mint, creator, initial reserves and liquidity, the dev buy, the price and the market cap. A heartbeat resubscribes or switches RPC if the stream goes silent, and it falls back to `getTransaction` when logs are truncated. |
| **Auto-buy** | Buys with Pump.fun's unified `buy_exact_quote_in_v2` instruction (a fixed SOL amount, fees included, with a slippage-protected minimum token amount). It uses a pre-fetched blockhash, a priority fee, and confirms by polling the signature status and re-broadcasting the transaction. |
| **Smart exit** | Take profit, stop loss, an optional trailing stop, a **no-gain timeout** ("didn't pump → get out") and a max hold time. Prices update in real time from the trade stream, and every position is also re-priced from the chain each cycle in a single RPC call. |
| **Buy filters** | Maximum token age, maximum open positions, minimum wallet balance, skip mayhem-mode coins, maximum dev buy, and pause/resume at runtime. |
| **Database** | SQLite (WAL) with tokens, positions, trades, price history and performance metrics. All SQL lives in one repository class, so moving to PostgreSQL later is straightforward. |
| **API / "RPC lite"** | REST endpoints for detected tokens, live prices, on-chain bonding-curve reads, positions, trades, metrics and controls. Includes a status dashboard. |
| **Alerts** | Optional Discord webhook and Telegram bot alerts for buys, sells, errors and (optionally) every detected token. |
| **Production basics** | Typed config validated with zod, structured logs (pino) with secret redaction, graceful shutdown, open positions resumed after a restart, RPC failover, Docker image, CI and 58 tests. |

## Architecture

```
            Solana RPC (Helius free → public fallback)
                 │ WebSocket logsSubscribe(Pump.fun)
                 ▼
 ┌─────────────────────────┐  token  ┌──────────┐  buy   ┌────────────────┐
 │ indexer/pumpfunIndexer  ├────────►│  Sniper  ├───────►│ Trader         │
 │  decode Create/Trade    │         │ filters  │        │ live │ paper   │
 └──────────┬──────────────┘         └────┬─────┘        └───────▲────────┘
            │ trade (real-time prices)    │ position             │ sell
            ▼                             ▼                      │
 ┌─────────────────────────┐   ┌──────────────────────────┐      │
 │ indexer/priceTracker    │   │ trading/positionManager  ├──────┘
 │  price ticks → DB       │   │  TP / SL / trailing /    │
 └──────────┬──────────────┘   │  no-gain / max-hold      │
            │                  └────────────┬─────────────┘
            ▼                               ▼
      ┌──────────────────────────────────────────┐      ┌───────────────┐
      │ SQLite: tokens · positions · trades ·    │◄─────┤ REST API +    │
      │         price_ticks                      │      │ dashboard     │
      └──────────────────────────────────────────┘      └───────────────┘
```

```
src/
├── index.ts            # entry point: config, DB, bot, API, graceful shutdown
├── bot.ts              # wires indexer → sniper → position manager
├── indexer/            # Pump.fun listener + price tracker
├── trading/            # sniper, strategy, position manager, live/paper trader, tx sender, wallet
├── pumpfun/            # protocol: constants, PDAs, borsh, events, accounts, instructions, math
├── api/                # Express REST API + dashboard
├── database/           # SQLite schema/migrations + repository
├── alerts/             # Discord / Telegram
├── rpc/                # RPC manager with failover
├── config/             # env parsing & validation
├── types/              # shared TypeScript types
└── utils/              # logger, async helpers
```

The protocol layer follows the **official Pump IDL and docs** ([pump-fun/pump-public-docs](https://github.com/pump-fun/pump-public-docs)). That includes the unified `*_v2` trade instructions (which support Token-2022 `create_v2` coins), fee and buyback recipients loaded from the on-chain `Global` account, creator vaults, volume accumulators and fee-sharing config.

## Requirements

- **Node.js 22.12+** (and npm)
- A Solana RPC endpoint. A **free [Helius](https://dashboard.helius.dev) API key** is recommended. Without one, the public `api.mainnet-beta.solana.com` is used, which is heavily rate limited and slower.
- For live trading: a dedicated Solana wallet with some SOL.

## Quick start

```bash
git clone https://github.com/ANIMALIUM123/pumpfun-sniper-bot.git
cd pumpfun-sniper-bot
npm install
cp .env.example .env        # then edit .env (at least HELIUS_API_KEY)
npm run build
npm start                   # or: npm run dev  (TypeScript, auto-reload)
```

Open the dashboard at **http://127.0.0.1:3000**.

The bot starts in **paper-trading** mode. It detects real tokens and simulates buys and sells against real on-chain prices, including fees, so you can tune the strategy at no cost. Check the results in the dashboard or at `GET /api/metrics`.

### Going live

1. Create a **new wallet** just for the bot and fund it with a small amount, for example 0.1–0.5 SOL.
2. In `.env`, set:
   ```ini
   DRY_RUN=false
   WALLET_PRIVATE_KEY=<base58 secret key | [json,array] | /path/to/keypair.json>
   BUY_AMOUNT_SOL=0.01
   ```
3. Restart. The log will show `LIVE TRADING ENABLED`.

> Keep `.env` private. It is git-ignored. Never share your private key.

## Strategy: "buy at launch, ride the pump, exit fast if it doesn't move"

The position value is the SOL you would receive **if you sold everything right now**, after fees and price impact. All rules are checked against that value:

| Rule | Default | Meaning |
|---|---|---|
| `TAKE_PROFIT_PERCENT` | `50` | Sell when PnL ≥ +50% (try 20 / 50 / 100). |
| `STOP_LOSS_PERCENT` | `10` | Sell when PnL ≤ −10% (try 5 / 10). |
| `TRAILING_STOP_PERCENT` | `0` (off) | Once PnL has reached `MIN_GAIN_PERCENT`, sell if the value drops this % from its peak. |
| `MIN_GAIN_PERCENT` | `5` | What counts as "it appreciated". |
| `NO_GAIN_EXIT_SECONDS` | `20` | **Exit right away** if, after this many seconds, PnL is still below `MIN_GAIN_PERCENT`. |
| `MAX_HOLD_SECONDS` | `120` | Always sell after this long. |

Notes:
- Pump.fun fees (roughly 1–1.5% each way, see `ESTIMATED_FEE_PERCENT`) and the bot's own price impact mean a fresh position usually starts slightly negative. A tight stop loss (for example 5%) can trigger on normal noise. Paper-trade first.
- If a coin completes its bonding curve while you hold it, it migrates to PumpSwap. The position is marked `migrated` and you get an alert to sell it manually, because PumpSwap selling is not implemented yet.
- A failed sell is retried automatically with backoff. Open positions are saved and resumed after a restart.

## Configuration

All settings come from environment variables. Each one is documented in [`.env.example`](.env.example). The most important ones:

| Variable | Default | Description |
|---|---|---|
| `HELIUS_API_KEY` | – | Free Helius key. Builds `https://mainnet.helius-rpc.com/?api-key=…` and the matching `wss://` URL. |
| `RPC_URL` / `WS_URL` | – | Any other RPC. Overrides Helius. |
| `FALLBACK_RPC_URLS` | public RPC | Comma-separated failover endpoints. |
| `DETECTION_COMMITMENT` | `processed` | `processed` is fastest. `confirmed` is safer. |
| `DRY_RUN` | `true` | Paper trading. Set `false` for live trading. |
| `AUTO_BUY` | `true` | `false` = detect and record only. |
| `BUY_AMOUNT_SOL` | `0.01` | SOL per buy, fees included. |
| `SLIPPAGE_PERCENT` | `15` | Slippage tolerance for buys and sells. |
| `PRIORITY_FEE_MICRO_LAMPORTS` | `100000` | Priority fee. 100k × 400k CU ≈ 0.00004 SOL per transaction. |
| `MAX_OPEN_POSITIONS` | `3` | Concurrent positions. |
| `MIN_WALLET_BALANCE_SOL` | `0.02` | Stop buying below this balance. |
| `MAX_TOKEN_AGE_SECONDS` | `15` | Don't buy tokens older than this when detected. |
| `MAX_DEV_BUY_SOL` | `0` (off) | Skip coins whose creator bought more than this. |
| `SKIP_MAYHEM_TOKENS` | `true` | Skip mayhem-mode coins. |
| `API_HOST` / `API_PORT` | `127.0.0.1` / `3000` | API bind address. |
| `API_KEY` | – | Protects `/api/*` and enables control endpoints. |
| `DISCORD_WEBHOOK_URL` | – | Discord alerts. |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | – | Telegram alerts. |
| `DATABASE_PATH` | `./data/pumpfun.db` | SQLite file. |
| `LOG_LEVEL` / `LOG_PRETTY` | `info` / `true` | Logging. |

The bot fails fast with a clear message if the configuration is invalid.

## REST API

Base URL: `http://127.0.0.1:3000`. When `API_KEY` is set, send it in the `x-api-key` header (a standard `Authorization` header with the key as a bearer credential also works). Large integers such as raw reserves and token amounts are returned as **strings**.

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Liveness check (no auth). |
| GET | `/` | Status dashboard. |
| GET | `/api/status` | Mode, wallet, RPC endpoint, indexer and sniper stats. |
| GET | `/api/config` | Active configuration, with secrets removed. |
| GET | `/api/metrics?mode=paper\|live` | Win rate, PnL, average hold time, exit reasons. |
| GET | `/api/tokens?limit=&offset=&search=` | Detected tokens, newest first. |
| GET | `/api/tokens/:mint` | Token details and live price. |
| GET | `/api/tokens/:mint/price` | Latest price (live if tracked, otherwise the last stored point). |
| GET | `/api/tokens/:mint/prices?limit=&since=` | Price history. |
| GET | `/api/tokens/:mint/curve` | Bonding curve read **directly from the chain**: reserves, price, market cap and progress. Works for any Pump.fun coin. |
| GET | `/api/prices/live` | All tokens currently tracked in real time. |
| GET | `/api/positions?status=&mode=&limit=&offset=` | Position history (`open`, `closed`, `failed`, `migrated`). |
| GET | `/api/positions/open` | Open positions with live value, unrealized PnL and hold time. |
| GET | `/api/positions/:id` | One position and its trades. |
| GET | `/api/trades?mint=&mode=&limit=&offset=` | Trade log, including failed attempts. |
| POST | `/api/positions/:mint/sell` | Sell a position now.¹ |
| POST | `/api/bot/pause` · `/api/bot/resume` | Stop or resume auto-buying. Detection keeps running.¹ |

¹ Only available when `API_KEY` is configured.

```bash
curl -H "x-api-key: $API_KEY" "http://127.0.0.1:3000/api/tokens?limit=5"
curl -H "x-api-key: $API_KEY" -X POST http://127.0.0.1:3000/api/bot/pause
```

## Deployment

### Docker

```bash
cp .env.example .env   # edit it
docker compose up -d --build
docker compose logs -f
```

Data is stored in `./data`. The API is published only on `127.0.0.1:3000` of the host.

### pm2 (VPS)

```bash
npm ci && npm run build
npm i -g pm2
pm2 start dist/index.js --name pumpfun-sniper --kill-timeout 10000
pm2 save && pm2 startup
```

For best detection speed, run the bot close to your RPC provider (US East or EU regions for Helius). A small VPS (1 vCPU, 1 GB RAM) is enough.

### Exposing the API

Keep `API_HOST=127.0.0.1` and use an SSH tunnel (`ssh -L 3000:127.0.0.1:3000 your-vps`). If you need remote access, set a strong `API_KEY` and put the API behind a reverse proxy with HTTPS.

## Development

```bash
npm run dev         # run with auto-reload (tsx)
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # compile to dist/
```

The tests cover the protocol layer (discriminators, PDAs, account order of the v2 instructions against the IDL, event, bonding-curve and Global decoding), the curve math, every exit rule, config validation, wallet loading, the repository, the indexer, full paper-trading flows, a live trader on a simulated chain (signed transaction size and rent-excluded PnL), alerts and the API.

## Scaling up later

- **RPC:** switch `RPC_URL` to a paid Helius, QuickNode or Triton plan, or use a Geyser/gRPC stream, for lower latency and higher rate limits. No code changes are needed for RPC URLs.
- **Landing rate:** raise `PRIORITY_FEE_MICRO_LAMPORTS`, or add a Jito bundle sender in `trading/txSender.ts`.
- **PostgreSQL:** every query is in `src/database/repository.ts`. Re-implement that class on top of `pg` and keep the same method signatures.
- **PumpSwap:** add AMM selling for coins that migrate while held.

---

## 🇧🇷 Guia rápido em português

**O que o bot faz:** monitora a blockchain da Solana em tempo real, detecta cada token novo criado no Pump.fun, **compra na hora** e **sai rápido**. Ele vende com lucro quando o token valoriza, ou sai imediatamente se o token não valorizar. Funciona com **RPC grátis** (Helius free + RPC público como reserva), guarda tudo em **SQLite** e tem uma **API + painel**.

### Passo a passo

1. Instale o **Node.js 22.12+**.
2. Crie uma conta grátis na [Helius](https://dashboard.helius.dev) e copie sua **API key**.
3. Instale e configure:
   ```bash
   git clone https://github.com/ANIMALIUM123/pumpfun-sniper-bot.git
   cd pumpfun-sniper-bot
   npm install
   cp .env.example .env      # edite: HELIUS_API_KEY=sua_chave
   npm run build
   npm start
   ```
4. Abra o painel em **http://127.0.0.1:3000**.

O bot começa em **modo simulação** (`DRY_RUN=true`). Ele detecta tokens reais e simula as compras e vendas com os preços reais da blockchain, **sem gastar nada**. Deixe rodando algumas horas e veja os resultados (taxa de acerto, lucro/prejuízo) no painel.

### Ativar compras reais

1. Crie uma **carteira nova só para o bot** e coloque pouco SOL (ex.: 0,1–0,5 SOL).
2. No `.env`, defina:
   ```ini
   DRY_RUN=false
   WALLET_PRIVATE_KEY=sua_chave_privada_base58
   BUY_AMOUNT_SOL=0.01
   ```
3. Reinicie o bot.

### Estratégia de saída (configurável no `.env`)

| Variável | Padrão | Significado |
|---|---|---|
| `TAKE_PROFIT_PERCENT` | 50 | Vende com +50% de lucro (ex.: 20, 50, 100). |
| `STOP_LOSS_PERCENT` | 10 | Vende com −10% de prejuízo (ex.: 5, 10). |
| `NO_GAIN_EXIT_SECONDS` | 20 | Se em 20 s não valorizou pelo menos `MIN_GAIN_PERCENT` (5%), **sai na hora**. |
| `MAX_HOLD_SECONDS` | 120 | Vende de qualquer jeito depois de 2 minutos. |
| `TRAILING_STOP_PERCENT` | 0 | (Opcional) Depois de lucrar, vende se cair X% do topo. |

### Alertas (opcional)

- **Discord:** coloque a URL do webhook em `DISCORD_WEBHOOK_URL`.
- **Telegram:** crie um bot com o @BotFather e preencha `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID`.

### Custos

- RPC: **grátis** (Helius free tier).
- Cada transação: ~0,000045 SOL de taxa de rede + prioridade, mais ~1–1,5% de taxa do Pump.fun em cada compra e venda.
- Servidor (opcional): uma VPS de US$ 5/mês é suficiente.

Quando o projeto começar a dar lucro, basta trocar o `RPC_URL` por um RPC pago, sem mudar o código.

> ⚠️ **Aviso:** tokens novos do Pump.fun são extremamente arriscados. A maioria vai a zero e existem muitos golpes. Use só dinheiro que você pode perder, sempre com uma carteira separada. Teste bastante em modo simulação antes.

## License

[MIT](LICENSE)
