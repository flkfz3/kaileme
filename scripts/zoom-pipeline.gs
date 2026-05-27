// Gmail → kaileme/timelog Zoom-recap forwarder
//
// Polls the user's Gmail (tooglehub@gmail.com) every 5 minutes for Zoom
// recap emails that the UGA Outlook redirect rule has forwarded in, POSTs
// each to the `inbound-outlook` Supabase edge function, and labels the
// thread as processed so it's only sent once. Labels are added ONLY after
// a 2xx response — so a failed POST doesn't get silently "marked done".
//
// HOW TO INSTALL (do this once when the previous script has gone silent):
//   1. Open https://script.google.com/ on the Gmail account that receives
//      the forwarded recaps (tooglehub@gmail.com).
//   2. If a project named "kaileme-zoom-recap" already exists, OPEN IT;
//      otherwise New project → rename to "kaileme-zoom-recap".
//   3. Replace the entire Code.gs contents with THIS file.
//   4. Paste your INBOUND_SECRET into the constant below (or set it as a
//      Script Property — see getSecret_ further down).
//   5. Run `main` once manually: top toolbar Run ▸ main. Authorise the
//      Gmail + UrlFetch scopes when prompted.
//      Then check View ▸ Executions — one row with the log "found N
//      threads matching query" and per-thread OK/FAIL lines.
//   6. Triggers (clock icon, left sidebar) → Add Trigger →
//      function: main, deployment: Head, source: Time-driven,
//      type: Minutes timer, every: 5 minutes. Save.
//
// HOW TO DEBUG WHEN RECAPS STOP FLOWING:
//   - Executions tab shows the last 7 days of runs. Click any row to see
//     the Logger output, including HTTP response bodies from inbound-outlook.
//   - `found 0 threads`: either the upstream chain is broken (check the
//     UGA Outlook rule + Gmail filter) OR everything matching the query
//     is already labeled `kaileme-done`. Run `reprocessAll_DANGER` to clear
//     the label and retry, then re-run `main`.
//   - `FAIL 401`: INBOUND_SECRET below doesn't match Supabase. Get the
//     live value from `cat /tmp/kaileme_inbound_secret.txt` on the dev
//     machine (strip the `INBOUND_SECRET=` env-prefix).
//   - `FAIL 5xx`: the edge function is erroring. Check Supabase dashboard
//     ▸ Functions ▸ inbound-outlook ▸ Logs.

const INBOUND_URL = 'https://kbcftsexzmxjtlljgcyi.supabase.co/functions/v1/inbound-outlook';

// ⚠️ PASTE THE SHARED SECRET HERE (or use Script Properties — see below).
// Current value (as of 2026-05-23): hudfnOETE2BckxA8FsgqEqZm22holg5P-g6AAOrcMtI
const INBOUND_SECRET = 'hudfnOETE2BckxA8FsgqEqZm22holg5P-g6AAOrcMtI';

const PROCESSED_LABEL = 'kaileme-done';
const SEARCH_QUERY =
  '("Meeting assets for" OR "会议摘要") -label:' + PROCESSED_LABEL + ' newer_than:7d';
const MAX_PER_RUN = 20;

function main() {
  const secret = getSecret_();
  if (!secret) {
    Logger.log('FATAL: INBOUND_SECRET is empty. Set the constant in this script ' +
               'or add a Script Property called INBOUND_SECRET.');
    return;
  }

  const label = GmailApp.getUserLabelByName(PROCESSED_LABEL) ||
                GmailApp.createLabel(PROCESSED_LABEL);
  const threads = GmailApp.search(SEARCH_QUERY, 0, MAX_PER_RUN);
  Logger.log('found ' + threads.length + ' threads matching query: ' + SEARCH_QUERY);

  let ok = 0, fail = 0, skip = 0;
  for (const thread of threads) {
    const msgs = thread.getMessages();
    if (!msgs.length) { skip++; continue; }
    const msg = msgs[msgs.length - 1]; // newest message in the thread

    const subject = msg.getSubject() || '';
    try {
      const payload = {
        subject: subject,
        from: msg.getFrom() || '',
        receivedDateTime: msg.getDate().toISOString(),
        internetMessageId: msg.getId() || '',
        bodyHtml: msg.getBody() || '',
      };
      const url = INBOUND_URL + '?key=' + encodeURIComponent(secret);
      const resp = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true,
        followRedirects: true,
      });
      const code = resp.getResponseCode();
      const text = resp.getContentText();

      if (code >= 200 && code < 300) {
        thread.addLabel(label);
        ok++;
        Logger.log('OK [' + code + '] ' + subject + ' → ' + text.slice(0, 280));
      } else {
        fail++;
        Logger.log('FAIL [' + code + '] ' + subject + ' → ' + text.slice(0, 280));
      }
    } catch (e) {
      fail++;
      Logger.log('ERROR ' + subject + ' → ' + e);
    }
  }
  Logger.log('done: ok=' + ok + ' fail=' + fail + ' skip=' + skip);
}

// Reads INBOUND_SECRET from the in-file constant, falling back to a Script
// Property of the same name. Use Properties if you'd rather not commit the
// secret into the script body: Project Settings ▸ Script Properties ▸ +.
function getSecret_() {
  const fromConst = (INBOUND_SECRET || '').trim();
  if (fromConst && !/<paste/.test(fromConst)) return fromConst;
  try {
    const v = PropertiesService.getScriptProperties().getProperty('INBOUND_SECRET');
    return v ? v.trim() : '';
  } catch (_) { return ''; }
}

// Ad-hoc helper: prints the most recent matching thread without POSTing,
// useful for debugging the Gmail search and message shape. Run from the
// editor; output appears in View ▸ Logs / Executions.
function peekLatest() {
  const threads = GmailApp.search(SEARCH_QUERY, 0, 3);
  Logger.log('peek: ' + threads.length + ' threads');
  threads.forEach((t, i) => {
    const m = t.getMessages().slice(-1)[0];
    Logger.log('[' + i + '] from=' + m.getFrom() + ' subj=' + m.getSubject() +
               ' received=' + m.getDate().toISOString() +
               ' bodySnippet=' + m.getBody().slice(0, 200));
  });
}

// Strip the kaileme-done label from EVERY thread that carries it, so the
// next main() run reprocesses them. Use this when the old script labeled
// emails as done without actually getting them into DB (the situation we
// hit 2026-05-23). After this returns, switch the dropdown back to `main`
// and run it.
function reprocessAll_DANGER() {
  const label = GmailApp.getUserLabelByName(PROCESSED_LABEL);
  if (!label) { Logger.log('no label exists; nothing to reprocess'); return; }
  const threads = label.getThreads();
  Logger.log('clearing label from ' + threads.length + ' threads');
  threads.forEach(t => t.removeLabel(label));
  Logger.log('done — now switch to main() and run it');
}

// Narrower variant: clear the label only from threads whose subject
// contains SUBSTR. Edit SUBSTR before running.
function reprocessSubjectsContaining_DANGER() {
  const SUBSTR = 'Meeting'; // change to e.g. 'lab meeting' / '会议摘要' to narrow
  const label = GmailApp.getUserLabelByName(PROCESSED_LABEL);
  if (!label) { Logger.log('no label exists; nothing to reprocess'); return; }
  const threads = label.getThreads();
  let n = 0;
  threads.forEach(t => {
    if (t.getFirstMessageSubject().indexOf(SUBSTR) >= 0) {
      t.removeLabel(label); n++;
    }
  });
  Logger.log('cleared label from ' + n + ' threads matching "' + SUBSTR + '"');
}
