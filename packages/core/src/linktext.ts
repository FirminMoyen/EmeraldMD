/** Splits `Note#Heading` into `{ path: "Note", subpath: "#Heading" }`. */
export function parseLinktext(linktext: string): { path: string; subpath: string } {
	const i = linktext.indexOf('#');
	if (i === -1) return { path: linktext.trim(), subpath: '' };
	return { path: linktext.slice(0, i).trim(), subpath: linktext.slice(i) };
}

export function getLinkpath(linktext: string): string {
	return parseLinktext(linktext).path;
}
