require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const API_KEY = process.env.YOUTUBE_API_KEY;
const YT_BASE = 'https://www.googleapis.com/youtube/v3';
const PORT = process.env.PORT || 3000;

// ── YouTube API helpers ────────────────────────────────────────────────────

async function ytFetch(url) {
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) {
    const reason = body?.error?.errors?.[0]?.reason ?? 'unknown';
    const err = new Error(`YouTube API ${res.status}: ${reason} — ${body?.error?.message ?? ''}`);
    err.status = res.status;
    err.reason = reason;
    throw err;
  }
  return body;
}

async function resolveChannelId(handleOrId) {
  const clean = handleOrId.replace(/^@/, '').trim();
  // Looks like a raw channel ID — skip the API call
  if (/^UC[\w-]{22}$/.test(handleOrId.trim())) {
    return { id: handleOrId.trim(), title: handleOrId.trim() };
  }
  const url = `${YT_BASE}/channels?part=snippet&forHandle=${encodeURIComponent(clean)}&key=${API_KEY}`;
  const data = await ytFetch(url);
  const item = data.items?.[0];
  if (!item) throw new Error(`Channel not found: ${handleOrId}`);
  return { id: item.id, title: item.snippet.title };
}

async function searchChannelVideos(channelId, publishedAfter) {
  const url = `${YT_BASE}/search?part=snippet&channelId=${channelId}` +
    `&publishedAfter=${encodeURIComponent(publishedAfter)}` +
    `&order=date&type=video&maxResults=50&key=${API_KEY}`;
  const data = await ytFetch(url);
  return (data.items || []).map(item => ({
    videoId: item.id.videoId,
    title: item.snippet.title,
    channelTitle: item.snippet.channelTitle,
    channelId: item.snippet.channelId,
    publishedAt: item.snippet.publishedAt,
  }));
}

async function searchKeywordVideos(keyword, publishedAfter) {
  const url = `${YT_BASE}/search?part=snippet&q=${encodeURIComponent(keyword)}` +
    `&publishedAfter=${encodeURIComponent(publishedAfter)}` +
    `&order=viewCount&type=video&maxResults=50&key=${API_KEY}`;
  const data = await ytFetch(url);
  return (data.items || []).map(item => ({
    videoId: item.id.videoId,
    title: item.snippet.title,
    channelTitle: item.snippet.channelTitle,
    channelId: item.snippet.channelId,
    publishedAt: item.snippet.publishedAt,
  }));
}

async function batchGetVideoStats(videoIds) {
  const statsMap = new Map();
  const chunks = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    chunks.push(videoIds.slice(i, i + 50));
  }
  await Promise.all(chunks.map(async chunk => {
    const url = `${YT_BASE}/videos?part=statistics&id=${chunk.join(',')}&key=${API_KEY}`;
    const data = await ytFetch(url);
    for (const item of (data.items || [])) {
      statsMap.set(item.id, {
        viewCount: parseInt(item.statistics.viewCount || '0', 10),
        likeCount: parseInt(item.statistics.likeCount || '0', 10),
      });
    }
  }));
  return statsMap;
}

function computeChannelAverage(viewCounts) {
  if (!viewCounts.length) return 0;
  return viewCounts.reduce((s, v) => s + v, 0) / viewCounts.length;
}

// ── Routes ─────────────────────────────────────────────────────────────────

app.get('/api/status', (_req, res) => {
  res.json({ ok: true, keyConfigured: !!(API_KEY && API_KEY.length > 5) });
});

