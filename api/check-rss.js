/**
 * api/check-rss.js
 *
 * Wordt aangeroepen door GitHub Actions (zie .github/workflows/rss-check.yml)
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

export default async function handler(req, res) {
  // ── ALLES in één grote try/catch, inclusief imports ──────────────────────
  // Zo komt elke fout terug als nette JSON i.p.v. Vercel's generieke crash page.
  try {
    // ── Auth check ───────────────────────────────────────────────────────
    const authHeader = req.headers["authorization"];
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // ── Check verplichte env vars vóórdat we iets doen ──────────────────
    const requiredEnvVars = [
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "TWILIO_WHATSAPP_FROM",
      "TWILIO_WHATSAPP_TO",
      "JSONBIN_API_KEY",
      "JSONBIN_BIN_ID",
    ];
    const missing = requiredEnvVars.filter((key) => !process.env[key]);
    if (missing.length > 0) {
      return res.status(500).json({
        error: "Environment variables ontbreken in Vercel",
        missing,
      });
    }

    // ── Dynamic imports — fouten hier worden nu WEL opgevangen ──────────
    const { default: Parser } = await import("rss-parser");
    const { default: twilio } = await import("twilio");
    const { RSS_FEEDS } = await import("./rss-feeds.js");

    const parser = new Parser({
      timeout: 10000,
      headers: { "User-Agent": "Mozilla/5.0 RSS-Checker/1.0" },
    });

    const twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );

    async function sendWhatsApp(body) {
      return twilioClient.messages.create({
        from: process.env.TWILIO_WHATSAPP_FROM,
        to: process.env.TWILIO_WHATSAPP_TO,
        body,
      });
    }

    async function getState() {
      const r = await fetch(
        `https://api.jsonbin.io/v3/b/${process.env.JSONBIN_BIN_ID}/latest`,
        { headers: { "X-Master-Key": process.env.JSONBIN_API_KEY } }
      );
      if (!r.ok) throw new Error(`JSONBin GET mislukt: ${r.status}`);
      const data = await r.json();
      return data.record || {};
    }

    async function saveState(state) {
      const r = await fetch(
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
      if (!r.ok) throw new Error(`JSONBin PUT mislukt: ${r.status}`);
    }

    // ── State ophalen ─────────────────────────────────────────────────────
    const state = await getState();
    const newState = { ...state };
    const sent = [];
    const errors = [];
    const log = [];

    // ── Feeds checken ────────────────────────────────────────────────────
    for (const feed of RSS_FEEDS) {
      try {
        const parsed = await parser.parseURL(feed.url);

        if (!parsed.items || parsed.items.length === 0) {
          log.push(`${feed.name}: geen items gevonden`);
          continue;
        }

        const latestItems = parsed.items.slice(0, 3);
        const lastSeenId = state[feed.url];

        const newItems = [];
        for (const item of latestItems) {
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
          await sendWhatsApp(message);
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
  } catch (err) {
    // Vangt ALLES op: import errors, syntax issues, onverwachte exceptions
    console.error("Onverwachte fout in check-rss:", err);
    return res.status(500).json({
      error: "Onverwachte fout",
      message: err.message,
      stack: err.stack,
    });
  }
}
