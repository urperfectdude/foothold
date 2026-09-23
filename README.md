# Foothold

Chrome extension: pick the role you want, let OpenAI expand it into similar titles,
scrape matching hiring posts in **your already logged-in LinkedIn tab**, score them,
create **Gmail drafts** (never sent), and download a **CSV report**.

Two modes:

- **Job seeker** — target role, years of experience, workplace preference. Resume is
  optional and is used only when drafting the email, not when searching.
- **Freelancer** — expertise + project links. Finds clients hiring that work and drafts
  emails that cite your projects.

Automated LinkedIn use is against LinkedIn's terms. Use sparingly.

## Load it

1. Chrome → `chrome://extensions` → turn on **Developer mode**.
2. **Load unpacked** → select the `extension` folder in this repo (not the repo root).
3. Pin the extension. Stay logged into LinkedIn.

Clicking the toolbar icon opens a **side panel**, not a popup, so it stays open while the
extension drives your LinkedIn tab. Needs Chrome 114+.

### The extension ID is pinned

`extension/manifest.json` carries a `key`, so the ID is always:

```
pjdckgljbogpnglkdnfgegmdfngoeefa
```

The matching private key is `key.pem` in the repo root. It is gitignored — **keep it, and
don't publish it**. Lose it and the ID changes, which breaks the Gmail OAuth redirect URI
below.

## Settings in the panel

Paste an **OpenAI API key**. It is stored in `chrome.storage.local` (plain text, readable by
anything with access to your Chrome profile) and only ever leaves as the `Authorization`
header to `api.openai.com`.

That is the only thing you type. Gmail is one button.

### Gmail (optional — CSV still works without it)

Click **Connect Gmail** and Chrome shows its own account chooser and consent sheet. There is
no client ID to paste and no redirect URI to register: the client ID lives in
`manifest.json` under `oauth2`, and Chrome handles consent, caching and **token refresh**.

Setting that up is a one-time job, already done unless `manifest.json` still says
`PASTE_CHROME_EXTENSION_CLIENT_ID_HERE`:

1. Google Cloud → enable the Gmail API.
2. Credentials → Create credentials → OAuth client ID → type **Chrome extension**.
3. Item ID: `pjdckgljbogpnglkdnfgegmdfngoeefa` (this is why the ID is pinned).
4. Paste the resulting client ID into `manifest.json` → `oauth2.client_id`.
5. Add yourself as an OAuth **Test user** if the consent screen is in Testing.

You must be signed into Chrome with the account you want drafts in. If a token expires
mid-run, the extension silently fetches a new one and retries the draft once.

The old Desktop-app `credentials.json` is for `gmail_drafts.py` only, not this extension.

## Run

Leave a LinkedIn tab open and logged in, then:

1. Pick **Job seeker** or **Freelancer**.
2. Job seeker: type a **target role**, pick **years of experience** and **workplace**
   (All / Remote / Hybrid / Onsite). Freelancer: describe your **expertise** and paste
   **project links**.
3. Click **Suggest similar roles**. OpenAI returns about six adjacent titles. Tick the ones
   worth searching, untick the rest, or type your own and hit **Add**. The title you typed is
   always included and pre-ticked.
4. Click **Run on LinkedIn**. Each ticked title becomes one search (capped at 6).
5. **Download CSV report** when it finishes.

Your form and ticked titles persist, so the next run is one click.

### Resume upload

Upload a **PDF, DOCX or TXT** and the extension summarises it once with OpenAI, then stores
that summary and reuses it on every run until you upload a different file. The summary shows
as a collapsed row under the upload field — click it to read, **Clear summary** to drop it.
There is no paste box: the file is the only input.

The summary — not the full resume — is what goes into the drafting prompt, so runs stay cheap
regardless of how long your resume is.

Extraction differs by format: TXT is read directly, DOCX is unzipped in the extension
(`word/document.xml`), and PDFs are handed to OpenAI to read, so no PDF library ships here.
Legacy binary `.doc` is not supported — save it as PDF or DOCX first.

