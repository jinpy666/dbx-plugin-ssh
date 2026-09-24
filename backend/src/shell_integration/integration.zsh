# DBX local terminal shell integration (zsh).
#
# Emits the OSC 133/633 command lifecycle marks and OSC 7 cwd reports the
# workbench consumes for command exit decorations and cwd tracking:
#   133;A prompt start | 133;C command start | 133;D;<code> command done
#   633;E;<cmdline>     | 633;P;Cwd=<cwd>    | 7;file://<host><cwd>
# Fail-safe by design: every hook is guarded so a broken user rc can never
# keep the shell from reaching a prompt. Parsed data stays inside the
# terminal UI (decorations/cwd display) and is never executed.
__dbx_si_precmd() {
  local __dbx_ec=$?
  printf '\e]633;D;%s\a' "$__dbx_ec"
  printf '\e]133;D;%s\a' "$__dbx_ec"
  printf '\e]633;A\a'
  printf '\e]133;A\a'
  printf '\e]633;P;Cwd=%s\a' "$PWD"
  printf '\e]7;file://%s%s\a' "${HOST:-localhost}" "$PWD"
}

__dbx_si_preexec() {
  printf '\e]633;E;%s\a' "$1"
  printf '\e]633;C\a'
  printf '\e]133;C\a'
}

if [[ -z "${precmd_functions[(r)__dbx_si_precmd]}" ]]; then
  precmd_functions+=(__dbx_si_precmd)
fi
if [[ -z "${preexec_functions[(r)__dbx_si_preexec]}" ]]; then
  preexec_functions+=(__dbx_si_preexec)
fi

# Initial prompt marks so the first prompt is decorated like every later one.
__dbx_si_precmd
