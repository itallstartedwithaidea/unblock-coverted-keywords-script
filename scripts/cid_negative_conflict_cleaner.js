/**
 * NEGATIVE KEYWORD CONFLICT CLEANER — SINGLE ACCOUNT (CID LEVEL)
 * ALL-IN-ONE: detects AND removes in the same run.
 * --------------------------------------------------------------
 * Finds negative keywords that are blocking your own active (positive)
 * keywords at the ACCOUNT, CAMPAIGN, AD GROUP, and SHARED LIST level
 * within this account — and removes them. Every removal is logged to
 * the spreadsheet with level, scope, text, and match type so it can be
 * re-added manually if needed.
 *
 * MATCHING RULES (negatives don't use close variants, so matching is literal):
 *   - Negative EXACT:  blocks only an identical keyword
 *   - Negative PHRASE: blocks if the negative appears as an ordered
 *                      sequence of words inside the keyword
 *   - Negative BROAD:  blocks if ALL words of the negative appear
 *                      anywhere in the keyword (any order)
 *
 * ACCOUNT-LEVEL NEGATIVES (technical note):
 *   These are NOT in customer_negative_criterion.keyword — they live in a
 *   shared set of type ACCOUNT_LEVEL_NEGATIVE_KEYWORDS, with the individual
 *   keywords stored as shared_criterion rows. We query shared_criterion and
 *   remove via AdsApp.mutate() with a sharedCriterionOperation.
 */

// ============================== CONFIG ==============================

var CONFIG = {
  // true = report only. false = remove conflicting negatives in the same run.
  DRY_RUN: false,

  // Google Sheet URL for the conflict/removal log. Leave '' for Logger only.
  SPREADSHEET_URL: 'https://docs.google.com/spreadsheets/d/1P6K0mCWdOrmZzBYCrUIyfXfioX1v2Gk6P6VOHvGof68/edit?gid=0#gid=0',

  // Which negative levels to REMOVE when DRY_RUN = false.
  REMOVE_ACCOUNT_LEVEL: true,
  REMOVE_CAMPAIGN_LEVEL: true,
  REMOVE_ADGROUP_LEVEL: true,
  REMOVE_FROM_SHARED_LISTS: true,  // NOTE: affects every campaign the list is attached to

  // Skip removal (log-only) if a single negative blocks more than this many
  // keywords — usually a sign it's intentional. Raise if you want it more aggressive.
  MAX_BLOCKED_BEFORE_SKIP: 25
};

// ====================================================================

