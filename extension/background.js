const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.compose";
const BUILD = "2026-09-23e";
const MODEL = "gpt-4o-mini";
// Vision is the fallback when a post's text has no email, so cap the spend.
const MAX_VISION_CALLS = 12;
const VISION_MAX_PX = 1024;

// Clicking the toolbar icon opens the side panel, which (unlike a popup)
// survives clicking into the LinkedIn tab this extension drives.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.error("sidePanel:", e));

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Answers even from an old worker, so a stale build is obvious.
  if (msg.type === "PING") {
    sendResponse({ ok: true, build: BUILD });
    return false;
  }
  if (msg.type === "RUN") {
    run(msg.payload)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (msg.type === "SUGGEST_ROLES") {
    suggestRoles(msg.payload)
      .then((roles) => sendResponse({ ok: true, roles }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (msg.type === "SUMMARIZE_RESUME") {
    summarizeResume(msg.payload)
      .then((summary) => sendResponse({ ok: true, summary }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
  if (msg.type === "CONNECT_GMAIL") {
    connectGmail(msg.clientId)
      .then((ok) => sendResponse({ ok }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
});

async function run(payload) {
  const {
    openaiKey,
    mode,
    expertise,
    projectLinks,
    resume,
    targetRole,
    yearsExp,
    workplace,
    selectedRoles,
    maxScrolls,
  } = payload;
  if (!openaiKey) throw new Error("Add your OpenAI API key in Settings.");

  postProgress("Loading profile context…");
  const projectContext = await loadProjectContext(projectLinks);
  const profile =
    mode === "freelance"
      ? { mode, expertise: expertise || "", projects: projectContext, workplace }
      : {
          mode,
          resume: (resume || "").slice(0, 12000),
          targetRole: targetRole || "",
          yearsExp: yearsExp || "",
          workplace,
        };

  // Freelance expertise is prose, not a title, so it is never a fallback query.
  const titles = pickTitles(selectedRoles, mode === "freelance" ? "" : targetRole);
  if (!titles.length) {
    throw new Error(
      mode === "freelance"
        ? "Describe your expertise, then Suggest similar roles and tick at least one."
        : "Type a target role, then Suggest similar roles and tick at least one."
    );
  }
  const searchQueries = buildQueries(titles, profile);

  const tab = await ensureLinkedInTab();
  const posts = [];
  const seen = new Set();
  await chrome.storage.local.set({
    partialRun: { startedAt: Date.now(), queries: searchQueries, done: [], posts: [] },
  });
  for (const q of searchQueries) {
    postProgress(`Searching LinkedIn: ${q}`);
    await navigate(tab.id, linkedinSearchUrl(q));
    await inject(tab.id);
    const batch = await chrome.tabs.sendMessage(tab.id, {
      type: "SCRAPE",
      maxScrolls: maxScrolls || 4,
    });
    for (const p of batch || []) {
      const id = p.post_url + (p.text || "").slice(0, 60);
      if (seen.has(id)) continue;
      seen.add(id);
      posts.push(p);
    }
    // The MV3 worker can be killed mid-run; keep scraped posts recoverable.
    await savePartial(searchQueries, q, posts);
  }

  if (!posts.length) {
    return { ok: true, rows: [], note: "No posts scraped. Open LinkedIn, log in, then run again." };
  }

  await fillContactsFromImages(openaiKey, posts);

  postProgress(`Scoring ${posts.length} posts with OpenAI…`);
  const judged = await openaiJson(openaiKey, matchPrompt(profile, posts.slice(0, 28)));
  const matches = (judged.matches || []).filter((m) => m.include);
  const rows = matches.map((m) => {
    const post = posts[m.index] || {};
    return {
      post_url: post.post_url || "",
      poster_name: post.poster_name || "",
      poster_profile: post.poster_profile || "",
      email: (m.to_email || post.email || "").trim(),
      email_source: post.email_source || (post.email ? "text" : ""),
      apply_url: post.apply_url || "",
      snippet: (post.text || "").slice(0, 300).replace(/\n/g, " "),
      why: m.why || "",
      subject: m.subject || "",
      body: m.body || "",
      action: "",
    };
  });

  const token = await getStoredGmailToken();
  for (const row of rows) {
    if (!row.email || !row.body) {
      row.action = row.email ? "email_found_no_draft" : "manual_dm_needed";
      continue;
    }
    if (!token) {
      row.action = "email_found_connect_gmail";
      continue;
    }
    try {
      await createGmailDraft(token, row.email, row.subject, row.body);
      row.action = "gmail_draft_created";
    } catch (e) {
      row.action = "email_found_draft_failed";
      row.why = (row.why || "") + ` (Gmail: ${e})`;
    }
  }

  await chrome.storage.local.set({ partialRun: null });
  return { ok: true, rows, queries: searchQueries };
}

async function savePartial(queries, lastQuery, posts) {
  const { partialRun } = await chrome.storage.local.get("partialRun");
  const done = [...((partialRun && partialRun.done) || []), lastQuery];
  await chrome.storage.local.set({
    partialRun: { startedAt: partialRun?.startedAt || Date.now(), queries, done, posts },
  });
}

function postProgress(text) {
  chrome.runtime.sendMessage({ type: "PROGRESS", text }).catch(() => {});
}

function linkedinSearchUrl(q) {
  return "https://www.linkedin.com/search/results/content/?keywords=" + encodeURIComponent(q);
}

async function ensureLinkedInTab() {
  const tabs = await chrome.tabs.query({ url: "https://www.linkedin.com/*" });
  if (tabs[0]) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    return tabs[0];
  }
  return chrome.tabs.create({ url: "https://www.linkedin.com/feed/" });
}

function navigate(tabId, url) {
  return new Promise((resolve) => {
    chrome.tabs.update(tabId, { url }, () => {
      const done = (id, info) => {
        if (id === tabId && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(done);
          setTimeout(resolve, 2500);
        }
      };
      chrome.tabs.onUpdated.addListener(done);
    });
  });
}

async function inject(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
}

async function loadProjectContext(linksText) {
  const urls = (linksText || "")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s))
    .slice(0, 5);
  const out = [];
  for (const url of urls) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const html = await r.text();
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .slice(0, 3500);
      out.push({ url, text });
    } catch {
      out.push({ url, text: "" });
    }
  }
  return out;
}

// Titles the user ticked; falls back to whatever they typed so Run still works
// if they never pressed Suggest.
function pickTitles(selectedRoles, typed) {
  const out = [];
  const seen = new Set();
  for (const t of [...(selectedRoles || []), typed || ""]) {
    const title = String(t || "").trim();
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    out.push(title);
  }
  return out;
}

const WORKPLACE_WORD = { remote: "remote", hybrid: "hybrid", onsite: "on-site" };

// LinkedIn content search has no workplace or seniority facet, so these words are
// only a nudge — matchPrompt does the real filtering.
function buildQueries(titles, profile) {
  const place = WORKPLACE_WORD[profile.workplace] || "";
  const years = profile.mode === "jobs" && profile.yearsExp ? `${profile.yearsExp} years` : "";
  return titles.slice(0, 6).map((title) =>
    [`hiring "${title}"`, place, years].filter(Boolean).join(" ")
  );
}

async function suggestRoles({ mode, seed, yearsExp, workplace, openaiKey }) {
  if (!openaiKey) throw new Error("Add your OpenAI API key in Settings.");
  if (!seed) throw new Error("Nothing to expand yet.");
  const context = [
    mode === "jobs" ? `Target role: ${seed}` : `Freelance expertise: ${seed}`,
    yearsExp ? `Experience: ${yearsExp} years` : "",
    workplace && workplace !== "all" ? `Prefers ${workplace} work` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const system =
    mode === "jobs"
      ? "You list adjacent job titles a candidate should also search for. Return JSON only."
      : "You list the job titles clients post when hiring a freelancer with this expertise. Return JSON only.";
  const data = await openaiJson(openaiKey, {
    system,
    user: `${context}

Give 6 titles that are realistically the same level and skill set, not more senior.
Exclude the seed title itself. Each "why" is at most 8 words.
Return {"roles":[{"title":"...","why":"..."}]}`,
  });
  return (data.roles || [])
    .filter((r) => r && r.title)
    .slice(0, 6)
    .map((r) => ({ title: String(r.title).trim(), why: String(r.why || "").trim() }));
}

function matchPrompt(profile, posts) {
  const slim = posts.map((p, index) => ({
    index,
    poster_name: p.poster_name,
    email: p.email,
    text: p.text.slice(0, 1200),
  }));
  const who =
    profile.mode === "freelance"
      ? `FREELANCER. Expertise: ${profile.expertise}\nProjects: ${JSON.stringify(profile.projects).slice(0, 5000)}`
      : `JOB SEEKER. Target role: ${profile.targetRole || "(not given)"}\nExperience: ${
          profile.yearsExp || "(not given)"
        } years\nResume:\n${(profile.resume || "(none given)").slice(0, 8000)}`;

  // The search keywords are only a hint, so the filtering happens here.
  const rules = [];
  if (profile.workplace && profile.workplace !== "all") {
    rules.push(
      `Exclude posts that clearly contradict ${profile.workplace} work. If the post never says, keep it.`
    );
  }
  if (profile.mode === "jobs" && profile.yearsExp) {
    rules.push(
      `Exclude posts asking for seniority far outside ${profile.yearsExp} years. If the post never says, keep it.`
    );
  }
  rules.push("Skip weak matches. It is fine to return an empty list.");

  return {
    system:
      "You pick LinkedIn posts that are a real fit and draft emails. Never send. Return JSON only.",
    user: `${who}\n\nPosts:\n${JSON.stringify(slim)}\n
Rules:
${rules.map((r) => "- " + r).join("\n")}
Email must sound like a human who read the post and (if freelance) cite relevant project/expertise; (if job) cite resume proof, or the target role when no resume was given.
If no email is in the post, to_email can be "".
Return {"matches":[{"index":0,"include":true,"why":"","to_email":"","subject":"","body":""}]}`,
  };
}


// Posts that carry the email in a graphic instead of the text body.
async function fillContactsFromImages(openaiKey, posts) {
  const targets = posts.filter((p) => !p.email && p.images && p.images.length);
  if (!targets.length) return 0;
  const batch = targets.slice(0, MAX_VISION_CALLS);
  postProgress(`Reading ${batch.length} post images for contact details…`);
  let found = 0;
  for (const post of batch) {
    try {
      const dataUrl = await toJpegDataUrl(post.images[0]);
      if (!dataUrl) continue;
      const out = await openaiVision(openaiKey, dataUrl);
      if (out.email) {
        post.email = out.email;
        post.email_source = "image";
        found++;
      }
      if (out.apply_url) post.apply_url = out.apply_url;
    } catch (e) {
      // One unreadable image must not end the run.
      console.warn("vision:", post.post_url, String(e));
    }
  }
  if (found) postProgress(`Found ${found} contact(s) inside post images.`);
  return found;
}

// Downscale before sending: full-size LinkedIn media costs tokens for no gain.
async function toJpegDataUrl(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) return "";
  const bmp = await createImageBitmap(await r.blob());
  const scale = Math.min(1, VISION_MAX_PX / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const jpeg = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  const bytes = new Uint8Array(await jpeg.arrayBuffer());
  // FileReader does not exist in a service worker, so base64 by hand.
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return "data:image/jpeg;base64," + btoa(bin);
}

async function openaiVision(apiKey, dataUrl) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "You read contact details off hiring graphics. Return JSON only.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: 'Read the contact details printed in this image. Copy them exactly as shown. Never guess, complete or invent an address. Return {"email":"","phone":"","apply_url":""} with "" for anything not clearly legible.',
            },
            { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
          ],
        },
      ],
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || "OpenAI vision request failed");
  const out = JSON.parse(data.choices?.[0]?.message?.content || "{}");
  const email = String(out.email || "").trim();
  // Only accept something that is actually an address.
  return {
    email: /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email) ? email : "",
    phone: String(out.phone || "").trim(),
    apply_url: String(out.apply_url || "").trim(),
  };
}


