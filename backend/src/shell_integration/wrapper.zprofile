# DBX local terminal zsh wrapper: .zprofile
#
# The plugin points ZDOTDIR at its own directory to inject shell integration.
# This wrapper chains the user's real startup file first so login-shell
# semantics (PATH via /etc/zprofile + ~/.zprofile) stay intact. DBX_USER_ZDOTDIR
# holds the user's original ZDOTDIR when it was set, otherwise HOME is used.
if [ -n "$DBX_USER_ZDOTDIR" ] && [ -f "$DBX_USER_ZDOTDIR/.zprofile" ]; then
  source "$DBX_USER_ZDOTDIR/.zprofile"
elif [ -f "$HOME/.zprofile" ]; then
  source "$HOME/.zprofile"
fi
