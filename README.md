# Viral Trend Scout

Find high-velocity and outlier YouTube videos from competitor channels and keyword searches. Runs entirely locally — no cloud services, no database.

## Prerequisites

- **Node.js 18+** — [nodejs.org](https://nodejs.org)
- A **YouTube Data API v3 key** — [console.cloud.google.com](https://console.cloud.google.com)
  - Enable the *YouTube Data API v3* for your project
  - Create an API key under *Credentials*

## Setup

```bash
# 1. Clone / enter the project
cd viral-trend-scout

# 2. Install dependencies
npm install

# 3. Configure your API key
cp .env.example .env
# Then open .env and replace the placeholder with your real key:
#   YOUTUBE_API_KEY=AIzaSy...
```

## Run

```bash
npm start
```

Open **http://localhost:3000** in your browser.

## Usage

1. **Add channels** — type a YouTube handle (`@mkbhd`) or channel ID (`UCxxxxxx`) in the channel field and press **Enter**. Repeat for multiple channels.
2. **Keyword** *(optional)* — enter a search term to find trending videos matching that query.
3. **Time range** — choose how far back to look (7 / 14 / 30 / 90 days).
4. **Outlier threshold** — videos with views ≥ N× the channel's average are flagged as outliers (default 3×).
5. Click **⚡ Scan**.

### Result cards

| Badge | Meaning |
|-------|---------|
| 🔥 Hot | Velocity > 500 views/hour |
| ⚡ N× avg | Video views vs channel average |
| Channel | Found via channel scan |
| Keyword | Found via keyword search |

Click any card to open the video on YouTube.

### Tabs & sorting

Use the **All / Outliers / Keyword Hits / Channel Hits** tabs to filter results.  
Sort by **Velocity**, **Total Views**, **Outlier Score**, or **Most Recent**.

## API quota

YouTube Data API v3 has a default quota of **10,000 units/day** (free).  
A typical scan with 3 channels + 1 keyword uses ~400 units. If you hit the limit, the app shows a warning banner and you can try again the next day.

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `YOUTUBE_API_KEY` | Yes | — | YouTube Data API v3 key |
| `PORT` | No | `3000` | Port the server listens on |
