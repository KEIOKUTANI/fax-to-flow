# FAX to Flow: 3-minute demo video script

Target length is 2:50–3:00. Record at 1440×900 in a browser at 100% zoom. Use live mode (with `NEBIUS_API_KEY`) for the real recording. If you record in demo mode, the banner and the `demo` tags must stay visible, and the narration must not claim live model output.

| # | Time | Shot | Narration (EN; JP subtitles optional) |
|---|---|---|---|
| 1 | 0:00–0:15 | Close-up of a real fax machine printing (or the `sample2_messy.png` image sliding out). Title card: "Japan, 2026. Still FAX." | "In Japan, thousands of small wholesalers still take orders by FAX. Every morning, someone re-types every sheet by hand." |
| 2 | 0:15–0:30 | The messy sample at full size. Zoom in on 「六ボル M10-30」, the crossed-out 4→6, and 「SUSが無ければ連絡ください」. | "Shorthand, crossed-out numbers, out-of-stock items. About five minutes per sheet, and that's before writing a polite reply." |
| 3 | 0:30–0:40 | App home screen. Point to the header badges: Agent = Nemotron 3 Super, Vision = Token Factory. | "FAX to Flow is an order-desk agent. NVIDIA Nemotron on Nebius Token Factory is the brain." |
| 4 | 0:40–1:15 | Click the **messy** sample, then **Read & process**. The right panel streams: Reading FAX → Transcribed 4 lines → `lookup_customer` → `search_products` ×4 (the ambiguous washer appears) → `check_stock` "only 0 in stock" → `propose_substitute`. | "A vision model only transcribes. Nemotron decides. It finds the customer from the fax header, matches each line to the product master, and notices the stainless bolt is out of stock, so it looks for a substitute in the same material. It also sees that 'washer M10' could be two different products, and it says so instead of guessing." |
| 5 | 1:15–1:45 | Scroll to the order table and show the chips: ✓ confirmed, ↻ substitute M10×45, ⚠ needs check (washer 4→6). Hover the confidence bars. Open the SKU dropdown on the washer line and pick スプリングワッシャー. The Approve button becomes enabled. | "Every line gets a status and a confidence score. Anything uncertain needs a human click before the order can be approved. The clerk stays in control." |
| 6 | 1:45–2:05 | Reply draft in Japanese next to the English gloss. Highlight 【代替品のご相談】 and 【ご確認のお願い】. | "Nemotron also writes the reply in proper business Japanese, asking about the substitute and the washer type. The English gloss is for you, the judges." |
| 7 | 2:05–2:20 | Click **Approve**. Order ID appears, the time-saved counter ticks up, then open **reply FAX** to show the printable ご注文確認書, then the ledger CSV opening in a spreadsheet. | "Approve, and the order goes straight into the ledger, and the reply FAX is ready to print and send." |
| 8 | 2:20–2:40 | Run the **いつもの分、今回は倍で** sample (fast-forward ×2). Show `get_usual_order` in the feed, then the table with doubled quantities and the anchor line split into 1 in stock + 1 substitute. | "It even understands 'the usual, doubled this time'. It pulls the customer's history, doubles it, and splits the line that's short on stock." |
| 9 | 2:40–2:55 | Architecture slide: FAX image → Qwen2-VL (transcribe) → **Nemotron agent loop** (6 tools, JSON-plan fallback) → server guardrails (prices from master, stock re-check) → human approval → ledger + reply FAX. | "Nemotron plans and decides with tool calls on Token Factory. The server checks prices and stock, and a human approves." |
| 10 | 2:55–3:00 | End card: "FAX to Flow · from 5 minutes to seconds per sheet" + repo URL + demo URL. | "FAX to Flow. Keep the FAX machine, lose the re-typing." |

## Recording checklist

- [ ] Start with an empty ledger (`data/orders.csv` contains only its header) so the counter starts at 0:00.
- [ ] Use live mode for the hero run. Note the real elapsed time on screen and in the narration if it differs from "seconds".
- [ ] Show the model badges at least once (Nemotron is the brain; Token Factory is the platform).
- [ ] Keep the English gloss visible during the reply step for non-Japanese judges.
- [ ] Deep links for quick retakes: `/?sample=sample2_messy&autorun=1`, `/?sample=sample3_usual&autorun=1`.

## Automatic recording (captions instead of narration)

`scripts/record-demo.mjs` plays this script in a headless browser with burned-in English captions and writes `demo-video/fax-to-flow-demo.mp4` (about 1:40). It needs Playwright and ffmpeg.

```bash
node --env-file=.env server.mjs &          # live mode; without a key it records demo mode and says so on screen
node scripts/record-demo.mjs --url http://localhost:3000
```
