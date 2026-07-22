"use strict";

const SPEECH_PREFERENCE_KEY = "echo-free-roam-speech";
const SPEECH_DEFAULT_MIGRATION_KEY = "echo-free-roam-speech-default-v2";

try {
  if (localStorage.getItem(SPEECH_DEFAULT_MIGRATION_KEY) !== "done") {
    // An older VoiceOver workaround could mistake an accessibility-generated
    // keyboard-style click for a request to disable game speech. That stale
    // value survived after the workaround itself was removed. Reset only that
    // old disabled value once; later explicit choices remain persistent.
    if (localStorage.getItem(SPEECH_PREFERENCE_KEY) === "off") {
      localStorage.removeItem(SPEECH_PREFERENCE_KEY);
    }
    localStorage.setItem(SPEECH_DEFAULT_MIGRATION_KEY, "done");
  }
} catch (_) {
  // Private browsing or storage restrictions must not prevent the game start.
}