const RESUME_BRIEF =
  "Summarise this resume in under 180 words for someone writing job application emails. " +
  "Keep concrete proof: job titles, employers, years, technologies, and any numbers or " +
  "measurable results. Drop addresses, hobbies and filler. Copy facts exactly; invent nothing.";

async function summarizeResume({ name, kind, text, base64, openaiKey }) {
  if (!openaiKey) throw new Error("Add your OpenAI API key in Settings.");
  if (kind === "pdf") return summarizePdf(openaiKey, name, base64);

  const raw = kind === "docx" ? await docxToText(base64) : String(text || "");
  const clean = raw.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (clean.length < 40) throw new Error("No readable text found in that file.");

  const data = await openaiJson(openaiKey, {
    system: "You condense resumes. Return JSON only.",
    user: `${RESUME_BRIEF}\n\nResume:\n${clean.slice(0, 30000)}\n\nReturn {"summary":"..."}`,
  });
  const summary = String(data.summary || "").trim();
  if (!summary) throw new Error("OpenAI returned an empty summary.");
  return summary;
}

// PDFs go to OpenAI as a file, so no PDF parser has to ship in the extension.
async function summarizePdf(apiKey, name, base64) {
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_file",
              filename: name || "resume.pdf",
              file_data: "data:application/pdf;base64," + base64,
            },
            { type: "input_text", text: RESUME_BRIEF },
          ],
        },
      ],
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || "OpenAI could not read that PDF.");
  const summary = responsesText(data);
  if (!summary) throw new Error("OpenAI returned an empty summary for that PDF.");
  return summary;
}

