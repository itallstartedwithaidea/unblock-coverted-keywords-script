/**
 * BLOCKED SEARCH TERM RECOVERY — SINGLE ACCOUNT (CID LEVEL)
 * ---------------------------------------------------------
 * Finds negative keywords (at ACCOUNT, CAMPAIGN — including PMax —,
 * AD GROUP, and SHARED LIST level) that are blocking search terms with
 * real performance history, and removes the negatives that are
 * suppressing converters.
 *
 * WHY THIS EXISTS
 * A keyword-conflict script only catches negatives that literally block a
 * positive keyword's text. But because keywords match queries via close
 * variants while negatives match literally, a negative can block valuable
 * QUERIES without ever conflicting with a keyword. This script audits
 * negatives against actual search term history instead.
 *
 * HOW IT WORKS
 * 1. Pulls search term performance (last LOOKBACK_DAYS) via GAQL —
 *    impressions, clicks, conversions, conv value — scoped by campaign
 *    and ad group.
 * 2. Pulls ALL negatives via GAQL (entity iterators can't see PMax;
 *    campaign_criterion can).
 * 3. Simulates negative matching (EXACT / PHRASE / BROAD, literal — no
 *    close variants, exactly how Google applies negatives) against the
 *    term history each negative can reach.
 * 4. Ranks negatives by blocked conversions / value, writes a report,
 *    and removes those meeting the removal criteria.
 *
 * KNOWN LIMITS
 * - Terms excluded long ago may not appear in the lookback window (they
 *   stopped serving once blocked). Lengthen LOOKBACK_DAYS to reach back
 *   before the exclusions were added.
 * - PMax search terms aren't in search_term_view, so PMax negatives are
 *   evaluated against the account's SEARCH term history as a proxy. A PMax
 *   negative blocking terms that convert in Search is still a red flag.
 */

// ============================== CONFIG ==============================

var CONFIG = {
  // true = report only. false = remove negatives meeting the criteria below.
  DRY_RUN: false,

  // Google Sheet URL for the report. Leave '' for Logger only.
  SPREADSHEET_URL: 'https://docs.google.com/spreadsheets/d/1P6K0mCWdOrmZzBYCrUIyfXfioX1v2Gk6P6VOHvGof68/edit?gid=0#gid=0',

  // How far back to look at search term history.
  LOOKBACK_DAYS: 180,

  // Only consider search terms with at least this many clicks (keeps runtime sane).
  MIN_TERM_CLICKS: 1,

  // REMOVAL CRITERIA: a negative is removed if the terms it blocks total
  // at least this many conversions in the lookback window.
  MIN_BLOCKED_CONVERSIONS_TO_REMOVE: 1,

  // Which levels are allowed to have negatives removed.
  REMOVE_ACCOUNT_LEVEL: true,
  REMOVE_CAMPAIGN_LEVEL: true,   // includes PMax campaign negatives
  REMOVE_ADGROUP_LEVEL: true,
  REMOVE_FROM_SHARED_LISTS: true // affects every campaign the list is attached to
};

// ====================================================================

