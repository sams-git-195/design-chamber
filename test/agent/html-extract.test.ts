import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { deriveArtifactTitle, extractHtml } from '../../src/shared/agent/html-extract.ts';

const PAGE = '<!doctype html>\n<html lang="en"><head><title>Hello</title></head><body><h1>Hi</h1></body></html>';

describe('extractHtml', () => {
  test('takes a ```html block', () => {
    assert.equal(extractHtml(`Here you go:\n\n\`\`\`html\n${PAGE}\n\`\`\`\n\nEnjoy.`), PAGE);
  });

  test('takes a ```htm block and ignores the info-string case', () => {
    assert.equal(extractHtml('```htm\n<p>one</p>\n```'), '<p>one</p>');
    assert.equal(extractHtml('```HTML\n<p>two</p>\n```'), '<p>two</p>');
  });

  test('takes an unlabeled block that starts with a doctype', () => {
    assert.equal(extractHtml(`\`\`\`\n${PAGE}\n\`\`\``), PAGE);
  });

  test('takes an unlabeled block that contains <html> or <body>', () => {
    assert.equal(extractHtml('```\n<html><p>x</p></html>\n```'), '<html><p>x</p></html>');
    assert.equal(extractHtml('```text\n<BODY class="a">x</BODY>\n```'), '<BODY class="a">x</BODY>');
  });

  test('the longest candidate wins, whatever its label', () => {
    const small = '```html\n<p>small</p>\n```';
    const big = `\`\`\`\n${PAGE}\n\`\`\``;
    assert.equal(extractHtml(`${small}\n\n${big}`), PAGE);
    assert.equal(extractHtml(`${big}\n\n${small}`), PAGE);
    const bigLabelled = `\`\`\`html\n${PAGE}\n<!-- more -->\n\`\`\``;
    assert.equal(extractHtml(`${bigLabelled}\n\n${big}`), `${PAGE}\n<!-- more -->`);
  });

  test('no candidate → null', () => {
    assert.equal(extractHtml('No code here, only <b>prose</b> with tags.'), null);
    assert.equal(extractHtml('```css\nbody { color: red }\n```'), null);
    assert.equal(extractHtml('```js\ndocument.body.append(x)\n```'), null);
    assert.equal(extractHtml('```html\n   \n```'), null);
    assert.equal(extractHtml(''), null);
  });

  test('handles ~~~ fences, a longer fence around an inner fence, indented fences and CRLF', () => {
    assert.equal(extractHtml('~~~html\n<p>tilde</p>\n~~~'), '<p>tilde</p>');
    assert.equal(extractHtml('````html\n<pre>\n```\ninner\n```\n</pre>\n````'), '<pre>\n```\ninner\n```\n</pre>');
    assert.equal(extractHtml('1. Save this:\n\n   ```html\n   <p>nested</p>\n   ```\n'), '<p>nested</p>');
    assert.equal(extractHtml('```html\r\n<p>crlf</p>\r\n```\r\n'), '<p>crlf</p>');
  });

  test('an unterminated block (a cut-off message) runs to the end', () => {
    assert.equal(extractHtml('```html\n<p>cut off'), '<p>cut off');
  });

  test('inline code that looks like a fence is not a block', () => {
    assert.equal(extractHtml('```<html>``` is the root tag.\nMore prose.'), null);
  });
});

describe('deriveArtifactTitle', () => {
  const message = (md: string, html = PAGE): [string, string] => [`${md}\n\n\`\`\`html\n${html}\n\`\`\``, html];

  test('prefers the page <title>, decoding entities', () => {
    const [text, html] = message('# Heading', '<html><head><title>Tom &amp; Jerry &#8212; fan page</title></head></html>');
    assert.equal(deriveArtifactTitle(text, html, 'Chat'), 'Tom & Jerry — fan page');
  });

  test('then the first Markdown heading of the message (not one inside a code block)', () => {
    const html = '<div>no title</div>';
    assert.equal(deriveArtifactTitle(`\`\`\`sh\n# a shell comment\n\`\`\`\n## A pricing page\n\n\`\`\`html\n${html}\n\`\`\``, html, 'Chat'), 'A pricing page');
  });

  test('then the first <h1>, then the session title, then a constant', () => {
    assert.equal(deriveArtifactTitle('text', '<main><h1 class="x">Big <em>news</em></h1></main>', 'Chat'), 'Big news');
    assert.equal(deriveArtifactTitle('text', '<p>x</p>', 'My chat'), 'My chat');
    assert.equal(deriveArtifactTitle('text', '<p>x</p>', '  '), 'HTML artifact');
  });

  test('is one line and at most 120 characters', () => {
    const long = `Line one\n${'x'.repeat(300)}`;
    const title = deriveArtifactTitle('', `<title>${long}</title>`, 'Chat');
    assert.ok(title.length <= 120 && !title.includes('\n'));
    assert.ok(title.endsWith('…'));
  });
});
