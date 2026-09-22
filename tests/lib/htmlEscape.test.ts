import { describe, expect, test } from 'vitest';

import { escapeHtml } from '../../src/lib/htmlEscape.js';

describe('escapeHtml', () => {
  test('escapes the five HTML-significant characters', () => {
    expect(escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  test('turns an injected script tag into inert text', () => {
    const escaped = escapeHtml('<script>alert(1)</script>');

    expect(escaped).not.toContain('<script>');
    expect(escaped).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  test('leaves ordinary text unchanged', () => {
    expect(escapeHtml('Asked about a treatment')).toBe('Asked about a treatment');
  });

  test('leaves non-ASCII text (Japanese) unchanged', () => {
    expect(escapeHtml('山田花子さんの件です。')).toBe('山田花子さんの件です。');
  });

  test('escapes an attribute-breakout attempt', () => {
    const escaped = escapeHtml('"><img src=x onerror=alert(1)>');

    expect(escaped).not.toContain('"');
    expect(escaped).not.toContain('<img');
  });
});
