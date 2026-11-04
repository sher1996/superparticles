# bol Opportunity Engine

Every day this app looks for products that are **trending on bol.com right now** and that you can
**buy cheaply on AliExpress and resell with real profit**. You only open the dashboard and click
**Approve** or **Reject**.

It only uses **official APIs**: the bol Retailer API, the bol Marketing Catalog API and the
AliExpress Affiliate API. It never scrapes websites. It is free to run: no paid data tools, and the AI
part is optional with a daily spending cap.

It starts in **DEMO MODE**, with a realistic simulated market, so you can try everything before your
accounts are approved. Changing one line in `.env` switches it to your real data.

---

## 1. Start it (Windows)

1. Install **Python 3.11 or newer** from <https://www.python.org/downloads/>.
   Tick **"Add python.exe to PATH"** during installation.
2. Download or copy this `bol-opportunity-engine` folder to your PC.
3. Double-click **`start_windows.bat`**.
   - The first time, it creates a private Python environment and installs everything (about 1 minute).
   - It creates your `.env` file from `.env.example`.
   - It opens <http://127.0.0.1:8000> in your browser.
4. Click **Run now**. In demo mode the run takes a few seconds and the list fills up.

Keep the black window open: it is the app. Close it to stop.

<details><summary>Mac / Linux / home server</summary>

```bash
cd bol-opportunity-engine
python3 -m venv .venv
```

```bash
source .venv/bin/activate
```

```bash
pip install -r requirements.txt
```

```bash
cp .env.example .env
```

```bash
python run.py
```

On a home server, set `HOST=0.0.0.0` in `.env` so you can open it from other devices. Only do this
inside your home network: the dashboard has no login.
</details>

---

## 2. What you see

**Today**: today's opportunities, best first. Each card shows:

- the **keyword** Dutch shoppers type on bol, plus other keywords for the same product
- a **search-volume chart**: the last 52 weeks against the same weeks last year
- the **top bol competitors**: price, number of sellers, reviews, rank and impressions
- the **AliExpress match**: photo, link, price, recent sales, rating and a **match confidence**
- **profit per unit** after every cost. Click *Show calculation* for the breakdown.
- **Why this score**: a plain-language explanation, plus **risk notes**
- a **🖨 Printable** badge if you could make it yourself on your Roland SG2-540, with your
  estimated print cost
- **Approve / Reject**, with an optional reason. Use *Undo* if you clicked by mistake.

At the bottom, **Filtered out** lists every product that was dropped today, and why.

**History**: every keyword the engine has ever checked, with a sparkline. Click one to see its full
search history, its score per day, and the impressions and seller count of its bol products over time.

**Settings & runs**: credentials status, a *Test connections* button, what the engine learned from your
decisions, every run with its log, and all rates, thresholds and weights (editable).

---

## 3. How it decides (the daily funnel)

| Step | What happens |
|---|---|
| 1. Seeds | Takes AliExpress hot products (sorted by recent sales), turns their titles into Dutch search terms, and adds bol's *related search terms*. The keyword list grows every day. Keywords that stay flat are parked and only re-checked weekly. |
| 2. Demand | Gets the bol search volume per week (up to 4 years). A keyword counts as **rising** only if: enough searches, the last 4 weeks beat the 4 weeks before, most recent weeks went up, it is higher than the same weeks **last year**, **and** it grows more than it did at this time last year. That last rule stops normal seasonal peaks (like Christmas) from counting as trends. It also estimates **earliness**: young, still accelerating, not past a peak. |
| 3. Competition | For rising keywords: the top bol products in bol's ranked order, their prices, number of competing sellers, review counts and listing quality. Ranks and impressions are **stored every day from day one**, because bol only keeps about 3 months. |
| 4. Supply match | Searches AliExpress and picks the same product by title, specs (size, quantity), price and, in live mode, photo similarity. With an AI key, Claude compares titles and photos too. Every match gets a confidence score. |
| 5. Profit | Sale price − 21% VAT − bol commission − bol fixed fee − fulfilment (Logistiek via bol or own shipping) − packaging − AliExpress price − shipping to NL − import VAT − customs/handling − returns allowance. All rates are editable. |
| 6. Risk filter | Drops electronics/batteries, kids' toys and baby items, cosmetics, food and supplements, anything needing CE or other certification, clothing and shoes with sizes, fragile items, heavy or large items, and brand names or trademarks. You can add your own blocked words. |
| 7. Score | Demand growth + earliness + weak competition + profit + match confidence, combined into a score from 0 to 100, with an explanation. |

