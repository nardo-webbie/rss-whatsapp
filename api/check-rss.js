/**
 * api/check-rss.js
 *
 * Wordt aangeroepen door GitHub Actions (zie .github/workflows/rss-check.yml)
 * Checkt alle feeds in api/rss-feeds.js op nieuwe items.
 * Stuurt bij een nieuw item een Telegram bericht via de Bot API.
 *
 * Vereiste environment variables (in Vercel dashboard):
 *   TELEGRAM_BOT_TOKEN   (van @BotFather)
 *   TELEGRAM_CHAT_ID     (jouw chat ID, via @userinfobot)
 *   JSONBIN_API_KEY
 *   JSONBIN_BIN_ID
 *   CRON_SECRET
 */

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

async function sendTelegram(token, chatId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: false,
    }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram fout: ${data.description}`);
  return data;
}

async function getState(binId, apiKey) {
  const r = await fetch(`https://api.jsonbin.io/v3/b/${binId}/latest`, {
    headers: { "X-Master-Key": apiKey },
  });
  if (!r.ok) throw new Error(`JSONBin GET mislukt: ${r.status}`);
  const data = await r.json();
  return data.record || {};
}

async function saveState(binId, apiKey, state) {
  const r = await fetch(`https://api.jsonbin.io/v3/b/${binId}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Master-Key": apiKey,
    },
    body: JSON.stringify(state),
  });
  if (!r.ok) throw new Error(`JSONBin PUT mislukt: ${r.status}`);
}

export default async function handler(req, res) {
  try {
    // ── Auth ─────────────────────────────────────────────────────────────
    if (req.headers["authorization"] !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // ── Env vars check ───────────────────────────────────────────────────
    const required = [
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_CHAT_ID",
      "JSONBIN_API_KEY",
      "JSONBIN_BIN_ID",
    ];
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length > 0) {
      return res.status(500).json({
        error: "Environment variables ontbreken in Vercel",
        missing,
      });
    }

    const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, JSONBIN_API_KEY, JSONBIN_BIN_ID } = process.env;

    // ── Imports ──────────────────────────────────────────────────────────
    const { default: Parser } = await import("rss-parser");
    const { RSS_FEEDS } = await import("./rss-feeds.js");

    const parser = new Parser({
      timeout: 10000,
      headers: { "User-Agent": "Mozilla/5.0 RSS-Checker/1.0" },
    });

    // ── State ophalen ────────────────────────────────────────────────────
    const state = await getState(JSONBIN_BIN_ID, JSONBIN_API_KEY);
    const newState = { ...state };
    const sent = [];
    const errors = [];
    const log = [];

    // ── Feeds checken ────────────────────────────────────────────────────
    for (const feed of RSS_FEEDS) {
      try {
        const parsed = await parser.parseURL(feed.url);

        if (!parsed.items?.length) {
          log.push(`${feed.name}: geen items gevonden`);
          continue;
        }

        const lastSeenId = state[feed.url];
        const newItems = [];

        for (const item of parsed.items.slice(0, 3)) {
          const itemId = item.guid || item.id || item.link || item.title;
          if (itemId === lastSeenId) break;
          newItems.push({ item, itemId });
        }

        if (newItems.length === 0) {
          log.push(`${feed.name}: geen nieuw item`);
          continue;
        }

        for (const { item, itemId } of newItems.reverse()) {
          const message = buildMessage(feed, item);
          await sendTelegram(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, message);
          sent.push({ feed: feed.name, title: item.title });
          log.push(`${feed.name}: bericht gestuurd — "${item.title}"`);
        }

        newState[feed.url] = newItems[0].itemId;
      } catch (err) {
        const msg = `${feed.name}: FOUT — ${err.message}`;
        errors.push(msg);
        log.push(msg);
      }
    }

    // ── State opslaan ────────────────────────────────────────────────────
    try {
      await saveState(JSONBIN_BIN_ID, JSONBIN_API_KEY, newState);
    } catch (err) {
      errors.push(`State opslaan mislukt: ${err.message}`);
    }

    return res.status(200).json({ checked: RSS_FEEDS.length, sentCount: sent.length, sent, errors, log });

  } catch (err) {
    console.error("Onverwachte fout:", err);
    return res.status(500).json({ error: "Onverwachte fout", message: err.message, stack: err.stack });
  }
}
