/**
 * api/check-rss.js
 *
 * Vercel Cron Function — draait elk uur.
 * Checkt alle feeds in config/rss-feeds.js op nieuwe items.
 * Stuurt bij een nieuw item een WhatsApp bericht via Twilio Sandbox.
 *
 * Vereiste environment variables (in Vercel dashboard):
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_WHATSAPP_FROM   (sandbox: whatsapp:+14155238886)
 *   TWILIO_WHATSAPP_TO     (jouw nummer: whatsapp:+31612345678)
 *   JSONBIN_API_KEY
 *   JSONBIN_BIN_ID
 *   CRON_SECRET            (willekeurige string, zelf kiezen)
 */

import Parser from "rss-parser";
import twilio from "twilio";
import { RSS_FEEDS } from "../config/rss-feeds.js";

const parser = new Parser({
  timeout: 10000,
  headers: { "User-Agent": "Mozilla/5.0 RSS-Checker/1.0" },
});

// ── JSONBin helpers ──────────────────────────────────────────────────────────

async function getState() {
  const res = await fetch(
    `https://api.jsonbin.io/v3/b/${process.env.JSONBIN_BIN_ID}/latest`,
    { headers: { "X-Master-Key": process.env.JSONBIN_API_KEY } }
  );
  if (!res.ok) throw new Error(`JSONBin GET mislukt: ${res.status}`);
  const data = await res.json();
  return data.record || {};
}

async function saveState(state) {
  const res = await fetch(
    `https://api.jsonbin.io/v3/b/${process.env.JSONBIN_BIN_ID}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Master-Key": process.env.JSONBIN_API_KEY,
      },
      body: JSON.stringify(state),
    }
  );
  if (!res.ok) throw new Error(`JSONBin PUT mislukt: ${res.status}`);
}

// ── Twilio WhatsApp helper ───────────────────────────────────────────────────

async function sendWhatsApp(body) {
  const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
  return client.messages.create({
    from: process.env.TWILIO_WHATSAPP_FROM,
    to: process.env.TWILIO_WHATSAPP_TO,
    body,
  });
}

function buildMessage(feed, item) {
  const pubDate = item.pubDate
    ? new Date(item.pubDate).toLocaleDateString("nl-NL", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : null;

  const snippet = item.contentSnippet
    ? item.contentSnippet.replace(/\s+/g, " ").trim().slice(0, 250) + "…"
    : null;

  return [
    `${feed.emoji} *${feed.name}*`,
    ``,
    `📰 ${item.title}`,
    pubDate ? `📅 ${pubDate}` : null,
    snippet ? `\n${snippet}` : null,
    ``,
    `🔗 ${item.link}`,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

// ── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // Vercel stuurt automatisch CRON_SECRET als Bearer token bij cron-aanroepen.
  // Bij handmatig testen: stuur Authorization: Bearer <CRON_SECRET> mee.
  const authHeader = req.headers["authorization"];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const log = [];
  let state;

  try {
    state = await getState();
  } catch (err) {
    return res.status(500).json({ error: "JSONBin laden mislukt", detail: err.message });
  }

  const newState = { ...state };
  const sent = [];
  const errors = [];

  for (const feed of RSS_FEEDS) {
    try {
      const parsed = await parser.parseURL(feed.url);

      if (!parsed.items || parsed.items.length === 0) {
        log.push(`${feed.name}: geen items gevonden`);
        continue;
      }

      // Neem de nieuwste N items (max 3) zodat we ook meerdere updates
      // in één check-ronde verwerken als ze er tegelijkertijd zijn.
      const latestItems = parsed.items.slice(0, 3);
      const lastSeenId = state[feed.url];

      // Bepaal welke items nieuw zijn (nog niet gezien)
      const newItems = [];
      for (const item of latestItems) {
        const itemId = item.guid || item.id || item.link || item.title;
        if (itemId === lastSeenId) break; // rest hebben we al gehad
        newItems.push({ item, itemId });
      }

      if (newItems.length === 0) {
        log.push(`${feed.name}: geen nieuw item`);
        continue;
      }

      // Stuur berichten voor elk nieuw item (oudste eerst)
      for (const { item, itemId } of newItems.reverse()) {
        const message = buildMessage(feed, item);
        await sendWhatsApp(message);
        sent.push({ feed: feed.name, title: item.title });
        log.push(`${feed.name}: bericht gestuurd — "${item.title}"`);
      }

      // Sla het meest recente item op
      newState[feed.url] = newItems[0].itemId;

    } catch (err) {
      const msg = `${feed.name}: FOUT — ${err.message}`;
      errors.push(msg);
      log.push(msg);
    }
  }

  try {
    await saveState(newState);
  } catch (err) {
    errors.push(`State opslaan mislukt: ${err.message}`);
  }

  return res.status(200).json({
    checked: RSS_FEEDS.length,
    sentCount: sent.length,
    sent,
    errors,
    log,
  });
}