**Learning from you**: after 3 decisions, your approvals and rejections re-rank new suggestions by
up to ±15 points, based on similar categories, price bands, sizes, keywords and so on. Your reasons
also shift the weights. For example, "margin too low" makes profit count more, and "too much
competition" makes competition count more. Rejected items stay hidden for 30 days (configurable)
unless their score improves a lot. Approved items stay approved.

---

## 4. Create your accounts and get your keys

You need **three free accounts**, and optionally an Anthropic account for the AI. Put every key in
the **`.env`** file in this folder (open it with Notepad). **Never** share this file or put it online.

> Menu names on these websites change from time to time. If a button has moved, search the
> platform's help center for the words in quotes.

### 4a. bol seller account → Retailer API (main demand signal)

Used for: search volume (Insights), product lists, ranks and impressions, and competing offers.

1. Register as a seller: <https://partner.bol.com> ("Verkopen via bol"). You need a KvK (Chamber of
   Commerce) number, a VAT number and a business bank account. bol checks your registration before
   you can sell.
2. In the seller dashboard, go to **Instellingen → API-instellingen** ("API settings").
   bol may first ask you to add a **technical contact**: add yourself.
3. Under the **Retailer API**, click **Aanmaken** / *Create credentials* and give them a name such as
   "opportunity-engine".
4. Copy the **Client ID**. Click **Toon secret** and copy the **Client Secret**. You can't see the
   secret again later, but you can always create a new pair.
5. In `.env`:
   ```
   BOL_CLIENT_ID=paste-client-id-here
   BOL_CLIENT_SECRET=paste-secret-here
   ```

bol's **demo environment** (`api.bol.com/retailer-demo`) accepts the same credentials but only returns
fixed example answers. In demo mode, *Settings → Test connections* checks that your seller
credentials work there. The trend data in demo mode comes from the built-in simulator, because fixed
examples can't show trends.

### 4b. bol affiliate account → Marketing Catalog API (prices, details, delivery)

1. Sign up for the bol **Partnerprogramma** (affiliate program). Search for "bol partnerprogramma
   aanmelden" to find the current sign-up page.
2. Once accepted, log in, click **Account**, scroll to the **Open API** section and click
   **Toevoegen** (add).
3. Copy the **Client ID**. Click **Toon secret** and copy the **Client Secret**.
4. In `.env`:
   ```
   BOL_AFFILIATE_CLIENT_ID=paste-client-id-here
   BOL_AFFILIATE_CLIENT_SECRET=paste-secret-here
   ```

### 4c. AliExpress affiliate account → Affiliate API (supply side)

1. Sign up as an affiliate at <https://portals.aliexpress.com>. In the portal, create a **tracking ID**
   (this is optional for this app, but it gives you affiliate links).
2. Go to the **AliExpress Open Platform** (developer console, <https://openservice.aliexpress.com>;
   the affiliate portal also links to it) and register as a developer with the same account.
