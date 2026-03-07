#!/bin/bash

# The purpose of this script is to check if the SonarQube (SonarLint) plugin is installed
# in the user's IDE (either VSCode or JetBrains). SonarQube is encouraged for all projects
# to maintain code quality and consistency.

set -e

# Check for VSCode
if command -v code >/dev/null 2>&1; then
  echo -e "\n\nDetected IDE: Visual Studio Code"
  if ! code --list-extensions | grep "sonarsource.sonarlint-vscode" > /dev/null; then
    echo -e "\n\033[1;31mERROR: SonarQube extension not installed.\033[0m"
    echo -e "\033[1mHarper encourages the use of SonarQube for all projects.\033[0m"
    echo -e "\033[1mPlease install the SonarQube extension for VSCode\033[0m"
  else
    echo "✅ SonarQube extension is installed in VSCode."
  fi

# Check for JetBrains IDEs
elif command -v jetbrains-toolbox >/dev/null 2>&1 || ls ~/Library/Application\ Support/JetBrains >/dev/null 2>&1; then
  echo "Detected JetBrains IDE"

  CONFIG_DIR=$(ls -d ~/Library/Application\ Support/JetBrains/* 2>/dev/null | head -n 1)

  if [ -z "$CONFIG_DIR" ]; then
    echo -e "\033[1;33mWarning: JetBrains config not found.\033[0m"
  else
    if ! grep -r "sonarlint" "$CONFIG_DIR" 2>/dev/null; then
        echo -e "\n\033[1;31mERROR: SonarQube (SonarLint) plugin not installed.\033[0m"
        echo -e "\033[1mHarper encourages the use of SonarQube for all company projects.\033[0m"
        echo -e "\033[1mPlease install the SonarQube (SonarLint) plugin for JetBrains.\033[0m"
    else
        echo "✅ SonarQube plugin is installed in JetBrains."
    fi
  fi

else
  echo -e "\033[1;33mWarning: Could not detect VSCode or JetBrains IDE.\033[0m"
  echo -e "\033[1mHarper encourages the use of SonarQube for all company projects.\033[0m"
  echo "Please ensure you have SonarQube (SonarLint) installed manually."
fi
