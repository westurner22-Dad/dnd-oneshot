// Backend config. 'local' = localStorage + BroadcastChannel (same browser only, for testing).
// 'firebase' = Firebase Realtime Database over REST. Fill databaseURL after creating the project.
window.GAME_CONFIG = {
  backend: 'firebase',                       // 'local' | 'firebase'
  firebase: { databaseURL: 'https://c-thug-default-rtdb.firebaseio.com' },
  scenesUrls: ['scenes.json']   // loaded from this folder only
};
