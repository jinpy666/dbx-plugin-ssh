# DBX local terminal zsh wrapper: .zlogin
#
# See wrapper.zprofile: chains the user's real login-time file so the
# ZDOTDIR override stays transparent.
if [ -n "$DBX_USER_ZDOTDIR" ] && [ -f "$DBX_USER_ZDOTDIR/.zlogin" ]; then
  source "$DBX_USER_ZDOTDIR/.zlogin"
elif [ -f "$HOME/.zlogin" ]; then
  source "$HOME/.zlogin"
fi
