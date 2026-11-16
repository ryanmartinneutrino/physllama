Unicode True
!include "MUI2.nsh"
!include "x64.nsh"
Name "Vernier Lab"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\Vernier Lab"
RequestExecutionLevel user
SetCompressor /SOLID lzma
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "Vernier Lab requires 64-bit Windows."
    Abort
  ${EndIf}
  MessageBox MB_OKCANCEL "Close Vernier Lab before installing or updating. Export measurements, then use Quit app in its browser window." IDOK proceed
  Abort
  proceed:
FunctionEnd

Section "Vernier Lab"
  SetRegView 64
  SetOutPath "$INSTDIR"
  File /r "${PAYLOAD}\*"
  CreateDirectory "$SMPROGRAMS\Vernier Lab"
  CreateShortcut "$SMPROGRAMS\Vernier Lab\Vernier Lab.lnk" "$INSTDIR\python\pythonw.exe" '-I "$INSTDIR\app\desktop.py"'
  CreateShortcut "$DESKTOP\Vernier Lab.lnk" "$INSTDIR\python\pythonw.exe" '-I "$INSTDIR\app\desktop.py"'
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\VernierLab" "DisplayName" "Vernier Lab"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\VernierLab" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\VernierLab" "UninstallString" '$"$INSTDIR\Uninstall.exe$"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\VernierLab" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\VernierLab" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\VernierLab" "NoRepair" 1
SectionEnd

Section "Uninstall"
  SetRegView 64
  MessageBox MB_OKCANCEL "Close Vernier Lab before uninstalling. Export measurements, then use Quit app." IDOK remove
  Abort
  remove:
  Delete "$DESKTOP\Vernier Lab.lnk"
  Delete "$SMPROGRAMS\Vernier Lab\Vernier Lab.lnk"
  RMDir "$SMPROGRAMS\Vernier Lab"
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\deps"
  RMDir /r "$INSTDIR\python"
  Delete "$INSTDIR\README.md"
  Delete "$INSTDIR\THIRD_PARTY_NOTICES.md"
  Delete "$INSTDIR\BUILD-MANIFEST.json"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\VernierLab"
SectionEnd
