/**
 * NEGATIVE PLACEMENT GUARDIAN — BEAUTY BRAND EDITION (CID LEVEL)
 * --------------------------------------------------------------
 * Automated weekly placement hygiene for Display, Video, and
 * Performance Max campaigns. Built for a premium beauty / facial
 * brand targeting women 25–55: excludes kids' content, gaming apps,
 * and junk inventory on sight, plus any placement that spends
 * without converting.
 *
 * TWO DETECTION LAYERS
 *   1. PATTERN BLOCKLIST — regex against placement URL / app name /
 *      channel title. Excludes immediately, no performance data needed.
 *      (Kids content, gaming, junk inventory. Fully editable below.)
 *   2. PERFORMANCE RULES (Display & Video only) —
 *        a) spend >= MIN_SPEND_NO_CONVERSIONS with 0 conversions
 *           over the lookback window
 *        b) accidental-click detector: clicks >= MIN_CLICKS_FOR_CTR_RULE
 *           and CTR >= CTR_ANOMALY — nobody is that excited about a
 *           facial ad inside a mobile game
 *
 * WHERE EXCLUSIONS LAND (this matters)
 *   - DISPLAY / VIDEO: campaign-level negative placement criteria,
 *     applied only to the campaign where the placement served.
 *   - PERFORMANCE MAX: PMax ignores campaign-level placement
 *     exclusions — only ACCOUNT-LEVEL exclusions apply, created in
 *     customer_negative_criterion. Pattern layer only, because
 *     Google exposes PMax placements with impressions but no cost
 *     or conversion data (performance_max_placement_view limitation).
 *
 * SETUP
 *   1. Paste a blank Google Sheet URL below.
 *   2. Run once today for the initial cleanup.
 *   3. Schedule WEEKLY in the Scripts interface. Each run only
 *      processes what's new — existing exclusions are skipped.
 */

// ============================== CONFIG ==============================

var CONFIG = {
  // true = report only. false = create exclusions.
  DRY_RUN: false,

  // Blank Google Sheet URL for the exclusion log. Leave '' for Logger only.
  SPREADSHEET_URL: '',

  // Performance lookback for Display/Video placement stats.
  LOOKBACK_DAYS: 90,

  // ---- Layer 2 thresholds (Display & Video only) ----
  MIN_SPEND_NO_CONVERSIONS: 10.00, // $ spent with zero conversions -> exclude
  MIN_CLICKS_FOR_CTR_RULE: 10,     // minimum clicks before CTR rule applies
  CTR_ANOMALY: 0.05,               // 5%+ CTR on display = accidental-click farm

  // Safety cap per run so a bad pattern can't nuke thousands of rows blind.
  MAX_EXCLUSIONS_PER_RUN: 500,

  // Skip YouTube channels with this many subscribers' worth of legitimacy?
  // (Not available via API — left as a note. Review the log weekly instead.)

  // ---- Layer 1: PATTERN BLOCKLIST (edit freely) ----
  // Case-insensitive regex, tested against placement URL, app name,
  // channel/video title, and display name.
  BLOCK_PATTERNS: [
    // Kids & family content — wrong audience entirely
    'kid', 'child', 'toddler', 'baby', 'cartoon', 'coloring', 'colouring',
    'nursery', 'preschool', 'kindergarten', 'toy', 'toys', 'peppa',
    'paw patrol', 'cocomelon', 'bluey', 'disney junior', 'nick jr',
    'fairy tale', 'bedtime stor',

    // Gaming — the #1 display budget leak for beauty brands
    'game', 'gaming', 'gamer', 'minecraft', 'roblox', 'fortnite',
    'puzzle', 'solitaire', 'sudoku', 'crossword', 'match 3', 'match3',
    'slots', 'casino', 'poker', 'bingo', 'arcade', 'simulator',
    'racing', 'shooter', 'idle ', 'clicker', 'tycoon', 'runner',

    // Junk / MFA-style inventory signals
    'free coins', 'free gems', 'cheat', 'hack', 'mod apk', 'apk ',
    'wallpaper', 'ringtone', 'screensaver', 'horoscope', 'lucky',
    'prank', 'fake call', 'flashlight',

    // Misaligned verticals for a facial/skincare brand
    'anime', 'manga', 'wrestling', 'airsoft', 'hunting', 'fishing app'
  ],

  // Placements matching these are NEVER excluded, even if a pattern hits.
  // Protect your own properties and known-good partners here.
  ALLOWLIST: [
    'silvermirror', 'youtube.com/@silvermirror'
  ]
};

