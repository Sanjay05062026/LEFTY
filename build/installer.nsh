; Lefty asks Windows for administrator, so he can click into windows that run as administrator themselves.
; An installer or uninstaller does not run that way, and Windows will not let the lesser one close the greater:
; every uninstall stopped at "Lefty cannot be closed. Please close it manually and click Retry to continue."
;
; So instead of trying to close him, leave a note where he is already looking (%APPDATA%\lefty\uninstalling,
; checked every two seconds) and give him a moment to close himself. taskkill is tried too, for a Lefty that
; is not running as administrator. By the time the usual "is it running?" check happens, he has gone.

!macro leftyStandDown
  CreateDirectory "$APPDATA\lefty"
  ClearErrors
  FileOpen $0 "$APPDATA\lefty\uninstalling" w
  IfErrors +3
  FileWrite $0 "1"
  FileClose $0
  nsExec::Exec 'taskkill /IM Lefty.exe /T'
  Sleep 4000
  nsExec::Exec 'taskkill /F /IM Lefty.exe /T'
  Sleep 1000
  Delete "$APPDATA\lefty\uninstalling"
!macroend

!macro customUnInit
  !insertmacro leftyStandDown
!macroend

; Installing over a copy that is already running has the same problem, and the same answer.
!macro customInit
  !insertmacro leftyStandDown
!macroend
