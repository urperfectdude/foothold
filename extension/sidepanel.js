const $ = (id) => document.getElementById(id);
let lastRows = [];

// Everything the user types, keyed the same way in chrome.storage.local.
const FIELDS = ["targetRole", "yearsExp", "expertise", "projectLinks"];
// Saved on every keystroke: these are short, usually pasted, and losing them
// mid-session is worse than the extra writes.
const CREDENTIALS = ["openaiKey", "googleClientId"];
const RADIOS = ["workplaceJobs", "workplaceFreelance"];
// Suggested titles per mode: [{ title, why, checked }]
const roleState = { jobs: [], freelance: [] };
// The uploaded resume is kept as an AI summary, not raw text.
let resumeSummary = "";
const MAX_RESUME_BYTES = 8 * 1024 * 1024;

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("on", b === btn));
    $("panel-jobs").classList.toggle("hidden", btn.dataset.tab !== "jobs");
    $("panel-freelance").classList.toggle("hidden", btn.dataset.tab !== "freelance");
  });
});

chrome.storage.local.get(null, (s) => {
  for (const f of [...CREDENTIALS, ...FIELDS]) if (s[f]) $(f).value = s[f];
  for (const name of RADIOS) setRadio(name, s[name] || "all");
  resumeSummary = s.resumeSummary || "";
  if (resumeSummary) showSummary(s.resumeFileName || "Resume", resumeSummary);
  roleState.jobs = s.rolesJobs || [];
  roleState.freelance = s.rolesFreelance || [];
  if (roleState.jobs.length) renderRoles("jobs");
  if (roleState.freelance.length) renderRoles("freelance");
  $("gmailStatus").textContent = s.gmailToken
    ? "Gmail: connected (drafts only)."
    : "Gmail: not connected. CSV still downloads if drafts fail.";
  // Keep Settings open until there is a key to remember.
  $("settings").open = !s.openaiKey;
  checkBuild();
  // A run that died mid-way leaves its scraped posts behind.
  const p = s.partialRun;
  if (p && p.posts?.length && p.done?.length < p.queries?.length) {
    log(
      `Last run stopped after ${p.done.length}/${p.queries.length} searches ` +
        `with ${p.posts.length} posts scraped. Run again to start over.`
    );
  }
});

for (const f of FIELDS) {
  $(f).addEventListener("change", () => chrome.storage.local.set({ [f]: $(f).value }));
}
for (const f of CREDENTIALS) {
  $(f).addEventListener("input", () => chrome.storage.local.set({ [f]: $(f).value.trim() }));
}
for (const name of RADIOS) {
  document.querySelectorAll(`input[name="${name}"]`).forEach((r) => {
    r.addEventListener("change", () => chrome.storage.local.set({ [name]: r.value }));
  });
}

// Show the exact redirect URI Chrome will use, so Google Cloud can match it verbatim.
const REDIRECT_URI = chrome.identity.getRedirectURL();
$("redirectUri").value = REDIRECT_URI;
$("copyRedirect").addEventListener("click", async () => {
  await navigator.clipboard.writeText(REDIRECT_URI);
  log("Redirect URI copied. Paste it into your Web application OAuth client.");
});

$("saveSettings").addEventListener("click", async () => {
  await chrome.storage.local.set({
    openaiKey: $("openaiKey").value.trim(),
    googleClientId: $("googleClientId").value.trim(),
  });
  log("Settings saved.");
});

$("connectGmail").addEventListener("click", async () => {
  const clientId = $("googleClientId").value.trim();
  await chrome.storage.local.set({ googleClientId: clientId });
  log("Opening Google sign-in…");
  const res = await send({ type: "CONNECT_GMAIL", clientId });
  if (res?.ok) {
    $("gmailStatus").textContent = "Gmail: connected (drafts only).";
    log("Gmail connected.");
  } else {
    log("Gmail failed: " + (res?.error || "unknown") + "\nAdd this extension's redirect URI in Google Cloud.");
  }
});

