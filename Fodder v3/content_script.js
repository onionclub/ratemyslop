(() => {
"use strict";

const SCORING_CONFIG = { K: 10, APPROVAL_FLOOR: 0.92, APPROVAL_CEILING: 0.98, VELOCITY_REF: 50 };
const WEIGHTS = { DNA: 0.45, VEL: 0.25, INT: 0.20, VOL: 0.10 };
const UI_CONFIG = { 
  PILL_ID: "fodder-pill", 
  BENTO_ID: "fodder-bento-portal", 
  DEBOUNCE_MS: 400, 
  CONTAINERS: "yt-lockup-view-model, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer, ytd-rich-grid-media" 
};

const TIER_MAP = {
  organic: { verdict: "Certified Fresh", detail: "High signal, pure content." },
  filler: { verdict: "Edible", detail: "Processed, caloric but empty." },
  synthetic: { verdict: "Bio-Hazard", detail: "Do not consume." }
};

const getIconUrl = (tier) => {
  const isDark = document.documentElement.hasAttribute('dark');
  const suffix = isDark ? '' : '_light';
  return chrome.runtime.getURL(`icon_${tier}${suffix}.png`);
};

const activePills = new Map();

function checkTheme() {
  const isDark = document.documentElement.hasAttribute('dark');
  document.body.classList.toggle('fodder-light-theme', !isDark);
}

function computeScore(data) {
  const { likes: L = 0, dislikes: D = 0, viewCount: V = 0, subscribers: S = 1 } = data;
  const A = Math.min(Math.max((((L+1)/(L+D+2)) - SCORING_CONFIG.APPROVAL_FLOOR) / (SCORING_CONFIG.APPROVAL_CEILING - SCORING_CONFIG.APPROVAL_FLOOR), 0), 1);
  const G = Math.min(Math.max((Math.log(1+(V/S)) / Math.log(1+SCORING_CONFIG.VELOCITY_REF)), 0), 1);
  const I = Math.min(((L+D)/V) / 0.03, 1);
  const Vol = Math.min(Math.log(1+L)/10, 1);
  const finalScore = Math.round(Math.max(0, (A*45) + (G*25) + (I*20) + (Vol*10)) * 10) / 10;
  
  const analyzeImpact = (val, weight) => {
    if (val >= 0.95) return 'positive'; 
    const loss = (1 - val) * weight;
    return loss > 0.15 ? 'severe' : (loss > 0.08 ? 'moderate' : (loss > 0.03 ? 'light' : 'none'));
  };

  return { 
    score: finalScore, 
    tier: finalScore >= 70 ? "organic" : (finalScore >= 40 ? "filler" : "synthetic"),
    stats: { DNA: { val: A, glow: analyzeImpact(A, WEIGHTS.DNA) }, VEL: { val: G, glow: analyzeImpact(G, WEIGHTS.VEL) }, INT: { val: I, glow: analyzeImpact(I, WEIGHTS.INT) } }
  };
}

function renderBento(result, parent) {
  const existing = document.getElementById(UI_CONFIG.BENTO_ID);
  if (existing) existing.remove();

  const bento = document.createElement("div");
  bento.id = UI_CONFIG.BENTO_ID;
  bento.className = `fodder-reset tier-${result.tier}`;
  bento.style.cssText = `position:absolute; top:42px; left:0; z-index:2147483647; width:230px; overflow:hidden;`;

  const renderMetric = (label, data) => `<div class="fodder-metric glow-${data.glow}"><span class="label">${label}</span><span class="val">${(data.val * 100).toFixed(0)}%</span></div>`;

  bento.innerHTML = `
    <img class="fodder-watermark" src="${getIconUrl(result.tier)}">
    <div class="fodder-bento-header"><span class="fodder-brand">FODDER SYSTEM</span><span class="fodder-verdict">${TIER_MAP[result.tier].verdict}</span></div>
    <div class="fodder-score-main">${result.score}</div>
    <div class="fodder-metric-grid">${renderMetric('DNA', result.stats.DNA)}${renderMetric('VEL', result.stats.VEL)}${renderMetric('INT', result.stats.INT)}</div>
    <div class="fodder-bento-footer">${TIER_MAP[result.tier].detail}</div>
  `;
  parent.appendChild(bento);
}

async function analyzeMainVideo() {
  const vId = new URLSearchParams(window.location.search).get("v");
  if (!vId || activePills.has(vId)) return;
  const target = document.querySelector("h1.ytd-watch-metadata, #title h1, ytd-watch-metadata #title");
  if (!target) return;

  const existing = document.getElementById(UI_CONFIG.PILL_ID);
  if (existing) existing.remove();

  try {
    const ryd = await new Promise(res => chrome.runtime.sendMessage({ type: "FETCH_RYD", videoId: vId }, res));
    if (!ryd) return;
    const result = computeScore(ryd);
    
    const wrapper = document.createElement("div");
    wrapper.id = UI_CONFIG.PILL_ID;
    wrapper.className = `fodder-reset fodder-unified-dock tier-${result.tier}`;
    wrapper.style.position = "relative";
    wrapper.innerHTML = `<div class="fodder-icon-dock"><img src="${getIconUrl(result.tier)}"></div><div class="fodder-score-pill"><span class="fodder-score">${result.score}</span><span class="fodder-label">${result.tier.toUpperCase()}</span></div>`;
    wrapper.onmouseenter = () => renderBento(result, wrapper);
    wrapper.onmouseleave = () => { const b = document.getElementById(UI_CONFIG.BENTO_ID); if(b) b.remove(); };

    target.prepend(wrapper);
    activePills.set(vId, true);
    checkTheme();
  } catch (e) {}
}

async function processVideo(container) {
  const link = container.querySelector('a.yt-lockup-view-model__content-image, a#thumbnail, a.ytd-thumbnail, #video-title-link');
  if (!link) return;
  const vId = (link.getAttribute("href") || "").match(/[?&]v=([^&]+)/)?.[1];
  if (!vId || link.getAttribute("href").includes("list=") || container.dataset.processedId === vId) return;

  container.dataset.processedId = vId;
  try {
    const ryd = await new Promise(res => chrome.runtime.sendMessage({ type: "FETCH_RYD", videoId: vId }, res));
    const result = computeScore(ryd);
    const old = container.querySelector('.fodder-mini-badge');
    if (old) old.remove();

    const badge = document.createElement("div");
    badge.className = `fodder-mini-badge tier-${result.tier}`;
    badge.textContent = result.score;
    container.style.position = 'relative';
    container.appendChild(badge);
  } catch (e) {}
}

const themeObserver = new MutationObserver(checkTheme);
themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['dark'] });

const contentObserver = new MutationObserver(() => { document.querySelectorAll(UI_CONFIG.CONTAINERS).forEach(processVideo); });
window.addEventListener('yt-navigate-finish', () => { activePills.clear(); setTimeout(() => { analyzeMainVideo(); checkTheme(); }, 600); });
contentObserver.observe(document.body, { childList: true, subtree: true });
document.querySelectorAll(UI_CONFIG.CONTAINERS).forEach(processVideo);
if (location.pathname === "/watch") setTimeout(analyzeMainVideo, 800);
checkTheme();
})();