/* eslint-disable no-undef */
pref("__prefsPrefix__.enable", true);
// Matches SciDBManager._defaultEndpoint. Previously this default was orphaned
// under an unresolved `${addonRef}` key, so the effective default came from
// SciDBManager.registerPrefs() (sci-hub.ru); keep that behavior now that the
// key resolves correctly.
pref("__prefsPrefix__.endpoint", "https://sci-hub.ru/");