3. **Create App** → choose the **Affiliate API** app type (sometimes called "Affiliates
   Individual"). Describe it honestly, for example "Personal product research tool using
   hotproduct.query and product.query". Approval usually takes a few working days.
4. When approved, open the app and copy the **App Key** and **App Secret**.
5. In `.env`:
   ```
   ALIEXPRESS_APP_KEY=paste-app-key
   ALIEXPRESS_APP_SECRET=paste-app-secret
   ALIEXPRESS_TRACKING_ID=your-tracking-id
   ```

The AliExpress API returns delivery time but usually not a shipping **cost**. The engine therefore
uses the *Shipping to NL estimate* from Settings (small, medium or large) and labels it
"(estimate)" in the calculation.

### 4d. (Optional) Anthropic API → smarter translation, matching and explanations

Without a key, everything still works with the built-in rules (a dictionary-based translator and
rule-based matching). With a key, the engine uses the small, cheap **Claude Haiku 5.5** model.

1. Create an account at <https://console.anthropic.com>, add a small amount of credit, and set a
   **monthly spend limit** under *Billing / Limits* as an extra safety net.
2. Go to **API Keys → Create Key** and copy it.
3. In `.env`: `ANTHROPIC_API_KEY=sk-ant-...`
4. The engine stops using AI for the rest of the day when it reaches the **daily cost cap** (Settings →
   AI, default $0.50/day). Results are cached, so the same question is never paid for twice. A
   normal day costs a few cents.

After editing `.env`, **close the app and start it again**.

---

## 5. Switch from demo to live

1. Fill in the keys above.
2. In `.env`, change:
   ```
   ENGINE_MODE=live
   ```
3. Restart the app, open **Settings & runs**, and click **Test connections**. Every line should say
   *Connected*.
4. Click **Run now** (or wait for the daily run).

**Not all accounts approved yet?** You can go live for the parts you already have and keep the
rest simulated:

```
ENGINE_MODE=live
MOCK_SOURCES=aliexpress
```

(possible values: `bol_retailer`, `bol_catalog`, `aliexpress`, comma separated). The badge at the top
shows **LIVE**. Hover over it to see which parts are still simulated. Results that mix real bol data
with simulated AliExpress data are only useful for testing.

**Starting fresh**: demo and live data share one database. Before your first live run, delete
`data/engine.db` (with the app closed) so demo keywords don't mix with real ones. Or point
`DB_PATH` to a new file.

Before you rely on the profit numbers, **check the rates in Settings → Profit** against bol's current
tariff sheet (commission per category, fixed fees, Logistiek via bol fees). The defaults are
conservative examples, not official tariffs.

---

## 6. Daily schedule, logs and errors

- While the app is open, it runs every day at `DAILY_RUN_TIME` (default **06:30**,
  `TIMEZONE=Europe/Amsterdam`). If the PC was off at that time, it runs once as soon as you start the
  app (`RUN_MISSED_ON_STARTUP=true`).
- **Alternative without keeping the app open**: Windows **Task Scheduler** → *Create Basic Task* →
  daily → *Start a program* → `run_once_windows.bat` in this folder.
- Every run is listed under **Settings & runs**. Click a run to see its log. The full log is in
  `logs/engine.log`.
- Errors are written in plain words, with what to do next. For example:
  - *"bol login rejected the client id/secret (HTTP 401) → Copy the credentials again…"*
  - *"API rate limit reached (HTTP 429) → The engine will continue with what it has; lower 'Max
    keywords per run'…"*. The engine waits and retries automatically, honouring bol's `Retry-After`.
  - *"AliExpress rejected the request: … (IncompleteSignature) → Check ALIEXPRESS_APP_KEY /
    ALIEXPRESS_APP_SECRET…"*
  - *"AI daily cost cap reached – continuing with rule-based fallback"*
- If the last run had a problem, a red banner appears on the Today page.

To stay inside bol's rate limits, each run checks at most *Max keywords per run* keywords (default 80,
least recently checked first) and tracks at most *Max EANs tracked daily* products.

---

## 7. Your Roland SG2-540 (print instead of import)

Products such as wall/window/car stickers, decals, labels, posters, banners, signs and window film get
a **🖨 Printable** badge. The engine checks that the design fits your **137 cm** media width and
estimates your cost: area × *print cost per m²* + labour (both in Settings → Printing). The card
compares this with the AliExpress landed cost. Use the *Printable on my Roland only* filter to see
just these.

---

## 8. Files

```
bol-opportunity-engine/
├── start_windows.bat        double-click to start (installs on first run)
├── run_once_windows.bat     one run, for Windows Task Scheduler
├── run.py                   starts dashboard + scheduler
├── run_pipeline.py          one run from the command line
├── .env.example             template for your keys -> copy to .env
├── app/
│   ├── config.py            reads .env
│   ├── settings.py          all editable rates/thresholds/weights (+ defaults)
│   ├── db.py                SQLite tables (data/engine.db)
│   ├── scheduler.py         daily run
│   ├── clients/             official API clients: bol.py, aliexpress.py, ai.py, http.py
│   ├── mock/                demo-mode simulator (same JSON as the real APIs)
│   ├── pipeline/            seeds, demand, matching, profit, risk, printable, scoring, learning, runner
│   └── web/                 FastAPI app + dashboard (plain HTML/JS, works offline)
└── tests/                   python -m pytest
```

Run the tests:

```bash
python -m pytest -q
```

---

## 9. Good to know / limitations

- **Official APIs only.** bol and AliExpress pages are never scraped. Product photos are only
  downloaded (for the photo comparison) from the image URLs the APIs themselves return. Stay within
  each platform's terms. For example, bol's affiliate API is meant for affiliate use, and AliExpress
  affiliate links should only be used as the affiliate program allows.
- bol's Insights data (search terms, ranks and impressions) is only available to active seller
  accounts, and bol decides which data it shares. If an endpoint returns "access denied", the run log
  says so.
- Matching across languages without a shared ID is never perfect. Always check the match (photo,
  size, material) before you order stock. Order a sample first.
- The risk filter is a safety net, not legal advice. It errs on the side of dropping too much. You are
  responsible for product safety (CE, GPSR), labelling and intellectual property.
- Demo mode simulates a market that changes from day to day: trends grow, peak and fade, and
  competitors arrive. Running it on several days in a row shows how the history pages fill up.