function main() {
  var account = AdsApp.currentAccount();
  var tz = account.getTimeZone();
  var dateRange = buildDateRange(CONFIG.LOOKBACK_DAYS, tz);

  // ---- 1. Pull search term history ----
  var terms = [];
  var termQuery =
    'SELECT search_term_view.search_term, campaign.id, campaign.name, ' +
    'ad_group.id, ad_group.name, metrics.impressions, metrics.clicks, ' +
    'metrics.conversions, metrics.conversions_value ' +
    'FROM search_term_view ' +
    "WHERE segments.date BETWEEN '" + dateRange.start + "' AND '" + dateRange.end + "' " +
    'AND metrics.clicks >= ' + CONFIG.MIN_TERM_CLICKS;

  var termRows = AdsApp.search(termQuery);
  while (termRows.hasNext()) {
    var tr = termRows.next();
    terms.push({
      term: normalize(tr.searchTermView.searchTerm),
      raw: tr.searchTermView.searchTerm,
      campaignId: String(tr.campaign.id),
      campaignName: tr.campaign.name,
      adGroupId: String(tr.adGroup.id),
      impressions: Number(tr.metrics.impressions || 0),
      clicks: Number(tr.metrics.clicks || 0),
      conversions: Number(tr.metrics.conversions || 0),
      convValue: Number(tr.metrics.conversionsValue || 0)
    });
  }

  if (terms.length === 0) {
    Logger.log('No search terms found in the lookback window — nothing to audit.');
    return;
  }
  Logger.log('Pulled ' + terms.length + ' search terms (last ' + CONFIG.LOOKBACK_DAYS + ' days).');

  var termsByCampaign = groupBy(terms, 'campaignId');
  var termsByAdGroup = groupBy(terms, 'adGroupId');

  var findings = [];

  // ---- 2a. Account-level negatives (shared set: ACCOUNT_LEVEL_NEGATIVE_KEYWORDS) ----
  try {
    var acctQuery =
      'SELECT shared_criterion.resource_name, shared_criterion.keyword.text, ' +
      'shared_criterion.keyword.match_type, shared_set.name ' +
      'FROM shared_criterion ' +
      "WHERE shared_set.type = 'ACCOUNT_LEVEL_NEGATIVE_KEYWORDS' " +
      "AND shared_criterion.type = 'KEYWORD'";
    var acctRows = AdsApp.search(acctQuery);
    while (acctRows.hasNext()) {
      var a = acctRows.next();
      evaluate(findings, 'ACCOUNT', '—', '—',
        a.sharedCriterion.keyword.text, a.sharedCriterion.keyword.matchType,
        terms, // account-level reaches everything
        { kind: 'shared_criterion', resource: a.sharedCriterion.resourceName },
        CONFIG.REMOVE_ACCOUNT_LEVEL);
    }
  } catch (e) {
    Logger.log('Account-level negatives skipped: ' + e.message);
  }

  // ---- 2b. Campaign-level negatives (ALL campaign types incl. PMax) ----
  var campNegQuery =
    'SELECT campaign_criterion.resource_name, campaign_criterion.keyword.text, ' +
    'campaign_criterion.keyword.match_type, campaign.id, campaign.name, ' +
    'campaign.advertising_channel_type ' +
    'FROM campaign_criterion ' +
    'WHERE campaign_criterion.negative = TRUE ' +
    "AND campaign_criterion.type = 'KEYWORD' " +
    "AND campaign.status = 'ENABLED'";
  var campNegRows = AdsApp.search(campNegQuery);
  while (campNegRows.hasNext()) {
    var c = campNegRows.next();
    var channel = String(c.campaign.advertisingChannelType || '');
    var isPmax = (channel === 'PERFORMANCE_MAX');
    // PMax has no search_term_view rows — evaluate against ALL search history
    // as a proxy; scoped campaigns evaluate against their own terms only.
    var scope = isPmax ? terms : (termsByCampaign[String(c.campaign.id)] || []);
    if (scope.length === 0) continue;

    evaluate(findings,
      'CAMPAIGN' + (isPmax ? ' (PMAX — proxy match vs Search history)' : ''),
      c.campaign.name, '—',
      c.campaignCriterion.keyword.text, c.campaignCriterion.keyword.matchType,
      scope,
      { kind: 'campaign_criterion', resource: c.campaignCriterion.resourceName },
      CONFIG.REMOVE_CAMPAIGN_LEVEL);
  }

  // ---- 2c. Ad group-level negatives ----
  var agNegQuery =
    'SELECT ad_group_criterion.resource_name, ad_group_criterion.keyword.text, ' +
    'ad_group_criterion.keyword.match_type, ad_group.id, ad_group.name, ' +
    'campaign.name ' +
    'FROM ad_group_criterion ' +
    'WHERE ad_group_criterion.negative = TRUE ' +
    "AND ad_group_criterion.type = 'KEYWORD' " +
    "AND ad_group.status = 'ENABLED' AND campaign.status = 'ENABLED'";
  var agNegRows = AdsApp.search(agNegQuery);
  while (agNegRows.hasNext()) {
    var g = agNegRows.next();
    var agScope = termsByAdGroup[String(g.adGroup.id)] || [];
    if (agScope.length === 0) continue;

    evaluate(findings, 'AD GROUP', g.campaign.name, g.adGroup.name,
      g.adGroupCriterion.keyword.text, g.adGroupCriterion.keyword.matchType,
      agScope,
      { kind: 'ad_group_criterion', resource: g.adGroupCriterion.resourceName },
      CONFIG.REMOVE_ADGROUP_LEVEL);
  }

  // ---- 2d. Shared negative keyword lists (regular attachable lists) ----
  try {
    // Map: shared set resource name -> attached enabled campaign IDs
    var attachments = {};
    var attachQuery =
      'SELECT campaign_shared_set.shared_set, campaign.id ' +
      'FROM campaign_shared_set ' +
      "WHERE campaign_shared_set.status = 'ENABLED' AND campaign.status = 'ENABLED'";
    var attachRows = AdsApp.search(attachQuery);
    while (attachRows.hasNext()) {
      var at = attachRows.next();
      var setRes = at.campaignSharedSet.sharedSet;
      if (!attachments[setRes]) attachments[setRes] = [];
      attachments[setRes].push(String(at.campaign.id));
    }

    var listQuery =
      'SELECT shared_criterion.resource_name, shared_criterion.keyword.text, ' +
      'shared_criterion.keyword.match_type, shared_set.resource_name, shared_set.name ' +
      'FROM shared_criterion ' +
      "WHERE shared_set.type = 'NEGATIVE_KEYWORDS' " +
      "AND shared_criterion.type = 'KEYWORD'";
    var listRows = AdsApp.search(listQuery);
    while (listRows.hasNext()) {
      var l = listRows.next();
      var attachedIds = attachments[l.sharedSet.resourceName] || [];
      var listScope = [];
      for (var i = 0; i < attachedIds.length; i++) {
        var p = termsByCampaign[attachedIds[i]];
        if (p) listScope = listScope.concat(p);
      }
      if (listScope.length === 0) continue;

      evaluate(findings, 'SHARED LIST: ' + l.sharedSet.name, '—', '—',
        l.sharedCriterion.keyword.text, l.sharedCriterion.keyword.matchType,
        listScope,
        { kind: 'shared_criterion', resource: l.sharedCriterion.resourceName },
        CONFIG.REMOVE_FROM_SHARED_LISTS);
    }
  } catch (e) {
    Logger.log('Shared list check skipped: ' + e.message);
  }

  // ---- 3. Sort by blocked value and report ----
  findings.sort(function (x, y) {
    return (y.blockedConversions - x.blockedConversions) ||
           (y.blockedConvValue - x.blockedConvValue) ||
           (y.blockedClicks - x.blockedClicks);
  });

  writeReport(account, findings, dateRange);
}

