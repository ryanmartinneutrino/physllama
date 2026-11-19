#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
if [[ "$(uname -s)" != Darwin ]]; then
  echo "This installer is for macOS."
  exit 1
fi
expected_arch="@ARCH@"
if [[ "$(uname -m)" != "$expected_arch" ]]; then
  echo "This download is for $expected_arch. Download the installer for your Mac's processor."
  read -r -p "Press Return to close. "
  exit 1
fi
printf 'PhysLlama installs in ~/Applications and includes Python and all dependencies.\n'
printf 'Close any running PhysLlama session before installing. Export your data first.\n'
read -r -p 'Install PhysLlama now? [y/N] ' answer
case "$answer" in y|Y|yes|YES) ;; *) exit 0 ;; esac
mkdir -p "$HOME/Applications"
destination="$HOME/Applications/PhysLlama.app"
if [[ -e "$destination" ]]; then
  echo "PhysLlama is already installed. Move the existing app to Trash, then rerun this installer."
  read -r -p "Press Return to close. "
  exit 1
fi
/usr/bin/ditto "PhysLlama.app" "$destination"
echo "Installed: $destination"
echo "If macOS blocks the app, try opening it, then use System Settings > Privacy & Security > Open Anyway."
echo "See START HERE - Mac.txt in the download for step-by-step instructions."
echo "Open PhysLlama from Applications in your home folder. Allow Bluetooth when prompted."
/usr/bin/open "$HOME/Applications"
