; Before uninstalling, remove the Claude Code hooks this app added to ~/.claude/settings.json,
; otherwise Claude Code would keep trying to run a program that no longer exists.
!macro NSIS_HOOK_PREUNINSTALL
  ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --remove-claude-hooks'
!macroend
