# Google Ads Cleanup Scripts — Unblock Converted Keywords & Automated Placement Exclusions

**Free open-source Google Ads Scripts that (1) find & remove negative keywords blocking your converting search terms and (2) automatically exclude brand-misaligned placements across Display, YouTube, and Performance Max — with weekly automation built in.**

![Blocked Search Term Recovery Script](images/recovery-script-header.png)

Built by [John Williams](https://www.linkedin.com/in/johnwilliamsseo/) — founder of [AHMEEGO™](https://ahmeego.com) and [It All Started With A Idea LLC](https://itallstartedwithaidea.com), creator of [Buddy, the Google Ads AI agent](https://googleadsagent.ai), with 15+ years running paid media at major agencies and $350M+ in managed ad spend.

---

## What's Included

| Script | Level | What It Does |
|---|---|---|
| [`blocked_search_term_recovery.js`](scripts/blocked_search_term_recovery.js) | Single account (CID) | **Flagship.** Audits every negative against your search term history and removes negatives blocking terms with conversion history. Sees PMax campaign negatives via GAQL. |
| [`negative_placement_guardian.js`](scripts/negative_placement_guardian.js) | Single account (CID), weekly | **Placement hygiene on autopilot.** Excludes kids' apps, mobile games, junk inventory, and zero-converting placements across Display, Video & PMax. Ships tuned for a beauty brand — [retune for any vertical in minutes](../../wiki/Customizing-For-Your-Vertical). |
| [`cid_negative_conflict_cleaner.js`](scripts/cid_negative_conflict_cleaner.js) | Single account (CID) | Finds negatives literally blocking your positive keywords across all four levels, and removes them. |
| [`mcc_negative_conflict_cleaner.js`](scripts/mcc_negative_conflict_cleaner.js) | MCC / Manager | The conflict cleaner, parallelized across up to 50 client accounts per run. |

## The Problems These Solve

**Negatives blocking your converters.** Keywords match queries loosely (close variants); negatives match literally. A negative like `"mens facial nyc"` can block a converting query without ever conflicting with any keyword text — invisible to every standard conflict checker, including Google's own script. The recovery script audits negatives against **actual search term performance** instead.

**Display & PMax placement bleed.** By default your ads serve on kids' games, junk apps, and made-for-advertising sites. For consumer brands, mobile games alone commonly eat 30–60% of Display spend via accidental taps. The Placement Guardian excludes by pattern (instantly) and by performance (zero-converting spend, accidental-click CTR anomalies) — correctly routing exclusions to **campaign level** for Display/Video and **account level** for PMax, the only level PMax respects.

## Quick Start (2 minutes)

1. Google Ads → **Tools & Settings → Bulk Actions → Scripts** → **+**
2. Paste a script, authorize, add a blank Google Sheet URL to `CONFIG.SPREADSHEET_URL`
3. `DRY_RUN: true` → Preview → review the report → flip to `false` → Run
4. Schedule the Placement Guardian **weekly**; it's incremental and skips existing exclusions

Full docs, config references, vertical customization (with a ready-made Claude prompt), and troubleshooting in the **[Wiki →](../../wiki)**

![Negative Keyword Conflict Cleaner](images/conflict-cleaner-header.png)

## Key Features

- **Performance Max coverage** — campaign negatives and placements handled via GAQL, which sees PMax campaigns that entity iterators cannot
- **Account-level negatives done right** — queries the `ACCOUNT_LEVEL_NEGATIVE_KEYWORDS` shared set via `shared_criterion` (not `customer_negative_criterion.keyword`, which throws `QueryError.UNRECOGNIZED_FIELD`)
- **True negative match simulation** — exact/phrase/broad, literal, no close variants, exactly how Google applies negatives
- **Vertical-adaptable placement blocklist** — editable pattern + allowlist arrays, with an [AI-assisted customization workflow](../../wiki/Customizing-For-Your-Vertical)
- **Weekly-safe automation** — incremental runs, per-run safety caps, dry-run mode, full Google Sheets audit trail on every action

## Related Projects from AHMEEGO™

- **[Buddy — Google Ads AI Agent](https://googleadsagent.ai)** — AI agent for Google Ads on web, iOS & Android
- **[google-ads-mcp](https://github.com/itallstartedwithaidea)** — MCP server for Google Ads
- **Free Google Ads Auditor** at [ahmeego.com](https://ahmeego.com)
- **r/ppc_** — our PPC community on Reddit: [reddit.com/r/ppc_](https://www.reddit.com/r/ppc_/)

## Keywords / Topics

`google-ads-script` · `negative-keywords` · `negative-keyword-conflicts` · `blocked-search-terms` · `unblock-converted-keywords` · `placement-exclusions` · `negative-placements` · `brand-safety` · `display-network` · `google-ads-automation` · `ppc` · `sem` · `performance-max` · `gaql` · `mcc-script` · `paid-search` · `ahmeego` · `buddy-google-ads` · `itallstartedwithaidea`

## About

**It All Started With A Idea LLC (AHMEEGO™)**
Performance marketing studio & AI advertising tools — Queen Creek, Arizona, United States
[itallstartedwithaidea.com](https://itallstartedwithaidea.com) · [ahmeego.com](https://ahmeego.com) · [googleadsagent.ai](https://googleadsagent.ai) · [LinkedIn](https://www.linkedin.com/in/johnwilliamsseo/) · [r/ppc_](https://www.reddit.com/r/ppc_/)

## License

MIT — free for personal, client, and agency use. Attribution appreciated: link back to this repo or [ahmeego.com](https://ahmeego.com).

---

*Built with ☕ and 4:30 AM discipline in Queen Creek, Arizona. If these scripts recovered conversions or killed placement waste for you, star the repo and share it in [r/ppc_](https://www.reddit.com/r/ppc_/).*