$("resumeFile").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (file.size > MAX_RESUME_BYTES) {
    log("That file is over 8MB. Export a smaller PDF and try again.");
    return;
  }
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (ext === "doc") {
    log("Legacy .doc is not readable here. Save it as PDF or DOCX and upload again.");
    return;
  }
  const kind = ext === "pdf" ? "pdf" : ext === "docx" ? "docx" : "text";
  log(`Reading ${file.name}…`);
  const payload = { name: file.name, kind, openaiKey: $("openaiKey").value.trim() };
  if (kind === "text") payload.text = await file.text();
  else payload.base64 = await fileToBase64(file);

  const res = await send({ type: "SUMMARIZE_RESUME", payload });
  if (!res.ok) {
    log("Could not read that resume: " + (res.error || "unknown"));
    return;
  }
  resumeSummary = res.summary || "";
  await chrome.storage.local.set({ resumeSummary, resumeFileName: file.name });
  showSummary(file.name, resumeSummary);
  log("Resume summarised. It stays until you upload another one.");
});

$("clearResume").addEventListener("click", async () => {
  resumeSummary = "";
  await chrome.storage.local.set({ resumeSummary: "", resumeFileName: "" });
  $("resumeSummaryBox").classList.add("hidden");
  $("resumeFile").value = "";
  log("Resume summary cleared. Paste text instead, or upload another file.");
});

function showSummary(name, text) {
  $("resumeFileName").textContent = name;
  $("resumeSummaryText").textContent = text;
  const box = $("resumeSummaryBox");
  box.open = false;
  box.classList.remove("hidden");
}

async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

$("suggestRolesJobs").addEventListener("click", () => suggestRoles("jobs"));
$("suggestRolesFreelance").addEventListener("click", () => suggestRoles("freelance"));

$("runJobs").addEventListener("click", () =>
  start({
    mode: "jobs",
    targetRole: $("targetRole").value.trim(),
    yearsExp: $("yearsExp").value,
    workplace: getRadio("workplaceJobs"),
    resume: resumeSummary,
    selectedRoles: selectedRoles("jobs"),
    expertise: "",
    projectLinks: "",
  })
);

$("runFreelance").addEventListener("click", () =>
  start({
    mode: "freelance",
    targetRole: "",
    yearsExp: "",
    workplace: getRadio("workplaceFreelance"),
    resume: "",
    selectedRoles: selectedRoles("freelance"),
    expertise: $("expertise").value,
    projectLinks: $("projectLinks").value,
  })
);

$("downloadCsv").addEventListener("click", () => {
  if (!lastRows.length) return;
  const csv = toCsv(lastRows);
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  chrome.downloads.download({ url, filename: `foothold_${Date.now()}.csv`, saveAs: true });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "PROGRESS") log(msg.text);
});

const EXPECTED_BUILD = "2026-09-23e";
const STALE =
  "Background script is out of date. Go to chrome://extensions and click the reload arrow on this extension.";

