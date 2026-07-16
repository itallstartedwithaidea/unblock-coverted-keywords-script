/**
 * MCC NEGATIVE KEYWORD CONFLICT CLEANER
 * -------------------------------------
 * Finds negative keywords that are blocking your own active (positive) keywords
 * at the ACCOUNT, CAMPAIGN, AD GROUP, and SHARED LIST level — across an MCC —
 * and optionally removes them.
 *
 * HOW IT WORKS
 * 1. Runs from the MCC via executeInParallel (max 50 accounts per run).
 * 2. In each account, builds an index of enabled positive keywords.
 * 3. Checks every negative keyword against the positives it can block,
 *    respecting negative match type rules:
 *       - Negative EXACT:  blocks only an identical keyword
 *       - Negative PHRASE: blocks if the negative appears as an ordered
 *                          sequence of words inside the keyword
 *       - Negative BROAD:  blocks if ALL words of the negative appear
 *                          anywhere in the keyword (any order)
 *    (Negatives do not use close variants, so matching is literal.)
 * 4. Logs every conflict to a Google Sheet and (if DRY_RUN = false)
 *    removes the blocking negative.
 *
 * SETUP
 * - Schedule at MCC level.
 * - Create a blank Google Sheet, paste its URL below.
 * - Start with DRY_RUN = true. Review the sheet. Then flip to false.
 *
 * SAFETY NOTES
 * - Shared-list negatives affect every campaign the list is attached to.
 *   Removal from shared lists is OFF by default (log-only) — enable with
 *   REMOVE_FROM_SHARED_LISTS = true only after reviewing the report.
 * - Only ENABLED campaigns / ad groups / keywords are considered.
 */

// ============================== CONFIG ==============================

var CONFIG = {
  // true = report only, no changes. false = actually remove conflicting negatives.
  DRY_RUN: true,

  // Blank Google Sheet URL for the conflict report.
  SPREADSHEET_URL: 'PASTE_YOUR_SHEET_URL_HERE',

  // Limit which accounts run. Leave both empty to run the first 50 accounts.
  // Option A: run only accounts with this MCC label:
  ACCOUNT_LABEL: '',            // e.g. 'Negative Cleanup'
  // Option B: explicit list of CIDs (overrides label if non-empty):
  ACCOUNT_IDS: [],              // e.g. ['123-456-7890', '234-567-8901']

  // Which negative levels to REMOVE when DRY_RUN = false.
  REMOVE_ACCOUNT_LEVEL: true,
  REMOVE_CAMPAIGN_LEVEL: true,
  REMOVE_ADGROUP_LEVEL: true,
  REMOVE_FROM_SHARED_LISTS: false,  // log-only by default; see safety note

  // Skip removal (log-only) if a single negative blocks more than this many
  // keywords — usually a sign it's intentional and needs a human look.
  MAX_BLOCKED_BEFORE_SKIP: 25
};

// ====================================================================

function main() {
  var accountSelector = MccApp.accounts();

  if (CONFIG.ACCOUNT_IDS && CONFIG.ACCOUNT_IDS.length > 0) {
    accountSelector = accountSelector.withIds(CONFIG.ACCOUNT_IDS);
  } else if (CONFIG.ACCOUNT_LABEL) {
    accountSelector = accountSelector.withCondition(
      "LabelNames CONTAINS '" + CONFIG.ACCOUNT_LABEL + "'");
  }

  accountSelector
    .withLimit(50)
    .executeInParallel('processAccount', 'reportResults', JSON.stringify(CONFIG));
}

// ---------------------- PER-ACCOUNT WORKER ----------------------

