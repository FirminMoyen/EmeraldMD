/**
 * Platform flags. EmeraldMD's desktop UI is a desktop layout, but plugins
 * read `isDesktopApp` as "Node.js and Electron are available", which is not
 * the case in the Tauri webview, so it is false until the Node shims exist.
 */

const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
const platform = typeof navigator === 'undefined' ? '' : navigator.platform || '';

export const Platform = {
	isDesktop: true,
	isMobile: false,
	isDesktopApp: false,
	isMobileApp: false,
	isIosApp: false,
	isAndroidApp: false,
	isPhone: false,
	isTablet: false,
	isMacOS: /Mac/.test(platform) || /Mac OS X/.test(ua),
	isWin: /Win/.test(platform),
	isLinux: /Linux/.test(platform) && !/Android/.test(ua),
	isSafari: /Safari/.test(ua) && !/Chrome|Chromium/.test(ua),
	resourcePathPrefix: '',
};
