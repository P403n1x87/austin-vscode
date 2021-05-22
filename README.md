# Austin VS Code Extension

Profile and analyse your Python application inside VS Code using Austin.

<p align="center">
    <img src="https://github.com/P403n1x87/austin-vscode/raw/main/art/flamegraph-heatmap-demo.gif"
        alt="Austin VS Code Extension demo" />
</p>


## Pre-requisites

This extension requires Austin 3. See
[Austin](https://github.com/p403n1x87/austin#installation) for installation
instructions for your platform. If you want to compile from sources or use one
of the available release binaries, you can specify the absolute location of the
Austin binary in the settings.


## Usage

To profile a Python script, open it up in VS Code, open the command palette and
search for `Profile with Austin`, or press  <kbd>Shift</kbd> + <kbd>F5</kbd>. If
you already have a file with Austin samples, open the panel, head to the `FLAME
GRAPH` view and click the `OPEN` button to select the file. Alternatively, once
the panel has been revealed, search for the `Load Austin samples ...` command in
the palette, or press <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Shift</kbd> +
<kbd>A</kbd>.

The flame graph is interactive and when you click on a frame, the corresponding
source will be opened (assuming that all the paths can be resolved correctly) in
VS Code and lines highlighted based on the amount of time spent on them.

To search through an open flame graph, press <kbd>F</kbd> and type a search
string. To reset the view, simply press <kbd>R</kbd>. Conveniently, you can
bring up the open dialog with <kbd>O</kbd> while the focus is on the flame graph
panel.

## Configuration

Whenver you have an active Python script, the sampling interval and mode
selector will appear  on the status bar. Select between wall-clock time and CPU
time sampling, and the sampling interval in microseconds.
