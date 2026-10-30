'use strict';

// Chromium/Edge reserve these ports for browser and legacy protocols.
// Keep local development URLs on ports that browsers can open normally.
const RESTRICTED_BROWSER_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69,
  77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119,
  123, 135, 137, 139, 143, 179, 389, 427, 465, 512, 513, 514, 515, 526,
  530, 531, 532, 540, 548, 554, 556, 563, 601, 636, 993, 995,
  1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666,
  6667, 6668, 6669, 6697, 10080
].filter(Number.isInteger));

function isBrowserSafePort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535 && !RESTRICTED_BROWSER_PORTS.has(port);
}

function nextBrowserSafePort(port) {
  let candidate = Number(port) + 1;
  while (candidate <= 65535 && !isBrowserSafePort(candidate)) candidate += 1;
  if (candidate > 65535) throw new RangeError('No browser-safe TCP port remains in the valid port range.');
  return candidate;
}

function normalizeBrowserSafePort(port) {
  const candidate = Number(port);
  if (!Number.isInteger(candidate) || candidate < 1 || candidate > 65535) {
    throw new RangeError(`Invalid TCP port: ${port}`);
  }
  return isBrowserSafePort(candidate) ? candidate : nextBrowserSafePort(candidate);
}

module.exports = { isBrowserSafePort, nextBrowserSafePort, normalizeBrowserSafePort };
