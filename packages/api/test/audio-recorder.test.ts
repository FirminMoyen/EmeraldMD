// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import '../src';
import { AudioRecorder } from '../src';
import { createTestApp } from '../src/testing';

afterEach(() => document.body.replaceChildren());

/** A recorder that "records" three bytes; it can make MP4 only, as WebKit does. */
class FakeRecorder extends EventTarget {
	static isTypeSupported(mime: string) {
		return mime === 'audio/mp4';
	}
	state: 'inactive' | 'recording' = 'inactive';
	constructor(
		readonly stream: unknown,
		readonly options: { mimeType: string },
	) {
		super();
	}
	get mimeType() {
		return this.options.mimeType;
	}
	start() {
		this.state = 'recording';
	}
	stop() {
		if (this.state === 'inactive') return;
		this.state = 'inactive';
		this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: new Blob(['abc']) }));
		this.dispatchEvent(new Event('stop'));
	}
}

it('records, saves the recording as an attachment, and turns the microphone off', async () => {
	const track = { stop: vi.fn() };
	vi.stubGlobal('MediaRecorder', FakeRecorder);
	Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) } });
	const { app, backend } = await createTestApp({ 'Note.md': 'text' }, { '.obsidian/core-plugins.json': JSON.stringify({ 'audio-recorder': true }), '.obsidian/app.json': JSON.stringify({ attachmentFolderPath: 'Attachments' }) });
	await app.internalPlugins.load(app);
	const recorder = app.internalPlugins.getEnabledPluginById('audio-recorder') as AudioRecorder;
	expect(app.commands.findCommand('audio-recorder:stop')?.checkCallback?.(true)).toBe(false);

	expect(app.commands.executeCommandById('audio-recorder:start')).toBe(true);
	await vi.waitFor(() => expect(recorder.isRecording).toBe(true));
	expect(app.statusBar.containerEl.querySelector('.audio-recorder-status')?.textContent).toBe('● Recording 0:00');
	expect(app.commands.findCommand('audio-recorder:start')?.checkCallback?.(true)).toBe(false);

	await recorder.stop();
	expect(recorder.isRecording).toBe(false);
	expect(track.stop).toHaveBeenCalled();
	expect(app.statusBar.containerEl.querySelector('.audio-recorder-status')).toBeNull();
	const saved = [...backend.files.keys()].find((path) => /^Attachments\/Recording \d{14}\.m4a$/.test(path));
	expect(saved).toBeDefined();
	expect(backend.files.get(saved!)).toBe('abc');
	vi.unstubAllGlobals();
});

it('says so when there is no microphone access', async () => {
	vi.stubGlobal('MediaRecorder', FakeRecorder);
	Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => Promise.reject(new Error('Permission denied'))) } });
	const { app } = await createTestApp({}, { '.obsidian/core-plugins.json': JSON.stringify({ 'audio-recorder': true }) });
	await app.internalPlugins.load(app);
	const recorder = app.internalPlugins.getEnabledPluginById('audio-recorder') as AudioRecorder;
	await recorder.start();
	expect(recorder.isRecording).toBe(false);
	expect(document.querySelector('.notice')?.textContent).toContain('Permission denied');
	vi.unstubAllGlobals();
});
