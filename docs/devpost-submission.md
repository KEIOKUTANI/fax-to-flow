# Devpost submission draft: FAX to Flow (Nebius x NVIDIA Global AI Hackathon)

Track: **Best Apps & Agents**. Replace `<DEMO_URL>`, https://github.com/KEIOKUTANI/fax-to-flow, `<VIDEO_URL>`.

---

## Project name
FAX to Flow

## Tagline
An NVIDIA Nemotron agent that turns the hand-written FAX orders Japanese wholesalers still receive every morning into checked order data and a polite reply, in seconds.

## Links
- Demo: `<DEMO_URL>` (pick a sample FAX and press Run, or upload your own)
- Video (≤ 3 min): `<VIDEO_URL>`
- Code: https://github.com/KEIOKUTANI/fax-to-flow

## Inspiration
I help small businesses in Japan adopt AI. At many wholesalers, the day still starts at the FAX machine: hand-filled order sheets with shorthand like 「六ボル M10-30」, crossed-out quantities, and notes like 「いつもの分、今回は倍で」 ("the usual, doubled this time"). A clerk retypes each sheet, checks stock, calls about anything unclear and writes a polite reply FAX. That's about 5 minutes per sheet, every sheet, every day. Generic OCR doesn't help much: the hard part isn't reading the characters, it's knowing what the customer meant.

## What it does
Drop in a FAX image. The agent:
1. Reads the sheet into raw text exactly as written.
2. Identifies the customer from the fax header stamp.
3. Matches each line to the product master, handling trade shorthand and spec variants.
4. Checks stock, proposes same-spec substitutes, and splits lines when stock is short.
5. Expands "the usual" from the customer's history and applies 倍 (×2).
6. Flags ambiguous lines (flat or spring washer?) and crossed-out quantities as **needs check** instead of guessing.
7. Drafts the reply FAX in polite business Japanese (keigo), with an English gloss.

The clerk reviews, fixes anything flagged, and approves. The order goes to the ledger (CSV) and a printable reply FAX opens.

## How we used NVIDIA Nemotron and Nebius Token Factory
- **Nemotron is the agent brain** (`nvidia/nemotron-3-super-120b-a12b` on Token Factory). It runs an OpenAI-style tool-calling loop over six tools: `lookup_customer`, `search_products`, `check_stock`, `get_usual_order`, `propose_substitute` and `finalize_order`. It decides every SKU, every substitute, what counts as ambiguous and the due date, and writes the keigo reply.
- **Token Factory** serves every model call through its OpenAI-compatible endpoint. The app uses no SDK, only `fetch`.
- A vision model on Token Factory does transcription only and makes no decisions. The app picks it from the Token Factory catalogue at runtime and prefers an NVIDIA VL model. *(After the live check, name the exact model used here.)*
- Robustness: if tool calling is rejected, the agent switches to a JSON-plan protocol with the same tools, so Nemotron stays in charge.

## Design choices
- **Honest uncertainty:** each line carries a confidence score. Anything unclear has to be checked by a human before approval.
- **A human approves every order:** the agent drafts, the clerk decides.
- **Works in the real workflow:** the output is a ledger row plus a printable reply FAX, because the customer is still on FAX.

## Challenges
- Japanese trade shorthand and full-width/half-width variants (`M10-30` vs `M10×30`), which we handled with a domain-specific matcher the agent calls as a tool.
- Getting the model to stop and ask instead of guessing, which we enforced with confidence scores and approval gating in the UI.

## Accomplishments that we're proud of
- The agent says "I'm not sure" instead of guessing: ambiguous items and crossed-out numbers become checks for a person, which is what makes it safe to use on real orders.
- "The usual, doubled this time" works end to end: history lookup, doubling, a stock shortfall, and a substitute for the missing part, all in one sheet.
- It fits the existing workflow. The customer keeps their FAX machine and gets a polite reply FAX back.

## What we learned
- The hard part of FAX orders isn't reading characters, it's knowing what the customer meant. Splitting the work (vision transcribes, Nemotron decides with tools) made both parts easier to test.
- Tool calling plus server-side checks (prices from the master, stock re-checked) gave far more reliable results than asking one model to do everything.

## What's next
A pilot with a wholesaler through a local chamber of commerce. Plugging into common Japanese ordering systems via CSV, and receiving faxes automatically from e-fax inboxes.

## Built with
nvidia-nemotron, nebius-token-factory, node.js, javascript, html, css, render

## Feedback for Token Factory (required field)
*(Fill in after the live run: what worked, latency, tool-calling support for Nemotron, and whether a Nemotron vision model was available.)*
