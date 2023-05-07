# Austin VS Code Extension

[![Visual Studio Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/p403n1x87.austin-vscode.svg?style=flat-square&color=blue&logo=visual-studio)](https://marketplace.visualstudio.com/items?itemName=p403n1x87.austin-vscode)

Profile and analyse your Python application inside VS Code using Austin.

<p align="center">
    <img src="https://github.com/P403n1x87/austin-vscode/raw/main/art/demo.gif"
        alt="Austin VS Code Extension demo" />
</p>


## Pre-requisites

This extension requires Austin 3. See
[Austin](https://github.com/p403n1x87/austin#installation) for installation
instructions for your platform. If you want to compile from sources or use one
of the available release binaries, you can specify the absolute location of the
Austin binary in the settings.


## Usage

There are two ways of executing Austin from VS Code. Either using a configured
task, or a one-off execution.

> **NOTE** MacOS users should consider adding a rule for Austin to their
> `sudoers` file. This will allow you to run `sudo austin ...` without having to
> type your user password. This is required if you want to run Austin through
> the extension tasks. To add a rule for Austin to the `sudoers` file, run `sudo
> visudo` and add
> ~~~
> <USER>        ALL = (root) NOPASSWD: <PATH_TO_AUSTIN>
> ~~~
> at the end, replacing `<USER>` and `<PATH_TO_AUSTIN>` with your user name and
> the path to the Austin binary respectively.

### Profiling with tasks

The Austin extension provides a `"austin"` task type to VS Code. The VS Code
[Tasks](https://code.visualstudio.com/docs/editor/tasks#_custom-tasks)
system is the best way to define jobs to run against your code, like profiling.
Create a `tasks.json` inside the `.vscode` folder in the root of your workspace:

```json
{
    "version": "2.0.0",
    "tasks": [
        {
            "type": "austin",
            "file": "main.py",
            "label": "Profile main.py",
        }
    ]
}
```

You can also specify a list of arguments to send to your Python script.
This is equivalent of running `python main.py --verbose`:

```json
{
    "version": "2.0.0",
    "tasks": [
        {
            "type": "austin",
            "file": "main.py",
            "args": ["--verbose"],
            "label": "Profile main.py",
        }
    ]
}
```

To Run the task, execute `Tasks: Run Task` from the Command Palette and select
the task you specified in `tasks.json`.

If you need to run a more generic command, for example by invoking a virtual
environment manager like Poetry, you can use the `command` field, e.g.

```json
{
    "version": "2.0.0",
    "tasks": [
        {
            "type": "austin",
            "label": "Profile tests",
            "command": [
                "poetry",
                "run"
            ],
            "args": [
                "python",
                "-m",
                "pytest",
            ]
        }
    ]
}
```

In the above task definition, the Austin command is placed in between the
`command` and the `args` lists. That is, the above ends up running

```console
poetry run austin <austin args> python -m pytest
```

from the current working directory.

### Profiling a standalone script

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

The extension also adds two interactive tree views in the side bar to explore
the sampled call stack and the top functions. Click on the Austin logo in the
activity bar to reveal them.


### Expression-level heat maps

To enable support for column-level location information, ensure that the Austin
extension is set up to use the binary mode in the extension settings. Note that
this requires at least the version 3.5 of Austin to work. Binary mode itself
only requires Austin 3.4 to work. Earlier Austin versions don't support binary
mode and the extension won't work if in binary mode.


<!-- To toggle line numbers, press <kbd>L</kbd>. This could be useful when the same
Python module has multiple methods with the same names (e.g. `__init__`), since
the function names collected by Austin are not fully qualified. -->

## Configuration

Whenever you have an active Python script, the sampling interval and mode
selector will appear  on the status bar. Select between wall-clock time and CPU
time sampling, and the sampling interval in microseconds.
