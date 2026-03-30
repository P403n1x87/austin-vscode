'use strict';
const path = require('path');

module.exports = {
    ui: 'tdd',
    require: [path.resolve(__dirname, 'out/test/vscode-mock.js')],
    spec: 'out/test/suite/*.test.js',
};