function main() {
  var account = AdsApp.currentAccount();
  var conflicts = [];

  // ---- 1. Index all enabled positive keywords ----
  var positives = [];
  var kwIter = AdsApp.keywords()
    .withCondition('Status = ENABLED')
    .withCondition('CampaignStatus = ENABLED')
    .withCondition('AdGroupStatus = ENABLED')
    .get();

  while (kwIter.hasNext()) {
    var kw = kwIter.next();
    positives.push({
      campaignId: kw.getCampaign().getId(),
      campaignName: kw.getCampaign().getName(),
      adGroupId: kw.getAdGroup().getId(),
      adGroupName: kw.getAdGroup().getName(),
      text: normalize(kw.getText()),
      raw: kw.getText()
    });
  }

  if (positives.length === 0) {
    Logger.log('No enabled keywords found — nothing to check.');
    return;
  }
  Logger.log('Indexed ' + positives.length + ' enabled keywords.');

  var byCampaign = groupBy(positives, 'campaignId');
  var byAdGroup = groupBy(positives, 'adGroupId');

  // ---- 2. Account-level negatives (block everything in the account) ----
  // Stored as shared_criterion rows inside the ACCOUNT_LEVEL_NEGATIVE_KEYWORDS
  // shared set. Removed via sharedCriterionOperation.
  var acctNegQuery =
    'SELECT shared_criterion.resource_name, ' +
    'shared_criterion.keyword.text, ' +
    'shared_criterion.keyword.match_type, ' +
    'shared_set.name ' +
    'FROM shared_criterion ' +
    "WHERE shared_set.type = 'ACCOUNT_LEVEL_NEGATIVE_KEYWORDS' " +
    "AND shared_criterion.type = 'KEYWORD'";

  try {
    var acctNegRows = AdsApp.search(acctNegQuery);
    while (acctNegRows.hasNext()) {
      var acctRow = acctNegRows.next();
      var acctNegText = acctRow.sharedCriterion.keyword.text;
      var acctNegMatch = acctRow.sharedCriterion.keyword.matchType;
      var acctNegResource = acctRow.sharedCriterion.resourceName;

      var blocked = findBlocked(acctNegText, acctNegMatch, positives);
      if (blocked.length > 0) {
        var removed = maybeRemoveSharedCriterion(acctNegResource, blocked.length,
          CONFIG.REMOVE_ACCOUNT_LEVEL);
        conflicts.push(rawRow('ACCOUNT', '—', '—', acctNegText, acctNegMatch,
          blocked, removed));
      }
    }
  } catch (e) {
    Logger.log('Account-level negative check skipped: ' + e.message);
  }

  // ---- 3. Campaign-level negatives ----
  var campIter = AdsApp.campaigns().withCondition('Status = ENABLED').get();
  while (campIter.hasNext()) {
    var campaign = campIter.next();
    var scoped = byCampaign[campaign.getId()];
    if (!scoped) continue;

    var cNegIter = campaign.negativeKeywords().get();
    while (cNegIter.hasNext()) {
      var cNeg = cNegIter.next();
      var cBlocked = findBlocked(cNeg.getText(), cNeg.getMatchType(), scoped);
      if (cBlocked.length > 0) {
        var cRemoved = maybeRemove(cNeg, cBlocked.length, CONFIG.REMOVE_CAMPAIGN_LEVEL);
        conflicts.push(row('CAMPAIGN', campaign.getName(), '—', cNeg, cBlocked, cRemoved));
      }
    }
  }

  // ---- 4. Ad group-level negatives ----
  var agIter = AdsApp.adGroups()
    .withCondition('Status = ENABLED')
    .withCondition('CampaignStatus = ENABLED')
    .get();
  while (agIter.hasNext()) {
    var adGroup = agIter.next();
    var agScoped = byAdGroup[adGroup.getId()];
    if (!agScoped) continue;

    var agNegIter = adGroup.negativeKeywords().get();
    while (agNegIter.hasNext()) {
      var agNeg = agNegIter.next();
      var agBlocked = findBlocked(agNeg.getText(), agNeg.getMatchType(), agScoped);
      if (agBlocked.length > 0) {
        var agRemoved = maybeRemove(agNeg, agBlocked.length, CONFIG.REMOVE_ADGROUP_LEVEL);
        conflicts.push(row('AD GROUP', adGroup.getCampaign().getName(),
          adGroup.getName(), agNeg, agBlocked, agRemoved));
      }
    }
  }

  // ---- 5. Shared negative keyword lists (the regular, attachable kind) ----
  var listIter = AdsApp.negativeKeywordLists().get();
  while (listIter.hasNext()) {
    var list = listIter.next();

    var attachedPositives = [];
    var attachedCampIter = list.campaigns().withCondition('Status = ENABLED').get();
    while (attachedCampIter.hasNext()) {
      var attached = attachedCampIter.next();
      var p = byCampaign[attached.getId()];
      if (p) attachedPositives = attachedPositives.concat(p);
    }
    if (attachedPositives.length === 0) continue;

    var listNegIter = list.negativeKeywords().get();
    while (listNegIter.hasNext()) {
      var lNeg = listNegIter.next();
      var lBlocked = findBlocked(lNeg.getText(), lNeg.getMatchType(), attachedPositives);
      if (lBlocked.length > 0) {
        var lRemoved = maybeRemove(lNeg, lBlocked.length, CONFIG.REMOVE_FROM_SHARED_LISTS);
        conflicts.push(row('SHARED LIST: ' + list.getName(), '—', '—', lNeg, lBlocked, lRemoved));
      }
    }
  }

  // ---- 6. Report ----
  writeReport(account, conflicts);
}

// ---------------------- MATCHING LOGIC ----------------------

