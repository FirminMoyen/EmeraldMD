// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import '../src';

describe('DOM helpers', () => {
	it('creates elements with options and appends them', () => {
		const parent = createDiv();
		const seen: HTMLElement[] = [];
		const link = parent.createEl('a', { cls: 'foo bar', text: 'hi', href: '/x', attr: { 'data-a': 1, hidden: false } }, (el) => seen.push(el));
		expect(parent.firstChild).toBe(link);
		expect(link.className).toBe('foo bar');
		expect(link.textContent).toBe('hi');
		expect(link.getAttribute('href')).toBe('/x');
		expect(link.getAttr('data-a')).toBe('1');
		expect(link.hasAttribute('hidden')).toBe(false);
		expect(seen).toEqual([link]);
		const first = parent.createSpan({ cls: ['x'], prepend: true });
		expect(parent.firstChild).toBe(first);
		expect(parent.createDiv('only-class').className).toBe('only-class');
	});

	it('manipulates classes, text and children', () => {
		const el = createDiv();
		el.addClass('a', 'b');
		el.removeClass('a');
		el.toggleClass(['c'], true);
		expect(el.className).toBe('b c');
		expect(el.hasClass('c')).toBe(true);
		el.setText('text');
		expect(el.getText()).toBe('text');
		el.setText(createFragment((f) => f.createEl('strong', { text: 'bold' })));
		expect(el.innerHTML).toBe('<strong>bold</strong>');
		el.empty();
		expect(el.childNodes.length).toBe(0);
		const one = el.createSpan({ text: '1' });
		const three = el.createSpan({ text: '3' });
		el.insertAfter(createSpan({ text: '2' }), one);
		expect(el.textContent).toBe('123');
		expect(el.indexOf(three)).toBe(2);
		el.setChildrenInPlace([three, one]);
		expect(el.textContent).toBe('31');
		one.detach();
		expect(el.textContent).toBe('3');
	});

	it('shows, hides and finds', () => {
		const el = createDiv();
		el.hide();
		expect(el.style.display).toBe('none');
		el.show();
		expect(el.style.display).toBe('');
		el.toggle(false);
		expect(el.style.display).toBe('none');
		el.createDiv('x').createSpan('y');
		expect(el.find('.y')?.tagName).toBe('SPAN');
		expect(el.findAll('div, span').length).toBe(2);
		expect(el.querySelector('.y')!.matchParent('.x')).toBe(el.firstChild);
	});

	it('delegates events with on/off', () => {
		const root = document.body.createDiv();
		const child = root.createDiv('item').createSpan();
		const listener = vi.fn();
		root.on('click', '.item', listener);
		child.click();
		expect(listener).toHaveBeenCalledTimes(1);
		expect(listener.mock.calls[0]![1]).toBe(root.firstChild);
		root.off('click', '.item', listener);
		child.click();
		expect(listener).toHaveBeenCalledTimes(1);
		root.detach();
	});

	it('adds array, string and object helpers without making them enumerable', () => {
		const arr = [1, 2, 3, 2];
		expect(arr.first()).toBe(1);
		expect(arr.last()).toBe(2);
		expect(arr.contains(3)).toBe(true);
		arr.remove(2);
		expect(arr).toEqual([1, 3]);
		expect([1, 1, 2].unique()).toEqual([1, 2]);
		const keys: string[] = [];
		for (const key in arr) keys.push(key);
		expect(keys).toEqual(['0', '1']);
		expect('foo {0} {1}'.format('a', 'b')).toBe('foo a b');
		expect('abc'.contains('b')).toBe(true);
		expect(Object.isEmpty({})).toBe(true);
		expect(Math.clamp(10, 0, 5)).toBe(5);
		expect(isBoolean(false)).toBe(true);
		expect(String.isString('x')).toBe(true);
		expect(Array.combine([[1], [2, 3]])).toEqual([1, 2, 3]);
	});

	it('creates SVG elements', () => {
		const svg = createDiv().createSvg('svg', { cls: 'icon', attr: { viewBox: '0 0 10 10' } });
		expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
		expect(svg.getAttribute('viewBox')).toBe('0 0 10 10');
		expect(svg.classList.contains('icon')).toBe(true);
	});
});
