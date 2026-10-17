// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import '../src';
import { createTestApp } from '../src/testing';

const press = (key: string, mods: { mod?: boolean; shift?: boolean } = {}) => {
	const isMac = /Mac/.test(navigator.platform);
	window.dispatchEvent(
		new KeyboardEvent('keydown', { key, code: `Key${key.toUpperCase()}`, bubbles: true, cancelable: true, metaKey: Boolean(mods.mod) && isMac, ctrlKey: Boolean(mods.mod) && !isMac, shiftKey: Boolean(mods.shift) }),
	);
};

describe('HotkeyManager', () => {
	it("binds the user's hotkeys from hotkeys.json over the defaults", async () => {
		const config = { '.obsidian/hotkeys.json': JSON.stringify({ 'test:run': [{ modifiers: ['Mod', 'Shift'], key: 'K' }], 'test:off': [] }) };
		const { app } = await createTestApp({}, config);
		await app.hotkeyManager.load();
		const run = vi.fn();
		const off = vi.fn();
		app.commands.addCommand({ id: 'test:run', name: 'Run', hotkeys: [{ modifiers: ['Mod'], key: 'J' }], callback: run });
		app.commands.addCommand({ id: 'test:off', name: 'Off', hotkeys: [{ modifiers: ['Mod'], key: 'L' }], callback: off });
		press('j', { mod: true });
		press('l', { mod: true });
		expect(run).not.toHaveBeenCalled();
		expect(off).not.toHaveBeenCalled();
		press('k', { mod: true, shift: true });
		expect(run).toHaveBeenCalledTimes(1);
		expect(app.hotkeyManager.getDefaultHotkeys('test:run')).toEqual([{ modifiers: ['Mod'], key: 'J' }]);
	});

	it('saves changes, rebinds, restores defaults and reports conflicts', async () => {
		const { app, config } = await createTestApp();
		await app.hotkeyManager.load();
		const run = vi.fn();
		app.commands.addCommand({ id: 'test:run', name: 'Run', hotkeys: [{ modifiers: ['Mod'], key: 'J' }], callback: run });
		app.commands.addCommand({ id: 'test:other', name: 'Other', hotkeys: [{ modifiers: ['Mod'], key: 'U' }], callback: () => {} });
		app.hotkeyManager.setHotkeys('test:run', [{ modifiers: ['Mod'], key: 'U' }]);
		await vi.waitFor(() => expect(JSON.parse(config.files.get('.obsidian/hotkeys.json')!)).toEqual({ 'test:run': [{ modifiers: ['Mod'], key: 'U' }] }));
		expect(app.hotkeyManager.findConflicts({ modifiers: ['Mod'], key: 'u' }, 'test:run')).toEqual(['test:other']);
		press('j', { mod: true });
		expect(run).not.toHaveBeenCalled();
		app.hotkeyManager.removeHotkeys('test:run');
		press('j', { mod: true });
		expect(run).toHaveBeenCalledTimes(1);
		expect(app.hotkeyManager.printHotkeyForCommand('test:run')).toMatch(/J$/);
	});
});
