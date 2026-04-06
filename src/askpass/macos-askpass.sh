#!/bin/sh
# Minimal askpass helper for macOS using AppleScript.
# Prints the entered password to stdout for SUDO_ASKPASS.
osascript -e 'tell application "System Events" to display dialog "Administrator privileges are required. Enter your password:" default answer "" with hidden answer with title "Austin"' -e 'text returned of result'