function processAccount(configJson) {
  var config = JSON.parse(configJson);
  var account = AdsApp.currentAccount();
  var conflicts = [];

  // ---- 1. Index all enabled positive keywords ----
  // Structure: [{campaignId, campaignName, adGroupId, adGroupName, text, raw}]
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
    return JSON.stringify({ account: account.getName(), cid: account.getCustomerId(), conflicts: [] });
  }

  // Group positives by campaign and ad group for scoped negative checks
  var byCampaign = groupBy(positives, 'campaignId');
  var byAdGroup = groupBy(positives, 'adGroupId');

  // ---- 2. Account-level negatives (block everything in the account) ----
  var acctNegIter = AdsApp.negativeKeywords().get();
  while (acctNegIter.hasNext()) {
    var neg = acctNegIter.next();
    var blocked = findBlocked(neg.getText(), neg.getMatchType(), positives);
    if (blocked.length > 0) {
      var removed = maybeRemove(neg, blocked.length, config, config.REMOVE_ACCOUNT_LEVEL);
      conflicts.push(row(account, 'ACCOUNT', '—', '—', neg, blocked, removed));
    }
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
        var cRemoved = maybeRemove(cNeg, cBlocked.length, config, config.REMOVE_CAMPAIGN_LEVEL);
        conflicts.push(row(account, 'CAMPAIGN', campaign.getName(), '—', cNeg, cBlocked, cRemoved));
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
        var agRemoved = maybeRemove(agNeg, agBlocked.length, config, config.REMOVE_ADGROUP_LEVEL);
        conflicts.push(row(account, 'AD GROUP', adGroup.getCampaign().getName(),
          adGroup.getName(), agNeg, agBlocked, agRemoved));
      }
    }
  }

  // ---- 5. Shared negative keyword lists ----
  var listIter = AdsApp.negativeKeywordLists().get();
  while (listIter.hasNext()) {
    var list = listIter.next();

    // Positives in campaigns this list is attached to
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
        var lRemoved = maybeRemove(lNeg, lBlocked.length, config, config.REMOVE_FROM_SHARED_LISTS);
        conflicts.push(row(account, 'SHARED LIST: ' + list.getName(), '—', '—', lNeg, lBlocked, lRemoved));
      }
    }
  }

  return JSON.stringify({
    account: account.getName(),
    cid: account.getCustomerId(),
    conflicts: conflicts
  });
}

// ---------------------- MATCHING LOGIC ----------------------

/**
 * Returns the subset of positive keywords blocked by a negative.
 */
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

/**
 * Removes the negative if allowed by config. Returns a status string.
 */
function maybeRemove(negEntity, blockedCount, config, levelEnabled) {
  if (config.DRY_RUN) return 'DRY RUN — would remove';
  if (!levelEnabled) return 'SKIPPED — removal disabled for this level';
  if (blockedCount > config.MAX_BLOCKED_BEFORE_SKIP) {
    return 'SKIPPED — blocks ' + blockedCount + ' keywords (over threshold, review manually)';
  }
  try {
    negEntity.remove();
    return 'REMOVED';
  } catch (e) {
    return 'ERROR — ' + e.message;
  }
}

function row(account, level, campaignName, adGroupName, neg, blocked, action) {
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

// ---------------------- MCC CALLBACK ----------------------

function reportResults(results) {
  var ss;
  try {
    ss = SpreadsheetApp.openByUrl(CONFIG.SPREADSHEET_URL);
  } catch (e) {
    Logger.log('Could not open spreadsheet — logging to console instead.');
  }

  var sheetName = 'Conflicts ' + Utilities.formatDate(new Date(),
    AdsApp.currentAccount().getTimeZone(), 'yyyy-MM-dd HH:mm');
  var rows = [['Account', 'CID', 'Level', 'Campaign', 'Ad Group',
    'Negative Keyword', 'Match Type', '# Keywords Blocked',
    'Sample Blocked Keywords', 'Action']];

  var totalConflicts = 0;
  for (var i = 0; i < results.length; i++) {
    if (results[i].getStatus() !== 'OK') {
      Logger.log('Account failed: ' + results[i].getCustomerId() + ' — ' + results[i].getError());
      continue;
    }
    var data = JSON.parse(results[i].getReturnValue());
    for (var j = 0; j < data.conflicts.length; j++) {
      var c = data.conflicts[j];
      totalConflicts++;
      rows.push([data.account, data.cid, c.level, c.campaign, c.adGroup,
        c.negative, c.matchType, c.blockedCount, c.sampleBlocked, c.action]);
    }
  }

  if (ss) {
    var sheet = ss.insertSheet(sheetName);
    sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
    sheet.getRange(1, 1, 1, rows[0].length).setFontWeight('bold');
    sheet.setFrozenRows(1);
    Logger.log('Report written: ' + sheetName + ' — ' + totalConflicts + ' conflicts found.');
  } else {
    for (var r = 0; r < rows.length; r++) Logger.log(rows[r].join(' | '));
  }
}
