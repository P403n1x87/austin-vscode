#!/usr/bin/env bash
# Simple askpass for Linux desktops. Uses zenity or kdialog.

if command -v zenity >/dev/null 2>&1; then
  zenity --password --title="Authentication required"
  exit $?
fi

if command -v kdialog >/dev/null 2>&1; then
  kdialog --password "Authentication required"
  exit $?
fi

# No GUI password helper available
printf 'Austin askpass: no GUI password helper found (install zenity or kdialog).\n' >&2
exit 1
