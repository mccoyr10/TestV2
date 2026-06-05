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
    `&order=date&type=video&maxResults=50` +
    `&relevanceLanguage=en&regionCode=US&key=${API_KEY}`;
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
    `&order=viewCount&type=video&maxResults=50` +
    `&relevanceLanguage=en&regionCode=US&key=${API_KEY}`;
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

// ── Video detail analysis ──────────────────────────────────────────────────

async function fetchVideoDetail(videoId) {
  const url = `${YT_BASE}/videos?part=snippet&id=${videoId}&key=${API_KEY}`;
  const data = await ytFetch(url);
  const item = data.items?.[0];
  if (!item) throw new Error('Video not found');
  return {
    description: item.snippet.description || '',
    tags: item.snippet.tags || [],
    categoryId: item.snippet.categoryId,
  };
}

function analyzeVideoDetail({ description, tags, title }) {
  const text = `${title} ${description}`.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();

  // Extract specific dollar amounts, percentages, counts mentioned
  const numberMatches = [...text.matchAll(/\$[\d,]+(?:\.\d+)?(?:\s*[km]illion)?|\b\d[\d,.]*\s*(?:dollars?|percent|%|k\b|million\b)/gi)];
  const numbers = [...new Set(numberMatches.map(m => m[0].trim()))].slice(0, 6);

  // Detect dominant emotional driver
  const emotionMap = {
    transformation: /transform|changed my|before i|after i|became|turned it|journey|different person/i,
    fear_avoidance:  /mistake|wrong|never do|avoid|danger|warning|stop doing|don.t do|regret/i,
    aspiration:      /dream|goal|success|achieve|freedom|financial|retire|build wealth|passive/i,
    vulnerability:   /honest|real talk|admit|failed|struggled|hard truth|wasn.t easy|almost gave up/i,
    curiosity:       /secret|nobody knows|you.d be surprised|most people|actually works|myth|debunk/i,
  };
  const dominantEmotion = Object.entries(emotionMap).find(([, rx]) => rx.test(text))?.[0] ?? 'curiosity';

  // Detect content format from title + description structure
  const format =
    /\d+\s*-?\s*day\s+(?:challenge|experiment|streak)/i.test(text) ? 'challenge' :
    /(?:number one|first tip|first thing|\bone\b[^.]{0,40}\btwo\b|\d+\s+(?:tips?|ways?|reasons?|things?))/i.test(text) ? 'list' :
    /(?:i was|it started|then one day|until i|the moment|so i decided)/i.test(text) ? 'story' :
    'essay';

  // Pull high-signal lines from description
  const lines = description.split(/\n+/).filter(l => l.trim().length > 20);
  const keyPhrases = lines
    .filter(l => /\$|\d+\s*%|secret|mistake|never|always|every\s+\w|key\s+to|reason\s+why|changed\s+my/i.test(l))
    .slice(0, 4)
    .map(l => l.trim());

  // Description opening (first 200 chars after stripping URLs)
  const descOpening = description.replace(/https?:\/\/\S+/g, '').trim().slice(0, 220);

  // Top tags (first 8)
  const topTags = tags.slice(0, 8);

  const ideas = buildIdeas({ numbers, dominantEmotion, format, title, keyPhrases, descOpening });

  return { descOpening, topTags, numbers, dominantEmotion, format, keyPhrases, ideas };
}

