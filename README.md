# AlvinHub YouTube AI Reply Bot

Automatically replies to every YouTube comment using Claude AI. Runs 24/7 in the cloud.

## Deploy to Railway (free)

### Step 1 — Push to GitHub
1. Go to github.com and create a new repository called `yt-reply-bot`
2. Upload all these files to the repo

### Step 2 — Deploy on Railway
1. Go to railway.app and sign up (free)
2. Click **New Project** → **Deploy from GitHub repo**
3. Select your `yt-reply-bot` repo
4. Railway will detect it's a Node.js app and deploy automatically

### Step 3 — Add environment variables on Railway
In your Railway project → **Variables** tab, add:

| Variable | Value |
|----------|-------|
| GOOGLE_CLIENT_ID | your-client-id.apps.googleusercontent.com |
| GOOGLE_CLIENT_SECRET | GOCSPX-your-secret |
| ANTHROPIC_API_KEY | sk-ant-your-key |
| CHANNEL_NAME | AlvinHub |
| REPLY_TONE | friendly and warm |
| REPLY_LENGTH | short (1-2 sentences) |
| CHECK_INTERVAL_MINS | 15 |
| REDIRECT_URI | https://your-app.up.railway.app/auth/callback |

### Step 4 — Update Google Cloud
1. Go to Google Cloud → Credentials → your OAuth client
2. Under **Authorised redirect URIs** add:
   `https://your-app.up.railway.app/auth/callback`
3. Under **Authorised JavaScript origins** add:
   `https://your-app.up.railway.app`

### Step 5 — Connect YouTube
1. Open your Railway app URL
2. Click **Connect YouTube**
3. Sign in with your Google account
4. Click **Start bot** — it will now run every 15 minutes automatically!
