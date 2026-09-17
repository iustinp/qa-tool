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

const MOBILE_UA =
  devices['iPhone 13']?.userAgent ||
  'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1';

/**
 * Build capture profiles from a recipe's `resolutions` list. Each entry is a
 * width + a user-agent class (desktop | mobile) — because content can differ by
 * both. Desktop keeps the historical behavior (random desktop UA, DPR 1); mobile
 * sends a phone UA + touch + DPR 3 so the site serves its mobile content. The
 * profile `name` is filename/tab-safe and carries `width`/`ua` for the reports.
 * @param {Array<{width:number, ua?:string, height?:number}>} resolutions
 * @returns {object[]} profile objects (empty if none valid)
 */
function buildResolutionProfiles(resolutions) {
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(resolutions) ? resolutions : []) {
    const width = Math.round(Number(r && r.width));
    if (!Number.isFinite(width) || width < 100 || width > 4000) continue;
    const ua = r.ua === 'mobile' ? 'mobile' : 'desktop';
    const name = `${width}${ua === 'mobile' ? 'm' : ''}`;
    if (seen.has(name)) continue;
    seen.add(name);
    const height = Math.round(Number(r.height)) || (ua === 'mobile' ? 812 : 900);
    out.push(
      ua === 'mobile'
        ? { name, width, ua, deviceName: null, viewport: { width, height }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: MOBILE_UA }
        : { name, width, ua, deviceName: null, viewport: { width, height }, deviceScaleFactor: 1, isMobile: false, hasTouch: false, userAgent: null }
    );
  }
  return out;
}

module.exports = {
  PROFILES,
  DESKTOP_VIEWPORT,
  resolveProfile,
  listProfiles,
  buildResolutionProfiles,
};