function cleanTopic(title) {
  return title
    .replace(/[?!.]{2,}/g, '')
    .replace(/[^\w\s'"-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 70);
}

function buildIdeas({ numbers, dominantEmotion, format, title, keyPhrases, descOpening }) {
  const topic  = cleanTopic(title);
  const num1   = numbers[0] || '';
  // A one-sentence context clue from the description, if available
  const detail = keyPhrases[0] || descOpening?.slice(0, 100) || '';

  return {
    finance: buildPillarIdea('finance', { topic, format, dominantEmotion, num1, detail }),
    family:  buildPillarIdea('family',  { topic, format, dominantEmotion, num1, detail }),
    build:   buildPillarIdea('build',   { topic, format, dominantEmotion, num1, detail }),
  };
}

function buildPillarIdea(pillar, { topic, format, dominantEmotion, num1, detail }) {
  const t = topic; // the actual video topic, used directly in every idea

  // Each pillar has a reframing lens that maps the video's topic to Ricky's world
  const lens = {
    finance: {
      subject:    'our family finances',
      angle:      'as a husband and dad building wealth on a normal income',
      adaptation: `what "${t}" means for families trying to get ahead financially`,
    },
    family: {
      subject:    'my marriage and kids',
      angle:      'as a husband and father',
      adaptation: `how "${t}" shows up inside a real marriage and family`,
    },
    build: {
      subject:    'building and creating things',
      angle:      'as someone who builds and documents the process on camera',
      adaptation: `how "${t}" connects to building something real with your hands`,
    },
  }[pillar];

  // Hook template grid: format × emotion, each using the actual topic (t)
  const grid = {
    challenge: {
      transformation: `"I applied the concept behind '${t}' to ${lens.subject} for 30 days — here's what actually changed" — run the same timed-experiment structure; you're the test subject, show the real before and after${num1 ? `, anchor it to a specific figure like ${num1}` : ''}`,
      fear_avoidance:  `"I tried my version of '${t}' for a month and here's the day it almost fell apart" — experiment format, lead with the moment of failure, end with the lesson learned ${lens.angle}`,
      aspiration:      `"30-day challenge: applying '${t}' to ${lens.subject} — full honest results" — show the goal, the grind, and the real outcome${num1 ? ` (real number: ${num1})` : ''}`,
      vulnerability:   `"I challenged myself to confront '${t}' in my own life for 30 days — here are the parts I almost didn't film" — radically transparent format, don't hide the hard moments`,
      curiosity:       `"I took the counter-intuitive idea inside '${t}' and tested it on ${lens.subject} — the result surprised me" — the unexpected outcome is the payoff, structure the video around the reveal`,
    },
    list: {
      transformation:  `"[N] ways '${t}' changed how I think about ${lens.subject} — in order of impact" — list format, each point is a real shift you personally lived through${detail ? `, starting from: "${detail}"` : ''}`,
      fear_avoidance:  `"[N] things '${t}' reveals that most people get completely wrong about ${lens.subject}" — debunk list, each point is a mistake + the correction from your real experience`,
      aspiration:      `"[N] things I'm now doing differently with ${lens.subject} because of what '${t}' shows is possible" — practical, repeatable steps grounded in your actual household${num1 ? ` and real numbers like ${num1}` : ''}`,
      vulnerability:   `"[N] honest things '${t}' made me realize about where I actually am with ${lens.subject}" — personal, no-filter list, each point is something you had to admit to yourself`,
      curiosity:       `"The [N] things about '${t}' that nobody's applying to ${lens.subject} yet" — counter-intuitive list, your take vs. the mainstream, from ${lens.angle}`,
    },
    story: {
      transformation:  `"'${t}' hit close to home — here's the story it reminded me of about ${lens.subject}" — use the same emotional arc as the original; tell a real turning-point story from your own life`,
      fear_avoidance:  `"'${t}' reminded me of a mistake I made with ${lens.subject} — here's the full story" — near-miss narrative, the stakes are real, the lesson is earned, end with what you'd do differently`,
      aspiration:      `"'${t}' is exactly why I'm working toward [specific goal with ${lens.subject}] — here's the story behind that decision" — origin story format, connect the viral topic directly to your real ambition`,
      vulnerability:   `"Watching '${t}' made me want to be more honest about ${lens.subject} — so here it is" — vulnerability-first, lower the mask, show where you actually are right now, not where you want to be`,
      curiosity:       `"'${t}' made me do something most people wouldn't when it comes to ${lens.subject} — here's what happened" — counter-intuitive personal decision leads to a surprising real outcome`,
    },
    essay: {
      transformation:  `"Here's my honest take on '${t}' — and what it's making me rethink about ${lens.subject} ${lens.angle}" — direct-to-camera opinion piece anchored in a real shift in your thinking${detail ? `; the detail that stuck with me: "${detail}"` : ''}`,
      fear_avoidance:  `"'${t}' is a warning — here's what it reveals about the mistake most people are making with ${lens.subject}" — direct-to-camera warning grounded in your own experience, not theory`,
      aspiration:      `"Why '${t}' matters if you're actually trying to build ${lens.subject} — my real take ${lens.angle}" — vision piece, specific and grounded in where you're actually headed, not a vague pep talk`,
      vulnerability:   `"I need to talk about '${t}' — and what it made me realize about where I actually am with ${lens.subject} right now" — honest check-in, no performance, just truth from ${lens.angle}`,
      curiosity:       `"Most people are watching '${t}' and missing the real point — here's what it actually means for ${lens.subject} ${lens.angle}" — counter-intuitive take, your specific perspective, not the obvious reaction`,
    },
  };

  return grid[format]?.[dominantEmotion] ?? grid.essay.curiosity;
}

// ── Routes ─────────────────────────────────────────────────────────────────

app.post('/api/analyze', async (req, res) => {
  const { videoId, title = '' } = req.body || {};
  if (!videoId) return res.status(400).json({ error: 'videoId is required' });
  if (!API_KEY) return res.status(400).json({ error: 'YOUTUBE_API_KEY not configured' });

  try {
    const detail   = await fetchVideoDetail(videoId);
    const analysis = analyzeVideoDetail({ ...detail, title });
    res.json(analysis);
  } catch (err) {
    console.error('Analyze error:', err.message);
    res.status(502).json({ error: err.message || 'Could not fetch video details.' });
  }
});

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

    // Global median fallback for keyword-only videos with no channel baseline
    const allViewCounts = [...statsMap.values()].map(s => s.viewCount).filter(v => v > 0).sort((a, b) => a - b);
    const globalMedian = allViewCounts.length
      ? allViewCounts[Math.floor(allViewCounts.length / 2)]
      : 0;

    // 5. Assemble results
    const now = Date.now();
    const videos = [];

    for (const [videoId, stub] of videoStubs) {
      const stats = statsMap.get(videoId);
      if (!stats) continue;

      const { viewCount } = stats;
      const hoursOld = Math.max((now - Date.parse(stub.publishedAt)) / 3_600_000, 1);
      const velocity = viewCount / hoursOld;
      const channelAvgViews = channelAvgMap.get(stub.channelId) ?? globalMedian;
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

// Local dev: start the server. Vercel imports this file as a module instead.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Viral Trend Scout running at http://localhost:${PORT}`);
    if (!API_KEY) console.warn('  WARNING: YOUTUBE_API_KEY not set in .env');
  });
}

module.exports = app;