// ---------------------- EVALUATION ----------------------

/**
 * Tests one negative against its reachable term history. If it blocks
 * anything, aggregates the blocked metrics, decides removal, and appends
 * a finding.
 */
function evaluate(findings, level, campaignName, adGroupName,
                  negText, matchType, scopeTerms, removalRef, levelEnabled) {
  var neg = normalize(negText);
  if (!neg) return;
  var negWords = neg.split(' ');

  var blockedTerms = [];
  var conv = 0, value = 0, clicks = 0, imps = 0;

  for (var i = 0; i < scopeTerms.length; i++) {
    var t = scopeTerms[i];
    var isBlocked = false;
    if (matchType === 'EXACT') {
      isBlocked = (t.term === neg);
    } else if (matchType === 'PHRASE') {
      isBlocked = hasOrderedSubsequence(t.term.split(' '), negWords);
    } else { // BROAD
      isBlocked = containsAllWords(t.term.split(' '), negWords);
    }
    if (isBlocked) {
      blockedTerms.push(t);
      conv += t.conversions;
      value += t.convValue;
      clicks += t.clicks;
      imps += t.impressions;
    }
  }

  if (blockedTerms.length === 0) return;

  // Removal decision
  var action;
  if (CONFIG.DRY_RUN) {
    action = (conv >= CONFIG.MIN_BLOCKED_CONVERSIONS_TO_REMOVE)
      ? 'DRY RUN — would remove' : 'KEPT — below conversion threshold';
  } else if (!levelEnabled) {
    action = 'SKIPPED — removal disabled for this level';
  } else if (conv >= CONFIG.MIN_BLOCKED_CONVERSIONS_TO_REMOVE) {
    action = removeNegative(removalRef);
  } else {
    action = 'KEPT — below conversion threshold';
  }

  // Top blocked terms by conversions for the report
  blockedTerms.sort(function (x, y) { return y.conversions - x.conversions; });
  var sample = [];
  for (var j = 0; j < Math.min(blockedTerms.length, 5); j++) {
    var bt = blockedTerms[j];
    sample.push(bt.raw + ' (' + bt.conversions.toFixed(1) + ' conv / ' + bt.clicks + ' clk)');
  }

  findings.push({
    level: level,
    campaign: campaignName,
    adGroup: adGroupName,
    negative: negText,
    matchType: matchType,
    blockedTermCount: blockedTerms.length,
    blockedConversions: round2(conv),
    blockedConvValue: round2(value),
    blockedClicks: clicks,
    blockedImpressions: imps,
    topBlockedTerms: sample.join(' | '),
    action: action
  });
}

