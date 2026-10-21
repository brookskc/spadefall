export default [{
  files: ['src/audio.js', 'src/captions.js', 'src/controls.js', 'src/settings.js', 'src/reload-timeline.js', 'src/hud.js', 'src/spawn-controller.js', 'src/objectives.js', 'src/match-lifecycle.js', 'src/bots.js', 'src/bot-navigation.js', 'src/bot-combat.js', 'src/performance-auto.js', 'src/telemetry.js', 'src/human-analytics.js'],
  languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { window: 'readonly', document: 'readonly', localStorage: 'readonly', AudioContext: 'readonly', webkitAudioContext: 'readonly', Blob: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', requestAnimationFrame: 'readonly', URLSearchParams: 'readonly', location: 'readonly', performance: 'readonly' } },
  rules: { 'no-undef': 'error', 'no-unused-vars': ['error', { argsIgnorePattern: '^_' }] },
}, {
  files: ['worker/src/index.js'],
  languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: {
    fetch: 'readonly', Request: 'readonly', Response: 'readonly', URL: 'readonly',
    AbortController: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
  } },
  rules: { 'no-undef': 'error', 'no-unused-vars': ['error', { argsIgnorePattern: '^_' }] },
}];
