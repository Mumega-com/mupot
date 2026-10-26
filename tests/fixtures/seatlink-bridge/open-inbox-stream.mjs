// Read-only SSE client fixture, verbatim function from Mumega-com/mupot@593c610c
// plugins/seatlink/bridge/seatlink.mjs. Only dependencies are supplied by the test.
export function seatlinkSseFixture(deps) {
  const { readTokenPath, log, seatMupotConfig, readJson, writeJson, CURSOR_FILE, fetch, isPaperclipSeat, paperclipHandler, injectPotMail, routeMail, setTimeout } = deps;
async function openInboxStream(entry, api) {
  const token = readTokenPath(entry.mupot_token_file);
  if (!token) {
    log(`${entry.herdr}: no token, skip SSE`);
    return;
  }
  seatMupotConfig.set(entry.herdr, { token, api });
  const cursors = readJson(CURSOR_FILE, {});
  let since = Number(cursors[entry.herdr] || 0);
  let backoff = 1000;
  const run = async () => {
    for (;;) {
      try {
        // poll_ms=5000 (server default 1000): each open stream re-reads D1 on this cadence. D1 load stopgap until real push (2026-10-25).
        const url = `${api.replace(/\/$/, "")}/api/inbox/stream?poll_ms=5000${since ? `&since=${since}` : ""}`;
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        backoff = 1000;
        log(`SSE open ${entry.herdr} since=${since}`);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let sep;
          while ((sep = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
            if (!dataLine) continue;
            let ev;
            try { ev = JSON.parse(dataLine.slice(6)); } catch { continue; }
            if (ev.type === "initial") {
              since = ev.since ?? since;
              if (isPaperclipSeat(entry)) await paperclipHandler.handleInitial(entry, ev.messages || []);
              else for (const m of ev.messages || []) await injectPotMail(entry.herdr, m);
            } else if (ev.type === "message" && ev.message) {
              since = ev.message.seq ?? since;
              await routeMail(entry, ev.message);
            }
            cursors[entry.herdr] = since;
            writeJson(CURSOR_FILE, cursors);
          }
        }
      } catch (e) {
        log(`SSE ${entry.herdr}:`, e.message, `retry ${backoff}ms`);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30000);
      }
    }
  };
  run().catch((e) => log(`SSE fatal ${entry.herdr}:`, e.message));
}

  return openInboxStream;
}