/** Removes a negative via mutate based on its criterion type. */
function removeNegative(ref) {
  try {
    var op = {};
    if (ref.kind === 'campaign_criterion') {
      op = { campaignCriterionOperation: { remove: ref.resource } };
    } else if (ref.kind === 'ad_group_criterion') {
      op = { adGroupCriterionOperation: { remove: ref.resource } };
    } else { // shared_criterion (account-level or shared list)
      op = { sharedCriterionOperation: { remove: ref.resource } };
    }
    var result = AdsApp.mutate(op);
    return result.isSuccessful() ? 'REMOVED'
      : 'ERROR — ' + result.getErrorMessages().join('; ');
  } catch (e) {
    return 'ERROR — ' + e.message;
  }
}

// ---------------------- MATCHING HELPERS ----------------------

function hasOrderedSubsequence(words, sub) {
  if (sub.length > words.length) return false;
  for (var i = 0; i <= words.length - sub.length; i++) {
    var match = true;
    for (var j = 0; j < sub.length; j++) {
      if (words[i + j] !== sub[j]) { match = false; break; }
    }
    if (match) return true;
  }
  return false;
}

function containsAllWords(words, sub) {
  for (var i = 0; i < sub.length; i++) {
    if (words.indexOf(sub[i]) === -1) return false;
  }
  return true;
}

function normalize(text) {
  return String(text || '').toLowerCase()
    .replace(/[\[\]"+]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------- UTILITIES ----------------------

function buildDateRange(days, tz) {
  var end = new Date();
  var start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return {
    start: Utilities.formatDate(start, tz, 'yyyy-MM-dd'),
    end: Utilities.formatDate(end, tz, 'yyyy-MM-dd')
  };
}

function groupBy(arr, key) {
  var out = {};
  for (var i = 0; i < arr.length; i++) {
    var k = arr[i][key];
    if (!out[k]) out[k] = [];
    out[k].push(arr[i]);
  }
  return out;
}

function round2(n) { return Math.round(n * 100) / 100; }

function writeReport(account, findings, dateRange) {
  var rows = [['Level', 'Campaign', 'Ad Group', 'Negative Keyword', 'Match Type',
    '# Terms Blocked', 'Blocked Conversions', 'Blocked Conv Value',
    'Blocked Clicks', 'Blocked Impressions', 'Top Blocked Terms', 'Action']];
  for (var i = 0; i < findings.length; i++) {
    var f = findings[i];
    rows.push([f.level, f.campaign, f.adGroup, f.negative, f.matchType,
      f.blockedTermCount, f.blockedConversions, f.blockedConvValue,
      f.blockedClicks, f.blockedImpressions, f.topBlockedTerms, f.action]);
  }

  Logger.log(findings.length + ' negative(s) blocking historical search terms in ' +
    account.getName() + ' (' + account.getCustomerId() + '), window ' +
    dateRange.start + ' to ' + dateRange.end + '.');

  if (CONFIG.SPREADSHEET_URL) {
    try {
      var ss = SpreadsheetApp.openByUrl(CONFIG.SPREADSHEET_URL);
      var sheetName = 'Recovery ' + Utilities.formatDate(new Date(),
        account.getTimeZone(), 'yyyy-MM-dd HH:mm');
      var sheet = ss.insertSheet(sheetName);
      sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
      sheet.getRange(1, 1, 1, rows[0].length).setFontWeight('bold');
      sheet.setFrozenRows(1);
      Logger.log('Report written to sheet: ' + sheetName);
      return;
    } catch (e) {
      Logger.log('Could not open spreadsheet (' + e.message + ') — logging to console instead.');
    }
  }

  for (var r = 0; r < rows.length; r++) Logger.log(rows[r].join(' | '));
}
