import * as fs from 'fs';
import * as vscode from 'vscode';

/**
 * Loads an HTML template from the media/ directory, resolves any
 * `{{key}}` placeholders using the provided vars map, and returns the
 * resulting HTML string ready to set as webview.html.
 *
 * URI values for scripts and stylesheets should be created with
 * `webview.asWebviewUri(...)` and passed in via vars.
 */
export function loadWebviewHtml(
    extensionUri: vscode.Uri,
    filename: string,
    vars: Record<string, string>
): string {
    const filePath = vscode.Uri.joinPath(extensionUri, 'media', filename);
    let html = fs.readFileSync(filePath.fsPath, 'utf8');
    for (const [key, value] of Object.entries(vars)) {
        html = html.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
    }
    return html;
}
