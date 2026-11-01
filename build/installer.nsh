; Lefty asks Windows for administrator, so he can click into windows that run as administrator themselves.
; An installer or uninstaller does not run that way, and Windows will not let the lesser one close the greater:
; every uninstall stopped at "Lefty cannot be closed. Please close it manually and click Retry to continue."
;
; So nothing tries to close him. This replaces electron-builder's "is it running?" check, which is where that
; dialog came from, with a note left where Lefty is already looking (%APPDATA%\lefty\uninstalling, which he
; checks every two seconds) and a few seconds for him to close himself. taskkill is tried too, for a Lefty
; that is not running as administrator.
;
; customCheckAppRunning is the hook that stands in for that check, in the installer and the uninstaller alike
; (app-builder-lib/templates/nsis/include/allowOnlyOneInstallerInstance.nsh). customUnInit is no use here: it
; runs after un.checkAppRunning, so the dialog would already have been and gone.

!macro customCheckAppRunning
  CreateDirectory "$APPDATA\lefty"
  ClearErrors
  FileOpen $0 "$APPDATA\lefty\uninstalling" w
  IfErrors +3
  FileWrite $0 "1"
  FileClose $0
  nsExec::Exec 'taskkill /IM ${APP_EXECUTABLE_FILENAME} /T'
  Sleep 4000
  nsExec::Exec 'taskkill /F /IM ${APP_EXECUTABLE_FILENAME} /T'
  Sleep 1500
  Delete "$APPDATA\lefty\uninstalling"
!macroend