### Contact details inside images

Plenty of hiring posts put the email in a graphic rather than the text. When a post's text
yields no address, the extension downloads the post image, downscales it to 1024px, and asks
OpenAI to read any contact details off it. This runs **only** for posts with no email in the
text, and is capped at 12 images per run to bound cost (well under a cent at `gpt-4o-mini`).

The CSV records where each address came from in `email_source` (`text` or `image`), plus any
`apply_url` found. **Check image-sourced addresses before sending** — OCR can confuse `l`/`1`
and `o`/`0`, and a wrong address bounces. Drafts are never sent automatically, so you always
get to look first.

### Sweeping combinations

**Workplace multi-selects** — All / Remote / Hybrid / Onsite, with **All** ticked by default.
Every ticked value becomes an axis, and Run sweeps the matrix of ticked roles x ticked
workplaces. **All** means one search with no workplace keyword, which is the widest net and
the only one that catches posts that never state their work arrangement. The line underneath
shows the real cost before you commit — `4 roles x 3 workplaces = 12 searches, about 2 min`.

A red **Stop run** button appears in the Status box while a sweep is running. It finishes the
search already in flight, then stops cleanly — posts scraped so far are still scored, drafted
and downloadable, and everything seen is remembered. It is not a hard kill, so expect up to
about 12 seconds before it takes effect.

Capped at 24 searches per sweep. Each search costs roughly 12 seconds, and there is a random
1.5–4s pause between them, because two dozen back-to-back searches is a conspicuous pattern.

Results from every search are pooled, deduped, and scored **in batches of 10 so every post is
judged** — earlier builds scored only the first 28 of a run, which silently discarded most of
a sweep.

**Posts are remembered across runs.** A repeat sweep only surfaces what is new, and the status
line reports how many were skipped. **Reset seen posts** clears that memory (it holds the most
recent 4000 post ids).

### Preferences

Both modes have a free-text **Preferences** box. Write what you actually want — cities,
industries, things to avoid, anything ("Bangalore, fintech, not agencies, non Indian").

Preferences are **intent, not keywords**, so before searching they are classified once by
OpenAI into three buckets:

- **keywords** — only terms that appear verbatim in real posts (`Bangalore`, `fintech`).
  These get appended to the LinkedIn search.
- **exclude** — disqualifying criteria (`companies based in India`). Applied when scoring.
- **include** — soft positive criteria. Applied when scoring.

This matters: typing `non indian` used to be appended straight to the query as
`hiring "Product Manager" non indian`, which no post contains, so every search returned
nothing. Now it becomes an exclusion rule and the search itself stays broad.

The status box prints what it decided each run, so you can see which preferences are
searching and which are only filtering. Classifications are cached per preference text, so
re-running costs nothing extra.

### Posted date

Both modes have a **Posted** filter — Any time / 24 hours / Week / Month. Unlike workplace
and years, this one is a real LinkedIn facet: it becomes a `datePosted` URL parameter and
LinkedIn does the filtering server-side, so it costs no recall. Use **Week** or **24 hours**
on repeat runs to see only what is new.

The parameter values live in `DATE_PARAM` in `extension/background.js`. They are undocumented
LinkedIn internals, so if recency stops working, fix them there.

### What the workplace filter actually does

LinkedIn *content* search has no workplace or seniority facet. The chosen workplace and
experience are added to the search keywords as a nudge, and the real filtering happens in
the scoring prompt — posts that clearly contradict your choice get dropped, posts that say
nothing are kept. Expect it to be directional, not exact. Using LinkedIn **Jobs** search
(`f_WT` / `f_E` URL params), where those filters are real, is a planned upgrade.

## Python scraper

`scraper.py` is the original hardcoded APM path (`SEARCH_QUERIES`, `ROLE_PATTERN`) and is
unrelated to the extension. It is kept as-is.
