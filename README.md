# FODDER:
## The Utility Filter

**A Chrome extension that scores YouTube videos 0-100 to surface expert content and filter AI slop.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Chrome Web Store](https://img.shields.io/badge/Chrome-Extension-blue.svg)](https://chrome.google.com/)
[![Version](https://img.shields.io/badge/version-4.0.0-green.svg)](https://github.com/yourusername/utility-filter)

<p align="center">
  <img src="https://via.placeholder.com/800x400/1a1a2e/ffffff?text=The+Utility+Filter" alt="The Utility Filter Banner" />
</p>

---

## 🎯 What It Does

The Utility Filter assigns every YouTube video a **Utility Score (0-100)** based on:
- **Approval quality** (Bayesian like/dislike ratio calibrated to YouTube's real distribution)
- **Absolute engagement volume** (10k likes >> 100 likes, even at same ratio)
- **Velocity dynamics** (view/subscriber ratio + engagement rate per day)
- **Content integrity** (interaction density catches bot views)
- **Recency bonus** (fresh content <7 days gets up to 20% boost)
- **Clickbait penalty** (minimal 2.5% max impact)

**Tier System:**
- 🟢 **Green (70-100):** Verified Utility — Expert-led, high-engagement content
- 🟡 **Yellow (45-69):** Standard Quality
- 🔴 **Red (<45):** Low Utility / AI Slop — Thumbnail desaturated, flags displayed

---

## 🚀 Quick Start

### Installation

1. **Download this repository:**
   ```bash
   git clone https://github.com/yourusername/utility-filter.git
   cd utility-filter
   ```

2. **Load in Chrome:**
   - Navigate to `chrome://extensions/`
   - Enable **Developer Mode** (top right)
   - Click **Load unpacked**
   - Select the `utility-filter` directory

3. **Visit YouTube** — scores appear automatically on watch pages and thumbnails

### Requirements

- Chrome/Edge/Brave (Manifest V3 compatible)
- No API keys needed (uses public RYD API)

---

## 📊 Features

### Watch Page Display
- **Large badge** with score, tier icon, and confidence level
- **Hover tooltip** showing all component breakdowns
- **Negative factors highlighted in red** (instantly see what's dragging score down)
- **Red tier desaturation** of video player for low-utility content

### Thumbnail Overlays
- **Mini-badges** on every video thumbnail in feeds/search/recommendations
- **Consistent scoring** — thumbnail and watch page scores match exactly
- **Confidence indicators** (`~` prefix for low sample size)

### Smart Caching
- **RYD data:** 1 hour in-memory cache (500 entry max)
- **Channel subscribers:** 24 hour localStorage cache
- **Efficient:** One fetch per unique channel, automatic pruning

### SPA Navigation
- **MutationObserver** detects new thumbnails and video changes
- **yt-navigate-finish** event handling for YouTube's SPA routing
- **Zero page reloads** required

---

## 🧮 Scoring Formula

### Core Equation
```javascript
composite = 0.45·A + 0.25·Γ + 0.15·I + 0.10·V - 0.025·C
score = composite × decay × 100
```

### Components (0-1 normalized)

#### A — Approval (45% weight)
```javascript
// Bayesian smoothed like ratio
α = (L + 1) / (L + D + 2)
bayesian = (α·Veff + K·μ) / (Veff + K)

// Rescaled to YouTube's 92-98% distribution
A = clamp((bayesian - 0.92) / (0.98 - 0.92), 0, 1)
```
- **92%** → 0.0 (bottom ~15% of content)
- **95%** → 0.5 (median good content)
- **98%+** → 1.0 (top 10-15%)

#### V — Volume (10% weight)
```javascript
// Logarithmic scaling by absolute like count
V = log(1 + likes) / log(1 + 10000)
```
- **100 likes** → ~40% volume credit
- **1,000 likes** → ~75%
- **10,000+ likes** → ~100%

**Impact:** Videos with 15k likes at 95% ratio now outrank 100 likes at 99% ratio

#### Γ — Velocity (25% weight)
```javascript
// Base: view/subscriber ratio
gammaBase = log(1 + V/S) / log(1 + 50)

// Engagement velocity: interaction density per day
engagementVel = (Veff / V) / daysOld

// Recency multiplier
recencyBonus = daysOld ≤ 7 
  ? 1.0 + (0.2 × (1 - daysOld/7))      // +20% boost
  : 1.0 / (1 + log(1 + daysOld/365))   // Decay

Γ = gammaBase × recencyBonus
```
- Favors breakout videos (high V/S)
- Penalizes subscriber churn (mega channels, low views)
- Fresh content (<7 days) gets significant boost

#### I — Integrity (15% weight)
```javascript
// Linear ramp to 3% interaction target
I = min((L + D) / V / 0.03, 1.0)
```
- Catches bot views, passive slop, inflated view counts
- Hard floor at 0.1% for extreme cases (×0.5 penalty)

#### C — Clickbait (2.5% weight, subtractive)
```javascript
signals = 0
if (CAPS_RATIO > 50%) signals += 0.4
signals += min(KEYWORD_MATCHES × 0.2, 0.4)
if (EMOJI_COUNT ≥ 3) signals += 0.2
C = clamp(signals, 0, 1)
```
- Max penalty: **-2.5 points** (halved from v3.2)
- Keywords: "you won't believe", "insane", "shocking", "exposed", etc.

#### Temporal Decay
```javascript
decay = 0.95^(daysOld / 365)
```
- 5% annual decay
- Lighter than typical (velocity/integrity already penalize stale content)

---

## 🔧 Configuration

All tunable constants in `content_script.js`:

```javascript
const WEIGHTS = {
  approval: 0.45,
  velocity: 0.25,
  integrity: 0.15,
  volume: 0.10,
  clickbait: 0.025,
};

const CONFIG = {
  // Approval rescaling
  APPROVAL_FLOOR: 0.92,
  APPROVAL_CEILING: 0.98,
  
  // Volume breakpoints
  VOLUME_BREAKPOINT_HIGH: 10000,
  
  // Velocity parameters
  VELOCITY_REF: 50,
  VELOCITY_DAYS_OPTIMAL: 7,
  VELOCITY_DAYS_PENALTY: 365,
  
  // Integrity
  INTEGRITY_TARGET: 0.03,
  
  // Tier thresholds
  TIER_GREEN: 70,
  TIER_YELLOW: 45,
};
```

### Customization Examples

**Favor viral content:**
```javascript
WEIGHTS.velocity = 0.35;
WEIGHTS.approval = 0.35;
```

**Strict quality filter:**
```javascript
CONFIG.TIER_GREEN = 80;
CONFIG.TIER_YELLOW = 60;
```

**Penalize older content more:**
```javascript
CONFIG.DECAY_RATE = 0.90; // 10% annual decay
```

---

## 📁 Architecture

```
utility-filter/
├── manifest.json          # Manifest V3 config
├── background.js          # Service worker (RYD API + channel fetching)
├── content_script.js      # Scoring engine + DOM injection
├── styles.css             # Badge UI + desaturation
├── icon48.png             # Extension icon (48x48)
├── icon128.png            # Extension icon (128x128)
└── README.md
```

### Data Flow

```
YouTube DOM
    ↓
Extract: videoId, channelHandle, daysOld, title
    ↓
background.js ←─ RYD API (likes, dislikes, views)
              └─ Channel page (subscribers)
    ↓
content_script.js → computeScore()
    ↓
Inject badge + mini-badges
```

### API Integrations

**Return YouTube Dislike (RYD):**
- Endpoint: `returnyoutubedislikeapi.com/Votes?videoId={id}`
- Cache: 1 hour in-memory (500 entry max)
- Rate limit: 10k requests/day
- Attribution: Link in badge footer

**Channel Subscriber Fetching:**
- Fetches `youtube.com/@{handle}` HTML
- Parses `ytInitialData` JSON blob for subscriber count
- Cache: 24 hours in `chrome.storage.local`
- Fallback: Multiple selector patterns

---

## 🧪 Testing & Validation

### Test Case: High Volume vs. High Ratio

**Video A (New Model Favored):**
- 15,000 likes, 200 dislikes (98.7% ratio)
- 500k views, 3 days old
- **v3.2 Score:** ~72
- **v4.0 Score:** ~85 (+13 from volume + recency)

**Video B (Old Model Favored):**
- 150 likes, 1 dislike (99.3% ratio)
- 5k views, 2 years old
- **v3.2 Score:** ~68
- **v4.0 Score:** ~58 (-10 from low volume + age)

### Test Case: Subscriber Churn Detection

**Mega Channel (2M subs, lazy content):**
- 100k views (V/S = 0.05)
- 3k likes, 1 week old
- **Velocity:** 0.24 (weak)
- **Volume:** 0.82 (decent)
- **Score:** ~55 (yellow tier)

**Small Breakout (5k subs):**
- 50k views (V/S = 10)
- 2k likes, 2 days old
- **Velocity:** 0.92 (strong + recency)
- **Volume:** 0.78
- **Score:** ~82 (green tier)

See `CHANGELOG_v4.0.md` for comprehensive statistical analysis.

---

## 🛠️ Development

### Project Structure

- **Manifest V3** service worker architecture
- **No jQuery** — Pure vanilla JS
- **No external dependencies** — Self-contained
- **Defensive selectors** — Multiple fallbacks for YouTube's shifting DOM

### Adding New Metrics

1. Define constant in `CONFIG` object
2. Add component calculation in `computeScore()`
3. Update `WEIGHTS` (must sum to 0.975, clickbait = 0.025)
4. Add to `result.raw` object for tooltip display
5. Update tooltip HTML in `injectBadge()`

### DOM Selector Maintenance

YouTube changes selectors frequently. Priority update targets:

```javascript
// Watch page (most stable)
extractChannelHandle() // '@handle' or 'UC...' from links
scrapeWatchDaysOld()   // Relative date parsing
scrapeWatchTitle()     // h1.ytd-watch-metadata

// Thumbnails (more fragile)
scrapeThumbnailChannelHandle() // a[href*="/@"]
scrapeThumbnailDaysOld()       // #metadata-line span
```

### Performance Profiling

```javascript
console.time('score');
const result = await scoreVideo({ ... });
console.timeEnd('score'); // Typically <50ms
```

---

## 📈 Roadmap

### v4.1 (Planned)
- [ ] Settings UI with weight sliders
- [ ] Export/import configuration profiles
- [ ] A/B testing mode (compare v3.2 vs v4.0 side-by-side)

### v4.2 (Future)
- [ ] Category-aware decay (news/tech heavier, tutorials lighter)
- [ ] Engagement momentum (like-rate acceleration)
- [ ] Viral coefficient: `(Veff/S) × (V/S)` composite
- [ ] Machine learning calibration on user feedback

### v5.0 (Long-term)
- [ ] Firefox extension
- [ ] Cross-platform support (Twitch, TikTok)
- [ ] API for external integrations
- [ ] Browser action popup with stats dashboard

---

## 🐛 Known Issues

1. **YouTube DOM shifts** — Selectors may need updates after YouTube redesigns
2. **RYD data estimated** — Dislike counts extrapolated from extension userbase
3. **No offline mode** — Requires network for API calls (no cached scoring)
4. **English-only clickbait** — Keyword list not internationalized

### Reporting Bugs

Please include:
- Chrome version
- Extension version
- Video URL exhibiting issue
- Console errors (F12 → Console)
- Expected vs actual behavior

---

## 🤝 Contributing

Contributions welcome! Areas of interest:

- **Selector updates** for YouTube DOM changes
- **Statistical improvements** to scoring formula
- **UI/UX enhancements** to badge design
- **Internationalization** of clickbait keywords
- **Performance optimization** for low-end devices

### Development Setup

```bash
git clone https://github.com/yourusername/utility-filter.git
cd utility-filter

# Make changes to .js/.css files

# Load unpacked in chrome://extensions
# Test on various YouTube pages
# Submit PR with test cases
```

---

## 📄 License

MIT License — See [LICENSE](LICENSE) for details.

**Attribution Required:**
- Return YouTube Dislike API (link in badge footer)
- If forking, credit original project

---

## 🙏 Acknowledgments

- **Return YouTube Dislike** team for API access
- **YouTube** for not encrypting engagement metrics (yet)
- **Users** fighting content pollution with data

---

## 📞 Support

- **Issues:** [GitHub Issues](https://github.com/yourusername/utility-filter/issues)
- **Discussions:** [GitHub Discussions](https://github.com/yourusername/utility-filter/discussions)
- **Email:** your.email@example.com

---

<p align="center">
  <strong>Built for researchers, educators, and anyone tired of AI slop.</strong><br>
  If this extension saves you time, consider starring ⭐ the repo.
</p>