/** Returns the subset of positive keywords blocked by a negative. */
function findBlocked(negText, matchType, positives) {
  var neg = normalize(negText);
  var negWords = neg.split(' ');
  var blocked = [];

  for (var i = 0; i < positives.length; i++) {
    var kwText = positives[i].text;
    var isBlocked = false;

    if (matchType === 'EXACT') {
      isBlocked = (kwText === neg);
    } else if (matchType === 'PHRASE') {
      isBlocked = hasOrderedSubsequence(kwText.split(' '), negWords);
    } else { // BROAD
      isBlocked = containsAllWords(kwText.split(' '), negWords);
    }

    if (isBlocked) blocked.push(positives[i]);
  }
  return blocked;
}

/** True if 'words' contains 'sub' as a contiguous ordered sequence. */
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

/** True if every word in 'sub' appears somewhere in 'words'. */
function containsAllWords(words, sub) {
  for (var i = 0; i < sub.length; i++) {
    if (words.indexOf(sub[i]) === -1) return false;
  }
  return true;
}

/** Lowercase, strip match-type punctuation and modifiers, collapse spaces. */
function normalize(text) {
  return text.toLowerCase()
    .replace(/[\[\]"+]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------- REMOVAL + REPORTING ----------------------

/** Removes a shared_criterion (account-level negative) via mutate. */
function maybeRemoveSharedCriterion(resourceName, blockedCount, levelEnabled) {
  if (CONFIG.DRY_RUN) return 'DRY RUN — would remove';
  if (!levelEnabled) return 'SKIPPED — removal disabled for this level';
  if (blockedCount > CONFIG.MAX_BLOCKED_BEFORE_SKIP) {
    return 'SKIPPED — blocks ' + blockedCount + ' keywords (over threshold, review manually)';
  }
  try {
    var result = AdsApp.mutate({
      sharedCriterionOperation: { remove: resourceName }
    });
    return result.isSuccessful() ? 'REMOVED' : 'ERROR — ' + result.getErrorMessages().join('; ');
  } catch (e) {
    return 'ERROR — ' + e.message;
  }
}

/** Removes a negative entity (campaign / ad group / shared list level). */
function maybeRemove(negEntity, blockedCount, levelEnabled) {
  if (CONFIG.DRY_RUN) return 'DRY RUN — would remove';
  if (!levelEnabled) return 'SKIPPED — removal disabled for this level';
  if (blockedCount > CONFIG.MAX_BLOCKED_BEFORE_SKIP) {
    return 'SKIPPED — blocks ' + blockedCount + ' keywords (over threshold, review manually)';
  }
  try {
    negEntity.remove();
    return 'REMOVED';
  } catch (e) {
    return 'ERROR — ' + e.message;
  }
}

/** Row builder for negatives read via GAQL (plain values, not entities). */
function rawRow(level, campaignName, adGroupName, negText, matchType, blocked, action) {
  var sample = [];
  for (var i = 0; i < Math.min(blocked.length, 5); i++) sample.push(blocked[i].raw);
  return {
    level: level,
    campaign: campaignName,
    adGroup: adGroupName,
    negative: negText,
    matchType: matchType,
    blockedCount: blocked.length,
    sampleBlocked: sample.join(' | '),
    action: action
  };
}

/** Row builder for entity-based negatives. */
function row(level, campaignName, adGroupName, neg, blocked, action) {
  var sample = [];
  for (var i = 0; i < Math.min(blocked.length, 5); i++) sample.push(blocked[i].raw);
  return {
    level: level,
    campaign: campaignName,
    adGroup: adGroupName,
    negative: neg.getText(),
    matchType: neg.getMatchType(),
    blockedCount: blocked.length,
    sampleBlocked: sample.join(' | '),
    action: action
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

function writeReport(account, conflicts) {
  var rows = [['Level', 'Campaign', 'Ad Group', 'Negative Keyword', 'Match Type',
    '# Keywords Blocked', 'Sample Blocked Keywords', 'Action']];
  for (var i = 0; i < conflicts.length; i++) {
    var c = conflicts[i];
    rows.push([c.level, c.campaign, c.adGroup, c.negative, c.matchType,
      c.blockedCount, c.sampleBlocked, c.action]);
  }

  Logger.log(conflicts.length + ' conflict(s) found in ' +
    account.getName() + ' (' + account.getCustomerId() + ').');

  if (CONFIG.SPREADSHEET_URL) {
    try {
      var ss = SpreadsheetApp.openByUrl(CONFIG.SPREADSHEET_URL);
      var sheetName = 'Conflicts ' + Utilities.formatDate(new Date(),
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
