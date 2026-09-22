import { describe, expect, test } from 'vitest';

import { renderTestCallBootstrapScript, renderTestCallPage } from '../../src/vapi/testPage.js';

describe('renderTestCallPage', () => {
  test('includes the client id and language, and a same-origin module script src', () => {
    const html = renderTestCallPage({ clientId: 'sakura-seikotsuin', language: 'ja' });

    expect(html).toContain('sakura-seikotsuin');
    expect(html).toContain('ja');
    expect(html).toContain('<script type="module" src="/vapi-test-call/sakura-seikotsuin--ja.js">');
  });

  test('includes start/end call buttons (the new SDK has no auto-injected widget UI)', () => {
    const html = renderTestCallPage({ clientId: 'sakura-seikotsuin', language: 'ja' });

    expect(html).toContain('id="start-call-button"');
    expect(html).toContain('id="end-call-button"');
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
      '<script type="module" src="/vapi-test-call/sakura-seikotsuin--ja.js"></script>',
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

  test('imports @vapi-ai/web directly (VP-6 R3) — not the stale html-script-tag wrapper', () => {
    const script = renderTestCallBootstrapScript({
      publicKey: 'pub-key',
      assistantId: 'assistant-id',
    });

    expect(script).toContain('import VapiModule from');
    expect(script).toContain('@vapi-ai/web@');
    expect(script).not.toContain('html-script-tag');
    expect(script).not.toContain('window.vapiSDK');
    expect(script).toContain('new Vapi(');
  });

  test("attaches vapi.on('error', ...) and logs the full error object, not just its message", () => {
    const script = renderTestCallBootstrapScript({
      publicKey: 'pub-key',
      assistantId: 'assistant-id',
    });

    expect(script).toContain("vapi.on('error'");
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

    expect(script).toContain('vapi.start = function');
    expect(script).toContain('Vapi start() configured values:');
    expect(script).toContain('"pub-key"');
    expect(script).toContain('"assistant-id"');
    expect(script).toContain('Vapi start() actual arguments:');
    expect(script).toContain('originalStart.apply(null, arguments)');
  });

  test('starts the call from the start-call-button click, not automatically', () => {
    const script = renderTestCallBootstrapScript({
      publicKey: 'pub-key',
      assistantId: 'assistant-id',
    });

    expect(script).toContain("getElementById('start-call-button')");
    expect(script).toContain("getElementById('end-call-button')");
    expect(script).toContain('vapi.stop()');
  });
});

describe('squad target (VP-3)', () => {
  test('the squad page has no language and names the squad file', () => {
    const html = renderTestCallPage({ clientId: 'sakura-seikotsuin' });

    expect(html).toContain('squad');
    expect(html).toContain(
      '<script type="module" src="/vapi-test-call/sakura-seikotsuin--squad.js"></script>',
    );
  });

  test('the bootstrap script starts the call with the squad id as the 3rd positional argument, and logs it', () => {
    const script = renderTestCallBootstrapScript({ publicKey: 'pub-key', squadId: 'squad-uuid' });

    expect(script).toContain('vapi.start(undefined, undefined, "squad-uuid")');
    expect(script).toContain('squadId: "squad-uuid"');
  });

  test('a single-assistant script starts with the assistant id as the 1st positional argument', () => {
    const script = renderTestCallBootstrapScript({ publicKey: 'k', assistantId: 'a-1' });

    expect(script).toContain('vapi.start("a-1")');
    expect(script).not.toContain('squadId:');
  });
});
