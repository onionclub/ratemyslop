// content_script.js — The Utility Filter v3.2
// Consistent scoring: both paths fetch subs from channel page

(() => {
  "use strict";

  // ═══════════════════════════════════════════
  //  TUNABLE CONFIG — All scoring constants in one place
  //  Adjust weights, thresholds, and scaling here.
  //  Weights (approval + velocity + integrity) must sum to 0.95
  //  Clickbait is subtractive (0.05 max penalty)
  // ═══════════════════════════════════════════

  const WEIGHTS = {
    approval: 0.45,      // Reduced to balance with volume
    velocity: 0.25,
    integrity: 0.15,
    volume: 0.10,        // NEW: Absolute engagement magnitude (favors high likes over high ratio)
    clickbait: 0.025,    // Halved from 0.05
  };

  const CONFIG = {
    // ── Bayesian Smoothing ──
    K: 10,                    // Prior sample weight
    MU: 0.5,                  // Prior mean

    // ── Approval Rescaling (real-world YouTube distribution) ──
    // YouTube like ratios: median ~96%, std concentrated 92–98%
    // Below 92%: bottom ~15% of all content, genuinely problematic
    // 92% = 0.0 | 95% = 0.5 | 98%+ = 1.0
    APPROVAL_FLOOR: 0.92,    // Below this → 0 approval credit
    APPROVAL_CEILING: 0.98,  // Above this → full approval credit

    // ── Velocity (V/S hidden gem detection) ──
    VELOCITY_REF: 50,        // V/S ratio that maps to 1.0

    // ── Integrity (engagement authenticity) ──
    INTEGRITY_TARGET: 0.03,  // 3% interaction rate = full credit

    // ── Volume Factor (absolute engagement magnitude) ──
    // Distinguishes 10,000 likes from 100 likes even at same ratio
    VOLUME_BREAKPOINT_LOW: 100,      // Below this: minimal volume credit
    VOLUME_BREAKPOINT_MID: 1000,     // Mid-tier engagement
    VOLUME_BREAKPOINT_HIGH: 10000,   // High engagement threshold
    VOLUME_DECAY_RATE: 0.3,          // Logarithmic scaling steepness

    // ── Engagement Velocity (recency × engagement rate) ──
    // Favors fresh, rapidly engaging content
    VELOCITY_DAYS_OPTIMAL: 7,        // Peak velocity window (1 week)
    VELOCITY_DAYS_PENALTY: 365,      // Old content decay threshold

    // ── Temporal Decay ──
    DECAY_RATE: 0.95,        // 5% annual decay

    // ── Anti-Bot Hard Floor ──
    SLOP_FLOOR_THRESHOLD: 0.001,  // 0.1% interaction = extremely suspicious
    SLOP_FLOOR_PENALTY: 0.5,
    SLOP_MIN_VIEWS: 5000,

    // ── Confidence Thresholds ──
    CONFIDENCE_FULL: 50,     // Veff >= 50 → full confidence
    CONFIDENCE_LOW: 5,       // Veff < 5 → low confidence (prior-dominant)

    // ── Tier Cutoffs ──
    TIER_GREEN: 70,
    TIER_YELLOW: 45,

    // ── Clickbait Detection ──
    CLICKBAIT_CAPS_THRESHOLD: 0.5,
    CLICKBAIT_EMOJI_THRESHOLD: 3,
    CLICKBAIT_WORDS: [
      "you won't believe", "insane", "shocking", "no way",
      "mind blown", "gone wrong", "not clickbait", "i tried",
      "challenge", "prank", "hack", "exposed", "destroyed",
      "impossible", "unbelievable", "secret", "they don't want you",
      "finally revealed", "truth about", "you need to see",
      "will shock you", "can't believe", "never expected",
    ],

    BADGE_ID: "uf-utility-badge",
    DESAT_CLASS: "uf-desaturated",
  };

  const processed = new Set();
  let currentVideoId = null;

  // ═══════════════════════════════════════════
  //  SCORING MODEL: Pareto Utility 4.0
  //
  //  COMPONENTS (0-1 normalized):
  //  1. Approval (A): Bayesian like ratio → rescaled to YouTube distribution
  //  2. Volume (V): Absolute engagement magnitude (log-scaled by likes count)
  //  3. Velocity (Γ): View/subscriber ratio + engagement velocity + recency bonus
  //  4. Integrity (I): Engagement rate ramp (catches bot views)
  //  5. Clickbait (C): Title heuristic (subtractive)
  //
  //  FORMULA:
  //  composite = W_a·A + W_v·V + W_γ·Γ + W_i·I - W_c·C
  //  score = composite × decay × 100
  //
  //  KEY IMPROVEMENTS:
  //  - Volume factor: 10,000 likes outweighs 100 likes even at same ratio
  //  - Engagement velocity: (likes+dislikes)/(views×days) favors rapid engagement
  //  - Recency bonus: Fresh content (<7 days) gets up to 20% boost
  //  - Clickbait weight halved: reduced from 0.05 to 0.025
  //
  //  No sigmoid — rescaled approval + volume provides natural spread.
  // ═══════════════════════════════════════════

  function computeScore({ likes, dislikes, viewCount, subscribers, daysOld, title }) {
    const L = likes;
    const D = dislikes;
    const V = viewCount;
    const S = Math.max(subscribers, 1);
    const Veff = L + D;

    // ── Component A: Approval (ratio quality) ──
    // Bayesian smoothed ratio
    const alpha = (L + 1) / (L + D + 2);
    const bayesian = (alpha * Veff + CONFIG.K * CONFIG.MU) / (Veff + CONFIG.K);

    // Rescale to real-world distribution
    const range = CONFIG.APPROVAL_CEILING - CONFIG.APPROVAL_FLOOR;
    const A = Math.min(Math.max((bayesian - CONFIG.APPROVAL_FLOOR) / range, 0), 1);

    // ── Component V: Volume (absolute engagement magnitude) ──
    // Logarithmic scaling: favors 10,000 likes over 100 likes even at same ratio
    // Uses likes specifically (not total votes) as primary signal of positive engagement
    const volumeRaw = Math.log(1 + L) / Math.log(1 + CONFIG.VOLUME_BREAKPOINT_HIGH);
    const volumeScore = Math.min(Math.max(volumeRaw, 0), 1.0);

    // ── Component Γ: Velocity (view/subscriber ratio + engagement velocity) ──
    const rawRatio = V / S;
    const gammaBase = Math.log(1 + rawRatio) / Math.log(1 + CONFIG.VELOCITY_REF);
    
    // Engagement velocity: (likes+dislikes) / (views × days_old)
    // Higher = rapid engagement on fresh content
    const ageInDays = Math.max(daysOld, 0.1); // Prevent division by zero
    const engagementVelocity = (Veff / V) / ageInDays;
    
    // Recency multiplier: peaks at 1 week, decays after
    const recencyBonus = daysOld <= CONFIG.VELOCITY_DAYS_OPTIMAL 
      ? 1.0 + (0.2 * (1 - daysOld / CONFIG.VELOCITY_DAYS_OPTIMAL)) // Up to 20% boost for very fresh
      : 1.0 / (1 + Math.log(1 + daysOld / CONFIG.VELOCITY_DAYS_PENALTY));
    
    const gamma = Math.min(Math.max(gammaBase * recencyBonus, 0), 1.0);

    // ── Component I: Integrity ──
    const interactionRate = V > 0 ? Veff / V : 0;
    const I = Math.min(interactionRate / CONFIG.INTEGRITY_TARGET, 1.0);

    // ── Component C: Clickbait ──
    const C = computeClickbait(title || "");

    // ── Composite (additive, no sigmoid) ──
    let composite = WEIGHTS.approval * A
                  + WEIGHTS.velocity * gamma
                  + WEIGHTS.integrity * I
                  + WEIGHTS.volume * volumeScore
                  - WEIGHTS.clickbait * C;
    composite = Math.min(Math.max(composite, 0), 1);

    // ── Temporal Decay ──
    const decay = Math.pow(CONFIG.DECAY_RATE, daysOld / 365);

    let score = composite * decay * 100;
    score = Math.min(100, Math.max(0, score));

    // ── Hard Floor: Extreme Slop ──
    let slopFlag = false;
    if (interactionRate < CONFIG.SLOP_FLOOR_THRESHOLD && V > CONFIG.SLOP_MIN_VIEWS) {
      score *= CONFIG.SLOP_FLOOR_PENALTY;
      slopFlag = true;
    }

    // ── Confidence Level ──
    let confidence;
    if (Veff >= CONFIG.CONFIDENCE_FULL) {
      confidence = "full";
    } else if (Veff >= CONFIG.CONFIDENCE_LOW) {
      confidence = "low_sample";
    } else {
      confidence = "low_confidence";
    }

    return {
      score: Math.round(score * 10) / 10,
      tier: score >= CONFIG.TIER_GREEN ? "green" : score >= CONFIG.TIER_YELLOW ? "yellow" : "red",
      slopFlag,
      confidence,
      clickbaitScore: C,
      interactionDensity: (interactionRate * 100).toFixed(2),
      raw: { 
        A, bayesian, gamma, I, C, 
        volumeScore, engagementVelocity, recencyBonus,
        composite, decay, ratio: rawRatio, Veff 
      },
    };
  }

  // ── Clickbait Heuristic (0 = clean, 1 = max clickbait) ──

  function computeClickbait(title) {
    if (!title) return 0;
    let signals = 0;
    const lower = title.toLowerCase();

    // ALL CAPS ratio
    const letters = title.replace(/[^a-zA-Z]/g, "");
    if (letters.length > 3) {
      const upperRatio = letters.replace(/[^A-Z]/g, "").length / letters.length;
      if (upperRatio > CONFIG.CLICKBAIT_CAPS_THRESHOLD) signals += 0.4;
    }

    // Keyword matches
    let keywordHits = 0;
    for (const word of CONFIG.CLICKBAIT_WORDS) {
      if (lower.includes(word)) keywordHits++;
    }
    signals += Math.min(keywordHits * 0.2, 0.4);

    // Emoji spam
    const emojiCount = (title.match(/[\u{1F600}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}]/gu) || []).length;
    if (emojiCount >= CONFIG.CLICKBAIT_EMOJI_THRESHOLD) signals += 0.2;

    return Math.min(signals, 1.0);
  }

  // ═══════════════════════════════════════════
  //  CHANNEL SUBSCRIBER FETCHING
  //  Both thumbnail + watch page → extract handle → background fetches
  // ═══════════════════════════════════════════

  function fetchChannelSubs(channelHandle) {
    return new Promise((resolve) => {
      if (!channelHandle) return resolve(0);
      chrome.runtime.sendMessage(
        { type: "FETCH_CHANNEL_SUBS", channelHandle },
        (response) => {
          if (chrome.runtime.lastError) return resolve(0);
          resolve(response?.subscribers || 0);
        }
      );
    });
  }

  function fetchRYD(videoId) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "FETCH_RYD", videoId }, (response) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (response?.error) return reject(new Error(response.error));
        resolve(response);
      });
    });
  }

  // ═══════════════════════════════════════════
  //  DOM SCRAPING — Shared Utilities
  // ═══════════════════════════════════════════

  function extractChannelHandle(container) {
    const links = container.querySelectorAll('a[href*="/@"], a[href*="/channel/"]');
    for (const link of links) {
      const href = link.getAttribute("href") || "";
      const handleMatch = href.match(/\/@([^/?]+)/);
      if (handleMatch) return `@${handleMatch[1]}`;
      const idMatch = href.match(/\/channel\/(UC[^/?]+)/);
      if (idMatch) return idMatch[1];
    }
    return null;
  }

  function parseDaysOld(text) {
    if (!text) return 0;
    const match = text.match(/(\d+)\s*(second|minute|hour|day|week|month|year)/i);
    if (!match) return 0;
    const num = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    const days = {
      second: 1 / 86400, minute: 1 / 1440, hour: 1 / 24,
      day: 1, week: 7, month: 30, year: 365,
    };
    return num * (days[unit] || 0);
  }

  function getVideoId() {
    return new URLSearchParams(window.location.search).get("v");
  }

  // ═══════════════════════════════════════════
  //  WATCH PAGE SCRAPING
  // ═══════════════════════════════════════════

  function scrapeWatchChannelHandle() {
    const handle = extractChannelHandle(
      document.querySelector("#owner") ||
      document.querySelector("ytd-video-owner-renderer") ||
      document.body
    );
    if (handle) return handle;
    const meta = document.querySelector('meta[itemprop="channelId"]');
    if (meta) return meta.getAttribute("content");
    return null;
  }

  function scrapeWatchDaysOld() {
    const infoEl = document.querySelector("#info-strings yt-formatted-string");
    if (infoEl) {
      const dateMatch = infoEl.textContent.match(
        /(?:premiered|streamed live|published)\s+(.+)/i
      );
      if (dateMatch) {
        const d = new Date(dateMatch[1]);
        if (!isNaN(d)) return Math.max(0, (Date.now() - d) / 86400000);
      }
      const days = parseDaysOld(infoEl.textContent);
      if (days > 0) return days;
    }
    const allInfo = document.querySelectorAll("#info-strings yt-formatted-string");
    for (const el of allInfo) {
      const days = parseDaysOld(el.textContent);
      if (days > 0) return days;
    }
    return 0;
  }

  function scrapeWatchTitle() {
    const el = document.querySelector(
      "h1.ytd-watch-metadata yt-formatted-string, h1.title yt-formatted-string"
    );
    return el?.textContent?.trim() || "";
  }

  // ═══════════════════════════════════════════
  //  THUMBNAIL SCRAPING
  // ═══════════════════════════════════════════

  function scrapeThumbnailChannelHandle(element) {
    return extractChannelHandle(element);
  }

  function scrapeThumbnailDaysOld(element) {
    const metaLine = element.querySelector("#metadata-line");
    if (metaLine) {
      const spans = metaLine.querySelectorAll("span");
      for (const span of spans) {
        const days = parseDaysOld(span.textContent);
        if (days > 0) return days;
      }
    }
    const allSpans = element.querySelectorAll("span, yt-formatted-string");
    for (const el of allSpans) {
      const text = el.textContent.trim();
      if (text.match(/\d+\s*(second|minute|hour|day|week|month|year)s?\s*ago/i)) {
        return parseDaysOld(text);
      }
    }
    return 0;
  }

  function scrapeThumbnailTitle(element) {
    const el = element.querySelector("#video-title");
    return el?.textContent?.trim() || el?.getAttribute("title") || "";
  }

  // ═══════════════════════════════════════════
  //  BADGE UI
  // ═══════════════════════════════════════════

  function getTierConfig(tier) {
    return {
      green: {
        icon: "◆", label: "Verified Utility",
        bg: "linear-gradient(135deg, #0d9a4e 0%, #06d66b 100%)",
        border: "#0d9a4e", glow: "0 0 14px rgba(6, 214, 107, 0.45)",
      },
      yellow: {
        icon: "●", label: "Standard",
        bg: "linear-gradient(135deg, #c28a09 0%, #e8b230 100%)",
        border: "#c28a09", glow: "0 0 14px rgba(232, 178, 48, 0.35)",
      },
      red: {
        icon: "▼", label: "Low Utility / Slop",
        bg: "linear-gradient(135deg, #b91c1c 0%, #ef4444 100%)",
        border: "#b91c1c", glow: "0 0 14px rgba(239, 68, 68, 0.45)",
      },
    }[tier];
  }

  function confidenceLabel(confidence) {
    if (confidence === "low_confidence") return "~ Low Confidence";
    if (confidence === "low_sample") return "~ Low Sample";
    return "";
  }

  function injectBadge(result) {
    const existing = document.getElementById(CONFIG.BADGE_ID);
    if (existing) existing.remove();
    document.querySelectorAll(`.${CONFIG.DESAT_CLASS}`)
      .forEach((el) => el.classList.remove(CONFIG.DESAT_CLASS));

    const tier = getTierConfig(result.tier);
    const confLabel = confidenceLabel(result.confidence);

    // Identify negative factors (contributing to low score)
    const negativeFactors = [];
    if (result.raw.A < 0.3) negativeFactors.push('Approval');
    if (result.raw.gamma < 0.3) negativeFactors.push('Velocity');
    if (result.raw.I < 0.3) negativeFactors.push('Integrity');
    if (result.raw.volumeScore < 0.3) negativeFactors.push('Volume');
    if (result.clickbaitScore > 0.3) negativeFactors.push('Clickbait');
    if (result.raw.decay < 0.7) negativeFactors.push('Decay');

    const highlightNegative = (label, value) => {
      return negativeFactors.some(f => label.includes(f)) 
        ? `<span style="color: #ef4444; font-weight: 600;">${label}: ${value}</span>`
        : `<div>${label}: ${value}</div>`;
    };

    const badge = document.createElement("div");
    badge.id = CONFIG.BADGE_ID;
    badge.innerHTML = `
      <div class="uf-badge-inner" style="
        background: ${tier.bg};
        border: 1px solid ${tier.border};
        box-shadow: ${tier.glow};
        ${result.confidence !== "full" ? "opacity: 0.75;" : ""}
      ">
        <span class="uf-badge-icon">${tier.icon}</span>
        <span class="uf-badge-score">${result.score}</span>
        <span class="uf-badge-label">${tier.label}</span>
        ${result.slopFlag ? '<span class="uf-slop-flag">⚠ Low Interaction</span>' : ""}
        ${result.clickbaitScore > 0.3 ? '<span class="uf-slop-flag">⚠ Clickbait</span>' : ""}
        ${confLabel ? `<span class="uf-slop-flag">${confLabel}</span>` : ""}
        <div class="uf-badge-details">
          ${highlightNegative('Approval', `${(result.raw.bayesian * 100).toFixed(1)}% → ${(result.raw.A * 100).toFixed(0)}%`)}
          ${highlightNegative('Velocity', `${result.raw.gamma.toFixed(3)} (V/S: ${result.raw.ratio.toFixed(2)})`)}
          ${highlightNegative('Integrity', `${(result.raw.I * 100).toFixed(1)}%`)}
          ${highlightNegative('Volume', `${(result.raw.volumeScore * 100).toFixed(0)}% (${result.raw.Veff} likes)`)}
          ${highlightNegative('Clickbait', `${(result.clickbaitScore * 100).toFixed(0)}%`)}
          ${highlightNegative('Decay', `${(result.raw.decay * 100).toFixed(1)}%`)}
          <div>Engagement Velocity: ${(result.raw.engagementVelocity * 100000).toFixed(2)}</div>
          <div>Recency Bonus: ${(result.raw.recencyBonus * 100).toFixed(0)}%</div>
          <div style="margin-top: 6px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,0.15);">
            Votes: ${result.raw.Veff} (${result.confidence})
          </div>
        </div>
      </div>
      <a class="uf-attribution" href="https://returnyoutubedislike.com" target="_blank" rel="noopener">
        Data via Return YouTube Dislike
      </a>
    `;

    const target =
      document.querySelector("#above-the-fold") ||
      document.querySelector("#info-contents") ||
      document.querySelector("#top-row");
    if (target) target.insertBefore(badge, target.firstChild);

    if (result.tier === "red") {
      const player = document.querySelector("#movie_player video");
      if (player) player.classList.add(CONFIG.DESAT_CLASS);
    }
  }

  function showLoading() {
    const existing = document.getElementById(CONFIG.BADGE_ID);
    if (existing) existing.remove();
    const badge = document.createElement("div");
    badge.id = CONFIG.BADGE_ID;
    badge.innerHTML = `
      <div class="uf-badge-inner uf-loading" style="
        background: linear-gradient(135deg, #374151 0%, #4b5563 100%);
        border: 1px solid #4b5563;
      ">
        <span class="uf-badge-icon uf-spin">⟳</span>
        <span class="uf-badge-label">Analyzing...</span>
      </div>
    `;
    const target = document.querySelector("#above-the-fold") || document.querySelector("#info-contents");
    if (target) target.insertBefore(badge, target.firstChild);
  }

  function showError(msg) {
    const existing = document.getElementById(CONFIG.BADGE_ID);
    if (existing) existing.remove();
    const badge = document.createElement("div");
    badge.id = CONFIG.BADGE_ID;
    badge.innerHTML = `
      <div class="uf-badge-inner" style="
        background: linear-gradient(135deg, #374151 0%, #4b5563 100%);
        border: 1px solid #4b5563;
      ">
        <span class="uf-badge-icon">✕</span>
        <span class="uf-badge-label">${msg}</span>
      </div>
    `;
    const target = document.querySelector("#above-the-fold") || document.querySelector("#info-contents");
    if (target) target.insertBefore(badge, target.firstChild);
  }

  // ═══════════════════════════════════════════
  //  UNIFIED SCORING PIPELINE
  //  Both watch page and thumbnails use identical path:
  //  channelHandle → background fetches real subs → same score
  // ═══════════════════════════════════════════

  async function scoreVideo({ videoId, channelHandle, daysOld, title }) {
    const [ryd, subs] = await Promise.all([
      fetchRYD(videoId),
      fetchChannelSubs(channelHandle),
    ]);

    return computeScore({
      likes: ryd.likes,
      dislikes: ryd.dislikes,
      viewCount: ryd.viewCount,
      subscribers: subs,
      daysOld,
      title,
    });
  }

  // ─── Watch Page ───

  async function analyzeCurrentVideo() {
    const videoId = getVideoId();
    if (!videoId) return;
    if (videoId === currentVideoId) return;

    currentVideoId = videoId;
    showLoading();
    await sleep(1500);

    try {
      const channelHandle = scrapeWatchChannelHandle();
      const daysOld = scrapeWatchDaysOld();
      const title = scrapeWatchTitle();

      const result = await scoreVideo({ videoId, channelHandle, daysOld, title });
      injectBadge(result);

      console.log("[Utility Filter]", { videoId, channelHandle, daysOld, title, result });
    } catch (err) {
      console.error("[Utility Filter] Error:", err);
      showError("Score unavailable");
    }
  }

  // ─── Thumbnails ───

  function processVideoThumbnails() {
    const thumbnails = document.querySelectorAll(
      "ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer"
    );

    thumbnails.forEach((thumb) => {
      const link = thumb.querySelector("a#thumbnail");
      if (!link) return;
      const href = link.getAttribute("href");
      if (!href) return;
      const match = href.match(/[?&]v=([^&]+)/);
      if (!match) return;

      const videoId = match[1];
      if (processed.has(`thumb-${videoId}`)) return;
      processed.add(`thumb-${videoId}`);

      scoreThumbnail(videoId, thumb);
    });
  }

  async function scoreThumbnail(videoId, element) {
    try {
      const channelHandle = scrapeThumbnailChannelHandle(element);
      const daysOld = scrapeThumbnailDaysOld(element);
      const title = scrapeThumbnailTitle(element);

      const result = await scoreVideo({ videoId, channelHandle, daysOld, title });

      const miniBadge = document.createElement("div");
      miniBadge.className = `uf-mini-badge uf-tier-${result.tier}`;
      miniBadge.textContent = result.score.toFixed(0);
      miniBadge.title = `Utility: ${result.score} — ${getTierConfig(result.tier).label}`;

      // Dim mini-badge if low confidence
      if (result.confidence !== "full") {
        miniBadge.style.opacity = "0.7";
        miniBadge.textContent = `~${result.score.toFixed(0)}`;
      }

      const thumbContainer = element.querySelector("#thumbnail");
      if (thumbContainer) {
        thumbContainer.style.position = "relative";
        const existingMini = thumbContainer.querySelector(".uf-mini-badge");
        if (existingMini) existingMini.remove();
        thumbContainer.appendChild(miniBadge);
      }

      if (result.tier === "red") {
        const img = element.querySelector("img");
        if (img) img.classList.add(CONFIG.DESAT_CLASS);
      }
    } catch (e) {
      // Silent fail
    }
  }

  // ─── Utilities ───

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ─── Init ───

  function init() {
    if (window.location.pathname === "/watch") analyzeCurrentVideo();
    processVideoThumbnails();

    const observer = new MutationObserver((mutations) => {
      const newVideoId = getVideoId();
      if (window.location.pathname === "/watch" && newVideoId !== currentVideoId) {
        analyzeCurrentVideo();
      }
      if (mutations.some((m) => m.addedNodes.length > 0)) {
        processVideoThumbnails();
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    window.addEventListener("yt-navigate-finish", () => {
      currentVideoId = null;
      if (window.location.pathname === "/watch") analyzeCurrentVideo();
      processVideoThumbnails();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
