/* eslint-disable */
/**
 * Shadow AI Guard — AI Tool Discovery (Feature 15)
 * ================================================
 * Deliberately the smallest file in the extension.
 *
 * It sends ONE signal — "someone at this company opened this tool today"
 * — and does nothing else. No detector, no input listeners, no debounce,
 * no content inspection, no popup. The service worker de-duplicates to
 * one signal per tool per day, so this is a shadow-IT inventory, not
 * a browsing-history tracker.
 *
 * The point of the feature is the question "which AI tools are people
 * actually using?", which IT usually cannot answer at all. It is not
 * "what is this person doing right now".
 */
(function () {
  "use strict";

  var host = location.hostname.replace(/^www\./, "");

  chrome.runtime.sendMessage({ type: "LOG_DISCOVERY", aiTool: host }, function () {
    void chrome.runtime.lastError;   // worker asleep or not enrolled — fine
  });
})();
