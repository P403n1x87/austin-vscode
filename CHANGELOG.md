# Change Log

## [1.3.0]

### MCP Server Changes

- Added a `load_profile` MCP tool that lets an AI agent open a profile file by
  path. The file is loaded and the flame graph view is revealed automatically,
  so the agent can display profiling results to the user without any manual
  interaction.

- Added a `focus_flamegraph` MCP tool that lets an AI agent highlight and zoom
  to a specific node in the flame graph, for AI-assisted flame graph
  navigation.

- Added a `search_flamegraph` MCP tool that highlights every frame whose
  function name contains a given term across all threads and call chains.
  Unlike `focus_flamegraph`, which zooms to a single node by exact path key,
  this is useful for showing all occurrences of a function at once.

- `get_call_stacks` increased the default expansion depth from 5 to 15 to reach
  past framework boilerplate into user code, and accepts a `threshold` parameter
  (in total%) to prune call-stack branches that contribute less than the given
  percentage of total profiling time — keeping the response compact for large
  profiles. The tool description now explains how to read `total` as flame graph
  width and use `module` paths to identify user code versus third-party
  libraries.

### Other Improvements

- The **Top** panel now caps the number of displayed entries with a configurable
  limit (`austin.topEntryLimit`), improving responsiveness on large profiles.

- Consolidated profiling configuration into a **single status bar item** for a
  cleaner UI.

- Improved the visual appearance of **native frames** across the flame graph,
  call stacks, GC top, and top functions views.

- Added the **Metadata** view to display the metadata entries from the loaded
  profile.

## [1.2.0]

### GC Activity

- Added a **GC Activity** timeline panel inside the flame graph view, showing
  per-thread garbage collector activity as proportional time spans. Hovering a
  span shows the top-3 contributing leaf frames. Clicking a thread label zooms
  the flame graph to that thread.

- Added a **GC Top** sidebar panel listing the functions that were on the stack
  during GC collection, with own and total GC time percentages, per-thread GC
  summaries, and a filter bar. Clicking a thread row zooms the flame graph to
  that thread; clicking a frame row opens the source file at that location.

- Added a **GC** toggle in the status bar to enable or disable GC data
  collection (`-g` / `--gc` flag). The toggle is persisted across sessions.

- Added a `get_gc_data` MCP tool that exposes per-thread GC fractions and
  the top functions executing during GC collection to AI chat agents.

## [1.1.2]

- Fixed more packaging issues.

## [1.1.1]

- Reduced the package size by omitting unnecessary multimedia assets from the
  extension bundle.

- Fixed the welcome screen in the Flame Graph panel to properly display icons.

## [1.1.0]

- Added AI chat integration via MCP: profiling data is exposed to AI agents
  (e.g. GitHub Copilot, Claude Code, Cursor) through three tools — `get_top`,
  `get_call_stacks`, and `get_metadata`. The server starts automatically when
  the extension activates and binds to an OS-assigned port, so multiple VS Code
  windows can run simultaneously without conflicts.

- Added the **Austin: Generate .mcp.json** command, which writes a `.mcp.json`
  file to the workspace root for agents with their own MCP client. If the file
  already has an austin entry, the port is updated automatically on every
  restart.

## [1.0.0]

### Flame Graph

- Replaced the third-party D3 flame graph with a fully custom canvas-based
  implementation featuring smooth zoom animations, keyboard-navigable search,
  and ancestor context rows that remain visible while zoomed in.

- Added a shareable interactive SVG export — the **Share** button generates a
  self-contained SVG flame graph that can be opened in any browser.

### Session Control

- **Attach to process** (⇧⌃F5 / Ctrl+Shift+F5): start profiling any running
  Python process by selecting it from a live process list without restarting it.

- **Pause / Resume**: suspend and continue UI updates mid-session (collection
  continues in the background).

### Live Profiling

- Real-time flame graph, call stacks, and top-functions views that update as
  samples stream in during a live session using the Profile with Austin command,
  or the new Attach to process command.

### Call Stacks & Top Functions Panels

- **Top Functions**: added a filter bar to narrow the list by scope or module
  name; caller rows now show a contribution percentage bar, an expand/collapse
  animation, and a distinct background to visually group the expanded callers.
  Hovering a row shows the caller count.

