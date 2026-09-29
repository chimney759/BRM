// Local development configuration. This file is intentionally safe to commit:
// it contains no database credential, token, or cloud secret.
window.BRMS_CONFIG = {
  mode: 'http',
  // Same-origin API keeps local ports, staging, and production deployments aligned.
  apiBaseUrl: '/api',
  // Browser role simulation is development-only and must be explicitly enabled.
  localAuth: false
};
