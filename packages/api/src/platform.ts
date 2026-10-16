/**
 * Platform flags. Plugins read `isDesktopApp` as "Node.js and Electron are
 * available", which is not the case in the Tauri webview, so it is false until
 * the Node shims exist. `isMobile` / `isMobileApp` are true in the Android and
 * iOS apps, where plugins switch to their mobile behaviour.
 */

const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
const platform = typeof navigator === 'undefined' ? '' : navigator.platform || '';
const touchPoints = typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints || 0;

const isAndroid = /Android/.test(ua);
// iPadOS reports itself as a Mac; touch support gives it away.
const isIos = /iPhone|iPad|iPod/.test(ua) || (/Mac/.test(platform) && touchPoints > 1);
const isMobileApp = isAndroid || isIos;
const shortestSide = typeof screen === 'undefined' ? 0 : Math.min(screen.width, screen.height);
const isTablet = isMobileApp && shortestSide >= 600;

export const Platform = {
	isDesktop: !isMobileApp,
	isMobile: isMobileApp,
	isDesktopApp: false,
	isMobileApp,
	isIosApp: isIos,
	isAndroidApp: isAndroid,
	isPhone: isMobileApp && !isTablet,
	isTablet,
	isMacOS: !isIos && (/Mac/.test(platform) || /Mac OS X/.test(ua)),
	isWin: /Win/.test(platform),
	isLinux: /Linux/.test(platform) && !isAndroid,
	isSafari: /Safari/.test(ua) && !/Chrome|Chromium/.test(ua),
	resourcePathPrefix: '',
};