- **Call Stacks**: clicking a frame syncs the flame graph zoom to the same
  call path; a "Sync with flame graph" toggle controls this behavior.

- Both panels show a sortable **Own** and **Total** column.

### Other Improvements

- Collapse-all buttons in the call stacks and top panels now correctly reset
  all expanded state before re-rendering.

- Fixed variable substitution in Austin task definitions. Previously, only
  `${file}` and `${workspaceFolder}` were resolved; all other variables
  (including `${input:…}`, `${env:NAME}`, and `${cwd}`) were passed literally
  to the profiled process. All standard VS Code task variables are now
  supported.

## [0.17.3]

- - Fixed regression for support for paths with spaces in Austin tasks.

## [0.17.2]

- Fixed the heat map visualisation when using the MOJO binary format with
  Python versions earlier than 3.11.

## [0.17.1]

- Fixed a visualisation bug that caused some frames to be aggregated incorrectly
  by scope name only, resulting in incorrect flame graph visualisations.

- General visual improvements to heat maps and flame graphs.

## [0.17.0]

- Added support for the `${file}` and `${workspaceFolder}` placeholders in the
  Austin task definitions.

- Added support for environment files in Austin task definitions.

- Fixed a bug that caused in-line memory percentages to be larger than 100%.

## [0.16.0]

- Added support for memory mode.

## [0.15.0]

- Added support for MOJO version 3, used by Austin 3.6.

## [0.14.0]

- Added setting option to select the type of line stats to display on the heat
  map to show percent, absolute or both values.

## [0.13.1]

- Fix the line heat color to reflect the profile type when data is loaded from
  a sample file.

## [0.13.0]

- Extended colour-coding to source heat maps.

## [0.12.0]

- Added support for MOJO version 2 and column-level heat decorations.

## [0.11.3]

- Fix extension packaging issue

## [0.11.2]

- Fixed integer parsing for the MOJO format that caused stacks to be wrongly
  reconstructed, resulting in incorrectly shaped flame graphs.

- Fixed the Top view that displayed wrong percentages.

## [0.11.1]

- Fixed string reference resolution for the MOJO format.

## [0.11.0]

- Added support for the MOJO file format.

- Fixed support for the "Profile with Austin" command on MacOS.

## [0.10.8]

- Fixed a conflict between Austin and debug mode (contributed by @slishak)

## [0.10.7]

- Fixed a bug that prevented the flame graph panel from loading.

## [0.10.6]

- Fixed a bug that prevented loading Austin stats when the flame graph view was
  not showing  (contributed by Anthony Shaw).

## [0.10.5]

- Fixed support for commands with spaces in Austin tasks.

## [0.10.4]

- Fixed support for paths with spaces in Austin tasks.

## [0.10.3]

- Fixed a bug that caused the workspace root folder to be repeated when trying
  to profile the active script.

## [0.10.2]

- Minor UI improvements.

## [0.10.1]

- Tasks running in multi-root workspaces will now ask the user to pick the
  working directory within which the command should be run.

## [0.10.0]

- Extended the Austin task definition to accept and run arbitrary commands.

## [0.9.3]

- Fixed packaging issue.

## [0.9.2]

- Fixed an issue with the flame graph view receiving data before being ready.

## [0.9.1]

- Fixed the issue with the `Profile with Austin` command that prevented the data
from being shown in the editor.

- Added licensing information.

## [0.9.0]

Improved the "Profile with Austin" command.

## [0.8.1]

- Fix a flame graph UI issue.

## [0.8.0]

- Flamegraph UI improvements
- Added documentation for task support
- Fixed the rendering of the sampled call stacks.

## [0.7.0]

- Added support for tasks to run Python scripts with Austin (contributed by Anthony Shaw)
- Flame graph panel visual improvements

## [0.6.1]

- Improved tooltip

## [0.6.0]

- Added sampled call stacks and top functions views in the side bar
- Improved the appearance of the flame graph
- Removed line-level granularity

## [0.5.0]

- Cache stats generation for higher responsiveness
- Better line heat map

## [0.4.0]

- Use similar colours for functions within the same module

## [0.3.0]

- Added line number toggle
## [0.2.0]

- Added search support
- Added keyboard shortcuts


## [0.1.0]

- Initial release
