; Cortex's uninstaller is the app itself: `cortex-desktop.exe --uninstall --from-installer` asks what to
; remove, stops and removes the local server, and exits with the decision (src/uninstall.rs):
;   0  proceed    10  proceed and delete the app's own data    20  cancelled
; Any other result (it could not start, it crashed) falls back to the stock confirm page.
;
; This file is included before Tauri's template declares its variables and defines, so nothing here
; may reference them at the top level: the binary name is spelled out, and $UpdateMode / $PassiveMode
; are re-read from the command line.

!include LogicLib.nsh

Var CortexUninstallResult

; Declared ahead of the template's confirm and progress pages, so it is the first uninstaller page.
UninstPage custom un.CortexUninstaller

Function un.CortexUninstaller
  StrCpy $CortexUninstallResult ""
  ; Updates run the old uninstaller with /UPDATE (silently): never stop the server for those.
  IfSilent cortex_done
  ClearErrors
  ${GetOptions} $CMDLINE "/UPDATE" $0
  IfErrors 0 cortex_done
  ClearErrors
  ${GetOptions} $CMDLINE "/P" $0
  IfErrors 0 cortex_done
  IfFileExists "$INSTDIR\cortex-desktop.exe" 0 cortex_done
  ClearErrors
  ExecWait '"$INSTDIR\cortex-desktop.exe" --uninstall --from-installer' $0
  IfErrors cortex_done
  ${If} $0 = 20
    Quit
  ${EndIf}
  ${If} $0 = 0
  ${OrIf} $0 = 10
    StrCpy $CortexUninstallResult $0
    ; The decision was made in Cortex's window: go straight past the confirm page to the removal.
    ; From a custom page's creator this only sets the page step, which NSIS applies on return.
    SendMessage $HWNDPARENT 0x408 2 0
  ${EndIf}
  cortex_done:
FunctionEnd

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $CortexUninstallResult = 10
    SetShellVarContext current
    RmDir /r "$APPDATA\${BUNDLEID}"
    RmDir /r "$LOCALAPPDATA\${BUNDLEID}"
  ${EndIf}
  ; Cortex's window already showed the outcome; the progress page needs no Close click.
  ${If} $CortexUninstallResult != ""
    SetAutoClose true
  ${EndIf}
!macroend