// ====================================================================

function main() {
  var account = AdsApp.currentAccount();
  var cid = account.getCustomerId().replace(/-/g, '');
  var tz = account.getTimeZone();
  var dr = buildDateRange(CONFIG.LOOKBACK_DAYS, tz);

  var blockRegexes = CONFIG.BLOCK_PATTERNS.map(function (p) {
    return new RegExp(p, 'i');
  });
  var allowRegexes = CONFIG.ALLOWLIST.map(function (p) {
    return new RegExp(p, 'i');
  });

  var actions = [];
  var exclusionCount = 0;

  // Existing exclusions -> skip set (so weekly runs are incremental)
  var already = loadExistingExclusions();
  Logger.log('Loaded ' + Object.keys(already).length + ' existing exclusions to skip.');

  // ================= DISPLAY & VIDEO (campaign-level) =================
  var dvQuery =
    'SELECT detail_placement_view.placement, ' +
    'detail_placement_view.display_name, ' +
    'detail_placement_view.placement_type, ' +
    'detail_placement_view.group_placement_target_url, ' +
    'campaign.id, campaign.name, campaign.advertising_channel_type, ' +
    'metrics.impressions, metrics.clicks, metrics.cost_micros, ' +
    'metrics.conversions ' +
    'FROM detail_placement_view ' +
    "WHERE campaign.advertising_channel_type IN ('DISPLAY', 'VIDEO') " +
    "AND campaign.status = 'ENABLED' " +
    "AND segments.date BETWEEN '" + dr.start + "' AND '" + dr.end + "' " +
    'AND metrics.impressions > 0';

  var dvRows = AdsApp.search(dvQuery);
  while (dvRows.hasNext()) {
    if (exclusionCount >= CONFIG.MAX_EXCLUSIONS_PER_RUN) break;
    var r = dvRows.next();
    var pv = r.detailPlacementView;
    var placement = String(pv.placement || '');
    var name = String(pv.displayName || '');
    var url = String(pv.groupPlacementTargetUrl || '');
    var ptype = String(pv.placementType || '');
    var campaignId = String(r.campaign.id);
    var campaignName = r.campaign.name;
    var spend = Number(r.metrics.costMicros || 0) / 1e6;
    var clicks = Number(r.metrics.clicks || 0);
    var imps = Number(r.metrics.impressions || 0);
    var conv = Number(r.metrics.conversions || 0);
    var ctr = imps > 0 ? clicks / imps : 0;

    var haystack = (placement + ' ' + name + ' ' + url);
    if (matchesAny(allowRegexes, haystack)) continue;

    var key = campaignId + '|' + ptype + '|' + normalizePlacementKey(placement, url, ptype);
    if (already[key]) continue;

    // Layer 1: pattern
    var reason = '';
    var hit = firstMatch(blockRegexes, CONFIG.BLOCK_PATTERNS, haystack);
    if (hit) {
      reason = 'PATTERN: "' + hit + '"';
    } else if (spend >= CONFIG.MIN_SPEND_NO_CONVERSIONS && conv === 0) {
      reason = 'PERFORMANCE: $' + spend.toFixed(2) + ' spend, 0 conversions in ' +
        CONFIG.LOOKBACK_DAYS + 'd';
    } else if (clicks >= CONFIG.MIN_CLICKS_FOR_CTR_RULE && ctr >= CONFIG.CTR_ANOMALY) {
      reason = 'CTR ANOMALY: ' + (ctr * 100).toFixed(1) + '% CTR / ' + clicks +
        ' clicks (accidental-click pattern)';
    }
    if (!reason) continue;

    var action = CONFIG.DRY_RUN ? 'DRY RUN — would exclude' :
      excludeCampaignLevel(cid, campaignId, ptype, placement, url);
    if (action === 'EXCLUDED') { exclusionCount++; already[key] = true; }

    actions.push({
      scope: 'CAMPAIGN: ' + campaignName,
      channel: String(r.campaign.advertisingChannelType),
      type: ptype,
      placement: name || placement,
      detail: url || placement,
      spend: round2(spend), clicks: clicks, imps: imps, conv: round2(conv),
      reason: reason, action: action
    });
  }

  // ================= PERFORMANCE MAX (account-level, pattern layer) =================
  var pmaxQuery =
    'SELECT performance_max_placement_view.placement, ' +
    'performance_max_placement_view.display_name, ' +
    'performance_max_placement_view.placement_type, ' +
    'performance_max_placement_view.target_url, ' +
    'campaign.name, metrics.impressions ' +
    'FROM performance_max_placement_view ' +
    "WHERE segments.date BETWEEN '" + dr.start + "' AND '" + dr.end + "' " +
    'AND metrics.impressions > 0';

  try {
    var pmRows = AdsApp.search(pmaxQuery);
    while (pmRows.hasNext()) {
      if (exclusionCount >= CONFIG.MAX_EXCLUSIONS_PER_RUN) break;
      var p = pmRows.next();
      var ppv = p.performanceMaxPlacementView;
      var pPlacement = String(ppv.placement || '');
      var pName = String(ppv.displayName || '');
      var pUrl = String(ppv.targetUrl || '');
      var pType = String(ppv.placementType || '');
      var pImps = Number(p.metrics.impressions || 0);

      var pHay = (pPlacement + ' ' + pName + ' ' + pUrl);
      if (matchesAny(allowRegexes, pHay)) continue;

      var pKey = 'ACCOUNT|' + pType + '|' + normalizePlacementKey(pPlacement, pUrl, pType);
      if (already[pKey]) continue;

      var pHit = firstMatch(blockRegexes, CONFIG.BLOCK_PATTERNS, pHay);
      if (!pHit) continue; // PMax = pattern layer only (no cost/conv data exposed)

      var pAction = CONFIG.DRY_RUN ? 'DRY RUN — would exclude' :
        excludeAccountLevel(cid, pType, pPlacement, pUrl);
      if (pAction === 'EXCLUDED') { exclusionCount++; already[pKey] = true; }

      actions.push({
        scope: 'ACCOUNT (PMax: ' + p.campaign.name + ')',
        channel: 'PERFORMANCE_MAX',
        type: pType,
        placement: pName || pPlacement,
        detail: pUrl || pPlacement,
        spend: '', clicks: '', imps: pImps, conv: '',
        reason: 'PATTERN: "' + pHit + '"',
        action: pAction
      });
    }
  } catch (e) {
    Logger.log('PMax placement check skipped: ' + e.message);
  }

  writeReport(account, actions, dr, exclusionCount);
}

