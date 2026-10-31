/**
 * Audio recorder (core plugin `audio-recorder`, off by default as in
 * Obsidian): records from the microphone, saves the recording as an
 * attachment (`Recording 20261031153000.webm`, or `.m4a` where the system
 * records MP4) and embeds it in the open note at the cursor. A ribbon button
 * and the "Start recording audio" and "Stop recording audio" commands; the
 * status bar shows how long it has been recording.
 */

import { InternalPluginInstance } from './core-plugins';
import { moment } from './moment';
import { Notice } from './notice';

/** The recording formats to ask for, in order, with the extension of each. */
const FORMATS: [mime: string, extension: string][] = [
	['audio/webm', 'webm'],
	['audio/mp4', 'm4a'],
	['audio/ogg', 'ogg'],
];

interface Recording {
	recorder: MediaRecorder;
	stream: MediaStream;
	chunks: Blob[];
	extension: string;
	started: number;
	timer: ReturnType<typeof setInterval>;
	statusEl: HTMLElement;
	/** The note to embed the recording in: the one open when recording started. */
	notePath: string | null;
}

export class AudioRecorder extends InternalPluginInstance {
	readonly id = 'audio-recorder';
	readonly name = 'Audio recorder';
	readonly description = 'Record audio notes from your microphone and embed them in the open note.';
	private recording: Recording | null = null;
	private ribbonEl: HTMLElement | null = null;

	get isRecording(): boolean {
		return this.recording !== null;
	}

	onEnable(): void {
		this.addCommand({
			id: 'audio-recorder:start',
			name: 'Audio recorder: Start recording audio',
			checkCallback: (checking) => {
				if (this.recording) return false;
				if (!checking) void this.start();
				return true;
			},
		});
		this.addCommand({
			id: 'audio-recorder:stop',
			name: 'Audio recorder: Stop recording audio',
			checkCallback: (checking) => {
				if (!this.recording) return false;
				if (!checking) void this.stop();
				return true;
			},
		});
		this.ribbonEl = this.addRibbonIcon('mic', 'Start/stop recording', () => void (this.recording ? this.stop() : this.start()));
	}

	override disable(): void {
		this.discard();
		super.disable();
	}

	/** Starts recording; asks the system for the microphone the first time. */
	async start(): Promise<void> {
		if (this.recording) return;
		const format = FORMATS.find(([mime]) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime));
		if (!format || !navigator.mediaDevices?.getUserMedia) {
			new Notice('Recording audio is not supported here.');
			return;
		}
		let stream: MediaStream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch (err) {
			new Notice(`Could not use the microphone: ${(err as Error).message ?? err}`);
			return;
		}
		const recorder = new MediaRecorder(stream, { mimeType: format[0] });
		const chunks: Blob[] = [];
		recorder.addEventListener('dataavailable', (event) => {
			if (event.data.size) chunks.push(event.data);
		});
		const statusEl = this.app.statusBar.containerEl.createDiv({ cls: 'status-bar-item mod-clickable audio-recorder-status', attr: { 'aria-label': 'Stop recording' } });
		statusEl.addEventListener('click', () => void this.stop());
		const started = Date.now();
		const tick = () => {
			const seconds = Math.floor((Date.now() - started) / 1000);
			statusEl.setText(`● Recording ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`);
		};
		tick();
		this.recording = {
			recorder,
			stream,
			chunks,
			extension: format[1],
			started,
			timer: setInterval(tick, 1000),
			statusEl,
			notePath: this.app.workspace.getActiveFile()?.path ?? null,
		};
		this.ribbonEl?.addClass('is-recording');
		recorder.start();
	}

	/** Stops recording, saves the recording and embeds it in the note. */
	async stop(): Promise<void> {
		const recording = this.recording;
		if (!recording) return;
		const stopped = new Promise<void>((resolve) => recording.recorder.addEventListener('stop', () => resolve(), { once: true }));
		recording.recorder.stop();
		await stopped;
		this.discard();
		const data = await new Blob(recording.chunks, { type: recording.recorder.mimeType }).arrayBuffer();
		if (!data.byteLength) {
			new Notice('Nothing was recorded.');
			return;
		}
		const app = this.app;
		try {
			const name = `Recording ${moment(recording.started).format('YYYYMMDDHHmmss')}.${recording.extension}`;
			const path = await app.fileManager.getAvailablePathForAttachment(name, recording.notePath ?? undefined);
			const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
			if (folder && !app.vault.getFolderByPath(folder)) await app.vault.createFolder(folder);
			const file = await app.vault.createBinary(path, data);
			const editor = app.workspace.activeEditor;
			if (editor?.editor && editor.file && editor.file.path === recording.notePath) {
				editor.editor.replaceSelection(`!${app.fileManager.generateMarkdownLink(file, editor.file.path)}`);
			} else {
				new Notice(`Saved ${file.path}.`);
			}
		} catch (err) {
			new Notice(`Could not save the recording: ${err}`);
		}
	}

	/** Ends the recording session: microphone off, status removed (the recording itself is handled by `stop`). */
	private discard(): void {
		const recording = this.recording;
		if (!recording) return;
		this.recording = null;
		clearInterval(recording.timer);
		for (const track of recording.stream.getTracks()) track.stop();
		if (recording.recorder.state !== 'inactive') recording.recorder.stop();
		recording.statusEl.remove();
		this.ribbonEl?.removeClass('is-recording');
	}
}
