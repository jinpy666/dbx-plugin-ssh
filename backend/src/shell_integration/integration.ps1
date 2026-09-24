# DBX local terminal shell integration (PowerShell / pwsh).
#
# Same contract as the POSIX scripts: OSC 133 A/D;code lifecycle marks plus
# 633;P cwd. On Windows the cwd report uses OSC 9;9 (the ConPTY-friendly
# convention) instead of the POSIX-only OSC 7. The user's own prompt function
# is preserved and called for its output; our marks wrap it. Fail-safe: if
# anything here throws, PowerShell keeps the built-in prompt.
$global:__DbxSiOriginalPrompt = $function:prompt

function global:__DbxSiEmit([string]$Payload) {
    [Console]::Write("$([char]27)]" + $Payload + "$([char]7)")
}

function global:prompt {
    $ec = 0
    if ($null -ne $global:LASTEXITCODE) {
        $ec = $global:LASTEXITCODE
    } elseif (-not $?) {
        $ec = 1
    }
    __DbxSiEmit "633;D;$ec"
    __DbxSiEmit "133;D;$ec"

    $text = "PS> "
    if ($null -ne $global:__DbxSiOriginalPrompt) {
        $produced = & $global:__DbxSiOriginalPrompt
        if ($null -ne $produced) { $text = ($produced | Out-String).TrimEnd() }
    }

    __DbxSiEmit "633;A"
    __DbxSiEmit "133;A"

    $cwd = $executionContext.SessionState.Path.CurrentLocation.Path
    __DbxSiEmit "633;P;Cwd=$cwd"
    __DbxSiEmit "9;9;$cwd"
    return $text
}