app.post('/api/scan', async (req, res) => {
  const { channels = [], keyword = '', days = 14, outlierThreshold = 3 } = req.body;

  if (!API_KEY) {
    return res.status(400).json({ error: 'YOUTUBE_API_KEY not configured in .env' });
  }
  if (!channels.length && !keyword.trim()) {
    return res.status(400).json({ error: 'Provide at least one channel or a keyword.' });
  }

  const publishedAfter = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

  // Map of videoId → stub data
  const videoStubs = new Map();
  // Map of channelId → { title, videoIds[] }
  const channelMap = new Map();

  let quotaWarning = null;

  const markSource = (videoId, src) => {
    const existing = videoStubs.get(videoId);
    if (existing) {
      if (existing.source !== src) existing.source = 'both';
    }
  };

  try {
    // 1. Resolve channel handles & fetch their videos (parallel per channel)
    await Promise.all(channels.map(async handle => {
      try {
        const { id: channelId, title: channelTitle } = await resolveChannelId(handle);
        const videos = await searchChannelVideos(channelId, publishedAfter);
        const videoIds = [];
        for (const v of videos) {
          if (!videoStubs.has(v.videoId)) {
            videoStubs.set(v.videoId, { ...v, source: 'channel' });
          } else {
            markSource(v.videoId, 'channel');
          }
          videoIds.push(v.videoId);
        }
        channelMap.set(channelId, { title: channelTitle, videoIds });
      } catch (err) {
        if (err.reason === 'quotaExceeded') throw err;
        console.warn(`Skipping channel "${handle}": ${err.message}`);
      }
    }));

    // 2. Keyword search
    if (keyword.trim()) {
      try {
        const kwVideos = await searchKeywordVideos(keyword.trim(), publishedAfter);
        for (const v of kwVideos) {
          if (!videoStubs.has(v.videoId)) {
            videoStubs.set(v.videoId, { ...v, source: 'keyword' });
          } else {
            markSource(v.videoId, 'keyword');
          }
        }
      } catch (err) {
        if (err.reason === 'quotaExceeded') throw err;
        console.warn(`Keyword search failed: ${err.message}`);
      }
    }

    // 3. Batch-fetch stats for all unique video IDs
    const allIds = [...videoStubs.keys()];
    const statsMap = allIds.length ? await batchGetVideoStats(allIds) : new Map();

    // 4. Compute per-channel average views
    const channelAvgMap = new Map();
    for (const [channelId, { videoIds }] of channelMap) {
      const views = videoIds
        .map(id => statsMap.get(id)?.viewCount ?? 0)
        .filter(v => v > 0);
      channelAvgMap.set(channelId, computeChannelAverage(views));
    }

    // 5. Assemble results
    const now = Date.now();
    const videos = [];

    for (const [videoId, stub] of videoStubs) {
      const stats = statsMap.get(videoId);
      if (!stats) continue;

      const { viewCount } = stats;
      const hoursOld = Math.max((now - Date.parse(stub.publishedAt)) / 3_600_000, 1);
      const velocity = viewCount / hoursOld;
      const channelAvgViews = channelAvgMap.get(stub.channelId) ?? 0;
      const outlierScore = channelAvgViews > 0 ? viewCount / channelAvgViews : 0;

      videos.push({
        id: videoId,
        title: stub.title,
        channelId: stub.channelId,
        channelName: stub.channelTitle,
        publishedAt: stub.publishedAt,
        viewCount,
        hoursOld: Math.round(hoursOld * 10) / 10,
        velocity: Math.round(velocity * 10) / 10,
        channelAvgViews: Math.round(channelAvgViews),
        outlierScore: Math.round(outlierScore * 10) / 10,
        isOutlier: outlierScore >= outlierThreshold,
        isHot: velocity >= 500,
        source: stub.source,
      });
    }

    // Sort default: velocity desc
    videos.sort((a, b) => b.velocity - a.velocity);

    const outliers = videos.filter(v => v.isOutlier).length;
    const peakVelocity = videos.reduce((m, v) => Math.max(m, v.velocity), 0);
    const totalViews = videos.reduce((s, v) => s + v.viewCount, 0);

    res.json({
      videos,
      meta: {
        scanned: videos.length,
        outliers,
        peakVelocity: Math.round(peakVelocity),
        totalViews,
        quotaWarning,
      },
    });

  } catch (err) {
    if (err.reason === 'quotaExceeded') {
      return res.json({
        videos: [],
        meta: { scanned: 0, outliers: 0, peakVelocity: 0, totalViews: 0, quotaWarning: 'YouTube API quota exceeded for today. Try again tomorrow.' },
      });
    }
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Viral Trend Scout running at http://localhost:${PORT}`);
  if (!API_KEY) console.warn('  WARNING: YOUTUBE_API_KEY not set in .env');
});
