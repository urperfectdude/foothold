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

1. Paste an **OpenAI API key**. It is stored in `chrome.storage.local` (plain text, readable
   by anything with access to your Chrome profile) and only ever leaves as the
   `Authorization` header to `api.openai.com`.
2. **Connect Gmail** (optional — CSV still works without it):
   - Google Cloud → enable Gmail API.
   - OAuth client type **Chrome extension**, item ID = the pinned ID above.
   - Or type **Web application** with this authorized redirect URI:
     `https://pjdckgljbogpnglkdnfgegmdfngoeefa.chromiumapp.org/`
   - Add yourself as an OAuth **Test user** if the app is in Testing.
   - Paste the Client ID into the panel and click **Connect Gmail**.

The old Desktop-app `credentials.json` is for the Python script only, not this extension.

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

### What the workplace filter actually does

LinkedIn *content* search has no workplace or seniority facet. The chosen workplace and
experience are added to the search keywords as a nudge, and the real filtering happens in
the scoring prompt — posts that clearly contradict your choice get dropped, posts that say
nothing are kept. Expect it to be directional, not exact. Using LinkedIn **Jobs** search
(`f_WT` / `f_E` URL params), where those filters are real, is a planned upgrade.

## Python scraper

`scraper.py` is the original hardcoded APM path (`SEARCH_QUERIES`, `ROLE_PATTERN`) and is
unrelated to the extension. It is kept as-is.