// ---------------------- EXCLUSION BUILDERS ----------------------

/** Campaign-level negative placement criterion (Display/Video). */
function excludeCampaignLevel(cid, campaignId, ptype, placement, url) {
  var criterion = buildCriterion(ptype, placement, url);
  if (!criterion) return 'SKIPPED — unsupported placement type: ' + ptype;
  criterion.campaign = 'customers/' + cid + '/campaigns/' + campaignId;
  criterion.negative = true;
  try {
    var result = AdsApp.mutate({ campaignCriterionOperation: { create: criterion } });
    return result.isSuccessful() ? 'EXCLUDED'
      : 'ERROR — ' + result.getErrorMessages().join('; ');
  } catch (e) {
    return 'ERROR — ' + e.message;
  }
}

/** Account-level exclusion via customer_negative_criterion (covers PMax). */
function excludeAccountLevel(cid, ptype, placement, url) {
  var criterion = buildCriterion(ptype, placement, url);
  if (!criterion) return 'SKIPPED — unsupported placement type: ' + ptype;
  try {
    var result = AdsApp.mutate({ customerNegativeCriterionOperation: { create: criterion } });
    return result.isSuccessful() ? 'EXCLUDED'
      : 'ERROR — ' + result.getErrorMessages().join('; ');
  } catch (e) {
    return 'ERROR — ' + e.message;
  }
}

