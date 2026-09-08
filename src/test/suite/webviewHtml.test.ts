import * as assert from 'assert';
import * as vscode from 'vscode';
import { loadWebviewHtml } from '../../utils/webviewHtml';

// loadWebviewHtml resolves `<extensionUri>/media/<filename>` and does plain
// `{{key}}` substitution -- run against the repo root so these tests exercise
// the real .html templates, not fixtures, catching a placeholder/template
// mismatch (e.g. a `{{key}}` in the .html with no matching `vars` entry, or
// vice versa) that a real webview load would otherwise fail on silently.
const extensionUri = { fsPath: process.cwd() } as vscode.Uri;

suite('loadWebviewHtml', () => {
    test('substitutes every {{placeholder}} in a template', () => {
        const html = loadWebviewHtml(extensionUri, 'tasks.html', {
            utilsScriptUri: 'UTILS_URI',
            scriptUri: 'SCRIPT_URI',
            codiconsUri: 'CODICONS_URI',
            viewsCssUri: 'VIEWS_CSS_URI',
            cssUri: 'CSS_URI',
        });
        assert.ok(!html.includes('{{'), `unsubstituted placeholder left in output:\n${html}`);
    });

    test('tasks.html loads flamegraph-utils.js before tasks.js, so FlamegraphUtils is defined when tasks.js runs', () => {
        const html = loadWebviewHtml(extensionUri, 'tasks.html', {
            utilsScriptUri: 'UTILS_URI',
            scriptUri: 'SCRIPT_URI',
            codiconsUri: 'CODICONS_URI',
            viewsCssUri: 'VIEWS_CSS_URI',
            cssUri: 'CSS_URI',
        });
        const utilsIndex = html.indexOf('<script src="UTILS_URI">');
        const scriptIndex = html.indexOf('<script src="SCRIPT_URI">');
        assert.notStrictEqual(utilsIndex, -1, 'expected a script tag for utilsScriptUri');
        assert.notStrictEqual(scriptIndex, -1, 'expected a script tag for scriptUri');
        assert.ok(utilsIndex < scriptIndex, 'flamegraph-utils.js must load before tasks.js');
    });
});
