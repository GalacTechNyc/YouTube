# YouTube for Meta Ray-Ban Display

A YouTube app for the 600×600 display on **Meta Ray-Ban Display** glasses. Search by voice or handwriting, browse trending videos, sign in to see your subscriptions, playlists and liked videos, and watch with swipe and pinch controls.

## Using it

**Home**
- **Search box:** pinch it to dictate or handwrite. Results appear as soon as you finish.
- **🔥 Hot:** what's trending on YouTube right now.
- **📺 Subs:** the newest uploads from channels you subscribe to (after signing in).
- **📚 Library:** 🕘 Recent, ★ Saved, and, once signed in, 👍 Liked videos, your 📂 playlists and your account.
- **Swipe ← / →** along the top row, **↓ / ↑** through the list, and **pinch** to open or play.
- **Swipe → on a video** to save it (★), or again to unsave it.
- **Back gesture** inside a playlist or list returns to Library.
- **⚙ Video quality** (in Library): pinch to cycle through Data saver (~240p), Auto (~360p), HD (~720p) and Full HD (~1080p). The player shows the resolution it's actually playing.

**Signing in:** in Subs or Library, pinch **Sign in with Google**. The glasses show a code. On your phone, go to **google.com/device**, enter the code and approve. You never type a password on the glasses. To sign out, pinch your account in Library twice.

What signing in can't do: videos still play through YouTube's embedded player as signed out. So YouTube Premium doesn't apply, and your viewing isn't added to your YouTube history. Watch Later and watch history aren't available to apps through YouTube's API.

**Player**
- **Pinch:** play / pause
- **Swipe ← / →:** back / forward 10 seconds
- **Swipe ↑ / ↓:** volume
- **Back gesture:** return to the list

When a video ends, the next one in the list plays automatically.

## How it works

```
Glasses (web app)  ──HTTPS──▶  server.js  ──▶  YouTube Data API (search, trending)
      │                        holds your API key
      └──▶ YouTube's official embedded player (playback)
```

Search and trending go through the server, so your YouTube API key never reaches the glasses. Sign-in uses Google's device flow with read-only YouTube access. The login token is scrambled (AES-GCM) with a key only your server has and stored on the glasses, so no database is needed. Playback uses YouTube's official embedded player with its on-screen controls hidden. The glasses' swipes and pinches drive it through YouTube's player API. Recent and Saved are stored on the glasses.

## 1. Get a YouTube API key (free)

1. Go to https://console.cloud.google.com/ and create a project (any name).
2. Open **APIs & Services → Library**, search for **YouTube Data API v3**, and click **Enable**.
3. Open **APIs & Services → Credentials → Create credentials → API key**, then copy the key.
4. Optional but recommended: click the key, and under **API restrictions** choose **Restrict key → YouTube Data API v3**.

The free quota is 10,000 units a day. A search costs about 100 units, so that's roughly **100 searches a day**. Repeat searches within 30 minutes are cached and cost nothing. The Hot tab costs almost nothing.

## 2. Optional: set up Google sign-in

Use the same Google Cloud project as your API key.

1. **Consent screen:** go to **Google Auth Platform → Branding** (or **APIs & Services → OAuth consent screen**). Enter an app name (e.g. "Glasses YouTube") and your email. Set **Audience** to **External**.
2. **Keep sign-in from expiring:** under **Audience**, click **Publish app**. While an app is in "Testing", Google ends YouTube sign-ins after 7 days. Publishing a personal app doesn't need Google review. You'll just see an "unverified app" warning when you sign in: tap **Advanced → Go to … (unsafe)**. This is safe because it's your own app.
3. **Client:** go to **Clients → Create client**. Set **Application type** to **TVs and Limited Input devices**, name it, and click **Create**. Copy the **Client ID** and **Client secret**.
4. **Vercel:** add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, then redeploy. `/api/health` should show `"signIn": true`.

## 3. Deploy on Vercel

1. Go to https://vercel.com/new and import `GalacTechNyc/youtube`. Leave the framework as **Other** and the build settings empty.
2. Add environment variables:
   - `YOUTUBE_API_KEY`: the key from step 1
   - `ACCESS_TOKEN`: a long passcode you make up, so strangers can't use up your quota
   - `REGION` (optional): country for the Hot tab, e.g. `US`, `GB`, `CA`
3. Click **Deploy**. Check `https://<your-project>.vercel.app/api/health`: `apiKey` and `locked` should both be `true`.

If the glasses show a Vercel login page, turn it off in **Settings → Deployment Protection**.

## 4. Add it to your glasses

In the Meta AI app, go to **Settings → App Connections → Web Apps → Add a Web App**, name it `YouTube`, and enter:

```
https://<your-project>.vercel.app/?key=YOUR_ACCESS_TOKEN
```

Developer Mode must be on first: **Settings → App Info**, then tap **App version** 5 times.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `YOUTUBE_API_KEY` | — | **Required.** YouTube Data API v3 key. |
| `ACCESS_TOKEN` | *(none)* | Passcode the glasses must send. **Set this.** |
| `REGION` | `US` | Country code for trending videos and search ranking. |
| `GOOGLE_CLIENT_ID` | *(none)* | Optional. OAuth client ("TVs and Limited Input devices") for Google sign-in. |
| `GOOGLE_CLIENT_SECRET` | *(none)* | Optional. That client's secret. It also protects the stored sign-in, so changing it signs you out. |

## Run locally

```bash
cp .env.example .env   # add YOUTUBE_API_KEY
npm start              # http://localhost:3000, no packages to install
```

In a desktop browser, the arrow keys, Enter and Escape stand in for the glasses' swipes, pinch and back gesture. The [Meta Ray-Ban Display Simulator](https://chromewebstore.google.com/detail/meta-ray-ban-display-simu/jpjlmmodokemlepklkdbimceggpbjcll) Chrome extension previews the real display.

## Notes

- Some videos don't allow embedding. Search already filters those out, and the player says "This video can't play here" if one slips through.
- YouTube's terms require its player to stay visible, so this app plays video, not audio only.
- YouTube's embed API no longer lets apps pick a resolution directly. The quality setting works by rendering the player at that size (for example 1920×1080) and scaling it down to fit, because YouTube picks the stream to match the player's size. The display is 600 px wide, so HD and Full HD mostly mean slightly sharper text at the cost of more data.
