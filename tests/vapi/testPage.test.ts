import { describe, expect, test } from 'vitest';

import { renderTestCallBootstrapScript, renderTestCallPage } from '../../src/vapi/testPage.js';

describe('renderTestCallPage', () => {
  test('includes the client id and language, and a same-origin script src', () => {
    const html = renderTestCallPage({ clientId: 'sakura-seikotsuin', language: 'ja' });

    expect(html).toContain('sakura-seikotsuin');
    expect(html).toContain('ja');
    expect(html).toContain('<script src="/vapi-test-call/sakura-seikotsuin--ja.js">');
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
      '<script src="/vapi-test-call/sakura-seikotsuin--ja.js"></script>',
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

  test("attaches vapi.on('error', ...) and logs the full error object, not just its message", () => {
    const script = renderTestCallBootstrapScript({
      publicKey: 'pub-key',
      assistantId: 'assistant-id',
    });

    expect(script).toContain("window.vapiSDK.vapi.on('error'");
    // Logs the raw value (covers plain-object errors) ...
    expect(script).toContain('console.error(');
    // ... and its own properties via an explicit replacer, so a real Error's
    // non-enumerable message/stack survive JSON.stringify too.
    expect(script).toContain('Object.getOwnPropertyNames(e');
  });

  test('logs the exact publicKey/assistantId and start() arguments right before vapi.start()', () => {
    const script = renderTestCallBootstrapScript({
      publicKey: 'pub-key',
      assistantId: 'assistant-id',
    });

    expect(script).toContain('vapiInstance.start = function');
    expect(script).toContain('Vapi start() configured values:');
    expect(script).toContain('"pub-key"');
    expect(script).toContain('"assistant-id"');
    expect(script).toContain('Vapi start() actual arguments:');
    expect(script).toContain('originalStart.apply(null, arguments)');
  });
});

describe('squad target (VP-3)', () => {
  test('the squad page has no language and names the squad file', () => {
    const html = renderTestCallPage({ clientId: 'sakura-seikotsuin' });

    expect(html).toContain('squad');
    expect(html).toContain('<script src="/vapi-test-call/sakura-seikotsuin--squad.js"></script>');
  });

  test('the bootstrap script starts the call with `squad`, not `assistant`, and logs the squad id', () => {
    const script = renderTestCallBootstrapScript({ publicKey: 'pub-key', squadId: 'squad-uuid' });

    expect(script).toContain('squad: "squad-uuid"');
    expect(script).not.toContain('assistant:');
    expect(script).toContain('squadId: "squad-uuid"');
    expect(script).toContain('window.vapiSDK.run');
  });

  test('a single-assistant script still uses `assistant`, not `squad`', () => {
    const script = renderTestCallBootstrapScript({ publicKey: 'k', assistantId: 'a-1' });

    expect(script).toContain('assistant: "a-1"');
    expect(script).not.toContain('squad:');
  });
});
