# DBX local terminal zsh wrapper: .zshrc
#
# Chains the user's real .zshrc first, then activates shell integration.
# Every step is guarded: a broken or missing user rc must never keep the
# shell from reaching a prompt.
if [ -n "$DBX_USER_ZDOTDIR" ] && [ -f "$DBX_USER_ZDOTDIR/.zshrc" ]; then
  source "$DBX_USER_ZDOTDIR/.zshrc"
elif [ -f "$HOME/.zshrc" ]; then
  source "$HOME/.zshrc"
fi
if [ -f "{{INTEGRATION_DIR}}/integration.zsh" ]; then
  source "{{INTEGRATION_DIR}}/integration.zsh"
fi
