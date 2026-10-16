/**
 * `requestUrl`: HTTP without CORS restrictions. The desktop shell routes it
 * through a Rust command (see `setRequestBackend`); the default uses `fetch`.
 */

export interface RequestUrlParam {
	url: string;
	method?: string;
	contentType?: string;
	body?: string | ArrayBuffer;
	headers?: Record<string, string>;
	/** Reject on status >= 400. Defaults to true. */
	throw?: boolean;
}

export interface RequestUrlResponse {
	status: number;
	headers: Record<string, string>;
	arrayBuffer: ArrayBuffer;
	json: unknown;
	text: string;
}

export interface RequestUrlResponsePromise extends Promise<RequestUrlResponse> {
	arrayBuffer: Promise<ArrayBuffer>;
	json: Promise<unknown>;
	text: Promise<string>;
}

export interface RawResponse {
	status: number;
	headers: Record<string, string>;
	body: ArrayBuffer;
}

export type RequestBackend = (request: RequestUrlParam) => Promise<RawResponse>;

const fetchBackend: RequestBackend = async (request) => {
	const headers = new Headers(request.headers);
	if (request.contentType) headers.set('Content-Type', request.contentType);
	const response = await fetch(request.url, { method: request.method ?? 'GET', headers, body: request.body });
	const out: Record<string, string> = {};
	response.headers.forEach((value, key) => (out[key] = value));
	return { status: response.status, headers: out, body: await response.arrayBuffer() };
};

let backend: RequestBackend = fetchBackend;

/** Replaces how requests are sent (the desktop shell uses a Rust command). */
export function setRequestBackend(next: RequestBackend): void {
	backend = next;
}

export class RequestUrlError extends Error {
	status: number;
	headers: Record<string, string>;
	text: string;

	constructor(url: string, response: RequestUrlResponse) {
		super(`Request failed, status ${response.status}`);
		this.status = response.status;
		this.headers = response.headers;
		this.text = response.text;
		this.name = 'RequestUrlError';
		Object.defineProperty(this, 'url', { value: url });
	}
}

async function send(param: RequestUrlParam): Promise<RequestUrlResponse> {
	const raw = await backend(param);
	const bytes = raw.body;
	let text: string | undefined;
	let json: unknown;
	let jsonParsed = false;
	const response: RequestUrlResponse = {
		status: raw.status,
		headers: raw.headers,
		arrayBuffer: bytes,
		get text() {
			text ??= new TextDecoder().decode(bytes);
			return text;
		},
		get json() {
			if (!jsonParsed) {
				json = JSON.parse(this.text);
				jsonParsed = true;
			}
			return json;
		},
	};
	if (param.throw !== false && raw.status >= 400) throw new RequestUrlError(param.url, response);
	return response;
}

export function requestUrl(request: RequestUrlParam | string): RequestUrlResponsePromise {
	const param = typeof request === 'string' ? { url: request } : request;
	const promise = send(param) as RequestUrlResponsePromise;
	Object.defineProperties(promise, {
		arrayBuffer: { get: () => promise.then((r) => r.arrayBuffer) },
		json: { get: () => promise.then((r) => r.json) },
		text: { get: () => promise.then((r) => r.text) },
	});
	return promise;
}

export async function request(req: RequestUrlParam | string): Promise<string> {
	return (await requestUrl(req)).text;
}
