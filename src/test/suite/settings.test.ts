import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { AustinRuntimeSettings, DEFAULT_INTERVAL, DEFAULT_MODE, DEFAULT_PATH } from '../../settings';

suite('Runtime SettingsTest Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Test Default Values are valid', () => {
		assert.strictEqual(AustinRuntimeSettings.get().settings.path, DEFAULT_PATH);
		assert.strictEqual(AustinRuntimeSettings.get().settings.interval, DEFAULT_INTERVAL);
		assert.strictEqual(AustinRuntimeSettings.get().settings.mode, DEFAULT_MODE);
	});
});
