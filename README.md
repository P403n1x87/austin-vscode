# Austin VS Code Extension

Profile and analyse your Python application inside VS Code using Austin.

<p align="center">
    <img src="https://github.com/P403n1x87/austin-vscode/raw/main/art/demo.gif"
        alt="Austin VS Code Extension demo" />
</p>


## Pre-requisites

This extension requires Austin 4. See
[Austin](https://github.com/p403n1x87/austin#installation) for installation
instructions for your platform. If you want to compile from sources or use one
of the available release binaries, you can specify the absolute location of the
Austin binary in the settings.

> [!WARNING]
> On macOS and Linux, this extension may prompt you for your administrator
> password when starting or stopping a profiling session. This is because
> Austin requires elevated privileges to profile processes. You can avoid
> password prompts by adding Austin to your sudoers file (see below).


## Usage

There are two ways of executing Austin from VS Code. Either using a configured
task, or a one-off execution.

> [!NOTE]
> When using a Python virtual environment, you might need to manually add the
> path of the Austin binary to the extension settings. You can do so by
> searching for the `austin.path` setting and typing the (absolute) path to
> the binary, e.g. `/home/user/project/.venv/bin/austin`.

> [!NOTE]
> macOS and Linux users should add Austin to their `sudoers` file to avoid
> password prompts when starting the profiler. However, stopping the profiler
> (detaching from a process) may still require your password unless you also add
> `kill` to the sudoers. To add Austin to the `sudoers` file, run `sudo visudo`
> and add
> ~~~
> <USER>        ALL = (root) NOPASSWD: <PATH_TO_AUSTIN>
> ~~~
> at the end, replacing `<USER>` and `<PATH_TO_AUSTIN>` with your user name and
> the path to the Austin binary respectively. If you are using environment files
> in task definitions, you might also need to use the `SETENV` directive:
> ~~~
> <USER>        ALL = (root) NOPASSWD:SETENV: <PATH_TO_AUSTIN>
> ~~~
>
> If you prefer not to add Austin to sudoers, you can install an askpass helper:
> - **macOS**: The extension includes a built-in askpass that will prompt for your
>   password via a dialog.
> - **Linux**: Install `ssh-askpass`, `ksshaskpass`, or `ksshaskpass-gnome`, or
>   use `zenity` (`sudo apt install zenity` on Debian/Ubuntu).

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

Tasks also support the use of the placeholders `${workspaceFolder}` and
`${file}`, and the use of environment files via the `envFile` property. To make
use of the latter on MacOS, you need to use `["sudo", "-E"]` for the `command`
property.

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

The extension also adds interactive tree views in the side bar to explore the
sampled call stack, the top functions, and GC activity. Click on the Austin logo
in the activity bar to reveal them.

### GC Activity

Enable garbage collector data collection with the **GC** toggle in the status
bar. When GC data is present, a collapsible **GC Activity** swimlane panel
appears above the flame graph, showing per-thread GC spans as proportional
blocks on a timeline. Hovering a span reveals the top contributing frames;
clicking a thread label zooms the flame graph to that thread.

The **GC Top** sidebar panel lists the functions that were on the stack during
GC collection, ranked by own GC time, with a per-thread summary at the top.
Clicking a thread row zooms the flame graph to that thread; clicking a frame
row opens the source file at the corresponding line.


### Expression-level heat maps

The extension supports expression-level profiling data from Austin. This
requires using CPython 3.11 or above, where column-level information is also
available to collect.


## AI Chat Integration (MCP)

The extension exposes profiling data to AI chat sessions via an MCP server that
starts automatically when the extension activates. The following tools are
available:

### Data tools

These tools require a loaded profiling session.

| Tool | Parameters | Description |
|---|---|---|
| `get_top` | `limit` (optional) | Top functions sorted by own time. |
| `get_call_stacks` | `depth` (optional, default 15), `threshold` (optional, default 0) | Process→thread→function call-stack tree. Each node carries a unique `nodeId`. Set `threshold` to a minimum total-% to prune low-contribution branches. |
| `get_metadata` | — | Source file, sampling mode, interval, and total sample count. |
| `get_gc_data` | `limit` (optional) | Per-thread GC time fractions and top functions on the stack during GC, ranked by own GC time. Returns `available: false` if GC collection was not enabled for the session. |

### Action tools

| Tool | Parameters | Description |
|---|---|---|
| `load_profile` | `path` (required) | Load an Austin profile file (`.austin`, `.aprof`, or `.mojo`) and open it in the flame graph view. |
| `focus_flamegraph` | `nodeId` (required) | Zoom the flame graph to a node by its `nodeId` (returned by `get_call_stacks`). |
| `search_flamegraph` | `term` (required) | Highlight all flame graph frames matching a substring. |

All time and memory values are expressed as a percentage of the total observed
metric for the session.

### GitHub Copilot

The MCP server is registered automatically with VS Code's built-in MCP client.
No configuration is required — the tools appear in Copilot agent mode as soon
as the extension activates, under the names `mcp_austin_get_top`,
`mcp_austin_get_call_stacks`, `mcp_austin_get_metadata`, and
`mcp_austin_get_gc_data`.

### Other agents (Claude Code, Cursor, etc.)

Run the **Austin: Generate .mcp.json** command from the Command Palette to
write a `.mcp.json` file to your workspace root. This file points the agent's
MCP client at the local server. You only need to do this once: if a `.mcp.json`
with an austin entry already exists, the extension updates the port
automatically on every restart.


## Configuration

Whenever you have an active Python script, the sampling interval and mode
selector will appear  on the status bar. Select between wall-clock time and CPU
time sampling, and the sampling interval in microseconds.
