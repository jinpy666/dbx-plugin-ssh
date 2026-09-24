# DBX local terminal bash wrapper (sourced via `bash --rcfile`).
#
# bash cannot combine a login startup (-l) with --rcfile, so this wrapper
# reproduces the login chain explicitly: system profile, first of the
# per-user profile files, then the user's .bashrc, then shell integration.
# Every step is guarded — a broken rc must never keep the shell from
# reaching a prompt.
if [ -r /etc/profile ]; then
  . /etc/profile
fi
for __dbx_profile in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
  if [ -r "$__dbx_profile" ]; then
    . "$__dbx_profile"
    break
  fi
done
unset __dbx_profile
if [ -r "$HOME/.bashrc" ]; then
  . "$HOME/.bashrc"
fi
if [ -r "{{INTEGRATION_DIR}}/integration.bash" ]; then
  . "{{INTEGRATION_DIR}}/integration.bash"
fi
