# AI Team

Black, Calibri chat site where several free AIs work together.

- **Solo:** you pick one AI. If it runs out of credits or errors, the next AI takes over.
- **Team:** 3 AIs answer at the same time (they know they're a team), then a lead AI merges them. That's 4 calls per message. Set `TEAM_SIZE=4` in Vercel for 4 AIs (5 calls).
- **Files:** any file up to 1 GB. Uploaded from your phone straight to Cloudflare R2 and deleted after 24 hours.

## What the AIs can read (straight from R2, any size)
- **Text, code, CSV, JSON, logs, etc.:** any size up to 1 GB.
- **Word (docx), Excel (xlsx), PowerPoint (pptx), OpenDocument:** any size.
- **PDF:** text PDFs up to 50 MB. Scanned PDFs (photos of pages) have no text, so they can't be read.
- **Pictures** (png, jpg, webp, gif): up to 5 MB.
- **Not yet:** audio, video, zip files, and old Word/Excel/PowerPoint (doc, xls, ppt). Save old ones as docx/xlsx/pptx or PDF.

**How a huge file works:** no AI can take 1 GB at once. For big files the AIs get the opening plus the parts that best match your question (like a search), about 12,000 characters at a time. The file stays attached, so keep asking questions and each one pulls the matching parts. Small files go in whole. The site tells you when it only showed parts. Raise `FILE_CHARS` in Vercel to show more per question (uses more credits).

## Setup on a phone (use your browser's "Desktop site" option on github.com, cloudflare and vercel)

### 1. Free AI keys (any 2 or 3)
- Gemini: aistudio.google.com > Get API key
- Groq: console.groq.com > API Keys
- Mistral: console.mistral.ai > API Keys
- OpenRouter: openrouter.ai > Keys
- Cerebras: cloud.cerebras.ai > API Keys

### 2. Cloudflare R2
1. Dashboard > R2 > Create bucket (it may ask for a card to turn R2 on; the free 10 GB isn't charged).
2. Bucket > Settings > Object lifecycle rules > delete objects 1 day after upload.
3. Bucket > Settings > CORS policy > Add, and paste this. **This is what allows uploads bigger than 4 MB** (it lets your site send files straight to the bucket):
   `[{"AllowedOrigins":["*"],"AllowedMethods":["PUT"],"AllowedHeaders":["*"],"MaxAgeSeconds":3600}]`
4. R2 > Manage API tokens > Create token with Object Read & Write for that bucket.
5. Note: Account ID, Access Key ID, Secret Access Key, bucket name.

### 3. Backblaze B2 (optional backup, skip if you want)
1. Create a private bucket. Lifecycle Settings > custom rule: hide after 1 day, delete after 1 day.
2. App Keys > Add a key for that bucket. Note keyID and applicationKey.
3. Copy the bucket's S3 endpoint (like `s3.us-west-004.backblazeb2.com`).
B2 only backs up files up to 4 MB.

### 4. GitHub
1. Unzip the file with your Files app.
2. New repository. Add file > Upload files: `package.json`, `vercel.json`, `README.md`, `env.example`. Commit.
3. Add file > Create new file. Type `api/index.js` as the name (typing the slash makes the folder), paste the file's contents, Commit.
4. Same again for `public/index.html`.

### 5. Vercel
1. vercel.com > Add New > Project > import your repo > Deploy.
2. Settings > Environment Variables: add the names from `env.example` with your values.
3. Deployments > Redeploy.
4. Open your site and enter your `ACCESS_CODE`.

## Notes
- Keep the screen on while a very large file uploads.
- Each question re-reads attached files from R2, so questions on a huge file take a few seconds longer.
- Skip any key you don't have. That AI is simply left out.
- If a model name is retired, set e.g. `GROQ_MODEL` in Vercel to a current one.
- The access code stops strangers from using up your free credits.