// chrome.runtime.sendMessage resolves to undefined when the worker has no branch
// for the message, which is exactly what a stale build looks like.
async function send(message) {
  try {
    const res = await chrome.runtime.sendMessage(message);
    if (res === undefined) return { ok: false, error: STALE };
    return res;
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function checkBuild() {
  const res = await send({ type: "PING" });
  if (res.build !== EXPECTED_BUILD) log(STALE);
}

async function suggestRoles(mode) {
  const seed =
    mode === "jobs" ? $("targetRole").value.trim() : $("expertise").value.trim();
  if (!seed) {
    log(mode === "jobs" ? "Type a target role first." : "Describe your expertise first.");
    return;
  }
  const btn = $(mode === "jobs" ? "suggestRolesJobs" : "suggestRolesFreelance");
  btn.disabled = true;
  log("Asking OpenAI for similar titles…");
  const res = await send({
    type: "SUGGEST_ROLES",
    payload: {
      mode,
      seed,
      yearsExp: mode === "jobs" ? $("yearsExp").value : "",
      workplace: getRadio(mode === "jobs" ? "workplaceJobs" : "workplaceFreelance"),
      openaiKey: $("openaiKey").value.trim(),
    },
  });
  btn.disabled = false;
  if (!res.ok) {
    log("Could not suggest roles: " + (res.error || "unknown"));
    return;
  }
  // Seed title always stays in the list and starts ticked.
  const titles = [{ title: seed, why: "The role you typed." }, ...(res.roles || [])];
  const seen = new Set();
  roleState[mode] = titles
    .filter((r) => r.title && !seen.has(r.title.toLowerCase()) && seen.add(r.title.toLowerCase()))
    .slice(0, 8)
    .map((r, i) => ({ title: r.title, why: r.why || "", checked: i === 0 }));
  renderRoles(mode);
  persistRoles(mode);
  log(`Suggested ${roleState[mode].length} titles. Tick the ones to search, then Run.`);
}

function renderRoles(mode) {
  const box = $(mode === "jobs" ? "rolesJobs" : "rolesFreelance");
  box.textContent = "";
  const ul = document.createElement("ul");
  roleState[mode].forEach((role, i) => {
    const li = document.createElement("li");
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!role.checked;
    cb.addEventListener("change", () => {
      roleState[mode][i].checked = cb.checked;
      persistRoles(mode);
    });
    const text = document.createElement("span");
    text.textContent = role.title;
    if (role.why) {
      const why = document.createElement("span");
      why.className = "why";
      why.textContent = role.why;
      text.appendChild(why);
    }
    label.append(cb, text);
    li.appendChild(label);
    ul.appendChild(li);
  });
  box.appendChild(ul);

  // Let the user add a title the model did not think of.
  const row = document.createElement("div");
  row.className = "addRow";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Add your own title";
  const add = document.createElement("button");
  add.type = "button";
  add.className = "secondary";
  add.textContent = "Add";
  const commit = () => {
    const title = input.value.trim();
    if (!title) return;
    roleState[mode].push({ title, why: "Added by you.", checked: true });
    persistRoles(mode);
    renderRoles(mode);
  };
  add.addEventListener("click", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
  });
  row.append(input, add);
  box.appendChild(row);
}

function persistRoles(mode) {
  const key = mode === "jobs" ? "rolesJobs" : "rolesFreelance";
  chrome.storage.local.set({ [key]: roleState[mode] });
}

function selectedRoles(mode) {
  return roleState[mode].filter((r) => r.checked).map((r) => r.title);
}

function getRadio(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value || "all";
}

function setRadio(name, value) {
  const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (el) el.checked = true;
}

async function start(fields) {
  const { openaiKey, googleClientId } = await chrome.storage.local.get(["openaiKey", "googleClientId"]);
  $("downloadCsv").disabled = true;
  lastRows = [];
  log("Starting… keep LinkedIn logged in.");
  const res = await send({
    type: "RUN",
    payload: {
      ...fields,
      openaiKey: openaiKey || $("openaiKey").value.trim(),
      googleClientId: googleClientId || $("googleClientId").value.trim(),
      maxScrolls: 4,
    },
  });
  if (!res?.ok) {
    log("Failed: " + (res?.error || "unknown"));
    return;
  }
  lastRows = res.rows || [];
  $("downloadCsv").disabled = !lastRows.length;
  const drafted = lastRows.filter((r) => r.action === "gmail_draft_created").length;
  log(
    `Queries: ${(res.queries || []).join(" | ")}\n` +
      `Matches: ${lastRows.length}. Gmail drafts: ${drafted}.\n` +
      (res.note || "Download the CSV report.")
  );
}

function log(text) {
  $("log").textContent = text;
}

function toCsv(rows) {
  const cols = ["post_url", "poster_name", "poster_profile", "email", "email_source", "apply_url", "snippet", "why", "subject", "body", "action"];
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}
