/**
 * Capture profiles — a profile bundles the browser-context traits that decide
 * *what content a page serves and shows*: viewport, device-scale, touch/mobile
 * flags, and user agent. Running the pipeline once per profile is how we catch
 * content that differs between desktop and mobile (CSS media queries *and*
 * UA/server-driven differences).
 *
 * The `desktop` profile mirrors the historical capture defaults (1920x1080,
 * random desktop UA) so single-profile runs are byte-for-byte unchanged.
 */

const { devices } = require('playwright');

const DESKTOP_VIEWPORT = { width: 1920, height: 1080 };

/**
 * Build a profile from a Playwright device descriptor.
 * @param {string} name profile name used in artifacts/logs
 * @param {string} deviceName key into playwright `devices`
 * @returns {object|null} null if the device is unknown in this Playwright version
 */
function fromDevice(name, deviceName) {
  const d = devices[deviceName];
  if (!d) return null;
  return {
    name,
    deviceName,
    viewport: d.viewport,
    deviceScaleFactor: d.deviceScaleFactor,
    isMobile: d.isMobile,
    hasTouch: d.hasTouch,
    userAgent: d.userAgent,
  };
}

const PROFILES = {
  // userAgent: null => caller supplies one (preserves the historical random
  // desktop-UA behavior); every other trait matches the previous default.
  desktop: {
    name: 'desktop',
    deviceName: null,
    viewport: DESKTOP_VIEWPORT,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    userAgent: null,
  },
  mobile: fromDevice('mobile', 'iPhone 13'),
  tablet: fromDevice('tablet', 'iPad (gen 7)'),
};

/**
 * @param {string|object} [nameOrProfile] profile name, a profile object, or falsy for desktop
 * @returns {object} resolved profile descriptor
 */
function resolveProfile(nameOrProfile) {
  if (!nameOrProfile) return PROFILES.desktop;
  if (typeof nameOrProfile === 'object') return nameOrProfile;
  const p = PROFILES[nameOrProfile];
  if (!p) {
    throw new Error(
      `Unknown capture profile: ${nameOrProfile}. Known: ${listProfiles().join(', ')}`
    );
  }
  return p;
}

/** @returns {string[]} names of profiles available in this Playwright version */
function listProfiles() {
  return Object.keys(PROFILES).filter((k) => PROFILES[k]);
}

module.exports = {
  PROFILES,
  DESKTOP_VIEWPORT,
  resolveProfile,
  listProfiles,
};
