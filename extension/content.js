if (!globalThis.__liOutreachLoaded) {
  globalThis.__liOutreachLoaded = true;

  function expandPosts() {
    document.querySelectorAll('[data-testid="expandable-text-button"]').forEach((b) => {
      try {
        b.click();
      } catch (e) {}
    });
  }

  // Post media only: avatars, logos and reaction icons are all small.
  function postImages(card) {
    const out = [];
    for (const img of card.querySelectorAll("img")) {
      const src = img.currentSrc || img.src || "";
      if (!/^https?:/i.test(src)) continue;
      const w = img.naturalWidth || img.clientWidth || 0;
      const h = img.naturalHeight || img.clientHeight || 0;
      if (w < 200 || h < 200) continue;
      if (!out.includes(src)) out.push(src);
    }
    return out.slice(0, 2);
  }

  function collectCards() {
    expandPosts();
    const cards = [];
    const seen = new Set();
    for (const card of document.querySelectorAll('[role="listitem"]')) {
      const key = card.getAttribute("componentkey") || "";
      if (key && !/update-card|FeedType/i.test(key)) continue;
      const text = (card.innerText || "").trim();
      if (text.length < 40) continue;
      const profileA = card.querySelector('a[href*="/in/"]');
      const profile = profileA ? profileA.href.split("?")[0] : "";
      const mailto = card.querySelector('a[href^="mailto:"]');
      const email = mailto ? mailto.href.replace(/^mailto:/i, "").split("?")[0] : "";
      const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
      const poster_name = lines.find((s) => s && s !== "Feed post" && s !== "Follow") || "Unknown";
      const uid = (key || profile || "") + "|" + text.slice(0, 80);
      if (seen.has(uid)) continue;
      seen.add(uid);
      cards.push({
        post_url: profile || uid,
        poster_name: poster_name.replace(/\s+/g, " ").slice(0, 80),
        poster_profile: profile,
        email,
        text: text.slice(0, 2000),
        images: postImages(card),
      });
    }
    return cards;
  }

  function scrollFeed() {
    const main = document.querySelector("main");
    if (main && main.scrollHeight > main.clientHeight + 20) {
      main.scrollBy(0, 1800);
    } else {
      window.scrollBy(0, 1800);
    }
  }

  async function scrape(maxScrolls) {
    const seen = new Map();
    for (let i = 0; i < (maxScrolls || 4); i++) {
      scrollFeed();
      await new Promise((r) => setTimeout(r, 2200));
      for (const p of collectCards()) {
        const id = p.post_url + p.text.slice(0, 60);
        if (!seen.has(id)) seen.set(id, p);
      }
    }
    return [...seen.values()];
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "SCRAPE") {
      scrape(msg.maxScrolls).then(sendResponse);
      return true;
    }
  });
}