function responsesText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) return data.output_text.trim();
  const parts = [];
  for (const item of data.output || []) {
    for (const c of item.content || []) {
      if (typeof c.text === "string") parts.push(c.text);
    }
  }
  return parts.join("\n").trim();
}

// A .docx is a zip; word/document.xml holds the text.
async function docxToText(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const xml = await unzipEntry(bytes, "word/document.xml");
  return xml
    .replace(/<w:p[ >][\s\S]*?(?=<w:p[ >]|$)/g, (m) => m + "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<w:tab[^>]*\/>/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

async function unzipEntry(bytes, wanted) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.byteLength - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("That file is not a valid .docx.");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (name === wanted) {
      const lNameLen = dv.getUint16(localOff + 26, true);
      const lExtraLen = dv.getUint16(localOff + 28, true);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const data = bytes.subarray(start, start + compSize);
      if (method === 0) return dec.decode(data);
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return await new Response(stream).text();
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error("No document text found inside that .docx.");
}

async function openaiJson(apiKey, { system, user }) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || "OpenAI request failed");
  const text = data.choices?.[0]?.message?.content || "{}";
  return JSON.parse(text);
}

async function connectGmail(clientId) {
  if (!clientId) throw new Error("Paste your Google OAuth Client ID in Settings.");
  const redirectUri = chrome.identity.getRedirectURL();
  const url =
    "https://accounts.google.com/o/oauth2/v2/auth" +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    "&response_type=token" +
    `&scope=${encodeURIComponent(GMAIL_SCOPE)}` +
    "&prompt=consent";
  const redirect = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
  const chunk = (redirect.split("#")[1] || redirect.split("?")[1] || "");
  const token = new URLSearchParams(chunk).get("access_token");
  if (!token) {
    throw new Error(
      "Gmail login did not return a token. In Google Cloud, add this Authorized redirect URI to a Chrome extension (or Web) OAuth client: " +
        redirectUri
    );
  }
  await chrome.storage.local.set({ gmailToken: token, googleClientId: clientId });
  return true;
}

async function getStoredGmailToken() {
  const { gmailToken } = await chrome.storage.local.get("gmailToken");
  return gmailToken || "";
}

async function createGmailDraft(token, to, subject, body) {
  const raw = btoa(unescape(encodeURIComponent(`To: ${to}\r\nSubject: ${subject}\r\n\r\n${body}`)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message: { raw } }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(t.slice(0, 180));
  }
}