/**
 * Builds the criterion object for a placement type.
 * Placement id formats from the views:
 *   WEBSITE          -> url (use the site domain)
 *   MOBILE_APPLICATION -> app id like '2-com.example.app' (2=Android via Play, 1=iOS)
 *   YOUTUBE_CHANNEL  -> channel id 'UC...'
 *   YOUTUBE_VIDEO    -> video id
 */
function buildCriterion(ptype, placement, url) {
  if (ptype === 'WEBSITE') {
    var site = url || placement;
    site = site.replace(/^https?:\/\//, '').split('/')[0];
    if (!site) return null;
    return { placement: { url: site } };
  }
  if (ptype === 'MOBILE_APPLICATION') {
    var appId = placement.replace(/^mobileapp::/, '');
    if (!appId) return null;
    return { mobileApplication: { appId: appId } };
  }
  if (ptype === 'YOUTUBE_CHANNEL') {
    var ch = placement.replace(/^.*channel\//, '');
    if (!ch) return null;
    return { youtubeChannel: { channelId: ch } };
  }
  if (ptype === 'YOUTUBE_VIDEO') {
    var vid = placement.replace(/^.*video\//, '');
    if (!vid) return null;
    return { youtubeVideo: { videoId: vid } };
  }
  return null; // MOBILE_APP_CATEGORY and misc types: skip, log-only
}

/** Load existing negative placement criteria so weekly runs don't duplicate. */
function loadExistingExclusions() {
  var map = {};
  try {
    var q1 = 'SELECT campaign.id, campaign_criterion.type, ' +
      'campaign_criterion.placement.url, ' +
      'campaign_criterion.mobile_application.app_id, ' +
      'campaign_criterion.youtube_channel.channel_id, ' +
      'campaign_criterion.youtube_video.video_id ' +
      'FROM campaign_criterion ' +
      'WHERE campaign_criterion.negative = TRUE ' +
      "AND campaign_criterion.type IN ('PLACEMENT','MOBILE_APPLICATION','YOUTUBE_CHANNEL','YOUTUBE_VIDEO')";
    var rows1 = AdsApp.search(q1);
    while (rows1.hasNext()) {
      var c = rows1.next();
      map[String(c.campaign.id) + '|' + keyFromCriterion(c.campaignCriterion)] = true;
    }
  } catch (e) { Logger.log('Existing campaign exclusions load: ' + e.message); }
  try {
    var q2 = 'SELECT customer_negative_criterion.type, ' +
      'customer_negative_criterion.placement.url, ' +
      'customer_negative_criterion.mobile_application.app_id, ' +
      'customer_negative_criterion.youtube_channel.channel_id, ' +
      'customer_negative_criterion.youtube_video.video_id ' +
      'FROM customer_negative_criterion ' +
      "WHERE customer_negative_criterion.type IN ('PLACEMENT','MOBILE_APPLICATION','YOUTUBE_CHANNEL','YOUTUBE_VIDEO')";
    var rows2 = AdsApp.search(q2);
    while (rows2.hasNext()) {
      var n = rows2.next();
      map['ACCOUNT|' + keyFromCriterion(n.customerNegativeCriterion)] = true;
    }
  } catch (e) { Logger.log('Existing account exclusions load: ' + e.message); }
  return map;
}

function keyFromCriterion(crit) {
  var t = String(crit.type || '');
  if (crit.placement && crit.placement.url) return t + '|' + crit.placement.url.toLowerCase();
  if (crit.mobileApplication && crit.mobileApplication.appId) return t + '|' + crit.mobileApplication.appId.toLowerCase();
  if (crit.youtubeChannel && crit.youtubeChannel.channelId) return t + '|' + crit.youtubeChannel.channelId.toLowerCase();
  if (crit.youtubeVideo && crit.youtubeVideo.videoId) return t + '|' + crit.youtubeVideo.videoId.toLowerCase();
  return t + '|unknown';
}

function normalizePlacementKey(placement, url, ptype) {
  if (ptype === 'WEBSITE') {
    var site = (url || placement).replace(/^https?:\/\//, '').split('/')[0];
    return 'PLACEMENT|' + site.toLowerCase();
  }
  if (ptype === 'MOBILE_APPLICATION') {
    return 'MOBILE_APPLICATION|' + placement.replace(/^mobileapp::/, '').toLowerCase();
  }
  if (ptype === 'YOUTUBE_CHANNEL') {
    return 'YOUTUBE_CHANNEL|' + placement.replace(/^.*channel\//, '').toLowerCase();
  }
  if (ptype === 'YOUTUBE_VIDEO') {
    return 'YOUTUBE_VIDEO|' + placement.replace(/^.*video\//, '').toLowerCase();
  }
  return ptype + '|' + placement.toLowerCase();
}

// ---------------------- HELPERS ----------------------

function matchesAny(regexes, text) {
  for (var i = 0; i < regexes.length; i++) {
    if (regexes[i].test(text)) return true;
  }
  return false;
}

function firstMatch(regexes, patterns, text) {
  for (var i = 0; i < regexes.length; i++) {
    if (regexes[i].test(text)) return patterns[i];
  }
  return null;
}

function buildDateRange(days, tz) {
  var end = new Date();
  var start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return {
    start: Utilities.formatDate(start, tz, 'yyyy-MM-dd'),
    end: Utilities.formatDate(end, tz, 'yyyy-MM-dd')
  };
}

function round2(n) { return Math.round(Number(n) * 100) / 100; }

function writeReport(account, actions, dr, exclusionCount) {
  var rows = [['Scope', 'Channel', 'Placement Type', 'Placement', 'URL / ID',
    'Spend', 'Clicks', 'Impressions', 'Conversions', 'Reason', 'Action']];
  for (var i = 0; i < actions.length; i++) {
    var a = actions[i];
    rows.push([a.scope, a.channel, a.type, a.placement, a.detail,
      a.spend, a.clicks, a.imps, a.conv, a.reason, a.action]);
  }

  Logger.log(actions.length + ' placement(s) flagged, ' + exclusionCount +
    ' exclusion(s) created in ' + account.getName() +
    ' (window ' + dr.start + ' to ' + dr.end + ').');

  if (CONFIG.SPREADSHEET_URL) {
    try {
      var ss = SpreadsheetApp.openByUrl(CONFIG.SPREADSHEET_URL);
      var sheetName = 'Placements ' + Utilities.formatDate(new Date(),
        account.getTimeZone(), 'yyyy-MM-dd HH:mm');
      var sheet = ss.insertSheet(sheetName);
      sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
      sheet.getRange(1, 1, 1, rows[0].length).setFontWeight('bold');
      sheet.setFrozenRows(1);
      Logger.log('Report written to sheet: ' + sheetName);
      return;
    } catch (e) {
      Logger.log('Could not open spreadsheet (' + e.message + ') — logging to console.');
    }
  }
  for (var r = 0; r < rows.length; r++) Logger.log(rows[r].join(' | '));
}
