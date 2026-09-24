# DBX local terminal shell integration (fish).
#
# Same contract as integration.zsh: OSC 133 A/C/D;code, 633;E command line,
# 633;P cwd and OSC 7. fish's fish_preexec / fish_prompt events carry exactly
# the lifecycle we need; $status inside fish_prompt is the last command's
# exit status. Fail-safe: event handlers only print.
function __dbx_si_preexec --on-event fish_preexec
    printf '\e]633;E;%s\a' "$argv[1]"
    printf '\e]633;C\a'
    printf '\e]133;C\a'
end

function __dbx_si_precmd --on-event fish_prompt
    printf '\e]633;D;%s\a' "$status"
    printf '\e]133;D;%s\a' "$status"
    printf '\e]633;A\a'
    printf '\e]133;A\a'
    printf '\e]633;P;Cwd=%s\a' "$PWD"
    printf '\e]7;file://localhost%s\a' "$PWD"
end

# Initial prompt marks so the first prompt is decorated like every later one.
__dbx_si_precmd
