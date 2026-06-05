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

  const ideas = buildIdeas({ numbers, dominantEmotion, format, title });

  return { descOpening, topTags, numbers, dominantEmotion, format, keyPhrases, ideas };
}

function buildIdeas({ hook, numbers, dominantEmotion, format, keyPhrases, title }) {
  // Pull specific numbers for injection, with fallbacks
  const num1 = numbers[0] || 'a specific number from your own experience';
  const num2 = numbers[1] || 'a second data point';

  const pillarIdeas = {
    finance: buildPillarIdea('finance', { format, dominantEmotion, num1, num2, title }),
    family:  buildPillarIdea('family',  { format, dominantEmotion, num1, num2, title }),
    build:   buildPillarIdea('build',   { format, dominantEmotion, num1, num2, title }),
  };

  return { ...pillarIdeas };
}

function buildPillarIdea(pillar, { format, dominantEmotion, num1, num2, title }) {
  const combos = {
    finance: {
      challenge_transformation: `"I tracked every dollar our family spent for 30 days — here's the number that shocked me most" (run the same timed-experiment format; anchor it to a real dollar figure like ${num1})`,
      challenge_fear_avoidance:  `"We did a no-spend month as a family and I almost quit on day 4 — here's the mistake that nearly broke us" (use the challenge format but lead with the moment it almost failed)`,
      challenge_aspiration:      `"30-day savings challenge: we tried to hit ${num1} in one month on a normal income — full results" (show the goal, the grind, and the real outcome)`,
      challenge_vulnerability:   `"I publicly tracked our family budget for 30 days — the numbers I almost didn't share" (be radically transparent with real figures)`,
      challenge_curiosity:       `"We quit buying [specific thing] for 30 days — the result actually surprised me" (counter-intuitive outcome as the payoff)`,
      list_transformation:       `"5 money moves that changed our financial life — in order of impact" (list format, each point is a before→after shift you personally lived)`,
      list_fear_avoidance:       `"7 money mistakes I made in my 20s that I'd never make now — real numbers included" (use ${num1} as a concrete anchor in at least one point)`,
      list_aspiration:           `"6 things we do every month to keep building wealth on a normal income" (practical, repeatable, grounded in your actual household)`,
      list_vulnerability:        `"5 financial decisions I regret — and what I'd tell myself if I could go back" (honest, no-filter list from your real story)`,
      list_curiosity:            `"The 4 'obvious' money tips that actually don't work — and what to do instead" (debunk common advice with your personal experience)`,
      story_transformation:      `"The moment I realized we were doing money completely wrong — and how we fixed it" (single turning-point story, lead with the low point, payoff is the system you built)`,
      story_fear_avoidance:      `"We almost bought a house we couldn't afford — the number that saved us was ${num1}" (near-miss story with a specific financial figure as the hero)`,
      story_aspiration:          `"How we went from living paycheck to paycheck to actually having savings — the honest story" (arc: rock bottom → decision → result)`,
      story_vulnerability:       `"I have to be honest about our finances — here's where we actually are right now" (vulnerability-first, real numbers, no sugarcoating)`,
      story_curiosity:           `"I did something most financial advisors say never to do — here's what actually happened" (counter-intuitive decision → surprising outcome)`,
      essay_transformation:      `"Here's the mindset shift that changed how I think about money as a husband and dad" (opinion piece anchored in personal change)`,
      essay_fear_avoidance:      `"Stop doing this with your money — it's why most families never get ahead" (direct-to-camera warning based on your own past mistake)`,
      essay_aspiration:          `"What I actually want our financial future to look like — and the plan to get there" (vision piece, specific goal + concrete steps)`,
      essay_vulnerability:       `"Real talk: we don't have it all figured out — here's where we're struggling financially right now" (honest check-in, invites the audience in)`,
      essay_curiosity:           `"The financial move that sounds dumb but actually accelerated our savings" (reveal a counter-intuitive strategy with your real result)`,
    },
    family: {
      challenge_transformation:  `"I put my phone in a drawer every night for 30 days — here's what it did to my marriage and my kids" (timed challenge, emotional payoff is the relationship change you felt)`,
      challenge_fear_avoidance:  `"I tried being the 'yes dad' for a week — the day it backfired was a wake-up call" (experiment format, honest about when it went wrong)`,
      challenge_aspiration:      `"30-day intentional marriage challenge — one thing every day for my wife. Here's what happened." (document the practice and the outcome, specific and personal)`,
      challenge_vulnerability:   `"I challenged myself to be fully present with my kids for 7 days — I failed more than I expected" (honest about the struggle, not just the wins)`,
      challenge_curiosity:       `"I let my kids plan one full day for 30 days — the thing they chose every time surprised me" (unexpected result as the hook)`,
      list_transformation:       `"5 things I changed about how I show up as a husband — and how each one shifted our marriage" (before→after structure per point, grounded in your relationship)`,
      list_fear_avoidance:       `"7 things I used to do that were quietly damaging my marriage — I didn't see it until too late" (honest, slightly uncomfortable list from your own blind spots)`,
      list_aspiration:           `"6 habits of the husband and dad I'm actively trying to become" (aspirational but grounded — you're in process, not claiming to have arrived)`,
      list_vulnerability:        `"5 moments that revealed I wasn't as good a dad as I thought I was" (vulnerable list, earns deep trust from your audience)`,
      list_curiosity:            `"The 4 marriage tips everyone gives that I think are actually wrong" (debunk common advice from your lived experience)`,
      story_transformation:      `"The conversation with my wife that changed how I think about being a husband" (single story, one moment that shifted everything)`,
      story_fear_avoidance:      `"I almost missed what my kid needed most — here's what I almost got wrong" (near-miss parenting story with emotional stakes)`,
      story_aspiration:          `"This is the kind of dad I want my kids to remember — and the moment I realized I wasn't there yet" (aspirational story anchored in a real wake-up moment)`,
      story_vulnerability:       `"My wife told me something that hurt — and she was completely right. Here's the story." (lead with conflict, resolve with growth)`,
      story_curiosity:           `"I asked my kid what their favorite memory of me was — their answer stopped me cold" (unexpected answer as the hook, emotional and real)`,
      essay_transformation:      `"Here's how my idea of what a 'good husband' looks like has completely changed since we had kids" (opinion + evolution of perspective)`,
      essay_fear_avoidance:      `"The one thing that kills marriages slowly — and how I almost let it happen to ours" (direct warning from your own near-miss)`,
      essay_aspiration:          `"The kind of marriage and family culture I'm intentionally trying to build — here's the vision" (share the goal, make it specific and real)`,
      essay_vulnerability:       `"Being a husband and dad is harder than I let on — here's what I actually struggle with" (honest essay, no performance, just truth)`,
      essay_curiosity:           `"Most people think being a present dad means spending more time — I think it's something different" (counter-intuitive take from your experience)`,
    },
    build: {
      challenge_transformation:  `"I committed to finishing my garage workshop in 30 days — here's how it transformed the space (and my routine)" (timed build challenge with a real before→after)`,
      challenge_fear_avoidance:  `"I challenged myself to only use tools I already owned for one month — the mistakes I made were expensive" (constraint challenge, honest about what went wrong)`,
      challenge_aspiration:      `"30-day build challenge: one project a week, starting with ${num1} budget — full results" (document the whole month, show the wins and the setbacks)`,
      challenge_vulnerability:   `"I tried to build [project] in a weekend — it took three and here's why" (honest about underestimating the work, relatable and funny)`,
      challenge_curiosity:       `"I only used hand tools for 30 days — here's what it forced me to learn" (counter-intuitive constraint leads to a surprising takeaway)`,
      list_transformation:       `"6 tools that actually changed how I build things — ranked by impact" (before→after framing, which tools leveled you up and why)`,
      list_fear_avoidance:       `"7 beginner building mistakes I made so you don't have to — with real cost estimates" (use ${num1} as a concrete figure in at least one mistake)`,
      list_aspiration:           `"The 5 projects I'm building this year — and the order I'm tackling them in" (roadmap-style, specific and documentable)`,
      list_vulnerability:        `"5 projects I started and didn't finish — and what finally got me to complete them" (honest about the gap between ambition and follow-through)`,
      list_curiosity:            `"The 4 tools most builders say are essential that I actually never use — and what I use instead" (debunk common wisdom with your experience)`,
      story_transformation:      `"The project that made me take building seriously — here's how it started and where it led" (origin story of your craft, one pivotal project)`,
      story_fear_avoidance:      `"I cut the wrong piece and set my project back two weeks — here's the mistake and how I fixed it" (specific mistake story, practical and relatable)`,
      story_aspiration:          `"I've wanted this workshop setup for 3 years — here's the day I finally started building it" (dream→action story, document the beginning)`,
      story_vulnerability:       `"I almost gave up on this project halfway through — here's what that moment looked and felt like" (raw honesty about the low point, powerful for builders)`,
      story_curiosity:           `"I built the same project twice — one cheap, one expensive — here's which one actually held up" (A/B experiment story with a real result)`,
      essay_transformation:      `"Building things with my hands changed how I think — here's what I didn't expect it to teach me" (broader life lesson through the lens of craft)`,
      essay_fear_avoidance:      `"Stop buying tools in this order — here's the sequence I wish I'd followed from the beginning" (direct advice, actionable, from your experience)`,
      essay_aspiration:          `"Here's what I want my shop to look like in two years — and the plan I'm working from" (vision piece, specific and documentable)`,
      essay_vulnerability:       `"I'm not a professional builder — and I think that actually makes my content more useful. Here's why." (defend the amateur perspective, turn it into a strength)`,
      essay_curiosity:           `"Most people overbuy for their first shop — here's the minimal setup that actually lets you build anything" (counter-intuitive take, specific and opinionated)`,
    },
  };

  const key = `${format}_${dominantEmotion}`;
  return combos[pillar][key] || combos[pillar][`essay_curiosity`];
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
