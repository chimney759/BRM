// Copy this file to config.js during deployment and load it before data-access.js.
// Do not put tokens, passwords, or database credentials in browser-side configuration.
window.BRMS_CONFIG = {
  mode: 'http',
  apiBaseUrl: 'https://your-api.example.com/api',
  // Keep false in every deployed environment. Local role simulation additionally
  // requires BRMS_DEMO_AUTH=1 on the API process.
  localAuth: false
};
