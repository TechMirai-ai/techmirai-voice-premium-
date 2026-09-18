import { describe, expect, test } from 'vitest';

import { renderTestCallBootstrapScript, renderTestCallPage } from '../../src/vapi/testPage.js';

describe('renderTestCallPage', () => {
  test('includes the client id and language, and a same-origin script src', () => {
    const html = renderTestCallPage({ clientId: 'sakura-seikotsuin', language: 'ja' });

    expect(html).toContain('sakura-seikotsuin');
    expect(html).toContain('ja');
    expect(html).toContain(
      '<script src="/vapi-test-call.js?clientId=sakura-seikotsuin&amp;language=ja">',
    );
  });

  test('HTML-escapes clientId/language to prevent injection into the page body', () => {
    const html = renderTestCallPage({ clientId: '<script>alert(1)</script>', language: 'ja' });

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  test('never inlines a <script> block with executable content (CSP script-src has no unsafe-inline)', () => {
    const html = renderTestCallPage({ clientId: 'sakura-seikotsuin', language: 'ja' });

    // The only <script> tag is the same-origin src reference — no inline body.
    expect(html.match(/<script\b[^>]*>[\s\S]*?<\/script>/g)).toEqual([
      '<script src="/vapi-test-call.js?clientId=sakura-seikotsuin&amp;language=ja"></script>',
    ]);
  });
});

describe('renderTestCallBootstrapScript', () => {
  test('includes the public key and assistant id', () => {
    const script = renderTestCallBootstrapScript({
      publicKey: 'pub-key-123',
      assistantId: 'assistant-uuid-456',
    });

    expect(script).toContain('"pub-key-123"');
    expect(script).toContain('"assistant-uuid-456"');
  });

  test('escapes a </script> sequence inside publicKey/assistantId so it cannot break out if ever inlined', () => {
    const script = renderTestCallBootstrapScript({
      publicKey: '</script><script>alert(1)</script>',
      assistantId: 'assistant-id',
    });

    expect(script).not.toContain('</script><script>alert(1)</script>');
  });

  test('references the hosted Vapi script-tag embed, not @vapi-ai/web', () => {
    const script = renderTestCallBootstrapScript({
      publicKey: 'pub-key',
      assistantId: 'assistant-id',
    });

    expect(script).toContain('html-script-tag');
    expect(script).toContain('window.vapiSDK.run');
  });
});
